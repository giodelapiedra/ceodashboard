/**
 * Check voided-but-positive credits in June 2026 by clinic.
 * Nookal UI may show these in the "Credit" column even though void=1 in v3.
 * Run: npx ts-node-dev --transpile-only src/diag-voided.ts
 */
import { fetchCreditsInRange } from './services/nookal-v3/fetchers';
import { CLINICS } from './types';

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
  const all = await fetchCreditsInRange('2026-01-01', '2026-12-31');
  const knownIds = new Map(CLINICS.map((c) => [c.v3LocationId, c.name]));

  // June-display, positive, VOIDED
  const voidedPos = all.filter((c) => {
    if (!c.void) return false;
    if ((c.amount ?? 0) <= 0) return false;
    const d = dayISO(c.date);
    return !!d && d >= '2026-06-01' && d <= '2026-06-30';
  });

  console.log(`\nVoided positive June credits: ${voidedPos.length}  total=$${voidedPos.reduce((s,c)=>s+(c.amount??0),0).toFixed(2)}`);
  console.log('\n clinic        creditID   clientID   invoiceID   amount      fromAdj');
  console.log(' ' + '-'.repeat(70));

  const byLoc = new Map<number, number>();
  for (const c of voidedPos.sort((a,b)=>a.locationID-b.locationID)) {
    const name = knownIds.get(c.locationID) ?? `unknown(${c.locationID})`;
    byLoc.set(c.locationID, (byLoc.get(c.locationID) ?? 0) + (c.amount ?? 0));
    console.log(` ${name.padEnd(12)} ${String(c.creditID).padEnd(10)} ${String(c.clientID).padEnd(10)} ${String(c.invoiceID).padEnd(11)} $${(c.amount??0).toFixed(2).padStart(9)}   adj=${c.fromAdjustment}  date=${dayISO(c.date)}`);
  }

  console.log('\nPer clinic totals:');
  let grand = 0;
  for (const [loc, total] of byLoc) {
    console.log(`  ${(knownIds.get(loc) ?? `unknown(${loc})`).padEnd(12)} $${total.toFixed(2)}`);
    grand += total;
  }
  console.log(`  TOTAL voided  $${grand.toFixed(2)}`);

  const missing = 50390.67 - 49049.67;
  console.log(`\nMissing from our total: $${missing.toFixed(2)}`);
  console.log(`If we include ONLY these voided credits that are in our 3 clinics, does it = $${missing.toFixed(2)}?`);

  const our3 = voidedPos.filter((c) => knownIds.has(c.locationID));
  const our3Total = our3.reduce((s,c)=>s+(c.amount??0),0);
  console.log(`Voided credits in our 3 clinics total: $${our3Total.toFixed(2)}`);
  console.log(`Match: ${Math.abs(our3Total - missing) < 0.01 ? '✅ YES — include voided credits is the fix!' : '❌ NO'}`);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
