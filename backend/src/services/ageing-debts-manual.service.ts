/**
 * Ageing Debts — manual entry
 *
 * The CEO dashboard's Ageing Debts figure is typed in by hand rather than
 * pulled from Nookal. Sam moved the typing from one box per MONTH (migration
 * 027) to one box per WEEK COLUMN (migration 028) on 2026-08-12, with the
 * Monthly Actual computed as their sum.
 *
 * Two stores, one read rule:
 *   - `ageing_debts_manual_week` — the current way in. Monthly = SUM of weeks.
 *   - `ageing_debts_manual`      — the 027 monthly figures, kept so the months
 *                                  Sam already typed keep showing. Read ONLY
 *                                  when a month has no weekly rows at all.
 * Writing the first week of a month deletes that month's 027 row, so a month is
 * never served from both.
 *
 * 'overall' is its own stored clinic in both tables, not a sum of the three.
 *
 * Reads are open to any authenticated caller that can already see the
 * dashboard; writes are ADMIN-only and gated at the route.
 */

import { query, withTransaction } from '../db/pool';
import { RequestScope } from '../middleware/auth.middleware';
import { Errors } from '../shared/errors';

/** Dashboard clinic selector values, including the synthetic 'overall'. */
export const AGEING_CLINIC_IDS = ['newport', 'narrabeen', 'brookvale', 'overall'] as const;
export type AgeingClinicId = typeof AGEING_CLINIC_IDS[number];

export function isAgeingClinicId(value: unknown): value is AgeingClinicId {
  return typeof value === 'string' && (AGEING_CLINIC_IDS as readonly string[]).includes(value);
}

export interface AgeingDebtsManualEntry {
  clinic_id:  AgeingClinicId;
  year:       number;
  month:      number;
  amount:     number;
  updated_at: string;
  /** Display name of whoever last typed it — shown next to the figure. */
  updated_by_name: string | null;
}

/** One typed week column. `week_num` is the 1-based dashboard column position. */
export interface AgeingDebtsWeekEntry {
  week_num:        number;
  amount:          number;
  updated_at:      string;
  updated_by_name: string | null;
}

/**
 * Everything the dashboard needs for one clinic-month.
 *
 * `total` is what goes in the Monthly Actual cell, and `source` says where it
 * came from so the UI can render the cell as a computed sum ('weeks') or as the
 * old editable box ('monthly'). null total + 'none' = nothing typed yet.
 */
export interface AgeingDebtsMonth {
  weeks:   AgeingDebtsWeekEntry[];
  /** The 027 monthly figure. Only ever set when `weeks` is empty. */
  monthly: AgeingDebtsManualEntry | null;
  total:   number | null;
  source:  'weeks' | 'monthly' | 'none';
}

interface Row {
  clinic_id:       string;
  year:            number;
  month:           number;
  // NUMERIC comes back from pg as a string — never read it as a number directly.
  amount:          string;
  updated_at:      Date;
  updated_by_name: string | null;
}

interface WeekRow extends Row {
  week_num: number;
}

function toEntry(row: Row): AgeingDebtsManualEntry {
  return {
    clinic_id:       row.clinic_id as AgeingClinicId,
    year:            row.year,
    month:           row.month,
    amount:          Number(row.amount),
    updated_at:      row.updated_at.toISOString(),
    updated_by_name: row.updated_by_name,
  };
}

function toWeekEntry(row: WeekRow): AgeingDebtsWeekEntry {
  return {
    week_num:        row.week_num,
    amount:          Number(row.amount),
    updated_at:      row.updated_at.toISOString(),
    updated_by_name: row.updated_by_name,
  };
}

// Prefer the last editor's name, falling back to the original enterer's — a row
// created and never edited has updated_by NULL.
const SELECT_SQL = `
  SELECT a.clinic_id, a.year, a.month, a.amount, a.updated_at,
         COALESCE(u.full_name, e.full_name) AS updated_by_name
    FROM ageing_debts_manual a
    LEFT JOIN users u ON u.id = a.updated_by
    LEFT JOIN users e ON e.id = a.entered_by
`;

const SELECT_WEEK_SQL = `
  SELECT a.clinic_id, a.year, a.month, a.week_num, a.amount, a.updated_at,
         COALESCE(u.full_name, e.full_name) AS updated_by_name
    FROM ageing_debts_manual_week a
    LEFT JOIN users u ON u.id = a.updated_by
    LEFT JOIN users e ON e.id = a.entered_by
`;

export const ageingDebtsManualService = {
  /**
   * Everything the dashboard shows for one clinic-month: the typed week columns
   * and the Monthly Actual derived from them.
   *
   * Weeks win whenever at least one exists. A month with no weeks falls back to
   * its 027 monthly figure so nothing Sam typed before 2026-08-12 disappears.
   */
  async getMonth(clinicId: AgeingClinicId, year: number, month: number): Promise<AgeingDebtsMonth> {
    const { rows } = await query<WeekRow>(
      `${SELECT_WEEK_SQL}
        WHERE a.clinic_id = $1 AND a.year = $2 AND a.month = $3
        ORDER BY a.week_num`,
      [clinicId, year, month]
    );
    const weeks = rows.map(toWeekEntry);

    if (weeks.length > 0) {
      // Sum, not last-week-wins: Sam's explicit choice (see migration 028).
      const total = weeks.reduce((sum, w) => sum + w.amount, 0);
      // Round to cents — floating-point addition of 2dp values drifts
      // (0.1 + 0.2), and this figure is money the CEO reads off the screen.
      return { weeks, monthly: null, total: Math.round(total * 100) / 100, source: 'weeks' };
    }

    const legacy = await this.get(clinicId, year, month);
    return legacy
      ? { weeks: [], monthly: legacy, total: legacy.amount, source: 'monthly' }
      : { weeks: [], monthly: null, total: null, source: 'none' };
  },

  /**
   * Create or correct ONE week column. ADMIN only (enforced at the route too).
   *
   * Also drops the month's 027 row: once a month is typed week-by-week, the old
   * monthly figure is stale and must never come back as a fallback when a week
   * is later cleared.
   */
  async upsertWeek(
    scope: RequestScope,
    clinicId: AgeingClinicId,
    year: number,
    month: number,
    weekNum: number,
    amount: number
  ): Promise<AgeingDebtsMonth> {
    if (scope.role !== 'ADMIN') {
      throw Errors.forbidden('Only ADMIN can enter Ageing Debts');
    }

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO ageing_debts_manual_week (clinic_id, year, month, week_num, amount, entered_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (clinic_id, year, month, week_num) DO UPDATE
           SET amount     = EXCLUDED.amount,
               updated_at = NOW(),
               updated_by = EXCLUDED.entered_by`,
        [clinicId, year, month, weekNum, amount, scope.userId]
      );
      await client.query(
        `DELETE FROM ageing_debts_manual WHERE clinic_id = $1 AND year = $2 AND month = $3`,
        [clinicId, year, month]
      );
    });

    return this.getMonth(clinicId, year, month);
  },

  /**
   * Clear ONE week column, putting that cell back to "—". Deleting rather than
   * storing 0 keeps "not entered" distinct from "$0.00", same as the monthly
   * figure always did. Clearing the last week leaves the month blank — the 027
   * fallback was already dropped when the first week was typed.
   */
  async clearWeek(
    scope: RequestScope,
    clinicId: AgeingClinicId,
    year: number,
    month: number,
    weekNum: number
  ): Promise<AgeingDebtsMonth> {
    if (scope.role !== 'ADMIN') {
      throw Errors.forbidden('Only ADMIN can clear Ageing Debts');
    }
    await query(
      `DELETE FROM ageing_debts_manual_week
        WHERE clinic_id = $1 AND year = $2 AND month = $3 AND week_num = $4`,
      [clinicId, year, month, weekNum]
    );
    return this.getMonth(clinicId, year, month);
  },

  /** The typed figure for one clinic-month, or null if nobody has entered it. */
  async get(clinicId: AgeingClinicId, year: number, month: number): Promise<AgeingDebtsManualEntry | null> {
    const { rows } = await query<Row>(
      `${SELECT_SQL} WHERE a.clinic_id = $1 AND a.year = $2 AND a.month = $3`,
      [clinicId, year, month]
    );
    return rows[0] ? toEntry(rows[0]) : null;
  },

  /**
   * Create or correct the figure for one clinic-month. ADMIN only (enforced at
   * the route); the scope is still checked here so a future caller that skips
   * the middleware can't write.
   */
  async upsert(
    scope: RequestScope,
    clinicId: AgeingClinicId,
    year: number,
    month: number,
    amount: number
  ): Promise<AgeingDebtsManualEntry> {
    if (scope.role !== 'ADMIN') {
      throw Errors.forbidden('Only ADMIN can enter Ageing Debts');
    }

    const { rows } = await query<Row>(
      `WITH upserted AS (
         INSERT INTO ageing_debts_manual (clinic_id, year, month, amount, entered_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (clinic_id, year, month) DO UPDATE
           SET amount     = EXCLUDED.amount,
               updated_at = NOW(),
               updated_by = EXCLUDED.entered_by
         RETURNING clinic_id, year, month, amount, updated_at, updated_by, entered_by
       )
       SELECT a.clinic_id, a.year, a.month, a.amount, a.updated_at,
              COALESCE(u.full_name, e.full_name) AS updated_by_name
         FROM upserted a
         LEFT JOIN users u ON u.id = a.updated_by
         LEFT JOIN users e ON e.id = a.entered_by`,
      [clinicId, year, month, amount, scope.userId]
    );
    return toEntry(rows[0]);
  },

  /**
   * Clear the figure for one clinic-month, putting the cell back to "—".
   * Deleting rather than storing 0 keeps "not entered" distinct from "$0.00".
   */
  async clear(scope: RequestScope, clinicId: AgeingClinicId, year: number, month: number): Promise<void> {
    if (scope.role !== 'ADMIN') {
      throw Errors.forbidden('Only ADMIN can clear Ageing Debts');
    }
    await query(
      `DELETE FROM ageing_debts_manual WHERE clinic_id = $1 AND year = $2 AND month = $3`,
      [clinicId, year, month]
    );
  },
};
