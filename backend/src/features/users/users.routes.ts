import { Router, Response, NextFunction } from 'express';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';
import { requireRole } from '../../middleware/role.middleware';
import { usersService } from './users.service';
import { Errors } from '../../shared/errors';
import { audit } from '../../shared/audit';
import { Role, isClinicId, isRole } from '../../shared/roles';
import {
  createUserSchema,
  updateUserSchema,
  resetPasswordSchema,
  listUsersQuerySchema,
} from './users.validators';

const router = Router();

// All endpoints require an authenticated user.
router.use(authMiddleware);

// ── Staff dropdown helper ─────────────────────────────────────────────────
// GET /api/users/staff?role=CLINICIAN[&clinic_id=newport]
//
// Clinician picker rule (confirmed with Sam 2026-05-11): physios rotate
// between clinics, so when role=CLINICIAN is queried the dropdown shows
// every active clinician regardless of caller scope — only honor clinic_id
// if the caller explicitly asked to filter.
//
// Other roles (FRONT_DESK lookup, etc.) stay pinned by scope: single-clinic
// callers see only their own clinic; ADMIN / FRONT_DESK_GLOBAL may pass
// clinic_id or omit it for cross-clinic listing.
router.get('/staff', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const scope = req.scope!;
    const roleParam = req.query.role;
    if (!isRole(roleParam)) throw Errors.validation('role query param must be ADMIN/CLINICIAN/FRONT_DESK');

    const clinicParam = typeof req.query.clinic_id === 'string' ? req.query.clinic_id : undefined;
    if (clinicParam !== undefined && !isClinicId(clinicParam)) {
      throw Errors.validation(`Unknown clinic: ${clinicParam}`);
    }

    let clinicId: string | null;
    if (roleParam === 'CLINICIAN') {
      clinicId = clinicParam ?? null;
    } else if (scope.role === 'ADMIN' || scope.role === 'FRONT_DESK_GLOBAL') {
      clinicId = clinicParam ?? null;
    } else {
      clinicId = scope.clinic_id;
    }

    if (clinicId === null) {
      const rows = await usersService.list({ role: roleParam as Role, active: true });
      return res.json(rows);
    }
    const rows = await usersService.listActiveByClinic(clinicId, roleParam as Role);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── ADMIN-only endpoints below ────────────────────────────────────────────
router.use(requireRole('ADMIN'));

// GET /api/users  (admin: full list with optional filters)
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const filters = listUsersQuerySchema.parse(req.query);
    const rows    = await usersService.list(filters);
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/users/:id
router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const user = await usersService.get(req.params.id);
    res.json(user);
  } catch (err) { next(err); }
});

// POST /api/users
router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = createUserSchema.parse(req.body);
    const user = await usersService.create(body);
    await audit(req.scope!.userId, 'user.create', { user_id: user.id, email: user.email, role: user.role });
    res.status(201).json(user);
  } catch (err) { next(err); }
});

// PATCH /api/users/:id
router.patch('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const patch = updateUserSchema.parse(req.body);
    const user  = await usersService.update(req.params.id, patch);
    await audit(req.scope!.userId, 'user.update', { user_id: req.params.id, patch });
    res.json(user);
  } catch (err) { next(err); }
});

// POST /api/users/:id/password
router.post('/:id/password', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { password } = resetPasswordSchema.parse(req.body);
    await usersService.resetPassword(req.params.id, password);
    await audit(req.scope!.userId, 'user.password_reset', { user_id: req.params.id });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/users/:id/deactivate
router.post('/:id/deactivate', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (String(req.scope!.userId) === String(req.params.id)) {
      throw Errors.validation('You cannot deactivate your own account');
    }
    const user = await usersService.deactivate(req.params.id);
    await audit(req.scope!.userId, 'user.deactivate', { user_id: req.params.id });
    res.json(user);
  } catch (err) { next(err); }
});

// POST /api/users/:id/reactivate
router.post('/:id/reactivate', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const user = await usersService.reactivate(req.params.id);
    await audit(req.scope!.userId, 'user.reactivate', { user_id: req.params.id });
    res.json(user);
  } catch (err) { next(err); }
});

export default router;
