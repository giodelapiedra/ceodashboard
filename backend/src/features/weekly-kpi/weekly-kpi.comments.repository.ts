import { query } from '../../db/pool';

/**
 * Comment threads on a weekly KPI report — migration 033.
 *
 * Kept in its own repository rather than bolted onto weekly-kpi.repository.ts:
 * the report tables and the comment tables share nothing but an id, and the
 * report repository is already the longest file in the feature. The service is
 * where the two are stitched together.
 */

export interface WeeklyKpiCommentDTO {
  id:          string;
  report_id:   string;
  author_id:   string;
  author_name: string | null;
  /** ADMIN / CLINICIAN — the UI labels the two sides of the thread with it. */
  author_role: string;
  body:        string;
  created_at:  string;
  updated_at:  string;
  /** updated_at > created_at, computed once here so every caller agrees. */
  edited:      boolean;
}

/** Per-report counts for one viewer. */
export interface CommentCounts {
  total:  number;
  unread: number;
}

/** A thread with something the physio has not read yet — drives the badge. */
export interface UnreadThread {
  report_id:  string;
  week_start: string;
  unread:     number;
}

interface CommentRow {
  id:          string;
  report_id:   string;
  author_id:   string;
  author_name: string | null;
  author_role: string;
  body:        string;
  created_at:  Date;
  updated_at:  Date;
}

function toDTO(r: CommentRow): WeeklyKpiCommentDTO {
  return {
    id:          r.id,
    report_id:   r.report_id,
    author_id:   r.author_id,
    author_name: r.author_name,
    author_role: r.author_role,
    body:        r.body,
    created_at:  r.created_at.toISOString(),
    updated_at:  r.updated_at.toISOString(),
    // Strict, and safe to be strict: both columns default to NOW() in the same
    // INSERT, and inside one statement NOW() is the transaction timestamp — so
    // an unedited row has them EXACTLY equal, not merely close. A tolerance
    // here would just hide edits made seconds after posting.
    edited:      r.updated_at.getTime() > r.created_at.getTime(),
  };
}

function isoDateOnly(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const SELECT_COMMENT = `
  SELECT c.id, c.report_id, c.author_id, c.body, c.created_at, c.updated_at,
         u.full_name AS author_name, u.role AS author_role
    FROM weekly_kpi_comments c
    JOIN users u ON u.id = c.author_id
`;

export const weeklyKpiCommentRepository = {
  /** One thread, oldest first — a conversation reads down the page. */
  async listForReport(reportId: string): Promise<WeeklyKpiCommentDTO[]> {
    const { rows } = await query<CommentRow>(
      `${SELECT_COMMENT} WHERE c.report_id = $1 ORDER BY c.created_at ASC, c.id ASC`,
      [reportId]
    );
    return rows.map(toDTO);
  },

  async findById(id: string): Promise<WeeklyKpiCommentDTO | null> {
    const { rows } = await query<CommentRow>(`${SELECT_COMMENT} WHERE c.id = $1`, [id]);
    return rows[0] ? toDTO(rows[0]) : null;
  },

  async add(reportId: string, authorId: string, body: string): Promise<WeeklyKpiCommentDTO> {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO weekly_kpi_comments (report_id, author_id, body)
       VALUES ($1, $2, $3) RETURNING id`,
      [reportId, authorId, body]
    );
    const saved = await this.findById(rows[0].id);
    if (!saved) throw new Error('Failed to read back the saved comment');
    return saved;
  },

  /** Scoped by author as well as id — a caller can only ever edit its own. */
  async update(id: string, authorId: string, body: string): Promise<WeeklyKpiCommentDTO | null> {
    const { rowCount } = await query(
      `UPDATE weekly_kpi_comments SET body = $3, updated_at = NOW()
        WHERE id = $1 AND author_id = $2`,
      [id, authorId, body]
    );
    if (!rowCount) return null;
    return this.findById(id);
  },

  async remove(id: string, authorId: string): Promise<boolean> {
    const { rowCount } = await query(
      `DELETE FROM weekly_kpi_comments WHERE id = $1 AND author_id = $2`,
      [id, authorId]
    );
    return !!rowCount;
  },

  /**
   * Counts for a set of reports, from one viewer's point of view.
   *
   * Unread = written by somebody else, after the last time this viewer opened
   * the thread. A thread never opened has no read row, hence the COALESCE to
   * -infinity: everything the other party wrote counts as unread, which is what
   * makes the badge appear the first time Sam comments.
   */
  async countsFor(reportIds: string[], viewerId: string): Promise<Map<string, CommentCounts>> {
    const out = new Map<string, CommentCounts>();
    if (reportIds.length === 0) return out;

    const { rows } = await query<{ report_id: string; total: string; unread: string }>(
      `SELECT c.report_id,
              COUNT(*)::bigint AS total,
              COUNT(*) FILTER (
                WHERE c.author_id <> $2
                  AND c.created_at > COALESCE(r.read_at, '-infinity'::timestamptz)
              )::bigint AS unread
         FROM weekly_kpi_comments c
         LEFT JOIN weekly_kpi_comment_reads r
                ON r.report_id = c.report_id AND r.user_id = $2
        WHERE c.report_id = ANY($1::bigint[])
        GROUP BY c.report_id`,
      [reportIds, viewerId]
    );

    for (const r of rows) {
      out.set(String(r.report_id), { total: Number(r.total), unread: Number(r.unread) });
    }
    return out;
  },

  /**
   * Every thread on THIS person's own reports that has something they have not
   * read. The physio's notification, and nothing more than that — it never
   * looks at reports belonging to anyone else.
   */
  async unreadForClinician(clinicianId: string): Promise<UnreadThread[]> {
    const { rows } = await query<{ report_id: string; week_start: Date; unread: string }>(
      `SELECT w.id AS report_id, w.week_start, COUNT(*)::bigint AS unread
         FROM weekly_kpi_comments c
         JOIN weekly_kpi_reports w ON w.id = c.report_id
         LEFT JOIN weekly_kpi_comment_reads r
                ON r.report_id = c.report_id AND r.user_id = $1
        WHERE w.clinician_id = $1
          AND c.author_id <> $1
          AND c.created_at > COALESCE(r.read_at, '-infinity'::timestamptz)
        GROUP BY w.id, w.week_start
        ORDER BY w.week_start DESC`,
      [clinicianId]
    );
    return rows.map(r => ({
      report_id:  String(r.report_id),
      week_start: isoDateOnly(r.week_start),
      unread:     Number(r.unread),
    }));
  },

  /** Same shape as unreadForClinician, for the super admin: replies waiting on
   *  threads he is part of. Only threads he has actually written in count —
   *  otherwise every physio's report would be an unread thread of his. */
  async unreadForAdmin(adminId: string): Promise<UnreadThread[]> {
    const { rows } = await query<{ report_id: string; week_start: Date; unread: string }>(
      `SELECT w.id AS report_id, w.week_start, COUNT(*)::bigint AS unread
         FROM weekly_kpi_comments c
         JOIN weekly_kpi_reports w ON w.id = c.report_id
         LEFT JOIN weekly_kpi_comment_reads r
                ON r.report_id = c.report_id AND r.user_id = $1
        WHERE c.author_id <> $1
          AND c.created_at > COALESCE(r.read_at, '-infinity'::timestamptz)
          AND EXISTS (
            SELECT 1 FROM weekly_kpi_comments mine
             WHERE mine.report_id = c.report_id AND mine.author_id = $1
          )
        GROUP BY w.id, w.week_start
        ORDER BY w.week_start DESC`,
      [adminId]
    );
    return rows.map(r => ({
      report_id:  String(r.report_id),
      week_start: isoDateOnly(r.week_start),
      unread:     Number(r.unread),
    }));
  },

  /** Stamp "I have read this thread up to now". Idempotent. */
  async markRead(reportId: string, userId: string): Promise<void> {
    await query(
      `INSERT INTO weekly_kpi_comment_reads (report_id, user_id, read_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (report_id, user_id) DO UPDATE SET read_at = NOW()`,
      [reportId, userId]
    );
  },
};
