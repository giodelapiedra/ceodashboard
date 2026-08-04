/**
 * Diagnostic: reconcile Nookal Account Credits ("Upfront Revenue") against
 * our v3 credits sum. Shows, per clinic + Overall:
 *   - total (current logic: all non-void)
 *   - total EXCLUDING fromAdjustment credits
 *   - total of voided credits (for reference)
 *
 * Run:  npx ts-node-dev --transpile-only src/diag-upfront.ts 2026 6
 */
import { CLINICS, Clinic } from './types';
import { getMonthRange } from './services/week.calculator';
import { NookalDataCache } from './services/nookal-v3/data-cache';
import { V3Credit } from './services/nookal-v3/queries';

const pad = (n: number) => String(n).padStart(2, '0');
const fmt = (n: number) => `$${n.toFixed(2)}`;
const MONTH_NUM: Record<string, number> = { Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12 };

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function dayISO(s: string | null): string | null {
  if (!s) return null;
  const m = s.match(/^\w{3}\s+(\w{3})\s+(\d{2})\s+(\d{4})/);
  return m ? `${m[3]}-${pad(MONTH_NUM[m[1]])}-${m[2]}` : null;
}

async function clinicCredits(clinic: Clinic, year: number, month: number) {
  const mr = getMonthRange(year, month);
  const cache = new NookalDataCache(addDays(mr.dateFrom, -7), addDays(mr.dateTo, +7));
  await cache.warm(clinic.v3LocationId);
  const all = await cache.credits();

  const inScope = (c: V3Credit) => {
    if (c.locationID !== clinic.v3LocationId) return false;
    const d = dayISO(c.date);
    return !!d && d >= mr.dateFrom && d <= mr.dateTo;
  };

  const nonVoid     = all.filter((c) => inScope(c) && !c.void);
  const voided      = all.filter((c) => inScope(c) && c.void);
  const positive    = nonVoid.filter((c) =>  (c.amount ?? 0) > 0);  // new logic: matches Nookal Credit column
  const adjustOnly  = nonVoid.filter((c) => c.fromAdjustment);
  const sum = (xs: V3Credit[]) => Math.round(xs.reduce((s, c) => s + (c.amount ?? 0), 0) * 100) / 100;

  return {
    name: clinic.name,
    totalAll:    sum(nonVoid),
    totalNoAdj:  sum(positive),
    adjTotal:    sum(adjustOnly),
    voidTotal:   sum(voided),
    adjCount:    adjustOnly.length,
    details: positive,
  };
}

async function main() {
  const year = Number(process.argv[2]) || 2026;
  const month = Number(process.argv[3]) || 6;
  const verbose = process.argv.includes('--verbose');

  console.log(`\n===== Account Credits reconciliation — ${pad(month)}/${year} =====`);
  console.log('clinic'.padEnd(12), 'all'.padStart(12), 'no-adjust'.padStart(12), 'adjustments'.padStart(12), 'voided'.padStart(12));

  let oAll = 0, oNo = 0, oAdj = 0;
  for (const c of CLINICS) {
    const r = await clinicCredits(c, year, month);
    oAll += r.totalAll; oNo += r.totalNoAdj; oAdj += r.adjTotal;
    console.log(
      r.name.padEnd(12),
      fmt(r.totalAll).padStart(12),
      fmt(r.totalNoAdj).padStart(12),
      `${fmt(r.adjTotal)} (${r.adjCount})`.padStart(12),
      fmt(r.voidTotal).padStart(12),
    );
    if (verbose) {
      for (const cr of r.details) {
        console.log(`     ${dayISO(cr.date)}  ${fmt(cr.amount).padStart(11)}  adj=${cr.fromAdjustment}  method=${cr.method ?? '-'}  inv=${cr.invoiceID}`);
      }
    }
  }
  console.log('-'.repeat(64));
  console.log(
    'OVERALL'.padEnd(12),
    fmt(Math.round(oAll*100)/100).padStart(12),
    fmt(Math.round(oNo*100)/100).padStart(12),
    fmt(Math.round(oAdj*100)/100).padStart(12),
  );
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
