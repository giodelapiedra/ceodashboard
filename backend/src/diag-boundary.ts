/**
 * Check Jul 1-2 credits — UTC timezone boundary issue.
 * Run: npx ts-node-dev --transpile-only src/diag-boundary.ts
 */
import { fetchCreditsInRange } from './services/nookal-v3/fetchers';
import { CLINICS } from './types';

const pad = (n: number) => String(n).padStart(2, '0');
const MONTH_NUM: Record<string,number> = {Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12};
function dayISO(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{4})/);
  if (!m) return null;
  const mon = MONTH_NUM[m[1]];
  return mon ? `${m[3]}-${pad(mon)}-${m[2].padStart(2,'0')}` : null;
}

async function main() {
  const all = await fetchCreditsInRange('2026-01-01','2026-12-31');
  const knownIds = new Map(CLINICS.map(c=>[c.v3LocationId,c.name]));

  const boundary = all.filter(c => {
    if (c.void || (c.amount??0) <= 0) return false;
    const d = dayISO(c.date);
    return d === '2026-07-01' || d === '2026-07-02';
  });

  console.log('\nCredits with Jul 1-2 display date (UTC boundary candidates):');
  let jul1Total = 0, jul2Total = 0;
  for (const c of boundary) {
    const name = knownIds.get(c.locationID) ?? 'unknown';
    const d = dayISO(c.date)!;
    console.log(`  ${name.padEnd(10)} creditID=${c.creditID} amount=$${c.amount} date=${d} fromAdj=${c.fromAdjustment}`);
    if (d === '2026-07-01') jul1Total += c.amount ?? 0;
    else jul2Total += c.amount ?? 0;
  }

  const cur = 49049.67;
  const target = 50390.67;
  console.log(`\nJul 1 total: $${jul1Total.toFixed(2)}   Jul 2 total: $${jul2Total.toFixed(2)}`);
  console.log(`\nIf we extend month filter to include Jul 1 (UTC boundary +1 day):`);
  console.log(`  $${cur} + $${jul1Total.toFixed(2)} = $${(cur+jul1Total).toFixed(2)}   target=$${target}   match=${Math.abs(cur+jul1Total-target)<0.01?'✅ YES':'❌ NO'}`);
  console.log(`If we include Jul 1 + Jul 2:`);
  console.log(`  $${cur} + $${(jul1Total+jul2Total).toFixed(2)} = $${(cur+jul1Total+jul2Total).toFixed(2)}   match=${Math.abs(cur+jul1Total+jul2Total-target)<0.01?'✅ YES':'❌ NO'}`);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
