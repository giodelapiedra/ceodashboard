import { Router, Response, NextFunction } from 'express';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';
import { query } from '../../db/pool';

const router = Router();
router.use(authMiddleware);

// GET /api/patients/suggest?q=jo
//
// Patient-name autocomplete sourced purely from names WE have already encoded
// (patient_dropouts + case_acceptances + ad_leads). NOT connected to Nookal —
// this just helps staff reuse an existing spelling instead of retyping a
// returning patient's name. Returns up to 10 distinct names matching the
// prefix, most-recently-seen first.
router.get('/suggest', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const raw = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    // Need at least 2 chars — a single letter matches almost everything.
    if (raw.length < 2) return res.json([]);

    // Escape LIKE metacharacters so "%" / "_" typed by the user stay literal.
    const term = raw.replace(/[\\%_]/g, (m) => '\\' + m);

    const { rows } = await query<{ patient_name: string }>(
      `SELECT patient_name
         FROM (
           SELECT patient_name, date_logged FROM patient_dropouts
           UNION ALL
           SELECT patient_name, date_logged FROM case_acceptances
           UNION ALL
           SELECT patient_name, date_added AS date_logged FROM ad_leads
         ) t
        WHERE patient_name ILIKE $1 || '%' ESCAPE '\\'
        GROUP BY patient_name
        ORDER BY MAX(date_logged) DESC, patient_name ASC
        LIMIT 10`,
      [term],
    );

    res.json(rows.map((r) => r.patient_name));
  } catch (err) { next(err); }
});

export default router;
