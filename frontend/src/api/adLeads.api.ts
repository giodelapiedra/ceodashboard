import api from './client';
import { AdLeadDTO, AdLeadPlatform, ClinicId } from '../types';
import { DuplicateReport, OnDuplicate } from './duplicates';

export interface ListAdLeadsFilters {
  clinic_id?: ClinicId;
  date_from?: string;
  date_to?:   string;
  /** One platform, or several (multi-select filter). */
  platform?:  AdLeadPlatform | AdLeadPlatform[];
  booked?:    boolean;
  search?:    string;
  limit?:     number;
  offset?:    number;
}

export interface PagedAdLeads {
  data: AdLeadDTO[];
  pagination: { limit: number; offset: number; total: number; hasMore: boolean };
}

/** Natural key of an ad lead — what the pre-flight check matches on. */
export interface AdLeadDuplicateQuery {
  clinic_id?:   ClinicId;
  patient_name: string;
  /** Optional — '' / omitted means "not specified". */
  platform?:    AdLeadPlatform | '';
  date_added:   string;
  /** Ignore this row when checking — used by the edit form. */
  exclude_id?:  string;
}

export interface CreateAdLeadPayload {
  /** Omit (= 'reject') to get a 409 carrying the existing row. */
  on_duplicate?:  OnDuplicate;
  clinic_id?:     ClinicId;
  patient_name:   string;
  /** Optional — '' / omitted means "not specified". */
  platform?:      AdLeadPlatform | '';
  campaign_name?: string | null;
  date_added:     string;
  booked?:        boolean;
  bella_called?:  string | null;
  bella_sms?:     string | null;
  bella_remarks?: string | null;
}

export interface UpdateAdLeadPayload {
  patient_name?:  string;
  platform?:      AdLeadPlatform;
  campaign_name?: string | null;
  date_added?:    string;
  booked?:        boolean;
  bella_called?:  string | null;
  bella_sms?:     string | null;
  bella_remarks?: string | null;
}

export interface AdLeadSummary {
  total:      number;
  booked:     number;
  byPlatform: Record<string, number>;
}

// ── Nookal "total paid" lookup (booked leads) ──
// Mirrors backend services/nookal-client-paid.service.ts.
export interface NookalPaidCandidate {
  clientID:     number;
  fullName:     string;
  invoiceCount: number;
  invoiced:     number;
  paid:         number;
}

export interface NookalPaidLookup {
  status:     'matched' | 'multiple' | 'not_found' | 'error';
  candidates: NookalPaidCandidate[];
}

export interface NookalPaidSyncSummary {
  names:     number;
  matched:   number;
  multiple:  number;
  not_found: number;
  errors:    number;
}

export const adLeadsApi = {
  list: (filters: ListAdLeadsFilters = {}): Promise<PagedAdLeads> =>
    api.get('/api/ad-leads', { params: filters }).then(r => r.data),

  summary: (filters: Omit<ListAdLeadsFilters, 'limit' | 'offset'> = {}): Promise<AdLeadSummary> =>
    api.get('/api/ad-leads/summary', { params: filters }).then(r => r.data),

  /** Pre-flight duplicate lookup. Advisory — create() re-checks under a lock. */
  checkDuplicate: (q: AdLeadDuplicateQuery): Promise<DuplicateReport<AdLeadDTO>> =>
    api.post('/api/ad-leads/check-duplicate', q).then(r => r.data),

  create: (payload: CreateAdLeadPayload): Promise<AdLeadDTO> =>
    api.post('/api/ad-leads', payload).then(r => r.data),

  update: (id: string, patch: UpdateAdLeadPayload): Promise<AdLeadDTO> =>
    api.patch(`/api/ad-leads/${id}`, patch).then(r => r.data),

  remove: (id: string): Promise<void> =>
    api.delete(`/api/ad-leads/${id}`).then(() => {}),

  /** Resolve ALL booked leads against Nookal and save the totals on the lead
   *  rows. Slow by design (~30s with 100+ names) — generous timeout. */
  syncNookalPaid: (): Promise<NookalPaidSyncSummary> =>
    api.post('/api/ad-leads/sync-nookal-paid', null, { timeout: 300_000 }).then(r => r.data),
};
