import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { dashboardService } from '../services/dashboard.service';
import { nookalService } from '../services/nookal.service';
import { revenueService } from '../services/revenue.service';
import { cashInsuranceService } from '../services/cash-insurance.service';
import { upfrontRevenueService } from '../services/upfront-revenue.service';
import { patientMetricsService } from '../services/patient-metrics.service';
import { calculateWeekMetrics } from '../services/kpi.calculator';
import { CLINICS } from '../types';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const router = Router();

router.use(authMiddleware);

// GET /api/dashboard/clinics
router.get('/clinics', (_req, res: Response) => {
  res.json(CLINICS.map((c) => ({ id: c.id, name: c.name })));
});

// GET /api/dashboard/monthly?clinic=newport&month=4&year=2026[&refresh=1]
router.get('/monthly', async (req: AuthRequest, res: Response, next) => {
  try {
    const { clinic, month, year, refresh } = req.query;

    if (!clinic || !month || !year) {
      return res.status(400).json({ error: 'clinic, month, year are required' });
    }

    const clinicData = CLINICS.find((c) => c.id === clinic);
    if (!clinicData) {
      return res.status(400).json({ error: `Unknown clinic: ${clinic}` });
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
