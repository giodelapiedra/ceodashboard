/**
 * Final diagnostic — search across ALL of 2026 for replacements of
 * the 2 orphan voided June credits, then check if Newport missing
 * $670.50 exists anywhere in the API under any date.
 *
 * Run: npx ts-node-dev --transpile-only src/diag-final.ts
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

// Known orphan voided credits from previous diagnostic
const ORPHANS = [
  { creditID: 1859, clientID: 95554, locationID: 6, amount: 134.00,  clinic: 'Brookvale', date: '2026-06-15' },
  { creditID: 1904, clientID: 95306, locationID: 2, amount: 670.50,  clinic: 'Narrabeen', date: '2026-06-25' },
];

async function main() {
  const all = await fetchCreditsInRange('2026-01-01', '2026-12-31');
  const knownIds = new Map(CLINICS.map((c) => [c.v3LocationId, c.name]));

  console.log('\n=== ORPHAN VOIDED CREDITS — searching for replacements in ALL of 2026 ===\n');

  let orphanMissingTotal = 0;
  for (const orphan of ORPHANS) {
    // Look for non-voided credit for same client+location (any amount, any date in 2026)
    const replacements = all.filter(
      (c) => !c.void && c.clientID === orphan.clientID && c.locationID === orphan.locationID && (c.amount ?? 0) > 0
    );
    console.log(`${orphan.clinic} clientID=${orphan.clientID} amount=$${orphan.amount} date=${orphan.date}`);
    if (replacements.length === 0) {
      console.log(`  → ❌ NO non-void replacement found anywhere in 2026. This is a true orphan.`);
      orphanMissingTotal += orphan.amount;
    } else {
      for (const r of replacements) {
        console.log(`  → replacement: creditID=${r.creditID} amount=$${r.amount} date=${dayISO(r.date)} fromAdj=${r.fromAdjustment}`);
      }
    }
  }
  console.log(`\nOrphans with no replacement: $${orphanMissingTotal.toFixed(2)}`);

  // ── Newport missing $670.50 — does this clientID exist at all? ───────────
  console.log('\n=== NEWPORT missing $670.50 — searching all credits for any Newport $670.50 ===');
  const newportLocation = CLINICS.find(c => c.id === 'newport')!.v3LocationId;
  const newportAll670 = all.filter(
    (c) => c.locationID === newportLocation && Math.abs((c.amount ?? 0) - 670.50) < 0.01
  );
  console.log(`Total Newport credits of $670.50 in full year: ${newportAll670.length}`);
  for (const c of newportAll670) {
    console.log(`  creditID=${c.creditID} clientID=${c.clientID} date=${dayISO(c.date)} void=${c.void} fromAdj=${c.fromAdjustment}`);
  }

  // Count June non-void Newport $670.50
  const juneNewport670 = newportAll670.filter((c) => {
    if (c.void) return false;
    const d = dayISO(c.date);
    return !!d && d >= '2026-06-01' && d <= '2026-06-30';
  });
  console.log(`\nNewport non-void $670.50 credits in June: ${juneNewport670.length} (Nookal shows 8 clients @ $670.50 in Newport)`);
  console.log(`If Nookal shows 8 but we have ${juneNewport670.length}, we're missing ${8 - juneNewport670.length} record(s).`);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
