import { V3Credit } from './nookal-v3/queries';
import { fetchCreditsInRange } from './nookal-v3/fetchers';
import { NookalDataCache } from './nookal-v3/data-cache';
import { Clinic } from '../types';

/**
 * "Upfront Revenue" — matches Nookal's Reports → Account Credits screen.
 * Sum of non-void `credits.amount` at the clinic with `credit.date` day
 * in [dateFrom, dateTo]. Verified kada-peso vs UI.
 */

export interface UpfrontCreditRow {
  creditID:  number;
  clientID:  number;
  method:    string | null;
  amount:    number;
  date:      string;
  invoiceID: number;
}

export interface UpfrontRevenueReport {
  clinicId:    string;
  clinicName:  string;
  dateFrom:    string;
  dateTo:      string;
  total:       number;
  count:       number;
  details:     UpfrontCreditRow[];
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
/**
 * Nookal returns credit dates as JS `Date.toString()` strings, e.g.
 * "Sat Jun 27 2026 02:30:06 GMT+1000 (Australian Eastern Standard Time)".
 * It's tempting to read the weekday/month/day/year straight out of the
 * string (Sydney-local calendar day) — but Nookal's OWN "Account Credits"
 * report buckets by UTC calendar day, not local day. Verified against
 * Nookal's UI directly: Newport, 01/06/2026-30/06/2026 reports a Total
 * Credit of $10,452.80, which only matches when a credit timestamped
 * "Wed Jul 01 2026 02:06:23 GMT+1000" (=16:06 UTC Jun 30) is counted as
 * June. Text-extracting the literal date gives $9,782.30 instead — wrong,
 * because it disagrees with Nookal's own report. So: convert to UTC.
 */
function nookalDayISO(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}
const round2 = (n: number) => Math.round(n * 100) / 100;

async function loadCredits(
  dateFrom: string,
  dateTo:   string,
  cache?:   NookalDataCache
): Promise<V3Credit[]> {
  if (cache) return cache.credits();
  return fetchCreditsInRange(addDays(dateFrom, -7), addDays(dateTo, +7));
}

export const upfrontRevenueService = {
  async getReport(
    clinic:   Clinic,
    dateFrom: string,
    dateTo:   string,
    cache?:   NookalDataCache
  ): Promise<UpfrontRevenueReport> {
    const targetLocation = clinic.v3LocationId;
    const all = await loadCredits(dateFrom, dateTo, cache);

    const kept: V3Credit[] = [];
    for (const c of all) {
      if (c.void) continue;
      if ((c.amount ?? 0) <= 0) continue;  // exclude deductions (used credits); include all positive receipts regardless of fromAdjustment
      if (c.locationID !== targetLocation) continue;
      const day = nookalDayISO(c.date);
      if (!day || day < dateFrom || day > dateTo) continue;
      kept.push(c);
    }

    const total = kept.reduce((s, c) => s + (c.amount ?? 0), 0);
    return {
      clinicId:   clinic.id,
      clinicName: clinic.name,
      dateFrom, dateTo,
      total:  round2(total),
      count:  kept.length,
      details: kept.map((c) => ({
        creditID:  c.creditID,
        clientID:  c.clientID,
        method:    c.method,
        amount:    round2(c.amount ?? 0),
        date:      c.date,
        invoiceID: c.invoiceID,
      })),
    };
  },
};
