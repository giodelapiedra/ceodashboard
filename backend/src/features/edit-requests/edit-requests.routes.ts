import { Router, Response, NextFunction } from 'express';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';
import { editRequestService } from './edit-request.service';
import { audit } from '../../shared/audit';
import { createEditRequestSchema, rejectEditRequestSchema } from './edit-request.validators';

const router = Router();
router.use(authMiddleware);

// GET /api/edit-requests — ADMIN review queue (pending).
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = await editRequestService.listPending(req.scope!);
    res.json({ data });
  } catch (err) { next(err); }
});

// GET /api/edit-requests/mine — entity refs the caller has open requests for.
router.get('/mine', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = await editRequestService.myPending(req.scope!);
    res.json({ data });
  } catch (err) { next(err); }
});

// GET /api/edit-requests/mine/rejected — recently rejected requests for the caller (30-day window).
router.get('/mine/rejected', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = await editRequestService.myRejected(req.scope!);
    res.json({ data });
  } catch (err) { next(err); }
});

// POST /api/edit-requests/:id/ack — requester dismisses a rejection banner for good.
router.post('/:id/ack', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await editRequestService.ackRejected(req.scope!, req.params.id);
    res.status(204).end();
  } catch (err) { next(err); }
});

// POST /api/edit-requests — submit a proposed edit with a reason.
router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body   = createEditRequestSchema.parse(req.body);
    const reqRow = await editRequestService.create(req.scope!, body);
    await audit(req.scope!.userId, 'edit_request.create', {
      id: reqRow.id, entity_type: reqRow.entity_type, entity_id: reqRow.entity_id,
    });
    res.status(201).json(reqRow);
  } catch (err) { next(err); }
});

// POST /api/edit-requests/:id/approve — ADMIN approves (patch applied to entry).
router.post('/:id/approve', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await editRequestService.approve(req.scope!, req.params.id);
    await audit(req.scope!.userId, 'edit_request.approve', { id: req.params.id });
    res.status(204).end();
  } catch (err) { next(err); }
});

// POST /api/edit-requests/:id/reject — ADMIN rejects with mandatory reason.
router.post('/:id/reject', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { rejection_reason } = rejectEditRequestSchema.parse(req.body);
    await editRequestService.reject(req.scope!, req.params.id, rejection_reason);
    await audit(req.scope!.userId, 'edit_request.reject', { id: req.params.id, rejection_reason });
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
