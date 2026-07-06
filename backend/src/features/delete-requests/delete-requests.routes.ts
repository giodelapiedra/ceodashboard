import { Router, Response, NextFunction } from 'express';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';
import { deleteRequestService } from './delete-request.service';
import { audit } from '../../shared/audit';
import { createDeleteRequestSchema } from './delete-request.validators';

const router = Router();
router.use(authMiddleware);

// GET /api/delete-requests — ADMIN review queue (pending).
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = await deleteRequestService.listPending(req.scope!);
    res.json({ data });
  } catch (err) { next(err); }
});

// GET /api/delete-requests/mine — entity refs the caller has open requests for.
router.get('/mine', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = await deleteRequestService.myPending(req.scope!);
    res.json({ data });
  } catch (err) { next(err); }
});

// POST /api/delete-requests — file a delete request for one's own entry.
router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = createDeleteRequestSchema.parse(req.body);
    const reqRow = await deleteRequestService.create(req.scope!, body);
    await audit(req.scope!.userId, 'delete_request.create', {
      id: reqRow.id, entity_type: reqRow.entity_type, entity_id: reqRow.entity_id,
    });
    res.status(201).json(reqRow);
  } catch (err) { next(err); }
});

// POST /api/delete-requests/:id/approve — ADMIN approves (entry is deleted).
router.post('/:id/approve', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await deleteRequestService.approve(req.scope!, req.params.id);
    await audit(req.scope!.userId, 'delete_request.approve', { id: req.params.id });
    res.status(204).end();
  } catch (err) { next(err); }
});

// POST /api/delete-requests/:id/reject — ADMIN rejects (entry stays).
router.post('/:id/reject', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await deleteRequestService.reject(req.scope!, req.params.id);
    await audit(req.scope!.userId, 'delete_request.reject', { id: req.params.id });
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
