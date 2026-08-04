import { Router, Response, NextFunction } from 'express';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';
import { adLeadService } from './ad-leads.service';
import { audit } from '../../shared/audit';
import {
  createAdLeadSchema,
  updateAdLeadSchema,
  listAdLeadsQuerySchema,
  checkAdLeadDuplicateSchema,
} from './ad-leads.validators';

const router = Router();
router.use(authMiddleware);

// GET /api/ad-leads
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const filters = listAdLeadsQuerySchema.parse(req.query);
    const result  = await adLeadService.list(req.scope!, filters);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/ad-leads/summary — aggregate over the full filtered set.
router.get('/summary', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const filters = listAdLeadsQuerySchema.parse(req.query);
    const summary = await adLeadService.summary(req.scope!, filters);
    res.json(summary);
  } catch (err) { next(err); }
});

// GET /api/ad-leads/:id
router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const row = await adLeadService.get(req.scope!, req.params.id);
    res.json(row);
  } catch (err) { next(err); }
});

// POST /api/ad-leads/sync-nookal-paid — resolve ALL booked leads' names to
// Nookal account totals and SAVE them on the lead rows. Manual-only (the Sync
// button); can take ~30s with a hundred-plus names, so no other endpoint
// triggers it. Writes only to our own ad_leads table, never to Nookal.
router.post('/sync-nookal-paid', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const summary = await adLeadService.syncNookalPaid(req.scope!);
    await audit(req.scope!.userId, 'ad_lead.sync_nookal_paid', summary);
    res.json(summary);
  } catch (err) { next(err); }
});

// POST /api/ad-leads/check-duplicate — pre-flight for the entry form. POST
// (not GET) because it takes the whole natural key as a body. Read-only.
router.post('/check-duplicate', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body   = checkAdLeadDuplicateSchema.parse(req.body);
    const report = await adLeadService.checkDuplicate(req.scope!, body);
    res.json(report);
  } catch (err) { next(err); }
});

// POST /api/ad-leads
// 201 on insert; 200 when the caller asked to overwrite an existing lead
// (nothing new was created, so 201 would be a lie).
router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = createAdLeadSchema.parse(req.body);
    const { row, outcome, replaced } = await adLeadService.create(req.scope!, body);

    if (outcome === 'overwritten') {
      // Keep the pre-overwrite values — an overwrite is the one path in this
      // feature that destroys data, so the audit trail has to be able to
      // reconstruct it.
      await audit(req.scope!.userId, 'ad_lead.overwrite', {
        id: row.id, clinic_id: row.clinic_id, before: replaced, after: row,
      });
      res.status(200).json(row);
    } else {
      await audit(req.scope!.userId, 'ad_lead.create', { id: row.id, clinic_id: row.clinic_id });
      res.status(201).json(row);
    }
  } catch (err) { next(err); }
});

// PATCH /api/ad-leads/:id
router.patch('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const patch = updateAdLeadSchema.parse(req.body);
    const row   = await adLeadService.update(req.scope!, req.params.id, patch);
    await audit(req.scope!.userId, 'ad_lead.update', { id: row.id });
    res.json(row);
  } catch (err) { next(err); }
});

// DELETE /api/ad-leads/:id
router.delete('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await adLeadService.delete(req.scope!, req.params.id);
    await audit(req.scope!.userId, 'ad_lead.delete', { id: req.params.id });
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
