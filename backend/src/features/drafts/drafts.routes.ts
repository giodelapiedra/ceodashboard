import { Router, Response, NextFunction } from 'express';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';
import { draftService } from './draft.service';
import { audit } from '../../shared/audit';
import {
  createDraftSchema,
  updateDraftSchema,
  listDraftsQuerySchema,
} from './draft.validators';

const router = Router();
router.use(authMiddleware);

// GET /api/drafts?kind=dropout|case_acceptance — the caller's own drafts.
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { kind } = listDraftsQuerySchema.parse(req.query);
    const drafts = await draftService.list(req.scope!, kind);
    res.json({ data: drafts });
  } catch (err) { next(err); }
});

// POST /api/drafts — save a new draft.
router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body  = createDraftSchema.parse(req.body);
    const draft = await draftService.create(req.scope!, body);
    await audit(req.scope!.userId, 'draft.create', { id: draft.id, kind: draft.kind });
    res.status(201).json(draft);
  } catch (err) { next(err); }
});

// PATCH /api/drafts/:id — overwrite an existing draft with a newer snapshot.
router.patch('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const patch = updateDraftSchema.parse(req.body);
    const draft = await draftService.update(req.scope!, req.params.id, patch);
    res.json(draft);
  } catch (err) { next(err); }
});

// DELETE /api/drafts/:id — discard a draft (also called after it's submitted
// as a real entry).
router.delete('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await draftService.delete(req.scope!, req.params.id);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
