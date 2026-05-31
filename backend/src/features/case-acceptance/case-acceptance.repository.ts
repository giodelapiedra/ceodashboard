import { query } from '../../db/pool';
import { RequestScope } from '../../middleware/auth.middleware';

export interface CaseAcceptanceRow {
  id:                       string;
  clinic_id:                string;
  entered_by:               string;
  // Free-form text. CLINICIAN entries are constrained at the validator to
  // FRONT_STAFF_NAMES; receptionist (FRONT_DESK / FRONT_DESK_GLOBAL) entries
  // are stamped server-side with the caller's users.full_name.
  front_staff_name:         string | null;
  clinician_id:             string;
  patient_name:             string;
  date_logged:              Date;
  treatment_plan_provided:  boolean | null;
  case_recommendations:     number;
  appointments_booked:      number;
  prepay_offered:           boolean | null;
  prepay_accepted:          boolean | null;
  transition_notes:         string | null;
  notes:                    string | null;
  created_at:               Date;
  updated_at:               Date;
  updated_by:               string | null;
}

export interface CaseAcceptanceDTO {
  id:                       string;
  clinic_id:                string;
  entered_by:               string;
  entered_by_name:          string | null;
  front_staff_name:         string | null;
  clinician_id:             string;
  clinician_name:           string | null;
  patient_name:             string;
  date_logged:              string; // YYYY-MM-DD
  treatment_plan_provided:  boolean | null;
  case_recommendations:     number;
  appointments_booked:      number;
  /** booked / recommendations × 100 — null when recommendations === 0. */
  case_acceptance_pct:      number | null;
  prepay_offered:           boolean | null;
  prepay_accepted:          boolean | null;
  transition_notes:         string | null;
  notes:                    string | null;
  created_at:               string;
  updated_at:               string;
}

interface CaseAcceptanceJoinedRow extends CaseAcceptanceRow {
  entered_by_name: string | null;
  clinician_name:  string | null;
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

function toDTO(row: CaseAcceptanceJoinedRow): CaseAcceptanceDTO {
  const recs   = Number(row.case_recommendations);
  const booked = Number(row.appointments_booked);
  return {
    id:                      row.id,
    clinic_id:               row.clinic_id,
    entered_by:              row.entered_by,
    entered_by_name:         row.entered_by_name,
    front_staff_name:        row.front_staff_name,
    clinician_id:            row.clinician_id,
    clinician_name:          row.clinician_name,
    patient_name:            row.patient_name,
    date_logged:             isoDateOnly(row.date_logged) ?? '',
    treatment_plan_provided: row.treatment_plan_provided,
    case_recommendations:    recs,
    appointments_booked:     booked,
    case_acceptance_pct:     recs > 0 ? Math.round((booked / recs) * 10_000) / 100 : null,
    prepay_offered:          row.prepay_offered,
    prepay_accepted:         row.prepay_accepted,
    transition_notes:        row.transition_notes,
    notes:                   row.notes,
    created_at:              row.created_at.toISOString(),
    updated_at:              row.updated_at.toISOString(),
  };
}

export interface ListFilters {
  clinic_id?:    string;
  date_from?:    string;
  date_to?:      string;
  clinician_id?: string;
  /** Filter rows where treatment_plan_provided IS the given boolean. */
  tp_provided?:  boolean;
  /** Case-insensitive partial match across patient_name and notes. */
  search?:       string;
  limit?:        number;
  offset?:       number;
}

export interface CreateInput {
  clinic_id:                string;
  entered_by:               string;
  front_staff_name:         string | null;
  clinician_id:             string;
  patient_name:             string;
  date_logged:              string;
  treatment_plan_provided:  boolean | null;
  case_recommendations:     number;
  appointments_booked:      number;
  prepay_offered:           boolean | null;
  prepay_accepted:          boolean | null;
  transition_notes:         string | null;
  notes:                    string | null;
}

export interface UpdateInput {
  front_staff_name?:         string | null;
  clinician_id?:             string;
  patient_name?:             string;
  date_logged?:              string;
  treatment_plan_provided?:  boolean | null;
  case_recommendations?:     number;
  appointments_booked?:      number;
  prepay_offered?:           boolean | null;
  prepay_accepted?:          boolean | null;
  transition_notes?:         string | null;
  notes?:                    string | null;
}

const SELECT_JOINED = `
  SELECT
    c.*,
    u_entered.full_name   AS entered_by_name,
    u_clinician.full_name AS clinician_name
  FROM case_acceptances c
  LEFT JOIN users u_entered   ON u_entered.id   = c.entered_by
  LEFT JOIN users u_clinician ON u_clinician.id = c.clinician_id
`;

/**
 * Apply caller scope to a query — every list/find query MUST go through this.
 * Mirrors patient_dropouts.applyScope so the same access rules apply.
 *
 * - ADMIN / FRONT_DESK_GLOBAL → no row filter (cross-clinic).
 * - FRONT_DESK                → pinned to own clinic.
 * - CLINICIAN                 → entries where they are the named clinician
 *                               (regardless of who logged the entry).
 *
 * NOTE: edit/delete is still tied to entered_by (see service layer) so a
 * clinician viewing an entry created by a receptionist cannot mutate it.
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
      sql:    `c.clinic_id = $${startIndex}`,
      params: [scope.clinic_id],
    };
  }

  // CLINICIAN — every entry where this user is the named clinician.
  return {
    sql:    `c.clinician_id = $${startIndex}`,
    params: [scope.userId],
  };
}

export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX     = 500;

function buildWhere(
  scope: RequestScope,
  filters: ListFilters
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const where:  string[]  = [];

  const scoped = applyScope(scope, params.length + 1);
  params.push(...scoped.params);
  where.push(scoped.sql);

  if (
    (scope.role === 'ADMIN' || scope.role === 'FRONT_DESK_GLOBAL') &&
    filters.clinic_id
  ) {
    params.push(filters.clinic_id);
    where.push(`c.clinic_id = $${params.length}`);
  }
  if (filters.date_from) {
    params.push(filters.date_from);
    where.push(`c.date_logged >= $${params.length}`);
  }
  if (filters.date_to) {
    params.push(filters.date_to);
    where.push(`c.date_logged <= $${params.length}`);
  }
  if (filters.clinician_id) {
    params.push(filters.clinician_id);
    where.push(`c.clinician_id = $${params.length}`);
  }
  if (filters.tp_provided !== undefined) {
    params.push(filters.tp_provided);
    where.push(`c.treatment_plan_provided = $${params.length}`);
  }
  if (filters.search) {
    const escaped = filters.search.replace(/[\\%_]/g, (m) => '\\' + m);
    params.push(`%${escaped}%`);
    where.push(`(c.patient_name ILIKE $${params.length} OR c.notes ILIKE $${params.length})`);
  }

  return { sql: where.join(' AND '), params };
}

export const caseAcceptanceRepository = {
  async list(scope: RequestScope, filters: ListFilters = {}): Promise<CaseAcceptanceDTO[]> {
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
      ORDER BY c.date_logged DESC, c.id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;
    const { rows } = await query<CaseAcceptanceJoinedRow>(sql, params);
    return rows.map(toDTO);
  },

  async count(scope: RequestScope, filters: ListFilters = {}): Promise<number> {
    const { sql: whereSql, params } = buildWhere(scope, filters);
    const sql = `SELECT COUNT(*)::bigint AS total FROM case_acceptances c WHERE ${whereSql}`;
    const { rows } = await query<{ total: string }>(sql, params);
    return Number(rows[0]?.total ?? 0);
  },

  /**
   * Aggregate metrics over the full filtered set (ignoring limit/offset).
   * Drives the admin summary cards: totals and weighted case-acceptance %.
   */
  async aggregate(scope: RequestScope, filters: ListFilters = {}): Promise<{
    total:                number;
    totalRecommendations: number;
    totalBooked:          number;
    /** Weighted (sum booked / sum recs * 100) — null when no recs at all. */
    caseAcceptancePct:    number | null;
    tpProvided:           number;
    tpNotProvided:        number;
    prepayOffered:        number;
    prepayAccepted:       number;
    transitions:          number;
    byClinic:             Record<string, number>;
  }> {
    const { sql: whereSql, params } = buildWhere(scope, filters);
    const [totals, byClinic] = await Promise.all([
      query<{
        total:        string;
        sum_recs:     string | null;
        sum_booked:   string | null;
        tp_yes:       string;
        tp_no:        string;
        prepay_off:   string;
        prepay_acc:   string;
        transitions:  string;
      }>(`
        SELECT
          COUNT(*)::bigint                                                    AS total,
          COALESCE(SUM(c.case_recommendations), 0)::bigint                    AS sum_recs,
          COALESCE(SUM(c.appointments_booked), 0)::bigint                     AS sum_booked,
          COUNT(*) FILTER (WHERE c.treatment_plan_provided IS TRUE)::bigint   AS tp_yes,
          COUNT(*) FILTER (WHERE c.treatment_plan_provided IS FALSE)::bigint  AS tp_no,
          COUNT(*) FILTER (WHERE c.prepay_offered  IS TRUE)::bigint           AS prepay_off,
          COUNT(*) FILTER (WHERE c.prepay_accepted IS TRUE)::bigint           AS prepay_acc,
          COUNT(*) FILTER (WHERE c.transition_notes IS NOT NULL AND c.transition_notes <> '')::bigint AS transitions
        FROM case_acceptances c
        WHERE ${whereSql}
      `, params),
      query<{ clinic_id: string; n: string }>(
        `SELECT c.clinic_id, COUNT(*)::bigint AS n FROM case_acceptances c WHERE ${whereSql} GROUP BY c.clinic_id`,
        params
      ),
    ]);

    const t = totals.rows[0];
    const recs   = Number(t?.sum_recs   ?? 0);
    const booked = Number(t?.sum_booked ?? 0);

    return {
      total:                Number(t?.total       ?? 0),
      totalRecommendations: recs,
      totalBooked:          booked,
      caseAcceptancePct:    recs > 0 ? Math.round((booked / recs) * 10_000) / 100 : null,
      tpProvided:           Number(t?.tp_yes      ?? 0),
      tpNotProvided:        Number(t?.tp_no       ?? 0),
      prepayOffered:        Number(t?.prepay_off  ?? 0),
      prepayAccepted:       Number(t?.prepay_acc  ?? 0),
      transitions:          Number(t?.transitions ?? 0),
      byClinic: byClinic.rows.reduce<Record<string, number>>((acc, r) => {
        acc[r.clinic_id] = Number(r.n);
        return acc;
      }, {}),
    };
  },

  async findById(scope: RequestScope, id: string): Promise<CaseAcceptanceDTO | null> {
    const params: unknown[] = [];
    const scoped = applyScope(scope, params.length + 1);
    params.push(...scoped.params);
    params.push(id);
    const idIdx = params.length;

    const sql = `
      ${SELECT_JOINED}
      WHERE ${scoped.sql} AND c.id = $${idIdx}
      LIMIT 1
    `;
    const { rows } = await query<CaseAcceptanceJoinedRow>(sql, params);
    return rows[0] ? toDTO(rows[0]) : null;
  },

  async findRawById(id: string): Promise<CaseAcceptanceRow | null> {
    const { rows } = await query<CaseAcceptanceRow>(
      `SELECT * FROM case_acceptances WHERE id = $1 LIMIT 1`,
      [id]
    );
    return rows[0] ?? null;
  },

  async create(input: CreateInput): Promise<CaseAcceptanceDTO> {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO case_acceptances (
         clinic_id, entered_by, front_staff_name, clinician_id,
         patient_name, date_logged, treatment_plan_provided,
         case_recommendations, appointments_booked,
         prepay_offered, prepay_accepted, transition_notes, notes
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [
        input.clinic_id, input.entered_by, input.front_staff_name, input.clinician_id,
        input.patient_name, input.date_logged, input.treatment_plan_provided,
        input.case_recommendations, input.appointments_booked,
        input.prepay_offered, input.prepay_accepted, input.transition_notes,
        input.notes,
      ]
    );

    const joined = await this.findById(
      { role: 'ADMIN', userId: '0', clinic_id: null, full_name: null },
      rows[0].id
    );
    if (!joined) throw new Error('Failed to fetch newly inserted case acceptance');
    return joined;
  },

  async update(id: string, patch: UpdateInput, updatedBy: string): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];

    const fields: (keyof UpdateInput)[] = [
      'front_staff_name', 'clinician_id', 'patient_name', 'date_logged',
      'treatment_plan_provided', 'case_recommendations', 'appointments_booked',
      'prepay_offered', 'prepay_accepted', 'transition_notes', 'notes',
    ];

    for (const k of fields) {
      if (patch[k] !== undefined) {
        params.push(patch[k]);
        sets.push(`${k} = $${params.length}`);
      }
    }

    if (sets.length === 0) return;

    params.push(updatedBy);
    sets.push(`updated_by = $${params.length}`);
    sets.push(`updated_at = NOW()`);
    params.push(id);

    await query(
      `UPDATE case_acceptances SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params
    );
  },

  async delete(id: string): Promise<void> {
    await query(`DELETE FROM case_acceptances WHERE id = $1`, [id]);
  },

  /**
   * Per-day rollups for the CEO dashboard rows sourced from case_acceptances:
   *   - recs / booked       → "Case Acceptance % For All Team" (weighted)
   *   - prepayAccepted      → "Number of Clients Who Took The Upfront
   *                            Treatment Plan Option" (count of TRUE rows)
   *
   * Weighted % matches the admin summary's formula
   * (sum(booked) / sum(recs) * 100) so dashboard and admin analytics agree.
   *
   * `clinicId = null` → cross-clinic totals (used by the Overall view).
   * Bypasses RequestScope: the CEO dashboard is clinic-wide regardless of
   * the viewer's role.
   */
  async dailyTotals(
    clinicId: string | null,
    dateFrom: string,
    dateTo:   string
  ): Promise<Map<string, { recs: number; booked: number; prepayAccepted: number }>> {
    const { rows } = await query<{
      day:             Date;
      recs:            string;
      booked:          string;
      prepay_accepted: string;
    }>(
      `SELECT
         c.date_logged::date AS day,
         COALESCE(SUM(c.case_recommendations), 0)::bigint              AS recs,
         COALESCE(SUM(c.appointments_booked), 0)::bigint               AS booked,
         COUNT(*) FILTER (WHERE c.prepay_accepted IS TRUE)::bigint     AS prepay_accepted
         FROM case_acceptances c
        WHERE ($1::text IS NULL OR c.clinic_id = $1)
          AND c.date_logged >= $2::date
          AND c.date_logged <= $3::date
        GROUP BY c.date_logged::date`,
      [clinicId, dateFrom, dateTo]
    );
    const map = new Map<string, { recs: number; booked: number; prepayAccepted: number }>();
    for (const r of rows) {
      const day = isoDateOnly(r.day);
      if (day) map.set(day, {
        recs:           Number(r.recs),
        booked:         Number(r.booked),
        prepayAccepted: Number(r.prepay_accepted),
      });
    }
    return map;
  },
};
