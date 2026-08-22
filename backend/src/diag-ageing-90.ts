/**
 * Ageing Debts — 90-day probe.
 *
 * Nookal's Ageing Debts UI report has a date filter. "90 days" can mean two
 * different things, and they give very different totals:
 *
 *   (A) DATE RANGE  — only invoices created in the last 90 days.
 *   (B) AGE BUCKET  — only invoices older than 90 days (the classic ">90" column).
 *
 * This script fetches the invoice superset once and reports BOTH, per clinic,
 * so we can see which one matches the number on screen at
 * https://auzone3.nookal.com/v2.5/reports/reports/ageing
 *
 * It also prints the RAW total (every Balance > 0, no cleanup) next to the
 * CLEAN total (the corrupted-invoice exclusions the service applies), because
 * that is the other common source of a mismatch.
 *
 * Run: npx ts-node-dev --transpile-only src/diag-ageing-90.ts
 */
import { nookalV3 } from './services/nookal-v3/client';
import {
  INVOICES_BY_DATE_BALANCE_QUERY,
  InvoicesByDateBalanceResult,
  V3InvoiceBalance,
  PAGE_LENGTH,
} from './services/nookal-v3/queries';
import { CLINICS } from './types';

const BATCH = 8;

function todayAEST(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
}

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00+10:00`);
  d.setUTCDate(d.getUTCDate() + days);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(d);
}

function ageInDays(dateCreated: string, nowMs: number): number {
  const d = new Date(dateCreated);
  if (isNaN(d.getTime())) return -1;
  return Math.floor((nowMs - d.getTime()) / 86_400_000);
}

/** Paginate the invoices query over a date window. */
async function fetchInvoices(dateFrom: string, dateTo: string): Promise<V3InvoiceBalance[]> {
  const all: V3InvoiceBalance[] = [];
  let batchStart = 1;

  for (let round = 0; round < 200; round++) {
    const pages = Array.from({ length: BATCH }, (_, i) => batchStart + i);
    const results = await Promise.all(
      pages.map((p) =>
        nookalV3
          .query<InvoicesByDateBalanceResult>(INVOICES_BY_DATE_BALANCE_QUERY, {
            dateFrom,
            dateTo,
            void: 0,
            page: p,
            pageLength: PAGE_LENGTH,
          })
          .then((r) => r.invoices ?? [])
      )
    );

    let done = false;
    for (const rows of results) {
      if (!rows.length) { done = true; break; }
      all.push(...rows);
      if (rows.length < PAGE_LENGTH) { done = true; break; }
    }
    if (done) break;
    batchStart += BATCH;
    process.stdout.write(`\r  … ${all.length} invoices fetched`);
  }
  process.stdout.write(`\r  … ${all.length} invoices fetched\n`);
  return all;
}

const money = (n: number) =>
  '$' + n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Nookal's Ageing Debts report excludes these (see ageing-debts.service.ts). */
function isClean(i: V3InvoiceBalance): boolean {
  const bal = i.Balance ?? 0;
  const tot = i.Total ?? 0;
  const pmt = i.TotalPayments ?? 0;
  return i.clientID > 0 && bal > 0 && tot > 0 && bal <= tot && pmt < tot;
}

function sumBal(rows: V3InvoiceBalance[]): number {
  return rows.reduce((s, i) => s + (i.Balance ?? 0), 0);
}

/** Print a total + per-clinic breakdown for one slice. */
function report(title: string, rows: V3InvoiceBalance[]) {
  console.log(`\n${title}`);
  console.log('  ' + '-'.repeat(66));
  console.log(
    `  ${'Clinic'.padEnd(14)} ${'Invoices'.padStart(9)} ${'CLEAN total'.padStart(16)} ${'RAW total'.padStart(16)}`
  );

  const seen = new Set<number>();
  for (const c of CLINICS) {
    seen.add(c.v3LocationId);
    const mine = rows.filter((i) => i.locationID === c.v3LocationId);
    const clean = mine.filter(isClean);
    console.log(
      `  ${c.name.padEnd(14)} ${String(clean.length).padStart(9)} ${money(sumBal(clean)).padStart(16)} ${money(sumBal(mine.filter((i) => (i.Balance ?? 0) > 0))).padStart(16)}`
    );
  }

  const other = rows.filter((i) => !seen.has(i.locationID));
  if (other.length) {
    const clean = other.filter(isClean);
    console.log(
      `  ${'(other locs)'.padEnd(14)} ${String(clean.length).padStart(9)} ${money(sumBal(clean)).padStart(16)} ${money(sumBal(other.filter((i) => (i.Balance ?? 0) > 0))).padStart(16)}`
    );
  }

  const allClean = rows.filter(isClean);
  const allRaw = rows.filter((i) => (i.Balance ?? 0) > 0);
  console.log('  ' + '-'.repeat(66));
  console.log(
    `  ${'OVERALL'.padEnd(14)} ${String(allClean.length).padStart(9)} ${money(sumBal(allClean)).padStart(16)} ${money(sumBal(allRaw)).padStart(16)}`
  );
}

async function main() {
  const today = todayAEST();
  const [y, m, d] = today.split('-');
  const tenYearsAgo = `${Number(y) - 10}-${m}-${d}`;
  const ninetyDaysAgo = shiftDays(today, -90);
  const nowMs = Date.now();

  console.log('='.repeat(70));
  console.log('AGEING DEBTS — 90-DAY PROBE');
  console.log(`Today (AEST): ${today}`);
  console.log(`90 days ago:  ${ninetyDaysAgo}`);
  console.log('='.repeat(70));

  // One 10-year fetch gives us the full superset; we slice it locally.
  console.log(`\nFetching invoices ${tenYearsAgo} → ${today} (void=0) …`);
  const raw = await fetchInvoices(tenYearsAgo, today);

  // Nookal's dateFrom/dateTo on `invoices` does not filter by dateCreated,
  // so trim to the 10-year window ourselves.
  const cutoff10y = new Date(`${tenYearsAgo}T00:00:00+10:00`).getTime();
  const pool = raw.filter((i) => {
    const dt = new Date(i.dateCreated);
    return !isNaN(dt.getTime()) && dt.getTime() >= cutoff10y;
  });
  console.log(`  ${raw.length} fetched → ${pool.length} inside the 10-year window`);

  const withBal = pool.filter((i) => (i.Balance ?? 0) > 0);
  console.log(`  ${withBal.length} of those have Balance > 0`);

  // ── What the dashboard shows today (10-year, all ages) ──
  report('1) ALL TIME (10 years) — what the CEO dashboard currently shows', withBal);

  // ── (A) date-range reading: invoices created in the last 90 days ──
  const cutoff90 = new Date(`${ninetyDaysAgo}T00:00:00+10:00`).getTime();
  const last90 = withBal.filter((i) => {
    const dt = new Date(i.dateCreated);
    return !isNaN(dt.getTime()) && dt.getTime() >= cutoff90;
  });
  report(`2) DATE RANGE — invoices CREATED in the last 90 days (${ninetyDaysAgo} → ${today})`, last90);

  // ── (B) age-bucket reading: debt older than 90 days ──
  const over90 = withBal.filter((i) => ageInDays(i.dateCreated, nowMs) > 90);
  report('3) AGE BUCKET — debt OLDER than 90 days (the classic ">90 days" column)', over90);

  // ── Full ageing ladder, clean only, overall ──
  const clean = withBal.filter(isClean);
  const buckets = { d0_30: 0, d31_60: 0, d61_90: 0, d90p: 0 };
  const counts = { d0_30: 0, d31_60: 0, d61_90: 0, d90p: 0 };
  for (const i of clean) {
    const bal = i.Balance ?? 0;
    const age = ageInDays(i.dateCreated, nowMs);
    if (age <= 30) { buckets.d0_30 += bal; counts.d0_30++; }
    else if (age <= 60) { buckets.d31_60 += bal; counts.d31_60++; }
    else if (age <= 90) { buckets.d61_90 += bal; counts.d61_90++; }
    else { buckets.d90p += bal; counts.d90p++; }
  }
  console.log('\n4) AGEING LADDER (clean invoices, all clinics)');
  console.log('  ' + '-'.repeat(66));
  console.log(`  ${'0–30 days'.padEnd(14)} ${String(counts.d0_30).padStart(9)} ${money(buckets.d0_30).padStart(16)}`);
  console.log(`  ${'31–60 days'.padEnd(14)} ${String(counts.d31_60).padStart(9)} ${money(buckets.d31_60).padStart(16)}`);
  console.log(`  ${'61–90 days'.padEnd(14)} ${String(counts.d61_90).padStart(9)} ${money(buckets.d61_90).padStart(16)}`);
  console.log(`  ${'90+ days'.padEnd(14)} ${String(counts.d90p).padStart(9)} ${money(buckets.d90p).padStart(16)}`);
  console.log('  ' + '-'.repeat(66));
  console.log(`  ${'TOTAL'.padEnd(14)} ${String(clean.length).padStart(9)} ${money(sumBal(clean)).padStart(16)}`);

  // ── Patient-direct vs third-party, since Nookal splits these ──
  const direct = clean.filter((i) => i.isThirdPartyInvoice === 0);
  const third = clean.filter((i) => i.isThirdPartyInvoice !== 0);
  console.log('\n5) SPLIT — patient-direct vs third-party/insurance (clean, all time)');
  console.log(`  patient-direct : ${String(direct.length).padStart(5)} inv  ${money(sumBal(direct))}`);
  console.log(`  third-party    : ${String(third.length).padStart(5)} inv  ${money(sumBal(third))}`);

  console.log('\nCompare these against your Nookal screen and tell me which row matches.\n');
}

main().catch((err) => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
