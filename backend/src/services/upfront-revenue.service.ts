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

const MONTH_NUM: Record<string, number> = {
  Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12,
};
const pad2 = (n: number) => String(n).padStart(2, '0');

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function nookalDayISO(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/^\w{3}\s+(\w{3})\s+(\d{2})\s+(\d{4})/);
  if (!m) return null;
  const mon = MONTH_NUM[m[1]];
  return mon ? `${m[3]}-${pad2(mon)}-${m[2]}` : null;
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
