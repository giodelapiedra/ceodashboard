import api from './client';
import { DashboardData } from '../types';

export interface AgeingDebtsData {
  total:     number;
  buckets:   { d0_30: number; d31_60: number; d61_90: number; d90p: number };
  fetchedAt: string;
  fromCache: boolean;
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
};
