/**
 * Ageing Debts Service
 *
 * Fetches ALL non-voided invoices with an outstanding balance (Balance > 0)
 * from Nookal v3 GraphQL using a rolling 10-year window (today − 10 years →
 * today), matching Nookal's own "10 Years" date preset. Optionally filtered
 * by location. Returns a total + age-bucket breakdown.
 *
 * This is a point-in-time snapshot — the same total appears across all weeks
 * in the CEO dashboard. Results are cached in-memory for 4 hours to avoid
 * paginating years of invoices on every dashboard load.
 */

import { nookalV3 } from './nookal-v3/client';
import {
  INVOICES_BY_DATE_BALANCE_QUERY,
  InvoicesByDateBalanceResult,
  V3InvoiceBalance,
  PAGE_LENGTH,
} from './nookal-v3/queries';

export interface AgeingBuckets {
  d0_30:  number;   // 0–30 days
  d31_60: number;   // 31–60 days
  d61_90: number;   // 61–90 days
  d90p:   number;   // > 90 days
}

export interface AgeingDebtsResult {
  total:     number;
  buckets:   AgeingBuckets;
  fetchedAt: string;
  fromCache: boolean;
}

// ── In-memory cache: keyed by sorted locationID list (or "all") ──
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

interface CacheEntry {
  result: AgeingDebtsResult;
  at:     number;
}
const _cache = new Map<string, CacheEntry>();

function cacheKey(locationIDs?: number[]): string {
  if (!locationIDs?.length) return 'all';
  return [...locationIDs].sort((a, b) => a - b).join(',');
}

// ── Date parsing ─────────────────────────────────────────────────
// Nookal v3 dateCreated: "Wed Jan 03 2024 10:00:00 GMT+1000 (AEST)"
// new Date() handles this format natively in Node.
function ageInDays(dateCreated: string): number {
  const d = new Date(dateCreated);
  if (isNaN(d.getTime())) return 0;
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

// ── Parallel-batch pagination ────────────────────────────────────
const BATCH = 8; // 8 concurrent page requests per round

/** Returns today's date string in AEST/AEDT (Australia/Sydney) as YYYY-MM-DD.
 *  Using UTC (new Date().toISOString()) is wrong because AEST = UTC+10/+11,
 *  so before 10:00 AEST the UTC date is still yesterday — off by 1 day vs
 *  Nookal's date filters which run in Sydney time.
 */
function todayAEST(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' })
    .format(new Date()); // en-CA gives YYYY-MM-DD
}

async function fetchAllInvoices(locationIDs?: number[]): Promise<V3InvoiceBalance[]> {
  // Use AEST date to match Nookal's "10 Years" preset exactly.
  const today    = todayAEST();                          // e.g. "2026-05-26"
  const [y, m, d] = today.split('-').map(Number);
  const dateFrom = `${y - 10}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; // "2016-05-26"
  const dateTo   = today;
  const locArgs  = locationIDs?.length ? locationIDs : undefined;

  console.log(`[ageing-debts] date range: ${dateFrom} → ${dateTo} | locationIDs: ${locArgs ?? 'all'}`);

  const all: V3InvoiceBalance[] = [];
  let batchStart = 1;

  for (let round = 0; round < 100; round++) {
    const pages  = Array.from({ length: BATCH }, (_, i) => batchStart + i);
    const results = await Promise.all(
      pages.map((p) =>
        nookalV3.query<InvoicesByDateBalanceResult>(
          INVOICES_BY_DATE_BALANCE_QUERY,
          {
            dateFrom,
            dateTo,
            ...(locArgs ? { locationIDs: locArgs } : {}),
            void:       0,
            page:       p,
            pageLength: PAGE_LENGTH,
          }
        ).then((r) => r.invoices ?? [])
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

  // The Nookal `invoices` query's dateFrom/dateTo does NOT filter by
  // dateCreated — it appears to use a different date field (e.g. dateModified),
  // so very old invoices with recent activity sneak in. Apply the cutoff
  // ourselves using the dateCreated field so our total matches Nookal's
  // "10 Years" Ageing Debts UI report.
  // Use AEST midnight for the cutoff so it aligns with Nookal's date boundaries.
  const cutoffMs = new Date(`${dateFrom}T00:00:00+10:00`).getTime();
  const beforeFilter = all.length;
  const filtered = all.filter(inv => {
    const d = new Date(inv.dateCreated);
    return !isNaN(d.getTime()) && d.getTime() >= cutoffMs;
  });
  if (filtered.length !== beforeFilter) {
    console.log(`[ageing-debts] client-side dateCreated filter: ${beforeFilter} → ${filtered.length} (removed ${beforeFilter - filtered.length} pre-cutoff invoices)`);
  }

  return filtered;
}

// ── Main service ─────────────────────────────────────────────────
export const ageingDebtsService = {
  async get(locationIDs?: number[], forceRefresh = false): Promise<AgeingDebtsResult> {
    const key    = cacheKey(locationIDs);
    const cached = _cache.get(key);

    if (!forceRefresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return { ...cached.result, fromCache: true };
    }

    console.log(`[ageing-debts] fetching (locationIDs=${key}) …`);
    const invoices = await fetchAllInvoices(locationIDs);

    // ── Exclude corrupted invoices — three classes of bad data that Nookal's
    // Ageing Debts report also excludes:
    //
    //  1. Total ≤ 0         → invoice was never completed (e.g. DNA/cancellation
    //                          fee entered but amount never set). Balance can show
    //                          a phantom amount (e.g. $200) with nothing actually owed.
    //
    //  2. Balance > Total   → accounting anomaly (reversed payment, misapplied
    //                          credit, or adjustment). Balance has drifted above
    //                          the invoice face value — invalid for debt reporting.
    //
    //  3. TotalPayments ≥ Total → invoice is fully paid (or overpaid), yet Balance
    //                              still shows a phantom positive amount due to
    //                              rounding or a misapplied credit reversal. These
    //                              should net to zero.
    //
    // All three produce inflated totals that don't match Nookal's UI report.
    const excluded = invoices.filter(i => {
      const bal = i.Balance       ?? 0;
      const tot = i.Total         ?? 0;
      const pmt = i.TotalPayments ?? 0;
      return bal > 0 && (tot <= 0 || bal > tot || pmt >= tot);
    });
    if (excluded.length) {
      const phantom  = excluded.reduce((s, i) => s + (i.Balance ?? 0), 0);
      const zeroTot  = excluded.filter(i => (i.Total ?? 0) <= 0).length;
      const balGtTot = excluded.filter(i => (i.Total ?? 0) > 0 && (i.Balance ?? 0) > (i.Total ?? 0)).length;
      const paidFull = excluded.filter(i => (i.Total ?? 0) > 0 && (i.Balance ?? 0) <= (i.Total ?? 0) && (i.TotalPayments ?? 0) >= (i.Total ?? 0)).length;
      console.log(`[ageing-debts] excluded ${excluded.length} corrupted invoices (${zeroTot} Total≤0, ${balGtTot} Bal>Total, ${paidFull} paid-in-full) — phantom $${phantom.toFixed(2)}`);
    }

    const withBalance = invoices.filter(i => {
      const bal = i.Balance       ?? 0;
      const tot = i.Total         ?? 0;
      const pmt = i.TotalPayments ?? 0;
      // clientID = 0 means the client was deleted — orphaned invoices that
      // Nookal's Ageing Debts report excludes automatically.
      return i.clientID > 0 && bal > 0 && tot > 0 && bal <= tot && pmt < tot;
    });

    // ── Debug breakdown: patient-direct vs third-party (insurance) invoices.
    // Nookal's "Ageing Debts" report may count these differently — log both
    // so we can compare against the UI report if a discrepancy is reported.
    const directInvoices     = withBalance.filter(i => i.isThirdPartyInvoice === 0);
    const thirdPartyInvoices = withBalance.filter(i => i.isThirdPartyInvoice !== 0);
    const directTotal        = directInvoices.reduce((s, i) => s + (i.Balance ?? 0), 0);
    const thirdPartyTotal    = thirdPartyInvoices.reduce((s, i) => s + (i.Balance ?? 0), 0);
    console.log(`[ageing-debts] ${invoices.length} invoices fetched | ${withBalance.length} valid (Bal>0, Tot>0, Bal≤Tot, Payments<Tot)`);
    console.log(`[ageing-debts] breakdown — patient-direct: ${directInvoices.length} inv $${directTotal.toFixed(2)} | third-party/insurance: ${thirdPartyInvoices.length} inv $${thirdPartyTotal.toFixed(2)}`);

    // Cross-check: what the total would be using (Total − TotalPayments) instead
    // of the server-computed Balance field.  A difference here means some invoices
    // have credit adjustments that reduce Balance below (Total − TotalPayments).
    const simpleTotal = withBalance.reduce((s, i) => {
      const tot = i.Total         ?? 0;
      const pmt = i.TotalPayments ?? 0;
      return s + Math.max(0, tot - pmt);
    }, 0);
    const balTotal = withBalance.reduce((s, i) => s + (i.Balance ?? 0), 0);
    if (Math.abs(balTotal - simpleTotal) > 0.01) {
      console.log(`[ageing-debts] Balance field total $${balTotal.toFixed(2)} vs (Total−Payments) total $${simpleTotal.toFixed(2)} — diff $${(balTotal - simpleTotal).toFixed(2)}`);
    }

    const buckets: AgeingBuckets = { d0_30: 0, d31_60: 0, d61_90: 0, d90p: 0 };
    let total = 0;

    for (const inv of withBalance) {
      const bal = inv.Balance ?? 0;

      total += bal;
      const age = ageInDays(inv.dateCreated);

      if      (age <= 30) buckets.d0_30  += bal;
      else if (age <= 60) buckets.d31_60 += bal;
      else if (age <= 90) buckets.d61_90 += bal;
      else                buckets.d90p   += bal;
    }

    console.log(`[ageing-debts] total: $${total.toFixed(2)} | 0-30=$${buckets.d0_30.toFixed(2)} 31-60=$${buckets.d31_60.toFixed(2)} 61-90=$${buckets.d61_90.toFixed(2)} 90+=$${buckets.d90p.toFixed(2)}`);

    const round2 = (n: number) => Math.round(n * 100) / 100;
    const result: AgeingDebtsResult = {
      total:   round2(total),
      buckets: {
        d0_30:  round2(buckets.d0_30),
        d31_60: round2(buckets.d31_60),
        d61_90: round2(buckets.d61_90),
        d90p:   round2(buckets.d90p),
      },
      fetchedAt: new Date().toISOString(),
      fromCache: false,
    };

    _cache.set(key, { result, at: Date.now() });
    return result;
  },
};
