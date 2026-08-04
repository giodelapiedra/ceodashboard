import api from './client';
import { AdSpendDTO, AdChannel } from '../types';

export interface ListAdSpendFilters {
  date_from?: string;
  date_to?:   string;
  channel?:   AdChannel;
  search?:    string;
  limit?:     number;
  offset?:    number;
}

export interface PagedAdSpend {
  data: AdSpendDTO[];
  pagination: {
    limit:   number;
    offset:  number;
    total:   number;
    hasMore: boolean;
  };
}

export interface CreateAdSpendPayload {
  spend_date:     string;
  channel:        AdChannel;
  campaign_name?: string | null;
  amount:         number;
  notes?:         string | null;
}

export interface UpdateAdSpendPayload {
  spend_date?:    string;
  channel?:       AdChannel;
  campaign_name?: string | null;
  amount?:        number;
  notes?:         string | null;
}

export interface AdSpendSummary {
  total:       number;
  totalAmount: number;
  byChannel:   Record<string, number>;
}

export interface WeeklyReportRow {
  week_start: string; // YYYY-MM-DD (Monday)
  week_end:   string; // YYYY-MM-DD (Friday)
  byChannel:  Record<string, number>;
  total:      number;
}

// All-time Paid (Nookal) vs ad spend per platform group. ADMIN only.
export interface LeadsRoiGroup {
  paid:  number;  // sum of synced Nookal Paid across booked, matched leads
  leads: number;  // how many matched booked leads contribute to `paid`
  spend: number;  // all-time ad_spend total for the matching channel
  net:   number;  // paid − spend
}
export interface LeadsRoi {
  google:    LeadsRoiGroup;
  meta:      LeadsRoiGroup;
  synced_at: string | null;
}

export const adSpendApi = {
  list: (filters: ListAdSpendFilters = {}): Promise<PagedAdSpend> =>
    api.get('/api/ad-spend', { params: filters }).then(r => r.data),

  summary: (filters: Omit<ListAdSpendFilters, 'limit' | 'offset'> = {}): Promise<AdSpendSummary> =>
    api.get('/api/ad-spend/summary', { params: filters }).then(r => r.data),

  weeklyReport: (dateFrom: string, dateTo: string): Promise<WeeklyReportRow[]> =>
    api.get('/api/ad-spend/weekly-report', { params: { date_from: dateFrom, date_to: dateTo } }).then(r => r.data),

  create: (payload: CreateAdSpendPayload): Promise<AdSpendDTO> =>
    api.post('/api/ad-spend', payload).then(r => r.data),

  update: (id: string, patch: UpdateAdSpendPayload): Promise<AdSpendDTO> =>
    api.patch(`/api/ad-spend/${id}`, patch).then(r => r.data),

  remove: (id: string): Promise<void> =>
    api.delete(`/api/ad-spend/${id}`).then(() => {}),

  syncGoogle: (dateFrom: string, dateTo: string): Promise<{ inserted: number; dates: string[]; message?: string }> =>
    api.post('/api/ad-spend/sync-google', null, { params: { date_from: dateFrom, date_to: dateTo } }).then(r => r.data),

  syncFacebook: (dateFrom: string, dateTo: string): Promise<{ inserted: number; dates: string[]; message?: string }> =>
    api.post('/api/ad-spend/sync-facebook', null, { params: { date_from: dateFrom, date_to: dateTo } }).then(r => r.data),

  /** Omit dates for the all-time view; pass a range to window both sides
   *  (leads by Date Added, spend by spend date). */
  leadsRoi: (dateFrom?: string, dateTo?: string): Promise<LeadsRoi> =>
    api.get('/api/ad-spend/leads-roi', {
      params: { date_from: dateFrom || undefined, date_to: dateTo || undefined },
    }).then(r => r.data),
};
