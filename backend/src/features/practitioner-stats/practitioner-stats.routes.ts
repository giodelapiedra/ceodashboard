import { Router, Response, NextFunction } from 'express';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';
import { requireRole } from '../../middleware/role.middleware';
import { practitionerStatsService } from './practitioner-stats.service';
import { practitionerStatsQuerySchema } from './practitioner-stats.validators';

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

export default router;
