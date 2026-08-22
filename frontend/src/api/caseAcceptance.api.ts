import api from './client';
import { CaseAcceptanceDTO, ClinicId, FrontStaffName } from '../types';
import { DuplicateReport, OnDuplicate } from './duplicates';

export interface ListCaseAcceptanceFilters {
  clinic_id?:    ClinicId;
  date_from?:    string;
  date_to?:      string;
  clinician_id?: string;
  tp_provided?:  boolean;
  search?:       string;
  limit?:        number;
  offset?:       number;
}

export interface PagedCaseAcceptance {
  data: CaseAcceptanceDTO[];
  pagination: {
    limit:   number;
    offset:  number;
    total:   number;
    hasMore: boolean;
  };
}

/** Natural key of a case-acceptance entry — what the pre-flight matches on. */
export interface CaseAcceptanceDuplicateQuery {
  clinic_id?:   ClinicId;
  clinician_id: string;
  patient_name: string;
  date_logged:  string;
  /** Ignore this row when checking — used by the edit form. */
  exclude_id?:  string;
}

export interface CreateCaseAcceptancePayload {
  /** Omit (= 'reject') to get a 409 carrying the existing row. */
  on_duplicate?:            OnDuplicate;
  clinic_id?:               ClinicId;
  front_staff_name?:        FrontStaffName | null;
  clinician_id:             string;
  patient_name:             string;
  date_logged:              string;
  treatment_plan_provided?: boolean | null;
  case_recommendations:     number;
  appointments_booked:      number;
  prepay_offered?:          boolean | null;
  prepay_accepted?:         boolean | null;
  transition_notes?:        string | null;
  notes?:                   string | null;
}

export interface UpdateCaseAcceptancePayload {
  front_staff_name?:        FrontStaffName | null;
  clinician_id?:            string;
  patient_name?:            string;
  date_logged?:             string;
  treatment_plan_provided?: boolean | null;
  case_recommendations?:    number;
  appointments_booked?:     number;
  prepay_offered?:          boolean | null;
  prepay_accepted?:         boolean | null;
  transition_notes?:        string | null;
  notes?:                   string | null;
}

export interface CaseAcceptanceSummary {
  total:                number;
  totalRecommendations: number;
  totalBooked:          number;
  /** Weighted: sum(booked) / sum(recs). */
  caseAcceptancePct:    number | null;
  /** Mean of the per-entry ACCEPTANCE column — each entry counts once. */
  avgAcceptancePct:     number | null;
  /** Entries with recs > 0 — the mean's denominator. */
  entriesWithRecs:      number;
  tpProvided:           number;
  tpNotProvided:        number;
  prepayOffered:        number;
  prepayAccepted:       number;
  transitions:          number;
  byClinic:             Record<string, number>;
}

export const caseAcceptanceApi = {
  list: (filters: ListCaseAcceptanceFilters = {}): Promise<PagedCaseAcceptance> =>
    api.get('/api/case-acceptance', { params: filters }).then(r => r.data),

  summary: (filters: Omit<ListCaseAcceptanceFilters, 'limit' | 'offset'> = {}): Promise<CaseAcceptanceSummary> =>
    api.get('/api/case-acceptance/summary', { params: filters }).then(r => r.data),

  /** Pre-flight duplicate lookup. Advisory — create() re-checks under a lock. */
  checkDuplicate: (q: CaseAcceptanceDuplicateQuery): Promise<DuplicateReport<CaseAcceptanceDTO>> =>
    api.post('/api/case-acceptance/check-duplicate', q).then(r => r.data),

  create: (payload: CreateCaseAcceptancePayload): Promise<CaseAcceptanceDTO> =>
    api.post('/api/case-acceptance', payload).then(r => r.data),

  update: (id: string, patch: UpdateCaseAcceptancePayload): Promise<CaseAcceptanceDTO> =>
    api.patch(`/api/case-acceptance/${id}`, patch).then(r => r.data),

  remove: (id: string): Promise<void> =>
    api.delete(`/api/case-acceptance/${id}`).then(() => {}),

  /**
   * Downloads an XLSX of the filtered set. Uses axios with responseType=blob
   * so the auth header / refresh interceptor still runs; the file is offered
   * to the browser via a synthetic <a download> click.
   */
  exportXlsx: async (filters: Omit<ListCaseAcceptanceFilters, 'limit' | 'offset'> = {}): Promise<void> => {
    const res = await api.get('/api/case-acceptance/export', {
      params:       filters,
      responseType: 'blob',
    });
    const blob = new Blob([res.data], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href    = url;
    // Pull filename from Content-Disposition if the server provided one.
    const cd = res.headers['content-disposition'] as string | undefined;
    const m  = cd?.match(/filename="?([^"]+)"?/i);
    a.download = m?.[1] ?? 'case-acceptance.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};
