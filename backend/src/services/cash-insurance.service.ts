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
 * "Cash from Insurance" / "Third Party" — matches Nookal's Providers and
 * Practice report with the "Active Provider + Third Party" filter combo.
 *
 * Filter rules (verified across multiple samples 2026-04-22):
 *   - `invoice.isThirdPartyInvoice === 1` — invoice is third-party billed.
 *   - `entry.providerID !== 0` — entry has an assigned provider (matches
 *     Nookal's "Active Provider" filter — admin charges with no provider
 *     are dropped).
 *   - `entry.date` day is in [dateFrom, dateTo] — NO after-midnight fallback
 *     (Revenue Report uses it but this report doesn't).
 */

export interface CategoryTotal {
  subtotal: number;
  gst:      number;
  total:    number;
}

export interface CashFromInsuranceReport {
  clinicId:   string;
  clinicName: string;
  dateFrom:   string;
  dateTo:     string;
  services:   CategoryTotal;
  inventory:  CategoryTotal;
  other:      CategoryTotal;
  grand:      CategoryTotal;
  entryCount: number;
}

// ── helpers ───────────────────────────────────────────────────────

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Nookal returns invoice/entry dates as JS `Date.toString()` strings, e.g.
 * "Sat Jun 27 2026 02:30:06 GMT+1000 (Australian Eastern Standard Time)".
 * Convert to UTC calendar day (not the Sydney-local day embedded in the
 * string) — verified against Nookal's own Reports UI, which buckets by
 * UTC day. See upfront-revenue.service.ts for the full writeup.
 */
function nookalDayISO(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}
const round2 = (n: number) => Math.round(n * 100) / 100;

function bucketFor(itemType: string | null | undefined): 'services' | 'inventory' | 'other' {
  const t = (itemType ?? '').toLowerCase();
  if (t.includes('consult') || t.includes('service') || t.includes('treatment')) return 'services';
  if (t.includes('stock') || t.includes('product') || t.includes('inventory')) return 'inventory';
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

export const cashInsuranceService = {
  async getReport(
    clinic:   Clinic,
    dateFrom: string,
    dateTo:   string,
    cache?:   NookalDataCache
  ): Promise<CashFromInsuranceReport> {
    const targetLocation = clinic.v3LocationId;
    const { entries, invoiceMap } = await loadData(dateFrom, dateTo, cache);

    const services  = emptyBucket();
    const inventory = emptyBucket();
    const other     = emptyBucket();
    const grand     = emptyBucket();
    let entryCount = 0;

    for (const entry of entries) {
      if (entry.void) continue;
      const inv = invoiceMap.get(entry.invoiceID);
      if (!inv) continue;
      if (inv.locationID !== targetLocation) continue;
      if (inv.isThirdPartyInvoice !== 1) continue;
      if (!entry.providerID || entry.providerID === 0) continue;

      const day = nookalDayISO(entry.date);
      if (!day || day < dateFrom || day > dateTo) continue;

      entryCount++;
      const b = bucketFor(entry.itemType);
      const bucket = b === 'services' ? services : b === 'inventory' ? inventory : other;
      addInto(bucket, entry);
      addInto(grand,  entry);
    }

    return {
      clinicId:   clinic.id,
      clinicName: clinic.name,
      dateFrom, dateTo,
      services:  roundBucket(services),
      inventory: roundBucket(inventory),
      other:     roundBucket(other),
      grand:     roundBucket(grand),
      entryCount,
    };
  },
};
