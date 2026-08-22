import {
  adLeadRepository, AdLeadDTO, AdLeadDupKey, ListFilters, adLeadLockKey,
  PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX,
} from './ad-leads.repository';
import { RequestScope } from '../../middleware/auth.middleware';
import { Errors } from '../../shared/errors';
import { canAccessAdLeads } from '../../shared/roles';
import { withTransaction } from '../../db/pool';
import {
  DuplicateReport, OnDuplicate, duplicateConflict, lockDuplicateKey,
} from '../../shared/duplicates';
import { lookupPaidByNames } from '../../services/nookal-client-paid.service';
import {
  CheckAdLeadDuplicateBody, CreateAdLeadBody, UpdateAdLeadBody,
} from './ad-leads.validators';

export interface PagedAdLeads {
  data: AdLeadDTO[];
  pagination: { limit: number; offset: number; total: number; hasMore: boolean };
}

/** Gate the whole feature: ADMIN + all front desk + allow-listed extras. */
function assertAdLeadsAccess(scope: RequestScope): void {
  if (!canAccessAdLeads(scope.role, scope.email)) {
    throw Errors.forbidden('You do not have access to the Meta/Google Leads section');
  }
}

/**
 * FRONT_DESK is pinned to its own clinic; FRONT_DESK_GLOBAL / ADMIN / ADSPEND
 * have no clinic pin (clinic_id is NULL on those accounts) and pick per entry.
 */
function resolveClinicId(scope: RequestScope, requested?: string): string {
  if (scope.role === 'FRONT_DESK_GLOBAL' || scope.role === 'ADMIN' || scope.role === 'ADSPEND') {
    if (!requested) {
      throw Errors.validation('clinic_id is required — pick which clinic this lead is for');
    }
    return requested;
  }
  if (!scope.clinic_id) throw Errors.forbidden('User has no clinic assigned');
  return scope.clinic_id;
}

export const adLeadService = {
  async list(scope: RequestScope, filters: ListFilters): Promise<PagedAdLeads> {
    assertAdLeadsAccess(scope);
    const limit  = Math.min(Math.max(filters.limit ?? PAGE_LIMIT_DEFAULT, 1), PAGE_LIMIT_MAX);
    const offset = Math.max(filters.offset ?? 0, 0);
    const effective: ListFilters = { ...filters, limit, offset };

    const [data, total] = await Promise.all([
      adLeadRepository.list(scope, effective),
      adLeadRepository.count(scope, effective),
    ]);

    return {
      data,
      pagination: { limit, offset, total, hasMore: offset + data.length < total },
    };
  },

  async summary(scope: RequestScope, filters: ListFilters) {
    assertAdLeadsAccess(scope);
    return adLeadRepository.aggregate(scope, filters);
  },

  /**
   * Resolve EVERY booked lead's patient name to Nookal account totals and
   * persist the result on the lead rows (nookal_status / candidates / paid /
   * synced_at). One manual click refreshes everything; page loads afterwards
   * read straight from the DB with zero Nookal calls, and the ad-spend page
   * totals nookal_paid per platform. Always bypasses the lookup cache — the
   * whole point of clicking Sync is to pick up payments taken since the last
   * one. Errors are NOT saved, so a Nookal hiccup never wipes stored totals.
   */
  async syncNookalPaid(scope: RequestScope): Promise<{
    names: number; matched: number; multiple: number; not_found: number; errors: number;
  }> {
    assertAdLeadsAccess(scope);
    const names = await adLeadRepository.distinctBookedNames();
    const summary = { names: names.length, matched: 0, multiple: 0, not_found: 0, errors: 0 };
    if (names.length === 0) return summary;

    const results = await lookupPaidByNames(names, true);
    for (const [name, lookup] of Object.entries(results)) {
      if (lookup.status === 'error') { summary.errors++; continue; }
      await adLeadRepository.saveNookalLookup(name, lookup);
      if (lookup.status === 'matched')       summary.matched++;
      else if (lookup.status === 'multiple') summary.multiple++;
      else                                   summary.not_found++;
    }
    return summary;
  },

  async get(scope: RequestScope, id: string): Promise<AdLeadDTO> {
    assertAdLeadsAccess(scope);
    const row = await adLeadRepository.findById(scope, id);
    if (!row) throw Errors.notFound(`Ad lead ${id} not found`);
    return row;
  },

  /**
   * Pre-flight duplicate lookup for the entry form. Advisory only — create()
   * re-checks under a lock, because between this call and the POST another
   * user can key the very same lead.
   */
  async checkDuplicate(
    scope: RequestScope,
    input: CheckAdLeadDuplicateBody
  ): Promise<DuplicateReport<AdLeadDTO>> {
    assertAdLeadsAccess(scope);
    const clinicId = resolveClinicId(scope, input.clinic_id);
    const { exact, similar } = await adLeadRepository.findDuplicates(
      {
        clinic_id:    clinicId,
        patient_name: input.patient_name,
        platform:     input.platform ?? '',
        date_added:   input.date_added,
      },
      { excludeId: input.exclude_id }
    );
    return { exact, similar };
  },

  async create(scope: RequestScope, input: CreateAdLeadBody): Promise<AdLeadDTO> {
    // Only the super admin and allow-listed front-desk logins encode leads.
    assertAdLeadsAccess(scope);

    const clinicId = resolveClinicId(scope, input.clinic_id);
    // Platform Source is optional at entry — '' means "not specified".
    const platform = input.platform ?? '';

    const key: AdLeadDupKey = {
      clinic_id:    clinicId,
      patient_name: input.patient_name,
      platform,
      date_added:   input.date_added,
    };
    const onDuplicate: OnDuplicate = input.on_duplicate ?? 'reject';

    const values = {
      patient_name:  input.patient_name,
      platform,
      campaign_name: input.campaign_name ?? null,
      date_added:    input.date_added,
      booked:        input.booked ?? false,
      bella_called:  input.bella_called ?? null,
      bella_sms:     input.bella_sms ?? null,
      bella_remarks: input.bella_remarks ?? null,
    };

    // Check and write under one advisory lock so two identical POSTs racing
    // (double-click, two tabs, a re-run of the same Meta export) cannot both
    // pass the check. The lock is transaction-scoped — no manual release.
    return withTransaction(async (client) => {
      await lockDuplicateKey(client, adLeadLockKey(key));
      const { exact, similar } = await adLeadRepository.findDuplicates(key, {}, client);

      // 409 so the UI can show the diff. 'allow' = the user saw that diff and
      // chose to save anyway — always honoured, whatever the role. Nothing here
      // can edit an existing lead, so this is not a way around update().
      if (exact && onDuplicate === 'reject') {
        throw duplicateConflict<AdLeadDTO>('lead', { exact, similar });
      }

      return adLeadRepository.create({
        clinic_id:  clinicId,
        entered_by: scope.userId,
        ...values,
      }, client);
    });
  },

  async update(scope: RequestScope, id: string, patch: UpdateAdLeadBody): Promise<AdLeadDTO> {
    assertAdLeadsAccess(scope);
    const existing = await adLeadRepository.findRawById(id);
    if (!existing) throw Errors.notFound(`Ad lead ${id} not found`);

    // The ad-spend encoder may edit leads (2026-08-12) but never writes
    // directly — every one of its corrections goes through admin approval, so
    // the direct PATCH stays shut even for its own rows. Checked before the
    // ownership rule below, which would otherwise let it through.
    if (scope.role === 'ADSPEND') {
      throw Errors.forbidden(
        'Your edits need admin approval — submit an edit request instead'
      );
    }

    // ADMIN edits any; everyone else only their own entries.
    if (scope.role !== 'ADMIN' && existing.entered_by !== scope.userId) {
      throw Errors.forbidden('You can only edit your own ad leads');
    }

    await adLeadRepository.update(id, patch, scope.userId);

    const updated =
      (await adLeadRepository.findById(scope, id)) ??
      (await adLeadRepository.findById(
        { role: 'ADMIN', userId: '0', clinic_id: null, full_name: null }, id));
    if (!updated) throw Errors.notFound(`Ad lead ${id} not found`);
    return updated;
  },

  async delete(scope: RequestScope, id: string): Promise<void> {
    assertAdLeadsAccess(scope);
    const existing = await adLeadRepository.findRawById(id);
    if (!existing) throw Errors.notFound(`Ad lead ${id} not found`);

    // Only ADMIN deletes directly. Front-desk must file a delete request
    // (POST /api/delete-requests) which an ADMIN approves — same approval flow
    // as dropout / case-acceptance.
    if (scope.role !== 'ADMIN') {
      throw Errors.forbidden('Deletion needs admin approval — submit a delete request instead');
    }
    await adLeadRepository.delete(id);
  },
};
