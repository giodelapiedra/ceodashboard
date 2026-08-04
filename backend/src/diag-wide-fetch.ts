/**
 * Test: fetch credits with a WIDE date range (±60 days) to find credits
 * that Nookal shows in June but our ±7 day window misses.
 *
 * Run: npx ts-node-dev --transpile-only src/diag-wide-fetch.ts 2026 6
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
  const m = s.match(/^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{4})/);  // \d{1,2} handles single-digit days
  if (!m) return null;
  const mon = MONTH_NUM[m[1]];
  return mon ? `${m[3]}-${pad(mon)}-${m[2].padStart(2,'0')}` : null;
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

  // Try ±7 days (current) vs ±60 days (wide)
  const ranges = [
    { label: '±7  days (current)', from: addDays(mr.dateFrom, -7),  to: addDays(mr.dateTo, +7)  },
    { label: '±60 days (wide)',    from: addDays(mr.dateFrom, -60), to: addDays(mr.dateTo, +60) },
  ];

  for (const range of ranges) {
    console.log(`\nFetching ${range.label}: ${range.from} → ${range.to}`);
    const all = await fetchCreditsInRange(range.from, range.to);

    // Filter: non-void, positive, date in June
    const inJune = all.filter((c) => {
      if (c.void) return false;
      if ((c.amount ?? 0) <= 0) return false;
      const d = dayISO(c.date);
      return !!d && d >= mr.dateFrom && d <= mr.dateTo;
    });

    const byLoc = new Map<number, number>();
    for (const c of inJune) {
      byLoc.set(c.locationID, (byLoc.get(c.locationID) ?? 0) + (c.amount ?? 0));
    }

    const knownIds = new Map(CLINICS.map((c) => [c.v3LocationId, c.name]));
    let grand = 0;
    for (const [loc, total] of [...byLoc.entries()].sort((a, b) => a[0] - b[0])) {
      const name = knownIds.get(loc) ?? `UNKNOWN(${loc})`;
      console.log(`  ${name.padEnd(12)} ${fmt(Math.round(total*100)/100).padStart(12)}`);
      grand += total;
    }
    console.log(`  ${'TOTAL'.padEnd(12)} ${fmt(Math.round(grand*100)/100).padStart(12)}  ${Math.abs(grand - 50390.67) < 0.01 ? '✅ MATCH' : `❌ short $${(50390.67 - grand).toFixed(2)}`}`);

    // Also check: any June credits whose date string failed to parse?
    const badDate = all.filter((c) => {
      if (c.void || (c.amount ?? 0) <= 0) return false;
      return !dayISO(c.date);
    });
    if (badDate.length) {
      console.log(`  ⚠️  ${badDate.length} records with unparseable date:`);
      for (const c of badDate.slice(0, 5)) console.log(`     creditID=${c.creditID} date="${c.date}" amount=${c.amount}`);
    }
  }

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
