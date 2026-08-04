/**
 * For each voided positive June credit, check if a non-voided credit
 * exists for the SAME client+location+amount. If yes → it's a corrected
 * duplicate (void=original, new=replacement). If no → Nookal UI may be
 * showing it and we're excluding it incorrectly.
 *
 * Run: npx ts-node-dev --transpile-only src/diag-void-vs-nookal.ts
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

  const june = all.filter((c) => {
    const d = dayISO(c.date);
    return !!d && d >= '2026-06-01' && d <= '2026-06-30';
  });

  const voidedPos  = june.filter((c) => c.void && (c.amount ?? 0) > 0);
  const activePos  = june.filter((c) => !c.void && (c.amount ?? 0) > 0);

  console.log(`\nJune voided positive: ${voidedPos.length}   June non-void positive: ${activePos.length}`);
  console.log('\nVoided credit → has matching non-voided replacement?');
  console.log(' clinic        creditID  clientID  amount     has-replacement?  match-creditID');
  console.log(' ' + '-'.repeat(80));

  let orphanTotal = 0;
  for (const v of voidedPos) {
    const name = knownIds.get(v.locationID) ?? `unknown(${v.locationID})`;
    // Match: same clientID, same locationID, same amount, not void
    const replacement = activePos.find(
      (a) => a.clientID === v.clientID && a.locationID === v.locationID && Math.abs((a.amount ?? 0) - (v.amount ?? 0)) < 0.01
    );
    const hasReplacement = !!replacement;
    if (!hasReplacement) orphanTotal += v.amount ?? 0;
    console.log(
      ` ${name.padEnd(12)} ${String(v.creditID).padEnd(9)} ${String(v.clientID).padEnd(9)} $${(v.amount??0).toFixed(2).padStart(8)}   ` +
      `${hasReplacement ? `YES → creditID=${replacement!.creditID}` : '❌ NO REPLACEMENT — orphan voided credit'}`
    );
  }

  console.log(`\nOrphan voided credits total: $${orphanTotal.toFixed(2)}`);
  console.log(`Missing from our dashboard:  $1341.00`);
  console.log(`Match: ${Math.abs(orphanTotal - 1341.00) < 0.01 ? '✅ YES — include orphan voided credits fixes it!' : `❌ NO (diff=$${Math.abs(orphanTotal - 1341.00).toFixed(2)})`}`);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
