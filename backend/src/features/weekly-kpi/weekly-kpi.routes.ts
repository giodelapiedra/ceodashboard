import { Router, Response, NextFunction } from 'express';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';
import { requireRole } from '../../middleware/role.middleware';
import { weeklyKpiService } from './weekly-kpi.service';
import { audit } from '../../shared/audit';
import {
  submitMondaySchema,
  submitFridaySchema,
  trackerQuerySchema,
  historyQuerySchema,
  commentBodySchema,
} from './weekly-kpi.validators';

const router = Router();

// Team Performance KPI Reporting. Access is split down the middle, per spec
// section 2: CLINICIAN writes and reads only its own; ADMIN reads everything
// and writes nothing. Both checks live in the service (which is where the
// authority is), so the routes below carry only the coarse role gate.
router.use(authMiddleware);

// GET /api/weekly-kpi/model — the 30-signal registry the form renders itself
// from: groups, weights, question text, Standards, the point map and the bands.
//
// No requireRole: this is the questionnaire, not anyone's answers, and the
// tracker needs the same band labels and question text to explain a score that
// has already been submitted. Declared before /:id so Express cannot read
// "model" as a report id.
//
// Served rather than duplicated into the frontend. Thirty rows of text and
// weights copied into a second file is thirty chances for the form to ask
// something the scorer does not know about, and the physio would never see the
// difference — their score would just quietly be computed from a different set
// of questions than the one they answered.
// ?version=1.0 returns the model a HISTORICAL row was scored under, so a past
// week's breakdown is explained by the weights and band labels that actually
// produced it. Omitted, it returns the current model — what the form needs.
router.get('/model', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const version = typeof req.query.version === 'string' ? req.query.version : undefined;
    res.json(weeklyKpiService.model(version));
  } catch (err) { next(err); }
});

// ── The physio's own form ────────────────────────────────────────────────────

// GET /api/weekly-kpi/me — current week (or ?week=YYYY-MM-DD for a past one),
// with the half-filled row if Monday is already in.
router.get('/me', requireRole('CLINICIAN'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const week = typeof req.query.week === 'string' ? req.query.week : undefined;
    res.json(await weeklyKpiService.myWeek(req.scope!, week));
  } catch (err) { next(err); }
});

// GET /api/weekly-kpi/me/unread — the comment notification: how many comments
// are waiting for the caller and on which weeks. Polled by the frontend, so it
// is deliberately cheap (one grouped query) and open to BOTH sides of a thread
// — a physio gets Sam's comments, Sam gets replies on threads he is in.
router.get('/me/unread', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await weeklyKpiService.unreadForMe(req.scope!));
  } catch (err) { next(err); }
});

// GET /api/weekly-kpi/me/history — "para may history", newest week first.
router.get('/me/history', requireRole('CLINICIAN'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { limit, offset } = historyQuerySchema.parse(req.query);
    res.json(await weeklyKpiService.myHistory(req.scope!, limit, offset));
  } catch (err) { next(err); }
});

// POST /api/weekly-kpi/monday — save/correct the Monday half of THIS week.
// Neither the name nor the clinic is accepted from the body: both come off the
// authenticated account (see the validator's header note).
router.post('/monday', requireRole('CLINICIAN'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = submitMondaySchema.parse(req.body);
    const row  = await weeklyKpiService.submitMonday(req.scope!, body);
    await audit(req.scope!.userId, 'weekly_kpi.monday', {
      id: row.id, week_start: row.week_start, checkin_needed: row.checkin_needed,
    });
    res.status(201).json(row);
  } catch (err) { next(err); }
});

// POST /api/weekly-kpi/friday — close the loop on THIS week.
router.post('/friday', requireRole('CLINICIAN'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = submitFridaySchema.parse(req.body);
    const row  = await weeklyKpiService.submitFriday(req.scope!, body);
    await audit(req.scope!.userId, 'weekly_kpi.friday', {
      id: row.id, week_start: row.week_start, goal_achieved: row.goal_achieved,
    });
    res.json(row);
  } catch (err) { next(err); }
});

// ── The shared tracker (super admin) ────────────────────────────────────────

// GET /api/weekly-kpi/tracker?week=&clinic_id=&checkin_only=&open_only=
// Spec section 8. Must be declared before /:id or Express reads "tracker" as an id.
router.get('/tracker', requireRole('ADMIN'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const q = trackerQuerySchema.parse(req.query);
    res.json(await weeklyKpiService.tracker(req.scope!, q));
  } catch (err) { next(err); }
});

// GET /api/weekly-kpi/clinician/:id/history — one physio's full history, for
// the KPI tab on their profile page. Same reason as above: before /:id.
router.get('/clinician/:id/history', requireRole('ADMIN'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { limit, offset } = historyQuerySchema.parse(req.query);
    res.json(await weeklyKpiService.historyFor(req.params.id, req.scope!.userId, limit, offset));
  } catch (err) { next(err); }
});

// ── Comment threads (migration 033) ─────────────────────────────────────────
// No requireRole on any of these: a thread has two parties (the physio who owns
// the report, and the super admin) and the service is where that is decided.
// A role gate here would have to duplicate the ownership half of that rule and
// would drift from it. Every one of these paths has two or more segments, so
// none of them can be swallowed by the /:id route below.

// GET /api/weekly-kpi/:id/comments — the whole thread, oldest first.
router.get('/:id/comments', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await weeklyKpiService.listComments(req.scope!, req.params.id));
  } catch (err) { next(err); }
});

// POST /api/weekly-kpi/:id/comments — say something on this week.
router.post('/:id/comments', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { body } = commentBodySchema.parse(req.body);
    const row = await weeklyKpiService.addComment(req.scope!, req.params.id, body);
    await audit(req.scope!.userId, 'weekly_kpi.comment.create', {
      id: row.id, report_id: row.report_id,
    });
    res.status(201).json(row);
  } catch (err) { next(err); }
});

// POST /api/weekly-kpi/:id/comments/read — "I have read this thread."
// A POST, not a side effect of the GET above: the badge count is fetched to
// render the badge, and a GET that cleared it would clear it before anyone
// looked.
router.post('/:id/comments/read', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await weeklyKpiService.markThreadRead(req.scope!, req.params.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// PATCH /api/weekly-kpi/comments/:commentId — edit your own comment.
router.patch('/comments/:commentId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { body } = commentBodySchema.parse(req.body);
    const row = await weeklyKpiService.editComment(req.scope!, req.params.commentId, body);
    await audit(req.scope!.userId, 'weekly_kpi.comment.update', {
      id: row.id, report_id: row.report_id,
    });
    res.json(row);
  } catch (err) { next(err); }
});

// DELETE /api/weekly-kpi/comments/:commentId — remove your own comment.
router.delete('/comments/:commentId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { report_id } = await weeklyKpiService.deleteComment(req.scope!, req.params.commentId);
    await audit(req.scope!.userId, 'weekly_kpi.comment.delete', {
      id: req.params.commentId, report_id,
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/weekly-kpi/:id — remove one week outright, thread and all.
// Super admin only. requireRole here AND a check in the service: this is the
// only destructive route in the feature, and the two layers fail closed
// independently. Declared before the GET /:id below only for readability —
// Express keys on the method, so the order of these two does not matter.
router.delete('/:id', requireRole('ADMIN'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const removed = await weeklyKpiService.deleteReport(req.scope!, req.params.id);
    // The row is gone after this line, so everything worth knowing about it has
    // to be in the audit entry itself.
    await audit(req.scope!.userId, 'weekly_kpi.delete', {
      id:             removed.id,
      clinician_id:   removed.clinician_id,
      clinician_name: removed.clinician_name,
      week_start:     removed.week_start,
      had_friday:     removed.friday_submitted_at !== null,
      comment_count:  removed.comment_count ?? 0,
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /api/weekly-kpi/:id — one report in full. Owner or super admin; the
// service does that check, so no requireRole here.
router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await weeklyKpiService.getOne(req.scope!, req.params.id));
  } catch (err) { next(err); }
});

export default router;
