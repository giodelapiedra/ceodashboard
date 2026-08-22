import api from './client';
import { DashboardData } from '../types';

export interface AgeingDebtsData {
  total:     number;
  buckets:   { d0_30: number; d31_60: number; d61_90: number; d90p: number };
  fetchedAt: string;
  fromCache: boolean;
}

/** The hand-typed Ageing Debts figure for one clinic-month (pre-2026-08-12). */
export interface AgeingDebtsManualEntry {
  clinic_id:       string;
  year:            number;
  month:           number;
  amount:          number;
  updated_at:      string;
  updated_by_name: string | null;
}

/** One typed week column. `week_num` is the 1-based dashboard column position. */
export interface AgeingDebtsWeekEntry {
  week_num:        number;
  amount:          number;
  updated_at:      string;
  updated_by_name: string | null;
}

/**
 * The whole Ageing Debts row for one clinic-month.
 *
 * `total` is what the Monthly Actual cell shows, and `source` says how to
 * render it: 'weeks' = the automatic sum, 'monthly' = a figure typed before
 * weekly entry existed, 'none' = nothing typed yet.
 */
export interface AgeingDebtsMonth {
  weeks:  AgeingDebtsWeekEntry[];
  entry:  AgeingDebtsManualEntry | null;
  total:  number | null;
  source: 'weeks' | 'monthly' | 'none';
}

export const dashboardApi = {
  getClinics: () =>
    api.get('/api/dashboard/clinics').then(r => r.data),

  getMonthly: (
    clinic: string,
    month: number,
    year: number,
    opts?: { forceRefresh?: boolean }
  ): Promise<DashboardData> =>
    api
      .get('/api/dashboard/monthly', {
        params:  { clinic, month, year, ...(opts?.forceRefresh && { refresh: 1 }) },
        // "overall + refresh" fetches 3 clinics × 3 Nookal queries in parallel;
        // give the backend up to 3 minutes before the browser cuts the connection.
        timeout: 180_000,
      })
      .then((r) => r.data),

  getAgeingDebts: (
    clinic: string,
    opts?: { forceRefresh?: boolean }
  ): Promise<AgeingDebtsData> =>
    api
      .get('/api/dashboard/ageing-debts', {
        params: { clinic, ...(opts?.forceRefresh && { refresh: 1 }) },
      })
      .then((r) => r.data),

  // ── Ageing Debts: hand-typed (migrations 027 + 028) ───────────
  // Replaces the old on-demand Nookal fetch on the dashboard. Typed per WEEK
  // COLUMN since 2026-08-12; the Monthly Actual is their sum. 'overall' is
  // stored on its own, not summed from the three clinics.

  /** The whole row for one clinic-month: week columns + the Monthly Actual. */
  getAgeingDebtsManual: (
    clinic: string,
    year: number,
    month: number
  ): Promise<AgeingDebtsMonth> =>
    api
      .get('/api/dashboard/ageing-debts-manual', { params: { clinic, year, month } })
      .then((r) => r.data),

  /**
   * Upsert ONE week column — re-saving corrects it. ADMIN only (403 otherwise).
   * Returns the recomputed month, so the caller never re-adds the sum itself.
   */
  saveAgeingDebtsWeek: (
    clinic: string,
    year: number,
    month: number,
    week: number,
    amount: number
  ): Promise<AgeingDebtsMonth> =>
    api
      .put('/api/dashboard/ageing-debts-manual-week', { clinic, year, month, week, amount })
      .then((r) => r.data),

  /** That one column back to "—". ADMIN only. */
  clearAgeingDebtsWeek: (
    clinic: string,
    year: number,
    month: number,
    week: number
  ): Promise<AgeingDebtsMonth> =>
    api
      .delete('/api/dashboard/ageing-debts-manual-week', { params: { clinic, year, month, week } })
      .then((r) => r.data),

  /**
   * Clear a month typed the old way (before weekly entry). Kept so a stale 027
   * figure can still be removed; new entry goes through the week calls above.
   */
  clearAgeingDebtsManual: (clinic: string, year: number, month: number): Promise<void> =>
    api
      .delete('/api/dashboard/ageing-debts-manual', { params: { clinic, year, month } })
      .then(() => undefined),
};
