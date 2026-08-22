import { PoolClient } from 'pg';
import { query } from '../../db/pool';
import { RequestScope } from '../../middleware/auth.middleware';
import { NAME_NORM_SQL, SIMILAR_WINDOW_DAYS, normalizeName } from '../../shared/duplicates';
import { NookalPaidCandidate, NookalPaidLookup } from '../../services/nookal-client-paid.service';

export interface AdLeadRow {
  id:            string;
  clinic_id:     string;
  entered_by:    string;
  patient_name:  string;
  platform:      string;
  campaign_name: string | null;
  date_added:    Date;
  booked:        boolean;
  bella_called:  string | null;
  bella_sms:     string | null;
  bella_remarks: string | null;
  created_at:    Date;
  updated_at:    Date;
  updated_by:    string | null;
  nookal_status:     string | null;
  nookal_candidates: NookalPaidCandidate[] | null;
  nookal_paid:       string | null;  // pg returns NUMERIC as string
  nookal_synced_at:  Date | null;
}

export interface AdLeadDTO {
  id:              string;
  clinic_id:       string;
  entered_by:      string;
  entered_by_name: string | null;
  patient_name:    string;
  platform:        string;
  campaign_name:   string | null;
  date_added:      string;          // YYYY-MM-DD
  booked:          boolean;
  bella_called:    string | null;
  bella_sms:       string | null;
  bella_remarks:   string | null;
  created_at:      string;
  updated_at:      string;
  nookal_status:     string | null;
  nookal_candidates: NookalPaidCandidate[] | null;
  nookal_paid:       number | null;
  nookal_synced_at:  string | null;
}

interface AdLeadJoinedRow extends AdLeadRow {
  entered_by_name: string | null;
}

function isoDateOnly(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  // pg returns DATE at LOCAL midnight; use local components so the calendar day
  // doesn't shift under toISOString()'s UTC conversion (same fix as dropouts).
  if (typeof d === 'string') return d.slice(0, 10);
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function toDTO(row: AdLeadJoinedRow): AdLeadDTO {
  return {
    id:              row.id,
    clinic_id:       row.clinic_id,
    entered_by:      row.entered_by,
    entered_by_name: row.entered_by_name,
    patient_name:    row.patient_name,
    platform:        row.platform,
    campaign_name:   row.campaign_name,
    date_added:      isoDateOnly(row.date_added) ?? '',
    booked:          row.booked,
    bella_called:    row.bella_called,
    bella_sms:       row.bella_sms,
    bella_remarks:   row.bella_remarks,
    created_at:      row.created_at.toISOString(),
    updated_at:      row.updated_at.toISOString(),
    nookal_status:     row.nookal_status,
    nookal_candidates: row.nookal_candidates,
    nookal_paid:       row.nookal_paid === null ? null : Number(row.nookal_paid),
    nookal_synced_at:  row.nookal_synced_at ? row.nookal_synced_at.toISOString() : null,
  };
}

export interface ListFilters {
  clinic_id?: string;    // ADMIN / FRONT_DESK_GLOBAL only; ignored for others
  date_from?: string;
  date_to?:   string;
  /** One platform, or several (multi-select filter). */
  platform?:  string | string[];
  booked?:    boolean;
  /** Case-insensitive partial match across patient_name, campaign_name, bella_remarks. */
  search?:    string;
  limit?:     number;
  offset?:    number;
}

export interface CreateAdLeadInput {
  clinic_id:     string;
  entered_by:    string;
  patient_name:  string;
  platform:      string;
  campaign_name: string | null;
  date_added:    string;
  booked:        boolean;
  bella_called:  string | null;
  bella_sms:     string | null;
  bella_remarks: string | null;
}

/**
 * Natural key of an ad lead. Platform is part of it on purpose: the same
 * person really can arrive as a Meta lead and a Google lead on the same day,
 * and that is two leads, not one — collapsing them would understate the cost
 * per lead of one of the two channels.
 */
export interface AdLeadDupKey {
  clinic_id:    string;
  patient_name: string;
  platform:     string;
  date_added:   string;   // YYYY-MM-DD
}

/** Stable string for the advisory lock that serializes check-then-insert. */
export function adLeadLockKey(key: AdLeadDupKey): string {
  return `ad_lead:${key.clinic_id}:${key.platform}:${key.date_added}:${normalizeName(key.patient_name)}`;
}

export interface UpdateAdLeadInput {
  patient_name?:  string;
  platform?:      string;
  campaign_name?: string | null;
  date_added?:    string;
  booked?:        boolean;
  bella_called?:  string | null;
  bella_sms?:     string | null;
  bella_remarks?: string | null;
}

const SELECT_JOINED = `
  SELECT
    l.*,
    u_entered.full_name AS entered_by_name
  FROM ad_leads l
  LEFT JOIN users u_entered ON u_entered.id = l.entered_by
`;

/**
 * Scope every list/find query:
 * - ADMIN / FRONT_DESK_GLOBAL / ADSPEND → no row filter (see all clinics)
 * - FRONT_DESK                          → pinned to own clinic
 * - anyone else (CLINICIAN)             → no rows (leads are not their concern)
 *
 * ADSPEND joined the cross-clinic group 2026-08-12: the account has clinic_id
 * NULL, so a pinned filter would show it nothing. The feature-level gate is
 * `canAccessAdLeads` (allow-listed emails only) — reaching this function at all
 * already means the caller is allowed in.
 */
function applyScope(scope: RequestScope, startIndex: number): { sql: string; params: unknown[] } {
  if (scope.role === 'ADMIN' || scope.role === 'FRONT_DESK_GLOBAL' || scope.role === 'ADSPEND') {
    return { sql: '1=1', params: [] };
  }
  if (scope.role === 'FRONT_DESK') {
    return { sql: `l.clinic_id = $${startIndex}`, params: [scope.clinic_id] };
  }
  return { sql: '1=0', params: [] };
}

export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX     = 500;

function buildWhere(scope: RequestScope, filters: ListFilters): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const where:  string[]  = [];

  const scoped = applyScope(scope, params.length + 1);
  params.push(...scoped.params);
  where.push(scoped.sql);

  // Only the cross-clinic roles may narrow by clinic — for FRONT_DESK the pin in
  // applyScope already decided it, and honouring the filter would be a no-op.
  if (
    (scope.role === 'ADMIN' || scope.role === 'FRONT_DESK_GLOBAL' || scope.role === 'ADSPEND') &&
    filters.clinic_id
  ) {
    params.push(filters.clinic_id);
    where.push(`l.clinic_id = $${params.length}`);
  }
  if (filters.date_from) {
    params.push(filters.date_from);
    where.push(`l.date_added >= $${params.length}`);
  }
  if (filters.date_to) {
    params.push(filters.date_to);
    where.push(`l.date_added <= $${params.length}`);
  }
  if (filters.platform) {
    const platforms = Array.isArray(filters.platform) ? filters.platform : [filters.platform];
    if (platforms.length === 1) {
      params.push(platforms[0]);
      where.push(`l.platform = $${params.length}`);
    } else {
      params.push(platforms);
      where.push(`l.platform = ANY($${params.length}::text[])`);
    }
  }
  if (filters.booked !== undefined) {
    params.push(filters.booked);
    where.push(`l.booked = $${params.length}`);
  }
  if (filters.search) {
    const escaped = filters.search.replace(/[\\%_]/g, (m) => '\\' + m);
    params.push(`%${escaped}%`);
    const i = params.length;
    where.push(
      `(l.patient_name ILIKE $${i} OR l.campaign_name ILIKE $${i} OR l.bella_remarks ILIKE $${i})`
    );
  }

  return { sql: where.join(' AND '), params };
}

export const adLeadRepository = {
  async list(scope: RequestScope, filters: ListFilters = {}): Promise<AdLeadDTO[]> {
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
      ORDER BY l.date_added DESC, l.id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;
    const { rows } = await query<AdLeadJoinedRow>(sql, params);
    return rows.map(toDTO);
  },

  async count(scope: RequestScope, filters: ListFilters = {}): Promise<number> {
    const { sql: whereSql, params } = buildWhere(scope, filters);
    const sql = `SELECT COUNT(*)::bigint AS total FROM ad_leads l WHERE ${whereSql}`;
    const { rows } = await query<{ total: string }>(sql, params);
    return Number(rows[0]?.total ?? 0);
  },

  /** Aggregate over the full filtered set (ignores limit/offset) — powers the
   *  admin summary cards. */
  async aggregate(scope: RequestScope, filters: ListFilters = {}): Promise<{
    total:      number;
    booked:     number;
    byPlatform: Record<string, number>;
  }> {
    const { sql: whereSql, params } = buildWhere(scope, filters);
    const [totalRes, bookedRes, platRes] = await Promise.all([
      query<{ total: string }>(
        `SELECT COUNT(*)::bigint AS total FROM ad_leads l WHERE ${whereSql}`, params),
      query<{ booked: string }>(
        `SELECT COUNT(*)::bigint AS booked FROM ad_leads l WHERE ${whereSql} AND l.booked = true`, params),
      query<{ platform: string; n: string }>(
        `SELECT l.platform, COUNT(*)::bigint AS n FROM ad_leads l WHERE ${whereSql} GROUP BY l.platform`, params),
    ]);

    const byPlatform = platRes.rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.platform] = Number(r.n);
      return acc;
    }, {});

    return {
      total:      Number(totalRes.rows[0]?.total ?? 0),
      booked:     Number(bookedRes.rows[0]?.booked ?? 0),
      byPlatform,
    };
  },

  async findById(scope: RequestScope, id: string): Promise<AdLeadDTO | null> {
    const params: unknown[] = [];
    const scoped = applyScope(scope, params.length + 1);
    params.push(...scoped.params);
    params.push(id);
    const idIdx = params.length;

    const sql = `${SELECT_JOINED} WHERE ${scoped.sql} AND l.id = $${idIdx} LIMIT 1`;
    const { rows } = await query<AdLeadJoinedRow>(sql, params);
    return rows[0] ? toDTO(rows[0]) : null;
  },

  async findRawById(id: string): Promise<AdLeadRow | null> {
    const { rows } = await query<AdLeadRow>(
      `SELECT * FROM ad_leads WHERE id = $1 LIMIT 1`, [id]);
    return rows[0] ?? null;
  },

  /**
   * Unscoped joined read. Used by create() to build the response
   * from INSIDE their own transaction — a scoped read on a pooled connection
   * would run on a different session and not see the uncommitted row.
   */
  async findJoinedById(id: string, client?: PoolClient): Promise<AdLeadDTO | null> {
    const sql = `${SELECT_JOINED} WHERE l.id = $1 LIMIT 1`;
    const { rows } = client
      ? await client.query<AdLeadJoinedRow>(sql, [id])
      : await query<AdLeadJoinedRow>(sql, [id]);
    return rows[0] ? toDTO(rows[0]) : null;
  },

  /**
   * Duplicate lookup for one natural key — see the twin in dropout.repository.
   *
   *   exact   → same clinic + normalized patient name + platform + date_added.
   *   similar → same clinic + patient within ±SIMILAR_WINDOW_DAYS on another
   *             platform or a nearby date. Advisory: this is the one that
   *             catches the same lead re-keyed a day later off the same
   *             Meta export.
   */
  async findDuplicates(
    key:     AdLeadDupKey,
    opts:    { excludeId?: string } = {},
    client?: PoolClient
  ): Promise<{ exact: AdLeadDTO | null; similar: AdLeadDTO[] }> {
    const params: unknown[] = [
      key.clinic_id,
      normalizeName(key.patient_name),
      key.date_added,
      SIMILAR_WINDOW_DAYS,
      key.platform,
      opts.excludeId ?? null,
    ];
    const sql = `
      ${SELECT_JOINED}
      WHERE l.clinic_id = $1
        AND ${NAME_NORM_SQL('l.patient_name')} = $2
        AND l.date_added BETWEEN ($3::date - $4::int) AND ($3::date + $4::int)
        AND ($6::bigint IS NULL OR l.id <> $6::bigint)
      ORDER BY (l.platform = $5 AND l.date_added = $3::date) DESC,
               l.date_added DESC, l.id DESC
      LIMIT 25
    `;
    const { rows } = client
      ? await client.query<AdLeadJoinedRow>(sql, params)
      : await query<AdLeadJoinedRow>(sql, params);

    const all = rows.map(toDTO);
    const isExact = (r: AdLeadDTO) =>
      r.platform === key.platform && r.date_added === key.date_added;

    return {
      exact:   all.find(isExact) ?? null,
      similar: all.filter((r) => !isExact(r)),
    };
  },

  /** Optional `client` runs the insert inside a caller-managed transaction —
   *  the duplicate guard needs check + insert to be atomic. */
  async create(input: CreateAdLeadInput, client?: PoolClient): Promise<AdLeadDTO> {
    const sql = `INSERT INTO ad_leads (
         clinic_id, entered_by, patient_name, platform, campaign_name,
         date_added, booked, bella_called, bella_sms, bella_remarks
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`;
    const params = [
      input.clinic_id, input.entered_by, input.patient_name, input.platform, input.campaign_name,
      input.date_added, input.booked, input.bella_called, input.bella_sms, input.bella_remarks,
    ];
    const { rows } = client
      ? await client.query<{ id: string }>(sql, params)
      : await query<{ id: string }>(sql, params);

    const joined = await this.findJoinedById(rows[0].id, client);
    if (!joined) throw new Error('Failed to fetch newly inserted ad lead');
    return joined;
  },

  async update(id: string, patch: UpdateAdLeadInput, updatedBy: string, client?: PoolClient): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];

    const fields: (keyof UpdateAdLeadInput)[] = [
      'patient_name', 'platform', 'campaign_name', 'date_added', 'booked',
      'bella_called', 'bella_sms', 'bella_remarks',
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

    const sql = `UPDATE ad_leads SET ${sets.join(', ')} WHERE id = $${params.length}`;
    if (client) await client.query(sql, params);
    else        await query(sql, params);
  },

  async delete(id: string, client?: PoolClient): Promise<void> {
    const sql = `DELETE FROM ad_leads WHERE id = $1`;
    if (client) await client.query(sql, [id]);
    else        await query(sql, [id]);
  },

  /** Every distinct patient name across booked leads — the Sync button
   *  resolves all of them against Nookal in one go. */
  async distinctBookedNames(): Promise<string[]> {
    const { rows } = await query<{ patient_name: string }>(
      `SELECT DISTINCT patient_name FROM ad_leads WHERE booked = true ORDER BY patient_name`);
    return rows.map((r) => r.patient_name);
  },

  /**
   * Persist one Nookal lookup onto every booked lead with that exact name.
   * nookal_paid is denormalized from the matched candidate so the ad-spend
   * page can SUM it per platform without unpacking JSONB.
   */
  async saveNookalLookup(patientName: string, lookup: NookalPaidLookup): Promise<void> {
    const paid = lookup.status === 'matched' ? lookup.candidates[0]?.paid ?? null : null;
    await query(
      `UPDATE ad_leads
          SET nookal_status     = $2,
              nookal_candidates = $3::jsonb,
              nookal_paid       = $4,
              nookal_synced_at  = NOW()
        WHERE booked = true AND patient_name = $1`,
      [patientName, lookup.status, JSON.stringify(lookup.candidates), paid]);
  },
};
