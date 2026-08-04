/**
 * Fetch full year 2026, find all June-display-date credits.
 * Run: npx ts-node-dev --transpile-only src/diag-fullyear.ts
 */
import { CLINICS } from './types';
import { fetchCreditsInRange } from './services/nookal-v3/fetchers';

const pad = (n: number) => String(n).padStart(2, '0');
const MONTH_NUM: Record<string, number> = {
  Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12,
};
function dayISO(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{4})/);
  if (!m) return null;
  const mon = MONTH_NUM[m[1]];
  return mon ? `${m[3]}-${pad(mon)}-${m[2].padStart(2, '0')}` : null;
}

async function main() {
  console.log('\nFetching full year 2026-01-01 → 2026-12-31...');
  const all = await fetchCreditsInRange('2026-01-01', '2026-12-31');
  console.log(`Total records in API response: ${all.length}`);

  const june = all.filter((c) => {
    if (c.void) return false;
    if ((c.amount ?? 0) <= 0) return false;
    const d = dayISO(c.date);
    return !!d && d >= '2026-06-01' && d <= '2026-06-30';
  });

  const knownIds = new Map(CLINICS.map((c) => [c.v3LocationId, c.name]));
  const byLoc = new Map<number, number>();
  for (const c of june) byLoc.set(c.locationID, (byLoc.get(c.locationID) ?? 0) + (c.amount ?? 0));

  let grand = 0;
  console.log('\n clinic        total');
  for (const [loc, total] of [...byLoc.entries()].sort((a,b)=>a[0]-b[0])) {
    const name = knownIds.get(loc) ?? `UNKNOWN(${loc})`;
    console.log(` ${name.padEnd(12)} $${Math.round(total*100)/100}`);
    grand += total;
  }
  console.log(` ${'TOTAL'.padEnd(12)} $${Math.round(grand*100)/100}`);
  console.log(` Nookal target: $50,390.67`);
  console.log(` Match: ${Math.abs(grand - 50390.67) < 0.01 ? '✅ YES' : `❌ short $${(50390.67 - grand).toFixed(2)}`}`);
  console.log(`\nJune credit count: ${june.length}`);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
