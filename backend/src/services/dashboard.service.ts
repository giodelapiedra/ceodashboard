import { revenueService } from './revenue.service';
import { cashInsuranceService } from './cash-insurance.service';
import { upfrontRevenueService } from './upfront-revenue.service';
import { patientMetricsService } from './patient-metrics.service';
import { NookalDataCache } from './nookal-v3/data-cache';
import { calculateMonthlyTotals } from './kpi.calculator';
import { getWeekRanges, getMonthRange } from './week.calculator';
import { snapshotRepository } from '../repositories/snapshot.repository';
import { env } from '../config/env';
import { Clinic, MonthlyDashboard, WeekMetrics, WeekRange } from '../types';

export interface DashboardResult extends MonthlyDashboard {
  fetchedAt: string;
  fromCache: boolean;
  duration:  number;
}

function isFresh(fetchedAt: Date): boolean {
  const ageMs = Date.now() - new Date(fetchedAt).getTime();
  return ageMs < env.SNAPSHOT_TTL_MINUTES * 60 * 1000;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const dashboardService = {
  async getMonthly(
    clinic:       Clinic,
    year:         number,
    month:        number,
    forceRefresh: boolean
  ): Promise<DashboardResult> {
    const startedAt = Date.now();

    if (!forceRefresh) {
      const cached = await snapshotRepository.find(clinic.id, year, month);
      if (cached && isFresh(cached.fetched_at)) {
        return {
          ...cached.payload,
          fetchedAt: new Date(cached.fetched_at).toISOString(),
          fromCache: true,
          duration:  Date.now() - startedAt,
        };
      }
    }

    const payload = await fetchFromNookal(clinic, year, month);
    await snapshotRepository.upsert(clinic.id, year, month, payload);

    return {
      ...payload,
      fetchedAt: new Date().toISOString(),
      fromCache: false,
      duration:  Date.now() - startedAt,
    };
  },
};

/**
 * Build monthly dashboard from v3 GraphQL using a shared data cache:
 * one fetch per data type for the whole month (±7 days overfetch for
 * boundary entries), then each service filters the cached data in-process
 * per week / for the monthly total.
 *
 * Before optimisation: 24 Nookal round-trip chains (~13s).
 * After:                4 Nookal round-trip chains (~3-5s typical).
 */
async function fetchFromNookal(
  clinic: Clinic,
  year:   number,
  month:  number
): Promise<MonthlyDashboard> {
  const weekRanges = getWeekRanges(year, month);
  const monthRange = getMonthRange(year, month);

  console.log(`[dashboard] v3: fetching ${clinic.name} ${month}/${year}`);

  // Shared cache — widen by 7 days so entries filter with after-midnight
  // fallback (used by revenue.service) has the data it needs.
  const cache = new NookalDataCache(
    addDays(monthRange.dateFrom, -7),
    addDays(monthRange.dateTo,   +7),
  );
  await cache.warm(clinic.v3LocationId);

  // Run every per-week and the monthly aggregation in parallel, all
  // reading from the shared cache (no extra Nookal traffic).
  const weeksPromise = Promise.all(
    weekRanges.map(async (week) => {
      console.log(`  -> ${week.label} (${week.dateFrom} .. ${week.dateTo})`);
      const [revenue, insurance, upfront, patients] = await Promise.all([
        revenueService.getReport(clinic, week.dateFrom, week.dateTo, cache),
        cashInsuranceService.getReport(clinic, week.dateFrom, week.dateTo, cache),
        upfrontRevenueService.getReport(clinic, week.dateFrom, week.dateTo, cache),
        patientMetricsService.getReport(clinic, week.dateFrom, week.dateTo, cache),
      ]);
      return reportToWeekMetrics(week, revenue, insurance.grand.total, upfront.total, patients);
    })
  );

  const monthlyPromise = Promise.all([
    revenueService.getReport(clinic, monthRange.dateFrom, monthRange.dateTo, cache),
    cashInsuranceService.getReport(clinic, monthRange.dateFrom, monthRange.dateTo, cache),
    upfrontRevenueService.getReport(clinic, monthRange.dateFrom, monthRange.dateTo, cache),
    patientMetricsService.getReport(clinic, monthRange.dateFrom, monthRange.dateTo, cache),
  ] as const);

  const [weekResults, [monthlyRevenue, monthlyInsurance, monthlyUpfront, monthlyPatients]] =
    await Promise.all([weeksPromise, monthlyPromise]);

  const monthly = calculateMonthlyTotals(weekResults);
  // "Monthly Actual" comes from the real month query (includes weekends),
  // not from summing Mon-Fri weeks.
  monthly.totalRevenue         = monthlyRevenue.summary.grand.total;
  monthly.productSalesRevenue  = monthlyRevenue.summary.inventory.total;
  monthly.cashFromInsurance    = monthlyInsurance.grand.total;
  monthly.upfrontRevenue       = monthlyUpfront.total;
  monthly.newPatients          = monthlyPatients.newPatients;
  monthly.patientReactivations = monthlyPatients.patientReactivations;

  return {
    clinic:   clinic.name,
    clinicId: clinic.id,
    month,
    year,
    weeks:    weekResults,
    monthly,
  };
}

function reportToWeekMetrics(
  week: WeekRange,
  r:    Awaited<ReturnType<typeof revenueService.getReport>>,
  cashFromInsurance: number,
  upfrontRevenue:    number,
  patients:          Awaited<ReturnType<typeof patientMetricsService.getReport>>
): WeekMetrics {
  return {
    weekNum:  week.weekNum,
    label:    week.label,
    dateFrom: week.dateFrom,
    dateTo:   week.dateTo,

    totalRevenue:        r.summary.grand.total,
    productSalesRevenue: r.summary.inventory.total,
    cashFromInsurance,
    upfrontRevenue,

    debtCollection:      0,

    newPatients:          patients.newPatients,
    patientReactivations: patients.patientReactivations,
    newOptIns:            0,

    totalPatients:            0,
    appointmentsAttended:     0,
    appointmentsCancelled:    0,
    appointmentsRebooked:     0,
    noShows:                  0,
    showUpRate:               null,
    cancellationRate:         null,
    caseAcceptance:           null,
    upfrontPlanAccepted:      0,
    productsUpsold:           0,
    complementaryTransitions: 0,
    activePatients:           0,
  };
}
