import api from './client';
import { ClinicId } from '../types';

export type Zone = 'thriving' | 'refining' | 'reset';

export interface Metric {
  value: number | null;
  zone:  Zone | null;
  /** True for the hand-entered figures (Total Appts, Occupancy, NC) — editable. */
  manual?: boolean;
  /** Why the cell is blank, or a warning about the value in it. */
  note?: string;
  /**
   * Neutral working behind the figure — the hours behind a synced occupancy, for
   * instance. Kept apart from `note` because the table paints anything with a
   * note as a warning, and this is not one.
   */
  detail?: string;
}

export interface SyncResult {
  year:         number;
  month:        number;
  weeksSynced:  number;
  appointments: number;
  rowsWritten:  number;
  mapping: {
    mapped:     { userId: string; fullName: string; staffID: number; nookalName: string; how: string }[];
    unresolved: { userId: string; fullName: string }[];
    orphanProviders: { staffID: number; fullName: string | null }[];
  };
  /** Providers in the feed with no mapped user — their appointments were skipped. */
  unmappedProviderIds: number[];

  /** Practitioner-weeks still without an Occupancy. Sync cannot produce one —
   *  it comes from the Nookal Occupancy report export, or by hand. */
  occupancyNeedsImport: number;
}

/** One practitioner-week of hand-read Nookal figures. */
export interface WeekInputPayload {
  clinician_id:  string;
  year:          number;
  month:         number;
  /** 1-4, or 5 for the Remainder column. */
  week_num:      number;
  total_appts:   number | null;
  occupancy_pct: number | null;
  new_cases:     number | null;
}

export interface PractitionerWeekStats {
  clinicianId:   string;
  clinicianName: string;
  clinicId:      string | null;
  initials:      number;

  recommendations: Metric;
  conversion:      Metric;
  caseAcceptance:  Metric;
  tpDocumented:    Metric;

  prepayOfferedPct:  Metric;
  prepayAcceptedPct: Metric;

  cancellations: number;
  churns:        number;

  /** From Sync (migration 026), hand-correctable. */
  totalAppts: Metric;
  /** Imported from Nookal's own Occupancy report, or hand-entered. Never from
   *  Sync — blank until one of those happens. */
  occupancy:  Metric;
  newCases:   Metric;
  /** Computed from the entered Total Appts. */
  cancellationPct: Metric;
}

export interface PractitionerStatsWeek {
  weekNum:  1 | 2 | 3 | 4 | 'remainder';
  label:    string;
  dateFrom: string;
  dateTo:   string;
  rows:     PractitionerWeekStats[];
  team:     PractitionerWeekStats;
  /** Last Nookal sync covering this week, or null if never synced. The report
   *  itself is read from Postgres — this says whether a sync is worth pressing. */
  syncedAt: string | null;
}

export interface PractitionerStatsReport {
  year:     number;
  month:    number;
  clinicId: string | null;
  weeks:    PractitionerStatsWeek[];
  notes:    string[];
}

export interface OccupancyScrapeResult {
  written: number;
  keptManual: number;
  skippedIdle: number;
  unmatched: string[];
  scraped: number;
  dateFrom: string;
  dateTo: string;
}

export interface OccupancySyncResponse {
  success: boolean;
  results: OccupancyScrapeResult[];
}

export interface OccupancyStatusResponse {
  configured: boolean;
  message: string;
}

export const practitionerStatsApi = {
  /** ADMIN-only. `clinicId` omitted → all clinics pooled. */
  async get(
    year:     number,
    month:    number,
    clinicId?: ClinicId
  ): Promise<PractitionerStatsReport> {
    // The shared axios instance has no baseURL, so every path carries its own
    // /api prefix — that is also what the vite dev server proxies. Without it the
    // dev server answers with index.html at status 200 and the caller gets HTML
    // where it expected JSON.
    const { data } = await api.get<PractitionerStatsReport>('/api/practitioner-stats', {
      params: { year, month, ...(clinicId ? { clinic_id: clinicId } : {}) },
    });
    return data;
  },

  /**
   * Save the three hand-read Nookal figures for one practitioner-week. Upsert —
   * saving the same week again corrects it rather than adding a duplicate.
   */
  async saveWeekInput(payload: WeekInputPayload): Promise<void> {
    await api.put('/api/practitioner-stats/week-input', payload);
  },

  /**
   * Pull a month of Nookal appointments and fill Total Appts, NC and the
   * cancelled count for every mapped practitioner.
   *
   * Occupancy is NOT touched. Nookal divides it by rostered hours, which the API
   * does not expose, so it arrives via the Occupancy-report import or by hand.
   * The result reports how many weeks are still waiting for one.
   */
  async sync(year: number, month: number): Promise<SyncResult> {
    const { data } = await api.post<SyncResult>('/api/practitioner-stats/sync', null, {
      params: { year, month },
    });
    return data;
  },

  /**
   * Check if Nookal web credentials are configured for browser-based occupancy sync.
   */
  async getOccupancyStatus(): Promise<OccupancyStatusResponse> {
    const { data } = await api.get<OccupancyStatusResponse>('/api/practitioner-stats/occupancy-status');
    return data;
  },

  /**
   * Sync occupancy from the Nookal web report via browser automation.
   * This scrapes the exact figures Nookal displays on the Occupancy report page.
   *
   * Takes 30-60 seconds per week due to browser automation.
   *
   * @param year  - Year to sync
   * @param month - Month to sync (1-12)
   * @param week  - Optional: specific week number (1-5). If omitted, syncs all weeks.
   */
  async syncOccupancy(year: number, month: number, week?: number): Promise<OccupancySyncResponse> {
    const { data } = await api.post<OccupancySyncResponse>(
      '/api/practitioner-stats/sync-occupancy',
      null,
      { 
        params: { year, month, ...(week !== undefined ? { week } : {}) },
        timeout: 300000, // 5 minutes - browser automation is slow
      }
    );
    return data;
  },
};
