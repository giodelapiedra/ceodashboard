import { Router, Response, NextFunction } from 'express';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';
import { requireRole } from '../../middleware/role.middleware';
import { practitionerStatsService } from './practitioner-stats.service';
import { practitionerStatsRepository } from './practitioner-stats.repository';
import { syncMonth } from './practitioner-stats.nookal';
import { syncMonthOccupancyFromScraper, syncOccupancyFromScraper } from './practitioner-stats.occupancy-scraper';
import { NookalOccupancyScraper } from '../../services/nookal-occupancy-scraper.service';
import {
  practitionerStatsQuerySchema,
  upsertWeekInputSchema,
} from './practitioner-stats.validators';

const router = Router();

// Practitioner Stats is ADMIN-only (super admin / CEO). It ranks every
// clinician side by side across all three clinics, so it is deliberately not
// exposed to CLINICIAN or front-desk roles — a physio must not see a colleague's
// performance board. Read-only: every figure is derived from case_acceptances
// and patient_dropouts, nothing is written here.
router.use(authMiddleware);
router.use(requireRole('ADMIN'));

// GET /api/practitioner-stats?year=2026&month=7[&clinic_id=newport]
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { year, month, clinic_id } = practitionerStatsQuerySchema.parse(req.query);
    const report = await practitionerStatsService.getReport(year, month, clinic_id ?? null);
    res.json(report);
  } catch (err) { next(err); }
});

/**
 * PUT /api/practitioner-stats/week-input
 *
 * Saves Total Appts, Occupancy and NC for one practitioner-week by hand. Upsert:
 * re-saving a week corrects it in place.
 *
 * All three are also filled by /sync now. This route stays because a person must
 * be able to correct a synced figure, and because the sync cannot measure
 * occupancy for weeks whose roster has left Nookal — see migration 029. An
 * occupancy typed in here is marked as owned by a person and survives every
 * later sync.
 *
 * Not scoped by clinic: SOP steps 8 and 16 read these with the Nookal location
 * filter on "All Location", so the figures are practice-wide per practitioner.
 */
router.put('/week-input', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = upsertWeekInputSchema.parse(req.body);
    const enteredBy = req.scope?.userId;
    if (!enteredBy) return res.status(401).json({ message: 'Not authenticated' });

    await practitionerStatsRepository.upsertWeekInput({ ...body, entered_by: enteredBy });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * POST /api/practitioner-stats/sync?year=2026&month=7
 *
 * Pulls one month of Nookal diary data and fills Total Appts, NC, the cancelled
 * count and Occupancy for every mapped practitioner-week.
 *
 * Occupancy came in on 2026-08-20 via the v3 `availabilities` query — see
 * practitioner-stats.occupancy.ts for what it measures and how that differs from
 * Nookal's own Occupancy report. A value a person typed in is never overwritten,
 * and a week Nookal cannot measure is left as it was rather than blanked.
 *
 * Returns the mapping outcome as well, because a practitioner whose Nookal
 * provider record could not be matched contributes nothing and that has to be
 * visible rather than read as a genuine zero.
 */
router.post('/sync', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { year, month } = practitionerStatsQuerySchema.parse(req.query);
    const actingUserId = req.scope?.userId;
    if (!actingUserId) return res.status(401).json({ message: 'Not authenticated' });

    const result = await syncMonth(year, month, actingUserId);
    res.json(result);
  } catch (err) { next(err); }
});

/**
 * POST /api/practitioner-stats/sync-occupancy?year=2026&month=8[&week=1]
 *
 * Scrapes the Nookal Occupancy report from the web interface using browser automation.
 * This is the only way to get exact occupancy figures for older weeks where the API's
 * roster data has drifted.
 *
 * Requires NOOKAL_WEB_EMAIL and NOOKAL_WEB_PASSWORD in .env.
 *
 * If week is provided, syncs only that week. Otherwise syncs all weeks in the month.
 * Takes 30-60 seconds per week due to browser automation.
 */
router.post('/sync-occupancy', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { year, month } = practitionerStatsQuerySchema.parse(req.query);
    const week = req.query.week ? Number(req.query.week) : undefined;
    const actingUserId = req.scope?.userId;
    if (!actingUserId) return res.status(401).json({ message: 'Not authenticated' });

    // Check if Nookal web credentials are configured
    if (!NookalOccupancyScraper.isConfigured()) {
      return res.status(400).json({
        message: 'Nookal web credentials not configured. Set NOOKAL_WEB_EMAIL and NOOKAL_WEB_PASSWORD in .env'
      });
    }

    if (week !== undefined) {
      // Sync single week
      const result = await syncOccupancyFromScraper(year, month, week, actingUserId, {
        log: (line) => console.log(line),
      });
      res.json({ success: true, results: [result] });
    } else {
      // Sync all weeks in the month
      const results = await syncMonthOccupancyFromScraper(year, month, actingUserId, {
        log: (line) => console.log(line),
      });
      res.json({ success: true, results });
    }
  } catch (err) { next(err); }
});

/**
 * GET /api/practitioner-stats/occupancy-status
 *
 * Check if Nookal web credentials are configured for occupancy scraping.
 */
router.get('/occupancy-status', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json({
      configured: NookalOccupancyScraper.isConfigured(),
      message: NookalOccupancyScraper.isConfigured()
        ? 'Nookal web credentials configured — browser-based occupancy sync available'
        : 'Set NOOKAL_WEB_EMAIL and NOOKAL_WEB_PASSWORD in .env to enable browser-based occupancy sync',
    });
  } catch (err) { next(err); }
});

export default router;
