import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { dashboardService } from '../services/dashboard.service';
import { nookalService } from '../services/nookal.service';
import { revenueService } from '../services/revenue.service';
import { cashInsuranceService } from '../services/cash-insurance.service';
import { upfrontRevenueService } from '../services/upfront-revenue.service';
import { patientMetricsService } from '../services/patient-metrics.service';
import { ageingDebtsService } from '../services/ageing-debts.service';
import {
  ageingDebtsManualService, isAgeingClinicId, AGEING_CLINIC_IDS, AgeingClinicId,
} from '../services/ageing-debts-manual.service';
import { calculateWeekMetrics } from '../services/kpi.calculator';
import { CLINICS } from '../types';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const router = Router();

router.use(authMiddleware);

// GET /api/dashboard/clinics
router.get('/clinics', (_req, res: Response) => {
  res.json(CLINICS.map((c) => ({ id: c.id, name: c.name })));
});

// GET /api/dashboard/ageing-debts?clinic=newport|narrabeen|brookvale|overall
// Returns a point-in-time snapshot of total outstanding invoice balances
// over a rolling 10-year window (today − 10 years → today). Cached in-memory
// for 4 hours (expensive paginated fetch).
// ?refresh=1 busts the cache.
router.get('/ageing-debts', async (req: AuthRequest, res: Response, next) => {
  try {
    const { clinic, refresh } = req.query;
    const forceRefresh = refresh === '1' || refresh === 'true';

    let locationIDs: number[] | undefined;
    if (clinic && clinic !== 'overall') {
      const clinicData = CLINICS.find((c) => c.id === clinic);
      if (!clinicData) {
        return res.status(400).json({ error: `Unknown clinic: ${clinic}` });
      }
      locationIDs = [clinicData.v3LocationId];
    }
    // clinic='overall' or omitted → all locations (no locationIDs filter)

    const result = await ageingDebtsService.get(locationIDs, forceRefresh);
    console.log(
      `[dashboard] ageing-debts ${clinic ?? 'overall'} — ${result.fromCache ? 'CACHE HIT' : 'FRESH'} total=$${result.total}`
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── Ageing Debts — manual entry (migrations 027 + 028) ────────
// The dashboard row is hand-typed, not pulled from Nookal (the /ageing-debts
// route above is kept only for cross-checking with the diag-ageing-* scripts).
//
// Typing moved from one box per MONTH to one box per WEEK COLUMN on 2026-08-12;
// the Monthly Actual is now their sum. The three `-manual` routes below are the
// 027 monthly figures, kept so months typed before that date still render (and
// can still be cleared). New writes go to `-manual-week`.
//
// 'overall' is stored separately in both, NOT summed from the three clinics.

/** Shared parse for the clinic/year/month triple these three routes all take. */
function parseAgeingPeriod(req: AuthRequest):
  | { ok: true; clinic: AgeingClinicId; year: number; month: number }
  | { ok: false; error: string } {
  const clinic = req.query.clinic ?? req.body?.clinic;
  const year   = Number(req.query.year  ?? req.body?.year);
  const month  = Number(req.query.month ?? req.body?.month);

  if (!isAgeingClinicId(clinic)) {
    return { ok: false, error: `clinic must be one of: ${AGEING_CLINIC_IDS.join(', ')}` };
  }
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    return { ok: false, error: 'Invalid year' };
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return { ok: false, error: 'Invalid month' };
  }
  return { ok: true, clinic, year, month };
}

/** week must be a dashboard column position, 1-based. */
function parseAgeingWeek(req: AuthRequest): number | null {
  const week = Number(req.query.week ?? req.body?.week);
  return Number.isInteger(week) && week >= 1 && week <= 6 ? week : null;
}

// GET /api/dashboard/ageing-debts-manual?clinic=newport&year=2026&month=8
// Returns the whole month: the typed week columns, the Monthly Actual derived
// from them, and which of the two it came from.
//   { weeks: [...], entry: <027 monthly or null>, total, source }
// `entry` is only ever non-null for months typed before weekly entry existed.
router.get('/ageing-debts-manual', async (req: AuthRequest, res: Response, next) => {
  try {
    const p = parseAgeingPeriod(req);
    if (!p.ok) return res.status(400).json({ error: p.error });

    const month = await ageingDebtsManualService.getMonth(p.clinic, p.year, p.month);
    res.json({
      weeks:  month.weeks,
      entry:  month.monthly,
      total:  month.total,
      source: month.source,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/dashboard/ageing-debts-manual-week
// Body: { clinic, year, month, week, amount }. Upsert — re-sending corrects
// that column. Returns the recomputed month so the caller never has to re-add
// the sum itself.
router.put('/ageing-debts-manual-week', requireRole('ADMIN'), async (req: AuthRequest, res: Response, next) => {
  try {
    const p = parseAgeingPeriod(req);
    if (!p.ok) return res.status(400).json({ error: p.error });

    const week = parseAgeingWeek(req);
    if (week === null) return res.status(400).json({ error: 'week must be a column number from 1 to 6' });

    // Reject NaN/Infinity/negatives here so the DB CHECK is a backstop, not the
    // error message the CEO sees.
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ error: 'amount must be a number of 0 or more' });
    }

    const month = await ageingDebtsManualService.upsertWeek(
      req.scope!, p.clinic, p.year, p.month, week, amount
    );
    res.json({ weeks: month.weeks, entry: month.monthly, total: month.total, source: month.source });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/dashboard/ageing-debts-manual-week?clinic=newport&year=2026&month=8&week=2
// Puts that one column back to "—" (a stored 0 means "nothing owed that week").
router.delete('/ageing-debts-manual-week', requireRole('ADMIN'), async (req: AuthRequest, res: Response, next) => {
  try {
    const p = parseAgeingPeriod(req);
    if (!p.ok) return res.status(400).json({ error: p.error });

    const week = parseAgeingWeek(req);
    if (week === null) return res.status(400).json({ error: 'week must be a column number from 1 to 6' });

    const month = await ageingDebtsManualService.clearWeek(req.scope!, p.clinic, p.year, p.month, week);
    res.json({ weeks: month.weeks, entry: month.monthly, total: month.total, source: month.source });
  } catch (err) {
    next(err);
  }
});

// PUT /api/dashboard/ageing-debts-manual
// Body: { clinic, year, month, amount }. Upsert — re-sending corrects the month.
router.put('/ageing-debts-manual', requireRole('ADMIN'), async (req: AuthRequest, res: Response, next) => {
  try {
    const p = parseAgeingPeriod(req);
    if (!p.ok) return res.status(400).json({ error: p.error });

    // Reject NaN/Infinity/negatives here so the DB CHECK is a backstop, not the
    // error message the CEO sees.
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ error: 'amount must be a number of 0 or more' });
    }

    const entry = await ageingDebtsManualService.upsert(req.scope!, p.clinic, p.year, p.month, amount);
    res.json({ entry });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/dashboard/ageing-debts-manual?clinic=newport&year=2026&month=8
// Puts the cell back to "—" (a stored 0 means "debts cleared", which is different).
router.delete('/ageing-debts-manual', requireRole('ADMIN'), async (req: AuthRequest, res: Response, next) => {
  try {
    const p = parseAgeingPeriod(req);
    if (!p.ok) return res.status(400).json({ error: p.error });

    await ageingDebtsManualService.clear(req.scope!, p.clinic, p.year, p.month);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/monthly?clinic=newport&month=4&year=2026[&refresh=1]
// clinic=overall returns a synthetic aggregate across all 3 clinics.
router.get('/monthly', async (req: AuthRequest, res: Response, next) => {
  try {
    const { clinic, month, year, refresh } = req.query;

    if (!clinic || !month || !year) {
      return res.status(400).json({ error: 'clinic, month, year are required' });
    }

    const m = Number(month);
    const y = Number(year);
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      return res.status(400).json({ error: 'Invalid month' });
    }
    if (!Number.isInteger(y) || y < 2020 || y > 2030) {
      return res.status(400).json({ error: 'Invalid year' });
    }

    const forceRefresh = refresh === '1' || refresh === 'true';

    if (clinic === 'overall') {
      const result = await dashboardService.getOverall(y, m, forceRefresh);
      console.log(
        `[dashboard] Overall ${m}/${y} — ${result.fromCache ? 'ALL CACHE' : 'ROLL-UP'} (${result.duration}ms)`
      );
      return res.json(result);
    }

    const clinicData = CLINICS.find((c) => c.id === clinic);
    if (!clinicData) {
      return res.status(400).json({ error: `Unknown clinic: ${clinic}` });
    }

    const result = await dashboardService.getMonthly(clinicData, y, m, forceRefresh);
    console.log(
      `[dashboard] ${clinicData.name} ${m}/${y} — ${result.fromCache ? 'CACHE HIT' : 'FRESH'} (${result.duration}ms)`
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/week?clinic=newport&dateFrom=...&dateTo=...
// Ad-hoc single week — not cached.
router.get('/week', async (req: AuthRequest, res: Response, next) => {
  try {
    const { clinic, dateFrom, dateTo, weekLabel, weekNum } = req.query;

    if (!clinic || !dateFrom || !dateTo) {
      return res.status(400).json({ error: 'clinic, dateFrom, dateTo required' });
    }

    const clinicData = CLINICS.find((c) => c.id === clinic);
    if (!clinicData) {
      return res.status(400).json({ error: `Unknown clinic: ${clinic}` });
    }

    const range = { dateFrom: String(dateFrom), dateTo: String(dateTo) };
    const locationId = clinicData.locationId;

    const [invoices, appointments, patients, inventory] = await Promise.all([
      nookalService.getInvoices(range, locationId),
      nookalService.getAppointments(range, locationId),
      nookalService.getPatients(range, locationId),
      nookalService.getInventory(range, locationId),
    ]);

    const week = {
      weekNum: (weekNum || 1) as any,
      label:    String(weekLabel || 'Custom'),
      dateFrom: range.dateFrom,
      dateTo:   range.dateTo,
    };

    const metrics = calculateWeekMetrics({ invoices, appointments, patients, inventory }, week);
    res.json({ metrics, fetchedAt: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/revenue?clinic=newport&dateFrom=2026-04-13&dateTo=2026-04-17
// Returns the Nookal Revenue Report shape (Services/Classes/Inventory/Passes/Other
// × Subtotal/GST/Total, plus per-item details). Sourced from v3 GraphQL.
router.get('/revenue', async (req: AuthRequest, res: Response, next) => {
  try {
    const { clinic, dateFrom, dateTo } = req.query;

    if (!clinic || !dateFrom || !dateTo) {
      return res.status(400).json({ error: 'clinic, dateFrom, dateTo required' });
    }
    if (!ISO_DATE.test(String(dateFrom)) || !ISO_DATE.test(String(dateTo))) {
      return res.status(400).json({ error: 'dateFrom and dateTo must be YYYY-MM-DD' });
    }

    const clinicData = CLINICS.find((c) => c.id === clinic);
    if (!clinicData) {
      return res.status(400).json({ error: `Unknown clinic: ${clinic}` });
    }

    const report = await revenueService.getReport(
      clinicData,
      String(dateFrom),
      String(dateTo)
    );
    res.json(report);
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/cash-insurance?clinic=newport&dateFrom=2026-04-13&dateTo=2026-04-17
// Cash collected from insurance patients (Health Fund + Medicare + DVA).
router.get('/cash-insurance', async (req: AuthRequest, res: Response, next) => {
  try {
    const { clinic, dateFrom, dateTo } = req.query;

    if (!clinic || !dateFrom || !dateTo) {
      return res.status(400).json({ error: 'clinic, dateFrom, dateTo required' });
    }
    if (!ISO_DATE.test(String(dateFrom)) || !ISO_DATE.test(String(dateTo))) {
      return res.status(400).json({ error: 'dateFrom and dateTo must be YYYY-MM-DD' });
    }

    const clinicData = CLINICS.find((c) => c.id === clinic);
    if (!clinicData) {
      return res.status(400).json({ error: `Unknown clinic: ${clinic}` });
    }

    const report = await cashInsuranceService.getReport(
      clinicData,
      String(dateFrom),
      String(dateTo)
    );
    res.json(report);
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/upfront-revenue?clinic=newport&dateFrom=2026-04-13&dateTo=2026-04-17
// Upfront revenue = account credits issued (Nookal: Reports → Account Credits).
router.get('/upfront-revenue', async (req: AuthRequest, res: Response, next) => {
  try {
    const { clinic, dateFrom, dateTo } = req.query;

    if (!clinic || !dateFrom || !dateTo) {
      return res.status(400).json({ error: 'clinic, dateFrom, dateTo required' });
    }
    if (!ISO_DATE.test(String(dateFrom)) || !ISO_DATE.test(String(dateTo))) {
      return res.status(400).json({ error: 'dateFrom and dateTo must be YYYY-MM-DD' });
    }

    const clinicData = CLINICS.find((c) => c.id === clinic);
    if (!clinicData) {
      return res.status(400).json({ error: `Unknown clinic: ${clinic}` });
    }

    const report = await upfrontRevenueService.getReport(
      clinicData,
      String(dateFrom),
      String(dateTo)
    );
    res.json(report);
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/patient-metrics?clinic=newport&dateFrom=2026-04-13&dateTo=2026-04-17
// New Patients (truly new to the practice) + Patient Reactivations
// (existing clients starting a new case) for a clinic/date range.
router.get('/patient-metrics', async (req: AuthRequest, res: Response, next) => {
  try {
    const { clinic, dateFrom, dateTo } = req.query;

    if (!clinic || !dateFrom || !dateTo) {
      return res.status(400).json({ error: 'clinic, dateFrom, dateTo required' });
    }
    if (!ISO_DATE.test(String(dateFrom)) || !ISO_DATE.test(String(dateTo))) {
      return res.status(400).json({ error: 'dateFrom and dateTo must be YYYY-MM-DD' });
    }

    const clinicData = CLINICS.find((c) => c.id === clinic);
    if (!clinicData) {
      return res.status(400).json({ error: `Unknown clinic: ${clinic}` });
    }

    const report = await patientMetricsService.getReport(
      clinicData,
      String(dateFrom),
      String(dateTo)
    );
    res.json(report);
  } catch (err) {
    next(err);
  }
});

export default router;
