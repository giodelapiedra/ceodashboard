import {
  V3InvoiceEntry,
  V3InvoiceStub,
  V3Appointment,
  V3Credit,
} from './queries';
import {
  fetchEntriesInRange,
  buildInvoiceMap,
  fetchAppointmentsInRange,
  fetchCreditsInRange,
} from './fetchers';

/**
 * Single-flight cache for one Nookal data pull.
 *
 * Pattern: the dashboard orchestrator constructs ONE cache per monthly
 * request with the WIDEST date range needed (month ±7 days). All four
 * aggregation services (revenue, cash-insurance, upfront, patient-metrics)
 * get that same cache and pull whatever they need from it. Each underlying
 * fetch happens at most once — subsequent callers await the shared promise.
 *
 * Cuts a monthly dashboard fetch from ~24 Nookal round-trips down to ~4.
 *
 * Services remain backward-compatible: if no cache is passed, they fall
 * back to fetching their own data (with ±7 day overfetch) as before.
 */
export class NookalDataCache {
  private entriesP:     Promise<V3InvoiceEntry[]> | null = null;
  private invoiceMapP:  Promise<Map<number, V3InvoiceStub>> | null = null;
  private apptsByLoc    = new Map<number, Promise<V3Appointment[]>>();
  private creditsP:     Promise<V3Credit[]> | null = null;

  /**
   * @param rangeFrom YYYY-MM-DD inclusive, **already widened** for overfetch.
   * @param rangeTo   YYYY-MM-DD inclusive, **already widened** for overfetch.
   */
  constructor(
    public readonly rangeFrom: string,
    public readonly rangeTo:   string,
  ) {}

  entries(): Promise<V3InvoiceEntry[]> {
    return this.entriesP ??= fetchEntriesInRange(this.rangeFrom, this.rangeTo);
  }

  invoiceMap(): Promise<Map<number, V3InvoiceStub>> {
    return this.invoiceMapP ??= this.entries().then((entries) => {
      const ids = [...new Set(entries.map((e) => e.invoiceID))];
      return buildInvoiceMap(ids);
    });
  }

  appointments(locationID: number): Promise<V3Appointment[]> {
    let p = this.apptsByLoc.get(locationID);
    if (!p) {
      p = fetchAppointmentsInRange(locationID, this.rangeFrom, this.rangeTo);
      this.apptsByLoc.set(locationID, p);
    }
    return p;
  }

  credits(): Promise<V3Credit[]> {
    return this.creditsP ??= fetchCreditsInRange(this.rangeFrom, this.rangeTo);
  }

  /** Warm every dataset in parallel. */
  async warm(locationID: number): Promise<void> {
    await Promise.all([
      this.invoiceMap(),
      this.appointments(locationID),
      this.credits(),
    ]);
  }
}
