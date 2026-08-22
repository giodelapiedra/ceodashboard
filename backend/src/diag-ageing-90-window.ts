/**
 * Can we ask Nookal for just the last 90 days instead of paginating 10 years?
 *
 * ageing-debts.service.ts warns that `invoices(dateFrom, dateTo)` does NOT
 * filter on dateCreated (it appears to use dateModified), so a narrow window
 * might return the wrong set. This checks that:
 *
 *   - how many invoices a 90-day server-side window returns (vs 89,889 for 10y)
 *   - after our own dateCreated filter, does the total match the number the
 *     10-year pull produced ($12,631.53 clean / 135 invoices on 2026-08-11)?
 *
 * If it matches, the dashboard can fetch 90-day ageing in seconds.
 *
 * Run: npx ts-node-dev --transpile-only src/diag-ageing-90-window.ts
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
const money = (n: number) =>
  '$' + n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function isClean(i: V3InvoiceBalance): boolean {
  const bal = i.Balance ?? 0, tot = i.Total ?? 0, pmt = i.TotalPayments ?? 0;
  return i.clientID > 0 && bal > 0 && tot > 0 && bal <= tot && pmt < tot;
}
const sumBal = (rows: V3InvoiceBalance[]) => rows.reduce((s, i) => s + (i.Balance ?? 0), 0);

async function fetchInvoices(dateFrom: string, dateTo: string): Promise<V3InvoiceBalance[]> {
  const all: V3InvoiceBalance[] = [];
  let batchStart = 1;
  for (let round = 0; round < 200; round++) {
    const pages = Array.from({ length: BATCH }, (_, i) => batchStart + i);
    const results = await Promise.all(
      pages.map((p) =>
        nookalV3
          .query<InvoicesByDateBalanceResult>(INVOICES_BY_DATE_BALANCE_QUERY, {
            dateFrom, dateTo, void: 0, page: p, pageLength: PAGE_LENGTH,
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
  }
  return all;
}

async function main() {
  const today = todayAEST();
  const from90 = shiftDays(today, -90);

  console.log(`Server-side window: ${from90} → ${today}\n`);

  const t0 = Date.now();
  const raw = await fetchInvoices(from90, today);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`fetched ${raw.length} invoices in ${elapsed}s (10-year pull was 89,889)`);

  // Apply our own dateCreated cutoff, same as the service does.
  const cutoff = new Date(`${from90}T00:00:00+10:00`).getTime();
  const inWindow = raw.filter((i) => {
    const d = new Date(i.dateCreated);
    return !isNaN(d.getTime()) && d.getTime() >= cutoff;
  });
  const outOfWindow = raw.length - inWindow.length;
  console.log(`  ${inWindow.length} have dateCreated inside the window (${outOfWindow} leaked in from earlier)`);

  const withBal = inWindow.filter((i) => (i.Balance ?? 0) > 0);
  const clean = withBal.filter(isClean);

  console.log(`\n  Balance > 0 : ${withBal.length} invoices, raw ${money(sumBal(withBal))}`);
  console.log(`  clean       : ${clean.length} invoices, ${money(sumBal(clean))}`);

  console.log('\nPer clinic (clean):');
  for (const c of CLINICS) {
    const mine = clean.filter((i) => i.locationID === c.v3LocationId);
    console.log(`  ${c.name.padEnd(12)} ${String(mine.length).padStart(4)} inv  ${money(sumBal(mine))}`);
  }

  console.log('\nExpected from the 10-year pull: 135 invoices, $12,631.53');
  const match = clean.length === 135 && Math.abs(sumBal(clean) - 12631.53) < 0.01;
  console.log(match
    ? '\n>>> MATCH — the narrow server-side window is safe to use.'
    : '\n>>> MISMATCH — the narrow window drops invoices; keep the wide fetch.');
}

main().catch((err) => { console.error('\nFAILED:', err.message); process.exit(1); });
