import api from './client';
import { DropoutDTO, DropoutStatus, DropoutReason, ClinicId, FrontStaffName } from '../types';
import { DuplicateReport, OnDuplicate } from './duplicates';

export interface ListDropoutsFilters {
  clinic_id?:    ClinicId;
  date_from?:    string;
  date_to?:      string;
  clinician_id?: string;
  status?:       DropoutStatus;
  reason?:       DropoutReason;
  search?:       string;
  limit?:        number;
  offset?:       number;
}

export interface PagedDropouts {
  data: DropoutDTO[];
  pagination: {
    limit:   number;
    offset:  number;
    total:   number;
    hasMore: boolean;
  };
}

/** Natural key of a dropout entry — what the pre-flight check matches on. */
export interface DropoutDuplicateQuery {
  clinic_id?:   ClinicId;
  clinician_id: string;
  patient_name: string;
  date_logged:  string;
  /** Ignore this row when checking — used by the edit form. */
  exclude_id?:  string;
}

export interface CreateDropoutPayload {
  /** Omit (= 'reject') to get a 409 carrying the existing row. */
  on_duplicate?:                OnDuplicate;
  clinic_id?:                   ClinicId;
  front_staff_name?:            FrontStaffName | null;
  clinician_id:                 string;
  patient_name:                 string;
  date_logged:                  string;
  appointment_cancelled_dates?: string[];
  status:                       DropoutStatus;
  reason:                       DropoutReason;
  notes?:                       string | null;
}

export interface UpdateDropoutPayload {
  front_staff_name?:            FrontStaffName | null;
  clinician_id?:                string;
  patient_name?:                string;
  date_logged?:                 string;
  appointment_cancelled_dates?: string[];
  status?:                      DropoutStatus;
  reason?:                      DropoutReason;
  notes?:                       string | null;
}

export interface DropoutSummary {
  total:    number;
  byStatus: Record<string, number>;
  byReason: Record<string, number>;
  byClinic: Record<string, number>;
  /** Days with ≥1 entry over the filtered range, ascending by date. */
  byDay:    Array<{ date: string; count: number }>;
}

export const dropoutsApi = {
  list: (filters: ListDropoutsFilters = {}): Promise<PagedDropouts> =>
    api.get('/api/dropouts', { params: filters }).then(r => r.data),

  summary: (filters: Omit<ListDropoutsFilters, 'limit' | 'offset'> = {}): Promise<DropoutSummary> =>
    api.get('/api/dropouts/summary', { params: filters }).then(r => r.data),

  /** Pre-flight duplicate lookup. Advisory — create() re-checks under a lock. */
  checkDuplicate: (q: DropoutDuplicateQuery): Promise<DuplicateReport<DropoutDTO>> =>
    api.post('/api/dropouts/check-duplicate', q).then(r => r.data),

  create: (payload: CreateDropoutPayload): Promise<DropoutDTO> =>
    api.post('/api/dropouts', payload).then(r => r.data),

  update: (id: string, patch: UpdateDropoutPayload): Promise<DropoutDTO> =>
    api.patch(`/api/dropouts/${id}`, patch).then(r => r.data),

  remove: (id: string): Promise<void> =>
    api.delete(`/api/dropouts/${id}`).then(() => {}),
};
