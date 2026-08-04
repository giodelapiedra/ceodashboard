import api from './client';
import { ClinicId } from '../types';

export type Zone = 'thriving' | 'refining' | 'reset';

export interface Metric {
  value: number | null;
  zone:  Zone | null;
}

/** A column the backend cannot fill yet — `reason` explains what is missing. */
export interface UnavailableMetric {
  value:  null;
  zone:   null;
  reason: string;
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

  totalAppts:      UnavailableMetric;
  newCases:        UnavailableMetric;
  occupancy:       UnavailableMetric;
  cancellationPct: UnavailableMetric;
}

export interface PractitionerStatsWeek {
  weekNum:  1 | 2 | 3 | 4 | 'remainder';
  label:    string;
  dateFrom: string;
  dateTo:   string;
  rows:     PractitionerWeekStats[];
  team:     PractitionerWeekStats;
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
};
