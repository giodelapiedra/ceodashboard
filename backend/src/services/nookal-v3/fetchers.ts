import { nookalV3 } from './client';
import {
  ENTRIES_BY_DATE_QUERY,
  INVOICES_BY_ID_QUERY,
  APPOINTMENTS_BY_DATE_QUERY,
  CREDITS_BY_DATE_QUERY,
  EntriesByDateResult,
  InvoicesByIDResult,
  AppointmentsByDateResult,
  CreditsByDateResult,
  V3InvoiceEntry,
  V3InvoiceStub,
  V3Appointment,
  V3Credit,
  PAGE_LENGTH,
} from './queries';

/**
 * Shared Nookal v3 data fetchers.
 *
 * Each function paginates a single logical resource. The services call
 * these directly for standalone use, or the data-cache layer wraps them
 * with single-flight memoisation so multiple services within one monthly
 * dashboard request only hit Nookal once per resource.
 */

/**
 * Parallel-batch pagination: fetch PARALLEL_BATCH pages at a time until
 * we see one that's short (indicates last page). Typical monthly data
 * (~2000-5000 entries) lands in a single batch of 8-10 pages fetched
 * concurrently, vs. 25+ sequential round-trips.
 */
const PARALLEL_BATCH = 8;

async function paginateParallel<T>(
  fetchPage: (page: number) => Promise<T[]>
): Promise<T[]> {
  const all: T[] = [];
  let batchStart = 1;
  for (let round = 0; round < 50; round++) {
    const pageNums = Array.from({ length: PARALLEL_BATCH }, (_, i) => batchStart + i);
    const results = await Promise.all(pageNums.map(fetchPage));

    let done = false;
    for (const rows of results) {
      if (!rows?.length) { done = true; break; }
      all.push(...rows);
      if (rows.length < PAGE_LENGTH) { done = true; break; }
    }
    if (done) break;
    batchStart += PARALLEL_BATCH;
  }
  return all;
}

export function fetchEntriesInRange(
  dateFrom: string,
  dateTo:   string
): Promise<V3InvoiceEntry[]> {
  return paginateParallel<V3InvoiceEntry>(async (page) => {
    const { invoiceEntry } = await nookalV3.query<EntriesByDateResult>(
      ENTRIES_BY_DATE_QUERY,
      { dateFrom, dateTo, page, pageLength: PAGE_LENGTH }
    );
    return invoiceEntry ?? [];
  });
}

/**
 * Batch-lookup invoices by ID. Nookal's `invoices` defaults to void=0 and
 * silently drops voided invoices — but their line items count as revenue
 * in Nookal's UI. So we query both void=0 and void=1 in parallel and merge.
 * Parallelised across ID chunks.
 */
export async function buildInvoiceMap(
  invoiceIds: number[]
): Promise<Map<number, V3InvoiceStub>> {
  const map = new Map<number, V3InvoiceStub>();
  if (!invoiceIds.length) return map;

  const chunks: number[][] = [];
  for (let i = 0; i < invoiceIds.length; i += PAGE_LENGTH) {
    chunks.push(invoiceIds.slice(i, i + PAGE_LENGTH));
  }

  const results = await Promise.all(chunks.flatMap((chunk) => [
    nookalV3.query<InvoicesByIDResult>(INVOICES_BY_ID_QUERY, {
      invoiceIDs: chunk, void: 0, page: 1, pageLength: PAGE_LENGTH,
    }),
    nookalV3.query<InvoicesByIDResult>(INVOICES_BY_ID_QUERY, {
      invoiceIDs: chunk, void: 1, page: 1, pageLength: PAGE_LENGTH,
    }),
  ]));
  for (const r of results) {
    for (const inv of r.invoices ?? []) map.set(inv.invoiceID, inv);
  }
  return map;
}

export function fetchAppointmentsInRange(
  locationID: number,
  dateFrom:   string,
  dateTo:     string
): Promise<V3Appointment[]> {
  return paginateParallel<V3Appointment>(async (page) => {
    const { appointments } = await nookalV3.query<AppointmentsByDateResult>(
      APPOINTMENTS_BY_DATE_QUERY,
      { locationIDs: [locationID], dateFrom, dateTo, page, pageLength: PAGE_LENGTH }
    );
    return appointments ?? [];
  });
}

export function fetchCreditsInRange(
  dateFrom: string,
  dateTo:   string
): Promise<V3Credit[]> {
  return paginateParallel<V3Credit>(async (page) => {
    const { credits } = await nookalV3.query<CreditsByDateResult>(
      CREDITS_BY_DATE_QUERY,
      { dateFrom, dateTo, page, pageLength: PAGE_LENGTH }
    );
    return credits ?? [];
  });
}
