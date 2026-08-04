/**
 * Find all locationIDs present in credits for a month.
 * Tells us which IDs to add to CLINICS config.
 *
 * Run: npx ts-node-dev --transpile-only src/diag-credit-locations.ts 2026 6
 */
import { CLINICS } from './types';
import { getMonthRange } from './services/week.calculator';
import { fetchCreditsInRange } from './services/nookal-v3/fetchers';

const pad = (n: number) => String(n).padStart(2, '0');
const fmt = (n: number) => `$${n.toFixed(2)}`;
const MONTH_NUM: Record<string, number> = {
  Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12,
};
function dayISO(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/^\w{3}\s+(\w{3})\s+(\d{2})\s+(\d{4})/);
  return m ? `${m[3]}-${pad(MONTH_NUM[m[1]])}-${m[2]}` : null;
}
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const year  = Number(process.argv[2]) || 2026;
  const month = Number(process.argv[3]) || 6;
  const mr    = getMonthRange(year, month);

  console.log(`\nFetching ALL credits for ${pad(month)}/${year}...`);
  const all = await fetchCreditsInRange(addDays(mr.dateFrom, -7), addDays(mr.dateTo, +7));

  // Filter to this month, non-void, positive amount only
  const inScope = all.filter((c) => {
    if (c.void) return false;
    if ((c.amount ?? 0) <= 0) return false;
    const d = dayISO(c.date);
    return !!d && d >= mr.dateFrom && d <= mr.dateTo;
  });

  // Group by locationID
  const byLoc = new Map<number, { count: number; total: number }>();
  for (const c of inScope) {
    const entry = byLoc.get(c.locationID) ?? { count: 0, total: 0 };
    entry.count++;
    entry.total += c.amount ?? 0;
    byLoc.set(c.locationID, entry);
  }

  const knownIds = new Map(CLINICS.map((c) => [c.v3LocationId, c.name]));

  console.log('\n locationID   clinic name        count   total');
  console.log(' ' + '-'.repeat(55));

  let grandTotal = 0;
  for (const [locId, { count, total }] of [...byLoc.entries()].sort((a, b) => a[0] - b[0])) {
    const name = knownIds.get(locId) ?? '⚠️  UNKNOWN — add this to config!';
    console.log(
      ` ${String(locId).padEnd(12)} ${name.padEnd(18)} ${String(count).padStart(5)}   ${fmt(Math.round(total * 100) / 100).padStart(12)}`
    );
    grandTotal += total;
  }

  console.log(' ' + '-'.repeat(55));
  console.log(` ${'TOTAL'.padEnd(30)} ${fmt(Math.round(grandTotal * 100) / 100).padStart(18)}`);
  console.log(`\n Nookal Credit total should be: $50,390.67`);
  console.log(` Our total:                      ${fmt(Math.round(grandTotal * 100) / 100)}`);
  console.log(` Match: ${Math.abs(grandTotal - 50390.67) < 0.01 ? '✅ YES' : '❌ NO — unknown location IDs above account for the gap'}`);

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
