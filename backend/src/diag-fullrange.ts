/**
 * Fetch ALL credits Jan→Jun 2026, filter for June display-date.
 * Finds credits that have a June date but were created far outside ±60 days.
 *
 * Run: npx ts-node-dev --transpile-only src/diag-fullrange.ts
 */
import { CLINICS } from './types';
import { getMonthRange } from './services/week.calculator';
import { fetchCreditsInRange } from './services/nookal-v3/fetchers';
import { V3Credit } from './services/nookal-v3/queries';

const pad = (n: number) => String(n).padStart(2, '0');
const fmt = (n: number) => `$${n.toFixed(2)}`;
const MONTH_NUM: Record<string, number> = {
  Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12,
};
function dayISO(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{4})/);
  if (!m) return null;
  const mon = MONTH_NUM[m[1]];
  return mon ? `${m[3]}-${pad(mon)}-${m[2].padStart(2,'0')}` : null;
}

async function main() {
  const mr = getMonthRange(2026, 6);

  // Fetch Jan 1 → Jun 30 (entire H1 2026)
  console.log('\nFetching 2026-01-01 → 2026-06-30 (full H1)...');
  const h1 = await fetchCreditsInRange('2026-01-01', '2026-06-30');

  // Filter: non-void, positive, display date in June
  const juneFromH1 = h1.filter((c) => {
    if (c.void) return false;
    if ((c.amount ?? 0) <= 0) return false;
    const d = dayISO(c.date);
    return !!d && d >= mr.dateFrom && d <= mr.dateTo;
  });

  const knownIds = new Map(CLINICS.map((c) => [c.v3LocationId, c.name]));
  const byLoc = new Map<number, { total: number; credits: V3Credit[] }>();
  for (const c of juneFromH1) {
    const e = byLoc.get(c.locationID) ?? { total: 0, credits: [] };
    e.total += c.amount ?? 0;
    e.credits.push(c);
    byLoc.set(c.locationID, e);
  }

  let grand = 0;
  console.log('\n locationID   clinic           count        total');
  console.log(' ' + '-'.repeat(55));
  for (const [loc, { total, credits }] of [...byLoc.entries()].sort((a,b)=>a[0]-b[0])) {
    const name = knownIds.get(loc) ?? `UNKNOWN(${loc})`;
    console.log(` ${String(loc).padEnd(12)} ${name.padEnd(16)} ${String(credits.length).padStart(5)}   ${fmt(Math.round(total*100)/100).padStart(12)}`);
    grand += total;
  }
  console.log(' ' + '-'.repeat(55));
  console.log(` ${'TOTAL'.padEnd(28)} ${fmt(Math.round(grand*100)/100).padStart(12)}  ${Math.abs(grand - 50390.67) < 0.01 ? '✅ MATCH' : `❌ short $${(50390.67 - grand).toFixed(2)}`}`);

  // Show any credits whose display-date is in June but were outside ±60 day window
  const narrowStart = '2026-04-02', narrowEnd = '2026-08-29';
  const outsideNarrow = h1.filter((c) => {
    if (c.void || (c.amount ?? 0) <= 0) return false;
    const d = dayISO(c.date);
    if (!d || d < mr.dateFrom || d > mr.dateTo) return false;
    // Check if this credit's DATE would have been outside ±60 day API window
    // (meaning it was fetched now only because we widened to the full H1)
    // We detect by checking if it appears in the narrow result
    return true; // we'll compare counts
  });
  console.log(`\nTotal June credits found in H1 fetch: ${outsideNarrow.length}`);
  console.log(`vs ±60-day fetch:                    check if numbers differ above vs previous run`);

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
