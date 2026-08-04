/**
 * Check if the missing $1,341 is in payments (not credits) for June 2026.
 * Looks for payments on invoices where the invoice is a "credit" type.
 * Run: npx ts-node-dev --transpile-only src/diag-payments-check.ts
 */
import { nookalV3 } from './services/nookal-v3/client';
import { CLINICS } from './types';

const PAYMENTS_QUERY = `
  query Payments($dateFrom: String!, $dateTo: String!, $page: Int!, $pageLength: Int!) {
    payments(dateFrom: $dateFrom, dateTo: $dateTo, page: $page, pageLength: $pageLength) {
      paymentID
      locationID
      method
      amount
      date
      active
      invoiceID
      clientID
    }
  }
`;

// Also check what ALL 226 credits look like — dump any with unusual void/fromAdjustment
const CREDITS_ALL_FLAGS = `
  query AllCredits($dateFrom: String!, $dateTo: String!, $page: Int!, $pageLength: Int!) {
    credits(dateFrom: $dateFrom, dateTo: $dateTo, page: $page, pageLength: $pageLength) {
      creditID locationID clientID amount date void fromAdjustment invoiceID method
    }
  }
`;

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
const PAGE = 200;
async function paginate<T>(fetchPage: (p: number) => Promise<T[]>): Promise<T[]> {
  const all: T[] = [];
  for (let p = 1; p <= 100; p++) {
    const rows = await fetchPage(p);
    if (!rows?.length) break;
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

async function main() {
  const knownIds = new Map(CLINICS.map((c) => [c.v3LocationId, c.name]));

  // ── 1. All credits full year — show ALL voided/negative ones with June date ──
  console.log('\n=== FULL YEAR CREDITS — ALL FLAGS (looking for hidden June records) ===');
  const allCredits: any[] = await paginate((p) =>
    nookalV3.query<any>(CREDITS_ALL_FLAGS, { dateFrom: '2026-01-01', dateTo: '2026-12-31', page: p, pageLength: PAGE })
      .then((d: any) => d.credits ?? [])
  );

  const juneAll = allCredits.filter((c) => {
    const d = dayISO(c.date);
    return !!d && d >= '2026-06-01' && d <= '2026-06-30';
  });

  console.log(`Total credits in full year: ${allCredits.length}`);
  console.log(`Credits with June display date (ALL, incl void/negative): ${juneAll.length}`);
  let juneAllTotal = 0;
  const byFlag: Record<string, number> = {};
  for (const c of juneAll) {
    const key = `void=${c.void} fromAdj=${c.fromAdjustment} amount>0=${(c.amount??0)>0}`;
    byFlag[key] = (byFlag[key] ?? 0) + (c.amount ?? 0);
    if ((c.amount ?? 0) > 0 && !c.void) juneAllTotal += c.amount;
  }
  console.log('Breakdown by flags:');
  for (const [k, v] of Object.entries(byFlag)) console.log(`  ${k}: $${v.toFixed(2)}`);
  console.log(`\nPositive non-void June credits total: $${juneAllTotal.toFixed(2)} (current $49049.67)`);

  // Show the amount breakdown to spot the missing $670.50
  const pos = juneAll.filter((c) => (c.amount ?? 0) > 0 && !c.void);
  const amounts = new Map<number, number>();
  for (const c of pos) amounts.set(c.amount, (amounts.get(c.amount) ?? 0) + 1);
  console.log('\nCredit amounts breakdown:');
  for (const [amt, cnt] of [...amounts.entries()].sort((a, b) => b[0] - a[0])) {
    console.log(`  $${amt.toFixed(2)} × ${cnt} = $${(amt * cnt).toFixed(2)}`);
  }

  // ── 2. Payments for June — find any that are account credit type ──────────
  console.log('\n=== JUNE PAYMENTS (checking for account credit payments) ===');
  const payments: any[] = await paginate((p) =>
    nookalV3.query<any>(PAYMENTS_QUERY, {
      dateFrom: '2026-06-01', dateTo: '2026-06-30', page: p, pageLength: PAGE,
    }).then((d: any) => d.payments ?? [])
  );

  const activePay = payments.filter((p) => p.active && (p.amount ?? 0) > 0);
  const byLoc = new Map<number, number>();
  for (const p of activePay) byLoc.set(p.locationID, (byLoc.get(p.locationID) ?? 0) + (p.amount ?? 0));

  console.log(`Active positive payments in June: ${activePay.length}`);
  let payTotal = 0;
  for (const [loc, total] of [...byLoc.entries()].sort()) {
    const name = knownIds.get(loc) ?? `unknown(${loc})`;
    console.log(`  ${name.padEnd(12)} $${total.toFixed(2)}`);
    payTotal += total;
  }
  console.log(`  TOTAL: $${payTotal.toFixed(2)}`);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
