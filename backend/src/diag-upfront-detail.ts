/**
 * Detailed upfront revenue diagnostic.
 * Dumps ALL credits from Nookal for a month, grouped per clinic,
 * so you can compare line-by-line with the Nookal Account Credits UI.
 *
 * Run:
 *   npx ts-node-dev --transpile-only src/diag-upfront-detail.ts 2026 6
 *   npx ts-node-dev --transpile-only src/diag-upfront-detail.ts 2026 6 --all-clinics
 */
import { CLINICS, Clinic } from './types';
import { getMonthRange } from './services/week.calculator';
import { NookalDataCache } from './services/nookal-v3/data-cache';
import { V3Credit } from './services/nookal-v3/queries';

const pad  = (n: number) => String(n).padStart(2, '0');
const fmt  = (n: number) => `$${n.toFixed(2).padStart(12)}`;
const MONTH_NUM: Record<string, number> = {
  Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,
  Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12,
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
const sum = (xs: V3Credit[]) =>
  Math.round(xs.reduce((s, c) => s + (c.amount ?? 0), 0) * 100) / 100;

async function run() {
  const year  = Number(process.argv[2]) || 2026;
  const month = Number(process.argv[3]) || 6;
  const allClinics = process.argv.includes('--all-clinics');

  const mr = getMonthRange(year, month);
  console.log(`\n===== Nookal Account Credits: ${pad(month)}/${year}  (${mr.dateFrom} → ${mr.dateTo}) =====\n`);

  // One shared fetch for ALL locations — same as the dashboard does.
  const cache = new NookalDataCache(addDays(mr.dateFrom, -7), addDays(mr.dateTo, +7));
  // Warm credits only (no location filter needed).
  const allCredits = await cache.credits();

  // ── filter to this month only (no location filter yet) ──────────
  const inMonth = allCredits.filter((c) => {
    const d = dayISO(c.date);
    return !!d && d >= mr.dateFrom && d <= mr.dateTo;
  });

  // ── overall breakdown (ALL locations) ───────────────────────────
  const nonVoid    = inMonth.filter((c) => !c.void);
  const voided     = inMonth.filter((c) =>  c.void);
  const noAdj      = nonVoid.filter((c) => !c.fromAdjustment);
  const adjOnly    = nonVoid.filter((c) =>  c.fromAdjustment);

  console.log('=== ALL LOCATIONS COMBINED (matches Nookal UI if no clinic filter set) ===');
  console.log(`  Non-void total (incl. fromAdjustment) : ${fmt(sum(nonVoid))}  ← compare with Nookal "All locations"`);
  console.log(`  Non-void excl. fromAdjustment         : ${fmt(sum(noAdj))}   ← what we currently report`);
  console.log(`  fromAdjustment records only           : ${fmt(sum(adjOnly))}  (${adjOnly.length} records)`);
  console.log(`  Voided total                          : ${fmt(sum(voided))}`);
  console.log('');

  // ── per-clinic breakdown ─────────────────────────────────────────
  for (const clinic of CLINICS) {
    const loc = clinic.v3LocationId;
    const cNonVoid = nonVoid.filter((c) => c.locationID === loc);
    const cNoAdj   = cNonVoid.filter((c) => !c.fromAdjustment);
    const cAdj     = cNonVoid.filter((c) =>  c.fromAdjustment);
    const cVoid    = voided.filter((c)   => c.locationID === loc);

    console.log(`=== ${clinic.name.toUpperCase()} (locationID=${loc}) ===`);
    console.log(`  Non-void total (incl. fromAdjustment) : ${fmt(sum(cNonVoid))}  ← compare with Nookal filtered to ${clinic.name}`);
    console.log(`  Non-void excl. fromAdjustment         : ${fmt(sum(cNoAdj))}   ← what we currently report`);
    console.log(`  fromAdjustment records                : ${fmt(sum(cAdj))}  (${cAdj.length} records)`);
    console.log(`  Voided records                        : ${fmt(sum(cVoid))}`);
    console.log('');

    // Print every non-void credit detail for this clinic
    console.log(`  ${'Date'.padEnd(12)} ${'CreditID'.padEnd(10)} ${'ClientID'.padEnd(10)} ${'InvoiceID'.padEnd(10)} ${'Amount'.padStart(10)} ${'Method'.padEnd(18)} fromAdj  void`);
    console.log(`  ${'-'.repeat(90)}`);
    for (const c of cNonVoid.sort((a, b) => (dayISO(a.date) ?? '') < (dayISO(b.date) ?? '') ? -1 : 1)) {
      const d   = dayISO(c.date) ?? c.date;
      const adj = c.fromAdjustment ? '  YES  ' : '  no   ';
      const v   = c.void           ? 'YES'     : 'no ';
      console.log(
        `  ${d.padEnd(12)} ${String(c.creditID).padEnd(10)} ${String(c.clientID).padEnd(10)} ` +
        `${String(c.invoiceID).padEnd(10)} ${fmt(c.amount ?? 0).padStart(10)} ` +
        `${(c.method ?? '-').padEnd(18)} ${adj}  ${v}`,
      );
    }

    if (allClinics || CLINICS.indexOf(clinic) < CLINICS.length - 1) {
      console.log('');
    }
  }

  // ── unknown location records ─────────────────────────────────────
  const knownLocs = new Set(CLINICS.map((c) => c.v3LocationId));
  const unknown = nonVoid.filter((c) => !knownLocs.has(c.locationID));
  if (unknown.length) {
    const byLoc = new Map<number, V3Credit[]>();
    for (const c of unknown) {
      const arr = byLoc.get(c.locationID) ?? [];
      arr.push(c);
      byLoc.set(c.locationID, arr);
    }
    console.log('=== ⚠️  UNKNOWN LOCATION IDs (not in CLINICS config) ===');
    for (const [loc, recs] of byLoc) {
      console.log(`  locationID=${loc}  count=${recs.length}  total=${fmt(sum(recs))}`);
    }
    console.log('');
  }

  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
