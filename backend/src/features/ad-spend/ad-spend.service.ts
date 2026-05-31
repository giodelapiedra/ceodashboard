import {
  adSpendRepository, AdSpendDTO, ListFilters,
  PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX,
} from './ad-spend.repository';
import { RequestScope } from '../../middleware/auth.middleware';
import { Errors } from '../../shared/errors';
import { CreateAdSpendBody, UpdateAdSpendBody } from './ad-spend.validators';
import { fetchGoogleAdsSpend } from '../../services/google-ads.service';
import { query } from '../../db/pool';

export interface PagedAdSpend {
  data: AdSpendDTO[];
  pagination: {
    limit:   number;
    offset:  number;
    total:   number;
    hasMore: boolean;
  };
}

const SAME_DAY_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

function withinSameDayWindow(createdAt: Date): boolean {
  return Date.now() - createdAt.getTime() <= SAME_DAY_EDIT_WINDOW_MS;
}

export const adSpendService = {
  async list(scope: RequestScope, filters: ListFilters): Promise<PagedAdSpend> {
    const limit  = Math.min(Math.max(filters.limit ?? PAGE_LIMIT_DEFAULT, 1), PAGE_LIMIT_MAX);
    const offset = Math.max(filters.offset ?? 0, 0);
    const effective: ListFilters = { ...filters, limit, offset };

    const [data, total] = await Promise.all([
      adSpendRepository.list(scope, effective),
      adSpendRepository.count(scope, effective),
    ]);

    return {
      data,
      pagination: { limit, offset, total, hasMore: offset + data.length < total },
    };
  },

  async summary(scope: RequestScope, filters: ListFilters) {
    return adSpendRepository.aggregate(scope, filters);
  },

  async get(scope: RequestScope, id: string): Promise<AdSpendDTO> {
    const row = await adSpendRepository.findById(scope, id);
    if (!row) throw Errors.notFound(`Ad spend ${id} not found`);
    return row;
  },

  async create(scope: RequestScope, input: CreateAdSpendBody): Promise<AdSpendDTO> {
    // ADMIN is read/correct-only, same convention as dropouts / case acceptance
    // — entries are created by the dedicated ADSPEND encoder account.
    if (scope.role === 'ADMIN') {
      throw Errors.forbidden('ADMIN cannot create ad spend entries — use the ADSPEND account');
    }

    return adSpendRepository.create({
      entered_by:    scope.userId,
      spend_date:    input.spend_date,
      channel:       input.channel,
      campaign_name: input.campaign_name ?? null,
      amount:        input.amount,
      notes:         input.notes ?? null,
    });
  },

  async update(scope: RequestScope, id: string, patch: UpdateAdSpendBody): Promise<AdSpendDTO> {
    const existing = await adSpendRepository.findRawById(id);
    if (!existing) throw Errors.notFound(`Ad spend ${id} not found`);

    // ADMIN can correct any entry. ADSPEND can edit their own entries anytime.
    if (scope.role !== 'ADMIN') {
      if (existing.entered_by !== scope.userId) {
        throw Errors.forbidden('You can only edit your own ad spend entries');
      }
    }

    await adSpendRepository.update(id, patch, scope.userId);
    return this.get(scope, id);
  },

  async weeklyReport(
    _scope: RequestScope,
    dateFrom: string,
    dateTo:   string
  ): Promise<Array<{
    week_start: string;
    week_end:   string;
    byChannel:  Record<string, number>;
    total:      number;
  }>> {
    const rows = await adSpendRepository.weeklyReport(dateFrom, dateTo);

    const weekMap = new Map<string, {
      week_start: string;
      week_end:   string;
      byChannel:  Record<string, number>;
      total:      number;
    }>();

    for (const row of rows) {
      let week = weekMap.get(row.week_start);
      if (!week) {
        week = { week_start: row.week_start, week_end: row.week_end, byChannel: {}, total: 0 };
        weekMap.set(row.week_start, week);
      }
      week.byChannel[row.channel] = row.total;
      week.total += row.total;
    }
    return Array.from(weekMap.values());
  },

  async delete(scope: RequestScope, id: string): Promise<void> {
    const existing = await adSpendRepository.findRawById(id);
    if (!existing) throw Errors.notFound(`Ad spend ${id} not found`);

    if (scope.role !== 'ADMIN') {
      if (existing.entered_by !== scope.userId) {
        throw Errors.forbidden('You can only delete your own ad spend entries');
      }
    }
    await adSpendRepository.delete(id);
  },

  async syncGoogleAds(
    dateFrom: string,
    dateTo:   string
  ): Promise<{ inserted: number; dates: string[] }> {
    // Look up the ADSPEND system user as the author of auto-synced rows.
    const { rows: userRows } = await query<{ id: string }>(
      `SELECT id FROM users WHERE role = 'ADSPEND' LIMIT 1`
    );
    if (!userRows[0]) {
      throw Errors.internal('ADSPEND user not found — run db:seed:adspend first');
    }
    const systemUserId = userRows[0].id;

    const rows = await fetchGoogleAdsSpend(dateFrom, dateTo);
    if (rows.length === 0) return { inserted: 0, dates: [] };

    const dates = [...new Set(rows.map(r => r.spend_date))];

    // Delete existing auto-synced Google rows for those dates before re-inserting.
    await query(
      `DELETE FROM ad_spend
        WHERE channel = 'Google'
          AND spend_date = ANY($1::date[])
          AND entered_by = $2
          AND notes = 'Auto-synced from Google Ads'`,
      [dates, systemUserId]
    );

    for (const row of rows) {
      await adSpendRepository.create({
        entered_by:    systemUserId,
        spend_date:    row.spend_date,
        channel:       'Google',
        campaign_name: row.campaign_name,
        amount:        row.amount,
        notes:         'Auto-synced from Google Ads',
      });
    }

    return { inserted: rows.length, dates };
  },
};
