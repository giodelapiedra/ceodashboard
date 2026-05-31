import { Router, Response, NextFunction } from 'express';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';
import { requireRole } from '../../middleware/role.middleware';
import { adSpendService } from './ad-spend.service';
import { audit } from '../../shared/audit';
import {
  createAdSpendSchema,
  updateAdSpendSchema,
  listAdSpendQuerySchema,
} from './ad-spend.validators';

const router = Router();

// Ad spend is touched only by the dedicated encoder (ADSPEND) and by ADMIN
// (read / data-correction). Every other role is rejected up front.
router.use(authMiddleware);
router.use(requireRole('ADSPEND', 'ADMIN'));

// POST /api/ad-spend/sync-google?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
// ADMIN only — pulls spend from Google Ads API and upserts into ad_spend table.
router.post('/sync-google', requireRole('ADMIN'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { date_from, date_to } = req.query as { date_from?: string; date_to?: string };
    if (!date_from || !date_to) {
      res.status(400).json({ error: { message: 'date_from and date_to are required' } });
      return;
    }

    const result = await adSpendService.syncGoogleAds(date_from, date_to);
    await audit(req.scope!.userId, 'ad_spend.sync_google', { date_from, date_to, inserted: result.inserted });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/ad-spend
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const filters = listAdSpendQuerySchema.parse(req.query);
    const result  = await adSpendService.list(req.scope!, filters);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/ad-spend/summary — aggregate over the FULL filtered set.
router.get('/summary', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const filters = listAdSpendQuerySchema.parse(req.query);
    const summary = await adSpendService.summary(req.scope!, filters);
    res.json(summary);
  } catch (err) { next(err); }
});

// GET /api/ad-spend/weekly-report — weekly spend pivot by channel.
// Must come before /:id so Express doesn't swallow "weekly-report" as an id.
router.get('/weekly-report', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { date_from, date_to } = req.query as { date_from?: string; date_to?: string };
    if (!date_from || !date_to) {
      res.status(400).json({ error: { message: 'date_from and date_to are required' } });
      return;
    }
    const report = await adSpendService.weeklyReport(req.scope!, date_from, date_to);
    res.json(report);
  } catch (err) { next(err); }
});

// GET /api/ad-spend/:id
router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const row = await adSpendService.get(req.scope!, req.params.id);
    res.json(row);
  } catch (err) { next(err); }
});

// POST /api/ad-spend
router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = createAdSpendSchema.parse(req.body);
    const row  = await adSpendService.create(req.scope!, body);
    await audit(req.scope!.userId, 'ad_spend.create', { id: row.id, amount: row.amount, channel: row.channel });
    res.status(201).json(row);
  } catch (err) { next(err); }
});

// PATCH /api/ad-spend/:id
router.patch('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const patch = updateAdSpendSchema.parse(req.body);
    const row   = await adSpendService.update(req.scope!, req.params.id, patch);
    await audit(req.scope!.userId, 'ad_spend.update', { id: row.id });
    res.json(row);
  } catch (err) { next(err); }
});

// DELETE /api/ad-spend/:id
router.delete('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await adSpendService.delete(req.scope!, req.params.id);
    await audit(req.scope!.userId, 'ad_spend.delete', { id: req.params.id });
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
