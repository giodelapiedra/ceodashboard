import api from './client';
import { ClinicId } from '../types';

export type Zone = 'thriving' | 'refining' | 'reset';

export interface Metric {
  value: number | null;
  zone:  Zone | null;
  /** True for the hand-entered figures (Total Appts, NC) — editable. */
  manual?: boolean;
  /** Why the cell is blank, or a warning about the value in it. */
  note?: string;
  /**
   * Neutral working behind the figure. Kept apart from `note` because the
   * table paints anything with a note as a warning, and this is not one.
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
}

/** One practitioner-week of hand-read Nookal figures. */
export interface WeekInputPayload {
  clinician_id:  string;
  year:          number;
  month:         number;
  /** 1-4, or 5 for the Remainder column. */
  week_num:      number;
  total_appts:   number | null;
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
   * Pull a month of Nookal appointments and fill Total Appts and NC for every
   * mapped practitioner.
   */
  async sync(year: number, month: number): Promise<SyncResult> {
    const { data } = await api.post<SyncResult>('/api/practitioner-stats/sync', null, {
      params: { year, month },
    });
    return data;
  },
};
