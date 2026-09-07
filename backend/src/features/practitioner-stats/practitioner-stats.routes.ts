import { Router, Response, NextFunction } from 'express';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';
import { requireRole } from '../../middleware/role.middleware';
import { practitionerStatsService } from './practitioner-stats.service';
import { practitionerStatsRepository } from './practitioner-stats.repository';
import { syncMonth } from './practitioner-stats.nookal';
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
 * Saves Total Appts and NC for one practitioner-week by hand. Upsert:
 * re-saving a week corrects it in place.
 *
 * Both are also filled by /sync now. This route stays because a person must
 * be able to correct a synced figure.
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
 * Pulls one month of Nookal diary data and fills Total Appts and NC for every
 * mapped practitioner-week.
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

export default router;
