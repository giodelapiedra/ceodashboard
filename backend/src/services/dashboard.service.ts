import { revenueService } from './revenue.service';
import { cashInsuranceService } from './cash-insurance.service';
import { upfrontRevenueService } from './upfront-revenue.service';
import { patientMetricsService } from './patient-metrics.service';
import { NookalDataCache } from './nookal-v3/data-cache';
import { calculateMonthlyTotals } from './kpi.calculator';
import { getWeekRanges, getMonthRange } from './week.calculator';
import { snapshotRepository } from '../repositories/snapshot.repository';
import { dropoutRepository } from '../features/dropouts/dropout.repository';
import { caseAcceptanceRepository } from '../features/case-acceptance/case-acceptance.repository';
import { adSpendRepository } from '../features/ad-spend/ad-spend.repository';
import { env } from '../config/env';
import { Clinic, CLINICS, MonthlyDashboard, MonthlyTotals, WeekMetrics, WeekRange } from '../types';

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

function sumDays(
  perDay:   Map<string, number>,
  dateFrom: string,
  dateTo:   string
): number {
  let total = 0;
  for (const [day, n] of perDay) {
    if (day >= dateFrom && day <= dateTo) total += n;
  }
  return total;
}

type CaseDailyTotals = Map<string, { recs: number; booked: number; prepayAccepted: number }>;

/**
 * Weighted case-acceptance % over a date range:
 *   sum(appointments_booked) / sum(case_recommendations) * 100
 * Returns null when there are no recommendations in the range (matches
 * `caseAcceptanceRepository.aggregate`'s null-when-empty semantics, so the
 * dashboard cell renders "—" instead of "0%").
 */
function pctFromTotals(
  perDay:   CaseDailyTotals,
  dateFrom: string,
  dateTo:   string
): number | null {
  let recs = 0, booked = 0;
  for (const [day, t] of perDay) {
    if (day >= dateFrom && day <= dateTo) {
      recs   += t.recs;
      booked += t.booked;
    }
  }
  if (recs <= 0) return null;
  return Math.round((booked / recs) * 10_000) / 100;
}

/** Count of prepay_accepted=TRUE rows across a date range. */
function sumPrepayAccepted(
  perDay:   CaseDailyTotals,
  dateFrom: string,
  dateTo:   string
): number {
  let n = 0;
  for (const [day, t] of perDay) {
    if (day >= dateFrom && day <= dateTo) n += t.prepayAccepted;
  }
  return n;
}

/**
 * Cost Per Patient = ad spend / new patients. Null when there are no new
 * patients in the range (renders "—" instead of a divide-by-zero / Infinity).
 * Ad spend is global, so the SAME ad-spend figure is used at every clinic
 * view; only the new-patient denominator differs.
 */
function costPerPatient(adSpend: number, newPatients: number): number | null {
  if (newPatients <= 0) return null;
  return Math.round((adSpend / newPatients) * 100) / 100;
}

/**
 * Show Up Rate % = attended / (attended + cancelled + rebooked) × 100
 * Cancellation % = (cancelled + rebooked) / (attended + cancelled + rebooked) × 100
 *
 * Both share the same denominator (total bookings = attended + cancelled)
 * so they sum to 100%. Returns null when there are no bookings at all so
 * the dashboard renders "—" instead of "0%".
 *
 * Mirrors the spreadsheet formulas:
 *   Show Up:      =C21/(C21+SUM(C23:C24))
 *   Cancellation: =SUM(C23:C24)/(C21+SUM(C23:C24))
 */
function showUpPct(
  cancelled: number,
  rebooked:  number,
  attended:  number
): number | null {
  const totalBookings = attended + cancelled + rebooked;
  if (totalBookings <= 0) return null;
  return Math.round((attended / totalBookings) * 10_000) / 100;
}

function cancellationPct(
  cancelled: number,
  rebooked:  number,
  attended:  number
): number | null {
  const cancellations = cancelled + rebooked;
  const totalBookings = cancellations + attended;
  if (totalBookings <= 0) return null;
  return Math.round((cancellations / totalBookings) * 10_000) / 100;
}

/**
 * Re-apply fresh DB-sourced metrics to a cached MonthlyDashboard payload.
 * Cheap — two parallel SQL queries — and lets the cached snapshot stay
 * valid for the slow-moving Nookal data while surfacing today's
 * newly-logged dropout / case-acceptance entries.
 *
 * Writes through:
 *   - appointmentsCancelled = "Cancelled - not rescheduled" + "No Future Bookings"
 *   - appointmentsRebooked  = "Re-scheduled"
 *   - caseAcceptance        = weighted SUM(booked) / SUM(recs) * 100
 */
async function overlayLiveMetrics(
  payload:  MonthlyDashboard,
  clinicId: string | null,
  year:     number,
  month:    number
): Promise<MonthlyDashboard> {
  const monthRange = getMonthRange(year, month);
  const [dropoutCounts, caseTotals, adSpendDaily] = await Promise.all([
    // dropoutCountsByDate currently requires a clinic — Overall builds its
    // dropout numbers by summing per-clinic snapshots (already correct via
    // SUM_WEEK_FIELDS), so this overlay only runs for per-clinic payloads.
    clinicId
      ? dropoutRepository.dropoutCountsByDate(clinicId, monthRange.dateFrom, monthRange.dateTo)
      : Promise.resolve({ cancelled: new Map<string, number>(), rebooked: new Map<string, number>() }),
    caseAcceptanceRepository.dailyTotals(clinicId, monthRange.dateFrom, monthRange.dateTo),
    // Ad spend is global — re-overlay so newly-logged spend shows on a cache
    // hit without a full Nookal refetch.
    adSpendRepository.dailyTotals(monthRange.dateFrom, monthRange.dateTo),
  ]);

  const weeks = payload.weeks.map((w) => {
    const cancelled = clinicId ? sumDays(dropoutCounts.cancelled, w.dateFrom, w.dateTo) : w.appointmentsCancelled;
    const rebooked  = clinicId ? sumDays(dropoutCounts.rebooked,  w.dateFrom, w.dateTo) : w.appointmentsRebooked;
    const adSpend = sumDays(adSpendDaily, w.dateFrom, w.dateTo);
    return {
      ...w,
      appointmentsCancelled: cancelled,
      appointmentsRebooked:  rebooked,
      caseAcceptance:        pctFromTotals(caseTotals,     w.dateFrom, w.dateTo),
      upfrontPlanAccepted:   sumPrepayAccepted(caseTotals, w.dateFrom, w.dateTo),
      cancellationRate:      cancellationPct(cancelled, rebooked, w.appointmentsAttended),
      showUpRate:            showUpPct(cancelled, rebooked, w.appointmentsAttended),
      adSpend,
      costPerPatient:        costPerPatient(adSpend, w.newPatients),
    };
  });
  const mCancelled = clinicId ? sumDays(dropoutCounts.cancelled, monthRange.dateFrom, monthRange.dateTo) : payload.monthly.appointmentsCancelled;
  const mRebooked  = clinicId ? sumDays(dropoutCounts.rebooked,  monthRange.dateFrom, monthRange.dateTo) : payload.monthly.appointmentsRebooked;
  const mAdSpend = sumDays(adSpendDaily, monthRange.dateFrom, monthRange.dateTo);
  const monthly: MonthlyTotals = {
    ...payload.monthly,
    appointmentsCancelled: mCancelled,
    appointmentsRebooked:  mRebooked,
    caseAcceptance:        pctFromTotals(caseTotals,     monthRange.dateFrom, monthRange.dateTo),
    upfrontPlanAccepted:   sumPrepayAccepted(caseTotals, monthRange.dateFrom, monthRange.dateTo),
    cancellationRate:      cancellationPct(mCancelled, mRebooked, payload.monthly.appointmentsAttended),
    showUpRate:            showUpPct(mCancelled, mRebooked, payload.monthly.appointmentsAttended),
    adSpend:               mAdSpend,
    costPerPatient:        costPerPatient(mAdSpend, payload.monthly.newPatients),
  };
  return { ...payload, weeks, monthly };
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
        // Dropout + case-acceptance entries are logged daily — re-overlay
        // on every cache hit so the dashboard reflects newly-logged rows
        // without forcing a full Nookal refetch.
        const payload = await overlayLiveMetrics(cached.payload, clinic.id, year, month);
        return {
          ...payload,
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

  /**
   * "Overall" = sum of the 3 per-clinic snapshots for the same month.
   * Each clinic uses its own cache, so this is typically a cheap roll-up.
   * Numeric fields (revenue, counts) are summed; rate fields (showUpRate,
   * cancellationRate, caseAcceptance) are left null because a simple average
   * across clinics would be misleading without the underlying booked-appt
   * counts — we'll wire them properly once cancelled/rebooked metrics are in.
   */
  async getOverall(
    year:         number,
    month:        number,
    forceRefresh: boolean
  ): Promise<DashboardResult> {
    const startedAt = Date.now();

    const results = await Promise.all(
      CLINICS.map((c) => this.getMonthly(c, year, month, forceRefresh))
    );

    const weekCount = Math.max(...results.map((r) => r.weeks.length));
    const weeks: WeekMetrics[] = [];
    for (let i = 0; i < weekCount; i++) {
      const parts = results.map((r) => r.weeks[i]).filter(Boolean) as WeekMetrics[];
      if (parts.length) weeks.push(sumWeeks(parts));
    }

    const monthly = sumMonthly(results.map((r) => r.monthly));

    // Case-acceptance % is a ratio, not a sum — recompute cross-clinic
    // weighted % directly from raw daily totals (no clinic filter) so the
    // Overall view shows the true team-wide rate, not an avg of per-clinic %.
    const monthRange = getMonthRange(year, month);
    const [caseTotals, adSpendDaily] = await Promise.all([
      caseAcceptanceRepository.dailyTotals(null, monthRange.dateFrom, monthRange.dateTo),
      // Ad spend is global — NOT in SUM_WEEK_FIELDS, so sumWeeks zeroed it.
      // Recompute once here so Overall shows the true business-wide figure
      // instead of 3× (one per clinic).
      adSpendRepository.dailyTotals(monthRange.dateFrom, monthRange.dateTo),
    ]);
    for (const w of weeks) {
      w.caseAcceptance = pctFromTotals(caseTotals, w.dateFrom, w.dateTo);
      // Ratios — derive from already-summed counts (cancelled, rebooked,
      // attended are all in SUM_WEEK_FIELDS).
      w.cancellationRate = cancellationPct(
        w.appointmentsCancelled, w.appointmentsRebooked, w.appointmentsAttended
      );
      w.showUpRate = showUpPct(
        w.appointmentsCancelled, w.appointmentsRebooked, w.appointmentsAttended
      );
      w.adSpend = sumDays(adSpendDaily, w.dateFrom, w.dateTo);
      w.costPerPatient = costPerPatient(w.adSpend, w.newPatients);
    }
    monthly.caseAcceptance   = pctFromTotals(caseTotals, monthRange.dateFrom, monthRange.dateTo);
    monthly.adSpend          = sumDays(adSpendDaily, monthRange.dateFrom, monthRange.dateTo);
    monthly.costPerPatient   = costPerPatient(monthly.adSpend, monthly.newPatients);
    monthly.cancellationRate = cancellationPct(
      monthly.appointmentsCancelled, monthly.appointmentsRebooked, monthly.appointmentsAttended
    );
    monthly.showUpRate = showUpPct(
      monthly.appointmentsCancelled, monthly.appointmentsRebooked, monthly.appointmentsAttended
    );

    return {
      clinic:    'Overall',
      clinicId:  'overall',
      month, year,
      weeks,
      monthly,
      fetchedAt: new Date().toISOString(),
      fromCache: results.every((r) => r.fromCache),
      duration:  Date.now() - startedAt,
    };
  },
};

const SUM_WEEK_FIELDS: (keyof WeekMetrics)[] = [
  'totalRevenue', 'productSalesRevenue', 'upfrontRevenue', 'cashFromInsurance',
  'debtCollection', 'newPatients', 'patientReactivations', 'newOptIns',
  'totalPatients', 'appointmentsAttended', 'appointmentsCancelled',
  'appointmentsRebooked', 'noShows', 'upfrontPlanAccepted', 'productsUpsold',
  'complementaryTransitions', 'activePatients',
];

const SUM_MONTHLY_FIELDS: (keyof MonthlyTotals)[] = SUM_WEEK_FIELDS as (keyof MonthlyTotals)[];

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

function sumWeeks(parts: WeekMetrics[]): WeekMetrics {
  const first = parts[0];
  const out: WeekMetrics = {
    weekNum:          first.weekNum,
    label:            first.label,
    dateFrom:         first.dateFrom,
    dateTo:           first.dateTo,
    totalRevenue:     0, productSalesRevenue: 0, upfrontRevenue: 0,
    cashFromInsurance: 0, debtCollection: 0,
    newPatients: 0, patientReactivations: 0, newOptIns: 0,
    adSpend: 0, costPerPatient: null,
    totalPatients: 0, appointmentsAttended: 0, appointmentsCancelled: 0,
    appointmentsRebooked: 0, noShows: 0,
    showUpRate: null, cancellationRate: null, caseAcceptance: null,
    upfrontPlanAccepted: 0, productsUpsold: 0,
    complementaryTransitions: 0, activePatients: 0,
  };
  for (const key of SUM_WEEK_FIELDS) {
    const sum = parts.reduce((s, p) => s + ((p[key] as number) || 0), 0);
    (out[key] as number) = roundMoney(sum);
  }
  return out;
}

function sumMonthly(parts: MonthlyTotals[]): MonthlyTotals {
  const out: MonthlyTotals = {
    totalRevenue: 0, productSalesRevenue: 0, upfrontRevenue: 0,
    cashFromInsurance: 0, debtCollection: 0,
    newPatients: 0, patientReactivations: 0, newOptIns: 0,
    adSpend: 0, costPerPatient: null,
    totalPatients: 0, appointmentsAttended: 0, appointmentsCancelled: 0,
    appointmentsRebooked: 0, noShows: 0,
    showUpRate: null, cancellationRate: null, caseAcceptance: null,
    upfrontPlanAccepted: 0, productsUpsold: 0,
    complementaryTransitions: 0, activePatients: 0,
  };
  for (const key of SUM_MONTHLY_FIELDS) {
    const sum = parts.reduce((s, p) => s + ((p[key] as number) || 0), 0);
    (out[key] as number) = roundMoney(sum);
  }
  return out;
}

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

  // DB-sourced rows (single query each, bucketed per week below):
  //   - dropouts → "Cancelled with No Rebooking" + "Cancelled & Rebooked"
  //   - case_acceptances → "Case Acceptance % For All Team" (weighted)
  const dropoutCountsPromise   = dropoutRepository.dropoutCountsByDate(
    clinic.id, monthRange.dateFrom, monthRange.dateTo
  );
  const caseTotalsPromise = caseAcceptanceRepository.dailyTotals(
    clinic.id, monthRange.dateFrom, monthRange.dateTo
  );
  // Ad spend is global (no clinic) — the SAME daily totals feed every clinic
  // view. Bucketed per week below, exactly like case acceptance.
  const adSpendDailyPromise = adSpendRepository.dailyTotals(
    monthRange.dateFrom, monthRange.dateTo
  );

  const [
    weekResults,
    [monthlyRevenue, monthlyInsurance, monthlyUpfront, monthlyPatients],
    dropoutCounts,
    caseTotals,
    adSpendDaily,
  ] = await Promise.all([weeksPromise, monthlyPromise, dropoutCountsPromise, caseTotalsPromise, adSpendDailyPromise]);

  // Per-week totals (sum of per-day counts falling inside each week's range).
  for (const wm of weekResults) {
    wm.appointmentsCancelled = sumDays(dropoutCounts.cancelled, wm.dateFrom, wm.dateTo);
    wm.appointmentsRebooked  = sumDays(dropoutCounts.rebooked,  wm.dateFrom, wm.dateTo);
    wm.caseAcceptance        = pctFromTotals(caseTotals,        wm.dateFrom, wm.dateTo);
    wm.upfrontPlanAccepted   = sumPrepayAccepted(caseTotals,    wm.dateFrom, wm.dateTo);
    wm.cancellationRate      = cancellationPct(
      wm.appointmentsCancelled, wm.appointmentsRebooked, wm.appointmentsAttended
    );
    wm.showUpRate            = showUpPct(
      wm.appointmentsCancelled, wm.appointmentsRebooked, wm.appointmentsAttended
    );
    wm.adSpend               = sumDays(adSpendDaily, wm.dateFrom, wm.dateTo);
    wm.costPerPatient        = costPerPatient(wm.adSpend, wm.newPatients);
  }

  const monthly = calculateMonthlyTotals(weekResults);
  // "Monthly Actual" comes from the real month query (includes weekends),
  // not from summing Mon-Fri weeks.
  monthly.totalRevenue         = monthlyRevenue.summary.grand.total;
  monthly.productSalesRevenue  = monthlyRevenue.summary.inventory.total;
  monthly.cashFromInsurance    = monthlyInsurance.grand.total;
  monthly.upfrontRevenue       = monthlyUpfront.total;
  monthly.newPatients          = monthlyPatients.newPatients;
  monthly.patientReactivations = monthlyPatients.patientReactivations;
  // Ad spend (global) — full-month total, same "Monthly Actual" semantics.
  monthly.adSpend              = sumDays(adSpendDaily, monthRange.dateFrom, monthRange.dateTo);
  monthly.costPerPatient       = costPerPatient(monthly.adSpend, monthly.newPatients);
  // DB-sourced rows: full-month totals (including weekend logging),
  // matching the "Monthly Actual" semantics above. caseAcceptance is
  // weighted over the entire month, not an average of weekly rates.
  monthly.appointmentsCancelled = sumDays(dropoutCounts.cancelled, monthRange.dateFrom, monthRange.dateTo);
  monthly.appointmentsRebooked  = sumDays(dropoutCounts.rebooked,  monthRange.dateFrom, monthRange.dateTo);
  monthly.caseAcceptance        = pctFromTotals(caseTotals,        monthRange.dateFrom, monthRange.dateTo);
  monthly.upfrontPlanAccepted   = sumPrepayAccepted(caseTotals,    monthRange.dateFrom, monthRange.dateTo);
  monthly.cancellationRate      = cancellationPct(
    monthly.appointmentsCancelled, monthly.appointmentsRebooked, monthly.appointmentsAttended
  );
  monthly.showUpRate            = showUpPct(
    monthly.appointmentsCancelled, monthly.appointmentsRebooked, monthly.appointmentsAttended
  );
  // totalPatients intentionally NOT overridden — per Sam: Monthly = sum of
  // weekly totals (same client seen multiple weeks counts once per week).
  // calculateMonthlyTotals already sums the week values for this field.

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
    adSpend:              0,
    costPerPatient:       null,

    totalPatients:            patients.uniqueClients,
    appointmentsAttended:     patients.completedConsults,
    appointmentsCancelled:    0,
    appointmentsRebooked:     0,
    noShows:                  patients.didNotArrive,
    showUpRate:               null,
    cancellationRate:         null,
    caseAcceptance:           null,
    upfrontPlanAccepted:      0,
    productsUpsold:           0,
    complementaryTransitions: 0,
    activePatients:           0,
  };
}
