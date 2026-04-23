import {
  V3InvoiceEntry,
  V3InvoiceStub,
} from './nookal-v3/queries';
import {
  fetchEntriesInRange,
  buildInvoiceMap,
} from './nookal-v3/fetchers';
import { NookalDataCache } from './nookal-v3/data-cache';
import { Clinic } from '../types';

/**
 * Nookal Revenue Report (Reports → Revenue).
 *
 * Filter rules (verified across 8 samples, Jan 2025–Apr 2026):
 *   1. Entries are fetched from a window ±7 days around the requested
 *      range (Nookal's own `dateTo` filter is inconsistent across months).
 *   2. Primary date test: `entry.date` day is in [dateFrom, dateTo].
 *   3. Fallback (Revenue Report only): if `entry.date` is OUTSIDE but the
 *      parent invoice's `dateCreated` is IN range AND the entry's clock
 *      time is before 06:00 — the entry counts. Catches merchant fees and
 *      admin entries booked just after midnight on a previous-day invoice.
 *   4. Aggregate by `itemType`: Consultation→services, Stock→inventory,
 *      Class→classes, Pass→passes, everything else→other.
 */

export type RevenueCategory = 'services' | 'classes' | 'inventory' | 'passes' | 'other';

export interface CategoryTotal {
  subtotal: number;
  gst:      number;
  total:    number;
}

export type RevenueSummary = Record<RevenueCategory, CategoryTotal> & {
  grand: CategoryTotal;
};

export interface RevenueDetailRow {
  itemName: string;
  itemCode: string | null;
  type:     RevenueCategory;
  rawType:  string;
  net:      number;   // == subtotal
  gst:      number;
  total:    number;
}

export interface RevenueReport {
  clinicId:   string;
  clinicName: string;
  dateFrom:   string;
  dateTo:     string;
  summary:    RevenueSummary;
  details:    RevenueDetailRow[];
  entryCount: number;
}

// ── helpers ───────────────────────────────────────────────────────

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

function num(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}
const round2 = (n: number) => Math.round(n * 100) / 100;

function bucketFor(itemType: string | null | undefined): RevenueCategory {
  const t = (itemType ?? '').toLowerCase();
  if (!t) return 'other';
  if (t.includes('consult') || t.includes('service') || t.includes('treatment')) return 'services';
  if (t.includes('class'))    return 'classes';
  if (t.includes('stock') || t.includes('product') || t.includes('inventory'))  return 'inventory';
  if (t.includes('pass'))     return 'passes';
  return 'other';
}

function addInto(target: CategoryTotal, entry: V3InvoiceEntry): void {
  target.subtotal += num(entry.subtotal);
  target.gst      += num(entry.tax);
  target.total    += num(entry.total);
}

const emptyBucket = (): CategoryTotal => ({ subtotal: 0, gst: 0, total: 0 });
const roundBucket = (b: CategoryTotal): CategoryTotal => ({
  subtotal: round2(b.subtotal), gst: round2(b.gst), total: round2(b.total),
});

// Either grab entries + invoices from the shared cache, or fetch ourselves.
async function loadData(
  dateFrom: string,
  dateTo:   string,
  cache?:   NookalDataCache
): Promise<{ entries: V3InvoiceEntry[]; invoiceMap: Map<number, V3InvoiceStub> }> {
  if (cache) {
    return { entries: await cache.entries(), invoiceMap: await cache.invoiceMap() };
  }
  const entries = await fetchEntriesInRange(addDays(dateFrom, -7), addDays(dateTo, +7));
  const invoiceMap = await buildInvoiceMap([...new Set(entries.map((e) => e.invoiceID))]);
  return { entries, invoiceMap };
}

// ── Public API ────────────────────────────────────────────────────

export const revenueService = {
  async getReport(
    clinic:   Clinic,
    dateFrom: string,
    dateTo:   string,
    cache?:   NookalDataCache
  ): Promise<RevenueReport> {
    const targetLocation = clinic.v3LocationId;
    if (!Number.isFinite(targetLocation)) {
      throw new Error(`clinic ${clinic.id} is missing numeric v3LocationId`);
    }

    const { entries, invoiceMap } = await loadData(dateFrom, dateTo, cache);

    const summary: RevenueSummary = {
      services:  emptyBucket(), classes: emptyBucket(), inventory: emptyBucket(),
      passes:    emptyBucket(), other:   emptyBucket(), grand:     emptyBucket(),
    };
    const details: RevenueDetailRow[] = [];
    let kept = 0;

    for (const entry of entries) {
      if (entry.void) continue;
      const inv = invoiceMap.get(entry.invoiceID);
      if (!inv || inv.locationID !== targetLocation) continue;

      const entryDay   = nookalDayISO(entry.date);
      const invoiceDay = nookalDayISO(inv.dateCreated);
      const entryOk    = entryDay   !== null && entryDay   >= dateFrom && entryDay   <= dateTo;
      const invoiceOk  = invoiceDay !== null && invoiceDay >= dateFrom && invoiceDay <= dateTo;
      if (!entryOk && !invoiceOk) continue;
      if (!entryOk && invoiceOk) {
        const hm = (entry.date || '').match(/(\d{2}):(\d{2}):(\d{2})/);
        const hour = hm ? parseInt(hm[1], 10) : 12;
        if (hour >= 6) continue;
      }

      kept++;
      const bucket = bucketFor(entry.itemType);
      addInto(summary[bucket], entry);
      addInto(summary.grand,   entry);

      details.push({
        itemName: entry.name,
        itemCode: entry.ItemCode,
        type:     bucket,
        rawType:  entry.itemType,
        net:      round2(num(entry.subtotal)),
        gst:      round2(num(entry.tax)),
        total:    round2(num(entry.total)),
      });
    }

    (Object.keys(summary) as (keyof RevenueSummary)[]).forEach((k) => {
      summary[k] = roundBucket(summary[k]);
    });

    return {
      clinicId:   clinic.id,
      clinicName: clinic.name,
      dateFrom, dateTo,
      summary, details,
      entryCount: kept,
    };
  },
};
