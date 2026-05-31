import { query } from '../../db/pool';
import { RequestScope } from '../../middleware/auth.middleware';
import { DropoutStatus, DropoutReason } from '../../shared/roles';

export interface DropoutRow {
  id:                          string;
  clinic_id:                   string;
  entered_by:                  string;
  // Free-form text. CLINICIAN entries are constrained at the validator to
  // FRONT_STAFF_NAMES; receptionist (FRONT_DESK / FRONT_DESK_GLOBAL) entries
  // are stamped server-side with the caller's users.full_name.
  front_staff_name:            string | null;
  clinician_id:                string;
  patient_name:                string;
  date_logged:                 Date;
  // Multiple cancelled-appointment dates per dropout entry (since 009).
  // Empty array if none were recorded.
  appointment_cancelled_dates: Date[];
  // Nullable since 006 — legacy 2026 import preserves blank status/reason
  // verbatim. Manual entry form still requires both via zod validators.
  status:                      DropoutStatus | null;
  reason:                      DropoutReason | null;
  notes:                       string | null;
  created_at:                  Date;
  updated_at:                  Date;
  updated_by:                  string | null;
}

export interface DropoutDTO {
  id:                          string;
  clinic_id:                   string;
  entered_by:                  string;
  entered_by_name:             string | null;
  front_staff_name:            string | null;
  clinician_id:                string;
  clinician_name:              string | null;
  patient_name:                string;
  date_logged:                 string; // YYYY-MM-DD
  appointment_cancelled_dates: string[]; // YYYY-MM-DD[]
  status:                      DropoutStatus | null;
  reason:                      DropoutReason | null;
  notes:                       string | null;
  created_at:                  string;
  updated_at:                  string;
}

interface DropoutJoinedRow extends DropoutRow {
  entered_by_name:  string | null;
  clinician_name:   string | null;
}

function isoDateOnly(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  // pg returns a DATE column as a JS Date at LOCAL midnight (TZ-aware), so
  // toISOString() shifts to UTC and lands on the previous day in any TZ east
  // of UTC. Use the Date's local components to keep the stored calendar day.
  if (typeof d === 'string') return d.slice(0, 10);
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function toDTO(row: DropoutJoinedRow): DropoutDTO {
  return {
    id:                          row.id,
    clinic_id:                   row.clinic_id,
    entered_by:                  row.entered_by,
    entered_by_name:             row.entered_by_name,
    front_staff_name:            row.front_staff_name,
    clinician_id:                row.clinician_id,
    clinician_name:              row.clinician_name,
    patient_name:                row.patient_name,
    date_logged:                 isoDateOnly(row.date_logged) ?? '',
    // Postgres returns DATE[] as Date[] via node-pg's type parser.
    appointment_cancelled_dates: (row.appointment_cancelled_dates ?? [])
      .map((d) => isoDateOnly(d))
      .filter((d): d is string => d !== null),
    status:                      row.status,
    reason:                      row.reason,
    notes:                       row.notes,
    created_at:                  row.created_at.toISOString(),
    updated_at:                  row.updated_at.toISOString(),
  };
}

export interface ListFilters {
  clinic_id?:    string;     // ADMIN can override; ignored for non-admin
  date_from?:    string;
  date_to?:      string;
  clinician_id?: string;
  status?:       DropoutStatus;
  reason?:       DropoutReason;
  /** Case-insensitive partial match across patient_name and notes. */
  search?:       string;
  limit?:        number;
  offset?:       number;
}

export interface CreateDropoutInput {
  clinic_id:                   string;
  entered_by:                  string;
  front_staff_name:            string | null;
  clinician_id:                string;
  patient_name:                string;
  date_logged:                 string;
  /** YYYY-MM-DD strings. Pass [] when none were recorded. */
  appointment_cancelled_dates: string[];
  status:                      DropoutStatus | null;
  reason:                      DropoutReason | null;
  notes:                       string | null;
}

export interface UpdateDropoutInput {
  front_staff_name?:            string | null;
  clinician_id?:                string;
  patient_name?:                string;
  date_logged?:                 string;
  appointment_cancelled_dates?: string[];
  status?:                      DropoutStatus;
  reason?:                      DropoutReason;
  notes?:                       string | null;
}

const SELECT_JOINED = `
  SELECT
    d.*,
    u_entered.full_name   AS entered_by_name,
    u_clinician.full_name AS clinician_name
  FROM patient_dropouts d
  LEFT JOIN users u_entered   ON u_entered.id   = d.entered_by
  LEFT JOIN users u_clinician ON u_clinician.id = d.clinician_id
`;

/**
 * Apply scope to a SQL builder: every list/find query MUST go through this.
 * - ADMIN:             no row filter
 * - FRONT_DESK_GLOBAL: no row filter (cross-clinic data-entry receptionist)
 * - FRONT_DESK:        pinned to own clinic
 * - CLINICIAN:         entries where THEY are the named clinician
 *                      (regardless of who logged the entry — receptionists
 *                      typically enter on a clinician's behalf)
 *
 * NOTE: edit/delete is still tied to entered_by (see service layer) so a
 * clinician viewing an entry created by a receptionist cannot mutate it.
 *
 * Returns the WHERE fragment + accumulated params (1-indexed by callers).
 */
function applyScope(
  scope: RequestScope,
  startIndex: number
): { sql: string; params: unknown[] } {
  if (scope.role === 'ADMIN' || scope.role === 'FRONT_DESK_GLOBAL') {
    return { sql: '1=1', params: [] };
  }

  if (scope.role === 'FRONT_DESK') {
    return {
      sql:    `d.clinic_id = $${startIndex}`,
      params: [scope.clinic_id],
    };
  }

  // CLINICIAN — every entry where this user is the named clinician.
  return {
    sql:    `d.clinician_id = $${startIndex}`,
    params: [scope.userId],
  };
}

export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX     = 500;

/**
 * Build the WHERE clause shared by list() and count() — guarantees both query
 * the same row set, so pagination metadata stays consistent with the data.
 */
function buildWhere(
  scope: RequestScope,
  filters: ListFilters
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const where:  string[]  = [];

  const scoped = applyScope(scope, params.length + 1);
  params.push(...scoped.params);
  where.push(scoped.sql);

  // ADMIN and FRONT_DESK_GLOBAL can pass clinic_id explicitly. Other roles
  // are already pinned by applyScope() so the filter is ignored.
  if (
    (scope.role === 'ADMIN' || scope.role === 'FRONT_DESK_GLOBAL') &&
    filters.clinic_id
  ) {
    params.push(filters.clinic_id);
    where.push(`d.clinic_id = $${params.length}`);
  }
  if (filters.date_from) {
    params.push(filters.date_from);
    where.push(`d.date_logged >= $${params.length}`);
  }
  if (filters.date_to) {
    params.push(filters.date_to);
    where.push(`d.date_logged <= $${params.length}`);
  }
  if (filters.clinician_id) {
    params.push(filters.clinician_id);
    where.push(`d.clinician_id = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`d.status = $${params.length}`);
  }
  if (filters.reason) {
    params.push(filters.reason);
    where.push(`d.reason = $${params.length}`);
  }
  if (filters.search) {
    // Case-insensitive partial match across patient_name and notes.
    // ILIKE escape: % and _ are wildcards; escape them so a literal "50%"
    // search doesn't accidentally match everything.
    const escaped = filters.search.replace(/[\\%_]/g, (m) => '\\' + m);
    params.push(`%${escaped}%`);
    where.push(`(d.patient_name ILIKE $${params.length} OR d.notes ILIKE $${params.length})`);
  }

  return { sql: where.join(' AND '), params };
}

export const dropoutRepository = {
  async list(scope: RequestScope, filters: ListFilters = {}): Promise<DropoutDTO[]> {
    const { sql: whereSql, params } = buildWhere(scope, filters);

    const limit  = Math.min(Math.max(filters.limit ?? PAGE_LIMIT_DEFAULT, 1), PAGE_LIMIT_MAX);
    const offset = Math.max(filters.offset ?? 0, 0);
    params.push(limit);
    const limitIdx = params.length;
    params.push(offset);
    const offsetIdx = params.length;

    const sql = `
      ${SELECT_JOINED}
      WHERE ${whereSql}
      ORDER BY d.date_logged DESC, d.id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;
    const { rows } = await query<DropoutJoinedRow>(sql, params);
    return rows.map(toDTO);
  },

  async count(scope: RequestScope, filters: ListFilters = {}): Promise<number> {
    const { sql: whereSql, params } = buildWhere(scope, filters);
    const sql = `SELECT COUNT(*)::bigint AS total FROM patient_dropouts d WHERE ${whereSql}`;
    const { rows } = await query<{ total: string }>(sql, params);
    return Number(rows[0]?.total ?? 0);
  },

  /**
   * Aggregate counts over the full filtered set (ignoring limit/offset). Used
   * by the admin summary cards so they reflect the whole filter, not just the
   * currently-paginated page.
   */
  async aggregate(scope: RequestScope, filters: ListFilters = {}): Promise<{
    total:    number;
    byStatus: Record<string, number>;
    byReason: Record<string, number>;
    byClinic: Record<string, number>;
    /** Daily counts over the filtered range — drives the trend line chart.
     *  Only days with ≥1 entry are returned; the client fills missing days
     *  with 0 against its known dateFrom/dateTo. */
    byDay:    Array<{ date: string; count: number }>;
  }> {
    const { sql: whereSql, params } = buildWhere(scope, filters);
    const [totalRes, statusRes, reasonRes, clinicRes, dayRes] = await Promise.all([
      query<{ total: string }>(
        `SELECT COUNT(*)::bigint AS total FROM patient_dropouts d WHERE ${whereSql}`,
        params
      ),
      query<{ status: string; n: string }>(
        `SELECT d.status, COUNT(*)::bigint AS n FROM patient_dropouts d WHERE ${whereSql} GROUP BY d.status`,
        params
      ),
      query<{ reason: string; n: string }>(
        `SELECT d.reason, COUNT(*)::bigint AS n FROM patient_dropouts d WHERE ${whereSql} GROUP BY d.reason`,
        params
      ),
      query<{ clinic_id: string; n: string }>(
        `SELECT d.clinic_id, COUNT(*)::bigint AS n FROM patient_dropouts d WHERE ${whereSql} GROUP BY d.clinic_id`,
        params
      ),
      query<{ day: Date; n: string }>(
        `SELECT d.date_logged::date AS day, COUNT(*)::bigint AS n
           FROM patient_dropouts d
          WHERE ${whereSql}
          GROUP BY d.date_logged::date
          ORDER BY day`,
        params
      ),
    ]);

    const toMap = <T extends string>(rows: { n: string }[], key: T) =>
      rows.reduce<Record<string, number>>((acc, r: any) => {
        acc[r[key]] = Number(r.n);
        return acc;
      }, {});

    return {
      total:    Number(totalRes.rows[0]?.total ?? 0),
      byStatus: toMap(statusRes.rows, 'status'),
      byReason: toMap(reasonRes.rows, 'reason'),
      byClinic: toMap(clinicRes.rows, 'clinic_id'),
      byDay:    dayRes.rows.map((r) => ({
        date:  isoDateOnly(r.day) ?? '',
        count: Number(r.n),
      })),
    };
  },

  async findById(scope: RequestScope, id: string): Promise<DropoutDTO | null> {
    const params: unknown[] = [];
    const scoped = applyScope(scope, params.length + 1);
    params.push(...scoped.params);
    params.push(id);
    const idIdx = params.length;

    const sql = `
      ${SELECT_JOINED}
      WHERE ${scoped.sql} AND d.id = $${idIdx}
      LIMIT 1
    `;
    const { rows } = await query<DropoutJoinedRow>(sql, params);
    return rows[0] ? toDTO(rows[0]) : null;
  },

  async findRawById(id: string): Promise<DropoutRow | null> {
    const { rows } = await query<DropoutRow>(
      `SELECT * FROM patient_dropouts WHERE id = $1 LIMIT 1`,
      [id]
    );
    return rows[0] ?? null;
  },

  async create(input: CreateDropoutInput): Promise<DropoutDTO> {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO patient_dropouts (
         clinic_id, entered_by, front_staff_name, clinician_id,
         patient_name, date_logged, appointment_cancelled_dates,
         status, reason, notes
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::date[],$8,$9,$10)
       RETURNING id`,
      [
        input.clinic_id, input.entered_by, input.front_staff_name, input.clinician_id,
        input.patient_name, input.date_logged, input.appointment_cancelled_dates,
        input.status, input.reason, input.notes,
      ]
    );

    const created = await this.findRawById(rows[0].id);
    if (!created) throw new Error('Failed to fetch newly inserted dropout');
    // Re-query with joined names so the response shape is consistent.
    const joined = await this.findById(
      { role: 'ADMIN', userId: '0', clinic_id: null, full_name: null },
      created.id
    );
    return joined!;
  },

  async update(id: string, patch: UpdateDropoutInput, updatedBy: string): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];

    const fields: (keyof UpdateDropoutInput)[] = [
      'front_staff_name', 'clinician_id', 'patient_name', 'date_logged',
      'appointment_cancelled_dates', 'status', 'reason', 'notes',
    ];

    for (const k of fields) {
      if (patch[k] !== undefined) {
        params.push(patch[k]);
        // Postgres needs an explicit ::date[] cast when binding a JS array
        // through node-pg, otherwise it tries to coerce element-by-element.
        const cast = k === 'appointment_cancelled_dates' ? '::date[]' : '';
        sets.push(`${k} = $${params.length}${cast}`);
      }
    }

    if (sets.length === 0) return;

    params.push(updatedBy);
    sets.push(`updated_by = $${params.length}`);
    sets.push(`updated_at = NOW()`);
    params.push(id);

    await query(
      `UPDATE patient_dropouts SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params
    );
  },

  async delete(id: string): Promise<void> {
    await query(`DELETE FROM patient_dropouts WHERE id = $1`, [id]);
  },

  /**
   * Per-day counts of dropout entries for the CEO dashboard rows:
   *   - cancelled = "Appointments Cancelled with No Rebooking"
   *       status IN ('Cancelled - not rescheduled', 'No Future Bookings')
   *   - rebooked  = "Appointments Cancelled & Rebooked"
   *       status =  'Re-scheduled'
   *
   * Bucketed by `date_logged` (the date the entry was keyed in) — that is
   * the filter Sam uses on the source spreadsheet, not the cancellation
   * date. One dropout row = one count.
   *
   * Bypasses RequestScope on purpose — the CEO dashboard shows clinic-wide
   * totals regardless of which user is viewing. Caller decides clinic.
   * Single round-trip: one SELECT with CASE-bucketing fills both maps.
   */
  async dropoutCountsByDate(
    clinicId: string,
    dateFrom: string,
    dateTo:   string
  ): Promise<{
    cancelled: Map<string, number>;
    rebooked:  Map<string, number>;
  }> {
    const { rows } = await query<{ day: Date; bucket: string; n: string }>(
      `SELECT
         d.date_logged::date AS day,
         CASE WHEN d.status = 'Re-scheduled' THEN 'rebooked' ELSE 'cancelled' END AS bucket,
         COUNT(*)::bigint AS n
         FROM patient_dropouts d
        WHERE d.clinic_id    = $1
          AND d.status       IN ('Cancelled - not rescheduled', 'No Future Bookings', 'Re-scheduled')
          AND d.date_logged >= $2::date
          AND d.date_logged <= $3::date
        GROUP BY d.date_logged::date, bucket`,
      [clinicId, dateFrom, dateTo]
    );
    const cancelled = new Map<string, number>();
    const rebooked  = new Map<string, number>();
    for (const r of rows) {
      const day = isoDateOnly(r.day);
      if (!day) continue;
      (r.bucket === 'rebooked' ? rebooked : cancelled).set(day, Number(r.n));
    }
    return { cancelled, rebooked };
  },
};
