import { nookalV3 } from '../../services/nookal-v3/client';
import { env } from '../../config/env';
import { query } from '../../db/pool';
import { getWeekRanges } from '../../services/week.calculator';
import { syncOccupancy, OccupancySyncSummary } from './practitioner-stats.occupancy-api';

/**
 * Nookal → Practitioner Stats sync.
 *
 * Deliberately self-contained: it calls the shared v3 client but adds its own
 * queries rather than touching services/nookal-v3 or patient-metrics.service,
 * so nothing the CEO Dashboard depends on changes behaviour.
 *
 * Two v3 queries the rest of the codebase has never used:
 *   staff(isProvider: 1)  → staffID + fullName, the bridge to users
 *   appointments(...)     → providerID + status + isNewCase, already fetched
 *                           per clinic by patient-metrics but summed to a
 *                           clinic total there, discarding the provider split
 *
 * Validated live for Week 1 July 2026 against the spreadsheet: Total Appts
 * matched 9 of 10 practitioners exactly and NC matched 10 of 10.
 *
 * This sync deliberately does NOT touch Occupancy.
 *
 * It could: practitioner-stats.occupancy.ts derives booked ÷ (booked +
 * still-bookable) from the diary, and that code is kept and still runs behind
 * `npm run verify:occupancy`. But it is not the measure Nookal reports, and
 * compared against Nookal's own Occupancy report for the week of 3 Aug 2026 it
 * ran up to 23 points high and put 5 of 11 practitioners in the WRONG zone —
 * always the flattering way (Isabella read 80.00% "thriving" where Nookal says
 * 56.96% "reset"). Sam's call, 2026-08-20: a blank cell beats a confident wrong
 * one, so Occupancy is filled only by the report import or by hand.
 *
 * See docs/OCCUPANCY_2026-08-20.md and db/import-occupancy-nookal.ts.
 */

// ── GraphQL ────────────────────────────────────────────────────────────────

const STAFF_PROVIDERS_QUERY = /* GraphQL */ `
  query StaffProviders($pageLength: Int!) {
    staff(isProvider: 1, pageLength: $pageLength) {
      staffID
      fullName
      firstName
      lastName
      status
    }
  }
`;

const APPTS_BY_PROVIDER_QUERY = /* GraphQL */ `
  query ApptsByProvider(
    $locationIDs: [Int], $dateFrom: String!, $dateTo: String!,
    $page: Int!, $pageLength: Int!
  ) {
    appointments(
      locationIDs: $locationIDs, dateFrom: $dateFrom, dateTo: $dateTo,
      page: $page, pageLength: $pageLength
    ) {
      apptID
      providerID
      appointmentDate
      isNewCase
      status
      # Occupancy needs the window each appointment occupies, and apptType to
      # tell a real consultation from a blockout or a diary note. Added here
      # rather than in a second query — this fetch already walks the whole month.
      startTime
      endTime
      apptType
    }
  }
`;

export interface NookalProvider {
  staffID:   number;
  fullName:  string | null;
  firstName: string | null;
  lastName:  string | null;
  /** 1 = active in Nookal, 0 = archived. */
  status:    number | null;
}

interface ApptRow {
  apptID:          number;
  providerID:      number | null;
  appointmentDate: string;
  isNewCase:       number;
  status:          string | null;
  /** "HH:MM:SS". Occupancy only — the appointment counts do not use these. */
  startTime:       string | null;
  endTime:         string | null;
  /** Consultation | Class | DiaryEvent | DiaryNote. */
  apptType:        string | null;
}

/** All three clinic locations — the SOP reads these figures with the Nookal
 *  location filter on "All Location", so the sync must too. */
function allLocationIds(): number[] {
  return [
    env.NOOKAL_V3_LOCATION_NEWPORT,
    env.NOOKAL_V3_LOCATION_NARRABEEN,
    env.NOOKAL_V3_LOCATION_BROOKVALE,
  ]
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n > 0);
}

async function fetchProviders(): Promise<NookalProvider[]> {
  const data = await nookalV3.query<{ staff: NookalProvider | NookalProvider[] }>(
    STAFF_PROVIDERS_QUERY,
    { pageLength: 200 }
  );
  const s = data.staff;
  // Nookal returns a bare object when a filter matches exactly one record.
  return Array.isArray(s) ? s : s ? [s] : [];
}

const PAGE_LENGTH = 200;
/** Backstop against a paging bug turning into an unbounded loop. */
const MAX_PAGES = 40;

async function fetchAppointments(dateFrom: string, dateTo: string): Promise<ApptRow[]> {
  const locationIDs = allLocationIds();
  const out: ApptRow[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await nookalV3.query<{ appointments: ApptRow[] | null }>(
      APPTS_BY_PROVIDER_QUERY,
      { locationIDs, dateFrom, dateTo, page, pageLength: PAGE_LENGTH }
    );
    const rows = data.appointments ?? [];
    out.push(...rows);
    if (rows.length < PAGE_LENGTH) break;
  }
  return out;
}

// ── Provider → user mapping ────────────────────────────────────────────────

/**
 * Spelling differences between Nookal and the PhysioWard account, keyed by the
 * normalised users.full_name. users.full_name holds FIRST NAMES for most
 * clinicians ("Angus", "Ben") while Nookal holds full names, so first-name
 * matching does the bulk of the work — these are the ones it cannot resolve.
 *
 * Confirmed with Sam 2026-08-04. "Gabby" is deliberately absent: it is a second
 * account for the already-matched Gabriella and must NOT be mapped, or her week
 * would be counted twice.
 */
const NAME_ALIASES: Record<string, string> = {
  zach:  'zac fielding',    // Nookal spells it "Zac"
  jesse: 'jesse barnes',    // archived in Nookal, still owns historical weeks
  tim:   'tim dereu',       // archived in Nookal
};

const norm = (s: string | null | undefined) =>
  (s ?? '').toLowerCase().replace(/[^a-z]/g, '');

export interface MappingResult {
  mapped:     { userId: string; fullName: string; staffID: number; nookalName: string; how: string }[];
  unresolved: { userId: string; fullName: string }[];
  /** Nookal providers with no PhysioWard account — informational. */
  orphanProviders: { staffID: number; fullName: string | null }[];
}

/**
 * Resolve users.nookal_staff_id from the live Nookal provider list.
 *
 * Only ever fills in or corrects a mapping; never clears one, so a hand-set ID
 * survives a sync that fails to match by name.
 */
export async function syncProviderMapping(providers: NookalProvider[]): Promise<MappingResult> {
  const { rows: users } = await query<{ id: string; full_name: string | null }>(
    `SELECT id, full_name FROM users
      WHERE role = 'CLINICIAN' OR also_clinician IS TRUE
      ORDER BY full_name NULLS LAST`
  );

  // Archived providers are still matched: a clinician who left mid-year still
  // owns the weeks they worked, and their historical figures must not vanish.
  const byFull  = new Map<string, NookalProvider>();
  const byFirst = new Map<string, NookalProvider[]>();
  for (const p of providers) {
    const f = norm(p.fullName);
    // An active record wins over an archived duplicate ("Jervis Goodsell" over
    // the archived "Jervis Bob Goodsell").
    if (f && (!byFull.has(f) || p.status === 1)) byFull.set(f, p);
    const first = norm(p.firstName);
    if (first) {
      const list = byFirst.get(first) ?? [];
      list.push(p);
      byFirst.set(first, list);
    }
  }

  const result: MappingResult = { mapped: [], unresolved: [], orphanProviders: [] };

  for (const u of users) {
    const n = norm(u.full_name);
    if (!n) { result.unresolved.push({ userId: u.id, fullName: u.full_name ?? '' }); continue; }

    let match: NookalProvider | undefined;
    let how = '';

    // byFull is keyed by norm(), which strips spaces — the alias has to be
    // normalised the same way or it can never match.
    const alias = NAME_ALIASES[n] ? norm(NAME_ALIASES[n]) : undefined;
    if (alias && byFull.has(alias)) { match = byFull.get(alias); how = 'alias'; }
    else if (byFull.has(n))         { match = byFull.get(n);     how = 'fullName'; }
    else {
      // Only accept a first-name match when it is unambiguous — two providers
      // sharing a first name must be resolved by hand, not guessed.
      const candidates = (byFirst.get(n) ?? []).filter((p) => p.status === 1);
      if (candidates.length === 1) { match = candidates[0]; how = 'firstName'; }
    }

    if (!match) { result.unresolved.push({ userId: u.id, fullName: u.full_name ?? '' }); continue; }

    await query(
      `UPDATE users SET nookal_staff_id = $1 WHERE id = $2`,
      [match.staffID, u.id]
    );
    result.mapped.push({
      userId:     u.id,
      fullName:   u.full_name ?? '',
      staffID:    match.staffID,
      nookalName: match.fullName ?? '',
      how,
    });
  }

  const takenIds = new Set(result.mapped.map((m) => m.staffID));
  result.orphanProviders = providers
    .filter((p) => p.status === 1 && !takenIds.has(p.staffID))
    .map((p) => ({ staffID: p.staffID, fullName: p.fullName }));

  return result;
}

// ── Weekly figures ─────────────────────────────────────────────────────────

export interface SyncResult {
  year:            number;
  month:           number;
  weeksSynced:     number;
  appointments:    number;
  rowsWritten:     number;
  mapping:         MappingResult;
  /** Providers seen in the appointment feed with no mapped user — their
   *  appointments are NOT counted, and silence about that would read as zero. */
  unmappedProviderIds: number[];

  /**
   * Practitioner-weeks this sync touched that still have no Occupancy — nothing
   * imported off the Nookal report and nothing typed in. Reported so a blank
   * column reads as "export the report", not as an oversight.
   */
  occupancyNeedsImport: number;

  /**
   * What the Occupancy pass did, or null if it failed.
   *
   * Occupancy is measured from the Nookal v2 roster (migration 031) and only for
   * weeks still fresh enough for that roster to describe them, so a month of old
   * weeks legitimately reports nothing written. Null means the pass itself threw
   * — the appointment figures above are still good, and the reason is logged.
   */
  occupancy: OccupancySyncSummary | null;
}

/**
 * Pull one month of appointments and write per-practitioner weekly figures.
 *
 * Writes total_appts, new_cases and cancelled_count, and — since migration 031 —
 * Occupancy too, for weeks recent enough that Nookal's roster still describes
 * them. Occupancy is never CLEARED here, and never overwrites a figure someone
 * typed in or imported off the report.
 */
export async function syncMonth(
  year:  number,
  month: number,
  actingUserId: string
): Promise<SyncResult> {
  const providers = await fetchProviders();
  const mapping   = await syncProviderMapping(providers);

  const { rows: mappedUsers } = await query<{ id: string; nookal_staff_id: number }>(
    `SELECT id, nookal_staff_id FROM users WHERE nookal_staff_id IS NOT NULL`
  );
  const userByStaffId = new Map<number, string>();
  for (const u of mappedUsers) userByStaffId.set(Number(u.nookal_staff_id), u.id);

  const weeks = getWeekRanges(year, month).filter((w) => w.dateFrom !== '9999-12-31');
  const dateFrom = weeks.reduce((a, w) => (w.dateFrom < a ? w.dateFrom : a), weeks[0].dateFrom);
  const dateTo   = weeks.reduce((a, w) => (w.dateTo   > a ? w.dateTo   : a), weeks[0].dateTo);

  const appts = await fetchAppointments(dateFrom, dateTo);

  const seenUnmapped = new Set<number>();
  let rowsWritten          = 0;
  let occupancyNeedsImport = 0;

  // Occupancy first, so the occupancyNeedsImport tally below counts what is
  // still missing AFTER this pass rather than before it. It is measured from a
  // different set of endpoints (getSchedules / getEvents) and is allowed to fail
  // on its own: a roster hiccup must not cost the appointment figures, which are
  // the reason someone pressed Sync.
  let occupancy: OccupancySyncSummary | null = null;
  try {
    occupancy = await syncOccupancy(year, month, actingUserId);
  } catch (e) {
    console.error(`[practitioner-stats] occupancy pass failed, appointments unaffected: ${(e as Error).message}`);
  }

  for (const w of weeks) {
    const weekNum = w.weekNum === 'remainder' ? 5 : w.weekNum;
    const perUser = new Map<string, { completed: number; cancelled: number; nc: number }>();

    for (const a of appts) {
      const day = (a.appointmentDate ?? '').slice(0, 10);
      if (!day || day < w.dateFrom || day > w.dateTo) continue;
      const pid = a.providerID;
      if (!pid) continue;

      const userId = userByStaffId.get(Number(pid));
      if (!userId) { seenUnmapped.add(Number(pid)); continue; }

      let acc = perUser.get(userId);
      if (!acc) perUser.set(userId, acc = { completed: 0, cancelled: 0, nc: 0 });

      // 'Completed' is Nookal's Completed Consults — the figure SOP step 10
      // reads off the Providers & Practice report.
      if (a.status === 'Completed') acc.completed += 1;
      if (a.status === 'Cancelled') acc.cancelled += 1;
      if (a.isNewCase)              acc.nc        += 1;
    }

    for (const [userId, v] of perUser) {
      await query(
        `INSERT INTO practitioner_week_inputs
           (clinician_id, year, month, week_num, total_appts, new_cases,
            cancelled_count, entered_by, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
         ON CONFLICT (clinician_id, year, month, week_num) DO UPDATE
            SET total_appts     = EXCLUDED.total_appts,
                new_cases       = EXCLUDED.new_cases,
                cancelled_count = EXCLUDED.cancelled_count,
                synced_at       = NOW(),
                updated_at      = NOW(),
                updated_by      = EXCLUDED.entered_by`,
        [userId, year, month, weekNum, v.completed, v.nc, v.cancelled, actingUserId]
      );
      rowsWritten += 1;

      // Counted after the occupancy pass above has had its go. A week still
      // blank here is one Nookal's roster could no longer describe, so it needs
      // the Occupancy report exported and imported, or typing in.
      const { rows: occ } = await query<{ occupancy_pct: string | null }>(
        `SELECT occupancy_pct FROM practitioner_week_inputs
          WHERE clinician_id = $1 AND year = $2 AND month = $3 AND week_num = $4`,
        [userId, year, month, weekNum]
      );
      if (occ[0]?.occupancy_pct === null || occ[0]?.occupancy_pct === undefined) {
        occupancyNeedsImport += 1;
      }
    }
  }

  return {
    year, month,
    weeksSynced:  weeks.length,
    appointments: appts.length,
    rowsWritten,
    mapping,
    unmappedProviderIds: [...seenUnmapped],
    occupancyNeedsImport,
    occupancy,
  };
}
