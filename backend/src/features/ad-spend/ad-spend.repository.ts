import { query } from '../../db/pool';
import { RequestScope } from '../../middleware/auth.middleware';

export interface AdSpendRow {
  id:            string;
  spend_date:    Date;
  channel:       string;
  campaign_name: string | null;
  amount:        string; // pg returns NUMERIC as string
  notes:         string | null;
  entered_by:    string;
  created_at:    Date;
  updated_at:    Date;
  updated_by:    string | null;
}

export interface AdSpendDTO {
  id:              string;
  entered_by:      string;
  entered_by_name: string | null;
  spend_date:      string; // YYYY-MM-DD
  channel:         string;
  campaign_name:   string | null;
  amount:          number;
  notes:           string | null;
  created_at:      string;
  updated_at:      string;
}

interface AdSpendJoinedRow extends AdSpendRow {
  entered_by_name: string | null;
}

function isoDateOnly(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  // pg returns a DATE column as a JS Date at LOCAL midnight, so toISOString()
  // can shift to the previous day east of UTC. Use local components.
  if (typeof d === 'string') return d.slice(0, 10);
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function toDTO(row: AdSpendJoinedRow): AdSpendDTO {
  return {
    id:              row.id,
    entered_by:      row.entered_by,
    entered_by_name: row.entered_by_name,
    spend_date:      isoDateOnly(row.spend_date) ?? '',
    channel:         row.channel,
    campaign_name:   row.campaign_name,
    amount:          Number(row.amount),
    notes:           row.notes,
    created_at:      row.created_at.toISOString(),
    updated_at:      row.updated_at.toISOString(),
  };
}

export interface ListFilters {
  date_from?: string;
  date_to?:   string;
  channel?:   string;
  /** Case-insensitive partial match across campaign_name and notes. */
  search?:    string;
  limit?:     number;
  offset?:    number;
}

export interface CreateInput {
  entered_by:    string;
  spend_date:    string;
  channel:       string;
  campaign_name: string | null;
  amount:        number;
  notes:         string | null;
}

export interface UpdateInput {
  spend_date?:    string;
  channel?:       string;
  campaign_name?: string | null;
  amount?:        number;
  notes?:         string | null;
}

const SELECT_JOINED = `
  SELECT
    a.*,
    u_entered.full_name AS entered_by_name
  FROM ad_spend a
  LEFT JOIN users u_entered ON u_entered.id = a.entered_by
`;

/**
 * Apply caller scope. Ad spend is global (no clinic). The route is gated to
 * ADSPEND / ADMIN — both see every row. Any other role that somehow reaches
 * here is defensively pinned to its own entries.
 */
function applyScope(
  scope: RequestScope,
  startIndex: number
): { sql: string; params: unknown[] } {
  if (scope.role === 'ADMIN' || scope.role === 'ADSPEND') {
    return { sql: '1=1', params: [] };
  }
  return {
    sql:    `a.entered_by = $${startIndex}`,
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

  if (filters.date_from) {
    params.push(filters.date_from);
    where.push(`a.spend_date >= $${params.length}`);
  }
  if (filters.date_to) {
    params.push(filters.date_to);
    where.push(`a.spend_date <= $${params.length}`);
  }
  if (filters.channel) {
    params.push(filters.channel);
    where.push(`a.channel = $${params.length}`);
  }
  if (filters.search) {
    const escaped = filters.search.replace(/[\\%_]/g, (m) => '\\' + m);
    params.push(`%${escaped}%`);
    where.push(`(a.campaign_name ILIKE $${params.length} OR a.notes ILIKE $${params.length})`);
  }

  return { sql: where.join(' AND '), params };
}

export const adSpendRepository = {
  async list(scope: RequestScope, filters: ListFilters = {}): Promise<AdSpendDTO[]> {
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
      ORDER BY a.spend_date DESC, a.id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;
    const { rows } = await query<AdSpendJoinedRow>(sql, params);
    return rows.map(toDTO);
  },

  async count(scope: RequestScope, filters: ListFilters = {}): Promise<number> {
    const { sql: whereSql, params } = buildWhere(scope, filters);
    const sql = `SELECT COUNT(*)::bigint AS total FROM ad_spend a WHERE ${whereSql}`;
    const { rows } = await query<{ total: string }>(sql, params);
    return Number(rows[0]?.total ?? 0);
  },

  /** Aggregate over the full filtered set — drives the encoder summary cards. */
  async aggregate(scope: RequestScope, filters: ListFilters = {}): Promise<{
    total:       number;
    totalAmount: number;
    byChannel:   Record<string, number>;
  }> {
    const { sql: whereSql, params } = buildWhere(scope, filters);
    const [totals, byChannel] = await Promise.all([
      query<{ total: string; sum_amount: string | null }>(
        `SELECT COUNT(*)::bigint AS total,
                COALESCE(SUM(a.amount), 0)::numeric AS sum_amount
           FROM ad_spend a WHERE ${whereSql}`,
        params
      ),
      query<{ channel: string; amt: string }>(
        `SELECT a.channel, COALESCE(SUM(a.amount), 0)::numeric AS amt
           FROM ad_spend a WHERE ${whereSql} GROUP BY a.channel`,
        params
      ),
    ]);

    const t = totals.rows[0];
    return {
      total:       Number(t?.total ?? 0),
      totalAmount: Number(t?.sum_amount ?? 0),
      byChannel: byChannel.rows.reduce<Record<string, number>>((acc, r) => {
        acc[r.channel] = Number(r.amt);
        return acc;
      }, {}),
    };
  },

  async findById(scope: RequestScope, id: string): Promise<AdSpendDTO | null> {
    const params: unknown[] = [];
    const scoped = applyScope(scope, params.length + 1);
    params.push(...scoped.params);
    params.push(id);
    const idIdx = params.length;

    const sql = `
      ${SELECT_JOINED}
      WHERE ${scoped.sql} AND a.id = $${idIdx}
      LIMIT 1
    `;
    const { rows } = await query<AdSpendJoinedRow>(sql, params);
    return rows[0] ? toDTO(rows[0]) : null;
  },

  async findRawById(id: string): Promise<AdSpendRow | null> {
    const { rows } = await query<AdSpendRow>(
      `SELECT * FROM ad_spend WHERE id = $1 LIMIT 1`,
      [id]
    );
    return rows[0] ?? null;
  },

  async create(input: CreateInput): Promise<AdSpendDTO> {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO ad_spend (
         entered_by, spend_date, channel, campaign_name, amount, notes
       ) VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [
        input.entered_by, input.spend_date, input.channel,
        input.campaign_name, input.amount, input.notes,
      ]
    );

    const joined = await this.findById(
      { role: 'ADMIN', userId: '0', clinic_id: null, full_name: null },
      rows[0].id
    );
    if (!joined) throw new Error('Failed to fetch newly inserted ad spend');
    return joined;
  },

  async update(id: string, patch: UpdateInput, updatedBy: string): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];

    const fields: (keyof UpdateInput)[] = [
      'spend_date', 'channel', 'campaign_name', 'amount', 'notes',
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
      `UPDATE ad_spend SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params
    );
  },

  async delete(id: string): Promise<void> {
    await query(`DELETE FROM ad_spend WHERE id = $1`, [id]);
  },

  /** Weekly spend grouped by channel — drives the encoder's Weekly Report tab. */
  async weeklyReport(
    dateFrom: string,
    dateTo:   string
  ): Promise<Array<{
    week_start: string;
    week_end:   string;
    channel:    string;
    total:      number;
  }>> {
    const { rows } = await query<{
      week_start: Date; week_end: Date; channel: string; total: string;
    }>(
      `SELECT
         date_trunc('week', spend_date)::date                         AS week_start,
         (date_trunc('week', spend_date) + INTERVAL '4 days')::date  AS week_end,
         channel,
         COALESCE(SUM(amount), 0)::numeric                           AS total
       FROM ad_spend
       WHERE spend_date >= $1::date
         AND spend_date <= $2::date
       GROUP BY week_start, week_end, channel
       ORDER BY week_start ASC, channel ASC`,
      [dateFrom, dateTo]
    );
    return rows.map(r => ({
      week_start: isoDateOnly(r.week_start) ?? '',
      week_end:   isoDateOnly(r.week_end)   ?? '',
      channel:    r.channel,
      total:      Number(r.total),
    }));
  },

  /**
   * Per-day ad-spend rollup for the CEO dashboard. The dashboard buckets these
   * into the existing Mon–Fri week ranges (getWeekRanges) by date, exactly like
   * every other KPI — that is what "automatic week" means: derived, not stored.
   *
   * Ad spend is global, so this is business-wide regardless of the dashboard's
   * clinic selector. Bypasses RequestScope: the CEO dashboard is clinic-wide.
   */
  async dailyTotals(
    dateFrom: string,
    dateTo:   string
  ): Promise<Map<string, number>> {
    const { rows } = await query<{ day: Date; amt: string }>(
      `SELECT a.spend_date::date AS day,
              COALESCE(SUM(a.amount), 0)::numeric AS amt
         FROM ad_spend a
        WHERE a.spend_date >= $1::date
          AND a.spend_date <= $2::date
        GROUP BY a.spend_date::date`,
      [dateFrom, dateTo]
    );
    const map = new Map<string, number>();
    for (const r of rows) {
      const day = isoDateOnly(r.day);
      if (day) map.set(day, Number(r.amt));
    }
    return map;
  },
};
