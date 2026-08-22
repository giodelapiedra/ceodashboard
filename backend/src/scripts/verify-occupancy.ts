import 'dotenv/config';
import { nookalV3 } from '../services/nookal-v3/client';
import { env } from '../config/env';
import { getWeekRanges } from '../services/week.calculator';
import {
  fetchFreeSlots,
  occupancyByProvider,
  occupancyPct,
  ApptWindow,
} from '../features/practitioner-stats/practitioner-stats.occupancy';

/**
 * Print the Occupancy the sync would write, week by week, without touching the
 * database.
 *
 * The point of this script is that our occupancy is NOT Nookal's occupancy and
 * has never been reconciled with it. Ours divides booked diary time by booked +
 * still-bookable; Nookal's Reports -> Occupancy screen divides by rostered shift
 * hours, which is why theirs can exceed 100% and ours cannot. Until somebody
 * puts the two side by side for one week, "Occupancy 82%" on the board is a
 * number whose definition nobody has checked.
 *
 * So this prints the working, not just the answer: booked, free and blocked
 * hours per practitioner-week, plus the percentage. Open Nookal -> Reports ->
 * Occupancy for the same week with Location on "All Location", and compare.
 *
 *   npx ts-node-dev --transpile-only src/scripts/verify-occupancy.ts 2026 8
 *
 * Read-only. It makes the same Nookal calls the sync makes and writes nothing.
 */

const STAFF_QUERY = /* GraphQL */ `
  query StaffProviders($pageLength: Int!) {
    staff(isProvider: 1, pageLength: $pageLength) {
      staffID
      fullName
      status
    }
  }
`;

const APPTS_QUERY = /* GraphQL */ `
  query Appts(
    $locationIDs: [Int], $dateFrom: String!, $dateTo: String!,
    $page: Int!, $pageLength: Int!
  ) {
    appointments(
      locationIDs: $locationIDs, dateFrom: $dateFrom, dateTo: $dateTo,
      page: $page, pageLength: $pageLength
    ) {
      providerID
      appointmentDate
      startTime
      endTime
      status
      apptType
    }
  }
`;

interface Provider { staffID: number; fullName: string | null; status: number | null }

const arr = <T>(v: T | T[] | null | undefined): T[] =>
  Array.isArray(v) ? v : v ? [v] : [];

function allLocationIds(): number[] {
  return [
    env.NOOKAL_V3_LOCATION_NEWPORT,
    env.NOOKAL_V3_LOCATION_NARRABEEN,
    env.NOOKAL_V3_LOCATION_BROOKVALE,
  ].map(Number).filter((n) => Number.isFinite(n) && n > 0);
}

const PAGE_LENGTH = 200;
const MAX_PAGES   = 40;

async function fetchAppointments(dateFrom: string, dateTo: string): Promise<ApptWindow[]> {
  const locationIDs = allLocationIds();
  const out: ApptWindow[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await nookalV3.query<{ appointments: ApptWindow[] | null }>(
      APPTS_QUERY,
      { locationIDs, dateFrom, dateTo, page, pageLength: PAGE_LENGTH }
    );
    const rows = data.appointments ?? [];
    out.push(...rows);
    if (rows.length < PAGE_LENGTH) break;
  }
  return out;
}

const hrs = (m: number) => (m / 60).toFixed(1).padStart(6);
const pad = (s: string, n: number) => s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);

async function main(): Promise<void> {
  const year  = Number(process.argv[2]);
  const month = Number(process.argv[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    console.error('usage: verify-occupancy.ts <year> <month>   e.g. 2026 8');
    process.exit(1);
  }

  const staffData = await nookalV3.query<{ staff: Provider | Provider[] }>(
    STAFF_QUERY, { pageLength: 200 }
  );
  const providers = arr(staffData.staff);
  const nameOf = new Map<number, string>(
    providers.map((p) => [Number(p.staffID), p.fullName ?? `#${p.staffID}`])
  );
  // Every provider, archived included: a practitioner who left mid-year still
  // owns the weeks they worked, exactly as syncProviderMapping treats them.
  const staffIDs = providers.map((p) => Number(p.staffID)).filter((n) => n > 0);

  const weeks = getWeekRanges(year, month).filter((w) => w.dateFrom !== '9999-12-31');
  const dateFrom = weeks.reduce((a, w) => (w.dateFrom < a ? w.dateFrom : a), weeks[0].dateFrom);
  const dateTo   = weeks.reduce((a, w) => (w.dateTo   > a ? w.dateTo   : a), weeks[0].dateTo);

  console.log(`\nOccupancy check — ${year}-${String(month).padStart(2, '0')}  (${dateFrom} .. ${dateTo})`);
  console.log('Compare against Nookal -> Reports -> Occupancy, Location = All Location.\n');

  const appts = await fetchAppointments(dateFrom, dateTo);
  const slots = await fetchFreeSlots(dateFrom, dateTo, allLocationIds(), staffIDs);
  console.log(`Nookal returned ${appts.length} appointments and ${slots.length} free slots.\n`);

  for (const w of weeks) {
    const occ = occupancyByProvider(appts, slots, w.dateFrom, w.dateTo);
    console.log(`── ${w.label}  ${w.dateFrom} .. ${w.dateTo} ${'─'.repeat(30)}`);
    console.log(`   ${pad('practitioner', 22)} booked   free blocked   occupancy`);

    const named = [...occ.entries()]
      .map(([pid, m]) => ({ name: nameOf.get(pid) ?? `#${pid}`, m }))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const { name, m } of named) {
      // A provider with nothing at all in the diary that week is noise, not a
      // zero — they were not working. Printing them would bury the real rows.
      if (m.bookedMinutes === 0 && m.availableMinutes === 0 && m.blockedMinutes === 0) continue;
      const pct = occupancyPct(m);
      const shown = pct === null
        ? '     — not measurable (no bookable time left in Nookal)'
        : `${pct.toFixed(2).padStart(9)}%`;
      console.log(`   ${pad(name, 22)}${hrs(m.bookedMinutes)} ${hrs(m.availableMinutes)} ${hrs(m.blockedMinutes)}  ${shown}`);
    }
    console.log('');
  }

  console.log('booked  = consultations and classes held (DNA counted, cancelled not)');
  console.log('free    = still bookable, from Nookal availabilities at 15-min granularity');
  console.log('blocked = DiaryEvent blockouts. NOT in the denominator — see practitioner-stats.occupancy.ts');
}

main().catch((e) => { console.error(e); process.exit(1); });
