import {
  dropoutRepository, DropoutDTO, DropoutDupKey, ListFilters, dropoutLockKey,
  PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX,
} from './dropout.repository';
import { userRepository, canBeTreatingClinician } from '../../repositories/user.repository';
import { RequestScope } from '../../middleware/auth.middleware';
import { Errors } from '../../shared/errors';
import { withTransaction } from '../../db/pool';
import {
  DuplicateReport, OnDuplicate, duplicateConflict, lockDuplicateKey,
} from '../../shared/duplicates';
import {
  CheckDropoutDuplicateBody, CreateDropoutBody, UpdateDropoutBody,
} from './dropout.validators';

export interface PagedDropouts {
  data: DropoutDTO[];
  pagination: {
    limit:    number;
    offset:   number;
    total:    number;
    hasMore:  boolean;
  };
}

/**
 * Result of create(): the caller (route) needs to know whether a row was
 * inserted or an existing one was replaced, so it can pick 201 vs 200 and
 * write the right audit action.
 */
export interface CreateDropoutResult {
  row:      DropoutDTO;
  outcome:  'created' | 'overwritten';
  /** The row as it looked BEFORE an overwrite — goes into the audit trail. */
  replaced: DropoutDTO | null;
}

/**
 * Who may overwrite an existing dropout in place. Intentionally identical to
 * the rule in update(): ADMIN edits anything, everyone else only their own
 * entries. When this is false the UI offers the edit-request flow instead —
 * the duplicate guard must not become a way around the approval rules.
 */
function canOverwriteDropout(scope: RequestScope, existing: DropoutDTO): boolean {
  return scope.role === 'ADMIN' || existing.entered_by === scope.userId;
}

/**
 * Which clinic an entry belongs to. FRONT_DESK_GLOBAL / CLINICIAN / ADMIN have
 * no pinned clinic and choose per entry; FRONT_DESK is pinned by scope so it
 * cannot log against another clinic.
 */
function resolveClinicId(scope: RequestScope, requested?: string): string {
  if (scope.role === 'FRONT_DESK_GLOBAL' || scope.role === 'CLINICIAN' || scope.role === 'ADMIN') {
    if (!requested) {
      throw Errors.validation('clinic_id is required — pick which clinic this entry is for');
    }
    return requested;
  }
  if (!scope.clinic_id) throw Errors.forbidden('User has no clinic assigned');
  return scope.clinic_id;
}

export const dropoutService = {
  async list(scope: RequestScope, filters: ListFilters): Promise<PagedDropouts> {
    const limit  = Math.min(Math.max(filters.limit ?? PAGE_LIMIT_DEFAULT, 1), PAGE_LIMIT_MAX);
    const offset = Math.max(filters.offset ?? 0, 0);
    const effective: ListFilters = { ...filters, limit, offset };

    // Run data + count in parallel — they hit the same indexes so this is
    // cheaper than serializing.
    const [data, total] = await Promise.all([
      dropoutRepository.list(scope, effective),
      dropoutRepository.count(scope, effective),
    ]);

    return {
      data,
      pagination: {
        limit,
        offset,
        total,
        hasMore: offset + data.length < total,
      },
    };
  },

  async summary(scope: RequestScope, filters: ListFilters) {
    return dropoutRepository.aggregate(scope, filters);
  },

  async get(scope: RequestScope, id: string): Promise<DropoutDTO> {
    const row = await dropoutRepository.findById(scope, id);
    if (!row) throw Errors.notFound(`Dropout ${id} not found`);
    return row;
  },

  /**
   * Pre-flight duplicate lookup for the entry form. Advisory only — create()
   * re-checks under a lock, because between this call and the POST another
   * user can key the very same entry.
   */
  async checkDuplicate(
    scope: RequestScope,
    input: CheckDropoutDuplicateBody
  ): Promise<DuplicateReport<DropoutDTO>> {
    const clinicId = resolveClinicId(scope, input.clinic_id);
    const { exact, similar } = await dropoutRepository.findDuplicates(
      {
        clinic_id:    clinicId,
        clinician_id: input.clinician_id,
        patient_name: input.patient_name,
        date_logged:  input.date_logged,
      },
      { excludeId: input.exclude_id }
    );
    return {
      exact,
      similar,
      can_overwrite: exact ? canOverwriteDropout(scope, exact) : false,
    };
  },

  async create(scope: RequestScope, input: CreateDropoutBody): Promise<CreateDropoutResult> {
    // Resolve clinic for the entry. FRONT_DESK_GLOBAL has no clinic pin and
    // must pick one per entry. CLINICIAN also picks per entry — physios
    // rotate between clinics, so the entry's clinic_id is independent of
    // their primary users.clinic_id. ADMIN (super admin) likewise has no
    // pinned clinic and picks per entry. FRONT_DESK (single-clinic
    // receptionist) remains pinned by scope so they can't log for other clinics.
    const clinicId = resolveClinicId(scope, input.clinic_id);

    // Clinician must exist + active + actually be a CLINICIAN. Their primary
    // users.clinic_id is intentionally NOT compared against clinicId here —
    // any active clinician can be tagged on an entry for any clinic.
    const clinician = await userRepository.findById(input.clinician_id);
    if (!clinician || !clinician.is_active) {
      throw Errors.validation(`Clinician ${input.clinician_id} not found or inactive`);
    }
    if (!canBeTreatingClinician(clinician)) {
      throw Errors.validation(
        `${clinician.full_name || clinician.email} cannot be tagged as the treating clinician`
      );
    }

    // Receptionist accounts (FRONT_DESK / FRONT_DESK_GLOBAL) have a fixed
    // identity from their login — stamp the entry with their own full_name
    // and ignore any value the client tries to send.
    const isReceptionist =
      scope.role === 'FRONT_DESK' || scope.role === 'FRONT_DESK_GLOBAL';
    let frontStaffName: string | null;
    if (isReceptionist) {
      if (!scope.full_name) {
        throw Errors.validation('Your account has no name set — ask an admin to update it');
      }
      frontStaffName = scope.full_name;
    } else {
      // CLINICIAN may explicitly set front_staff_name (e.g. "Other - Physio").
      // The zod validator already enforced it against FRONT_STAFF_NAMES.
      frontStaffName = input.front_staff_name ?? null;
    }

    const key: DropoutDupKey = {
      clinic_id:    clinicId,
      clinician_id: input.clinician_id,
      patient_name: input.patient_name,
      date_logged:  input.date_logged,
    };
    const onDuplicate: OnDuplicate = input.on_duplicate ?? 'reject';

    // Check and write under one advisory lock so two identical POSTs racing
    // (double-click, two tabs, two staff keying the same patient) cannot both
    // pass the check. The lock is transaction-scoped — no manual release.
    return withTransaction(async (client) => {
      await lockDuplicateKey(client, dropoutLockKey(key));
      const { exact, similar } = await dropoutRepository.findDuplicates(key, {}, client);

      // 'allow' = the user saw the diff and confirmed it is a separate entry.
      if (exact && onDuplicate !== 'allow') {
        const canOverwrite = canOverwriteDropout(scope, exact);

        if (onDuplicate === 'reject') {
          throw duplicateConflict<DropoutDTO>('dropout entry', {
            exact, similar, can_overwrite: canOverwrite,
          });
        }

        // onDuplicate === 'overwrite'
        if (!canOverwrite) {
          throw Errors.forbidden(
            'That entry was logged by someone else — submit an edit request so an admin can approve the change'
          );
        }
        await dropoutRepository.update(exact.id, {
          front_staff_name:            frontStaffName,
          clinician_id:                input.clinician_id,
          patient_name:                input.patient_name,
          date_logged:                 input.date_logged,
          appointment_cancelled_dates: input.appointment_cancelled_dates ?? [],
          status:                      input.status,
          reason:                      input.reason,
          notes:                       input.notes ?? null,
        }, scope.userId, client);

        const updated = await dropoutRepository.findJoinedById(exact.id, client);
        if (!updated) throw Errors.notFound(`Dropout ${exact.id} not found`);
        return { row: updated, outcome: 'overwritten' as const, replaced: exact };
      }

      const created = await dropoutRepository.create({
        clinic_id:                   clinicId,
        entered_by:                  scope.userId,
        front_staff_name:            frontStaffName,
        clinician_id:                input.clinician_id,
        patient_name:                input.patient_name,
        date_logged:                 input.date_logged,
        appointment_cancelled_dates: input.appointment_cancelled_dates ?? [],
        status:                      input.status,
        reason:                      input.reason,
        notes:                       input.notes ?? null,
      }, client);
      return { row: created, outcome: 'created' as const, replaced: null };
    });
  },

  async update(scope: RequestScope, id: string, patch: UpdateDropoutBody): Promise<DropoutDTO> {
    const existing = await dropoutRepository.findRawById(id);
    if (!existing) throw Errors.notFound(`Dropout ${id} not found`);

    // ADMIN can edit any entry. Clinician / front-desk can edit their OWN
    // entries at any time (no 24h window) — they may need to correct data
    // days later. Every change is captured in audit_log.
    if (scope.role !== 'ADMIN') {
      if (existing.entered_by !== scope.userId) {
        throw Errors.forbidden('You can only edit your own dropout entries');
      }
    }

    if (patch.clinician_id) {
      const clinician = await userRepository.findById(patch.clinician_id);
      if (!clinician || !clinician.is_active) {
        throw Errors.validation(`Clinician ${patch.clinician_id} not found or inactive`);
      }
      if (!canBeTreatingClinician(clinician)) {
        throw Errors.validation(
          `${clinician.full_name || clinician.email} cannot be tagged as the treating clinician`
        );
      }
    }

    // Receptionist accounts have a fixed front_staff_name (their own login).
    // Strip any client-provided value before persisting.
    const isReceptionist =
      scope.role === 'FRONT_DESK' || scope.role === 'FRONT_DESK_GLOBAL';
    const safePatch = isReceptionist
      ? { ...patch, front_staff_name: undefined }
      : patch;

    await dropoutRepository.update(id, safePatch, scope.userId);

    // Re-read for the response. A CLINICIAN's list scope filters on
    // clinician_id — if they just reassigned the entry to another clinician,
    // the scoped read comes back empty even though the update committed.
    // Fall back to an unscoped read (ownership was already verified above)
    // so the caller gets the updated row instead of a bogus 404.
    const updated =
      (await dropoutRepository.findById(scope, id)) ??
      (await dropoutRepository.findById(
        { role: 'ADMIN', userId: '0', clinic_id: null, full_name: null }, id
      ));
    if (!updated) throw Errors.notFound(`Dropout ${id} not found`);
    return updated;
  },

  async delete(scope: RequestScope, id: string): Promise<void> {
    const existing = await dropoutRepository.findRawById(id);
    if (!existing) throw Errors.notFound(`Dropout ${id} not found`);

    // Only ADMIN deletes directly. Clinician / front-desk must file a delete
    // request (POST /api/delete-requests) which an ADMIN approves.
    if (scope.role !== 'ADMIN') {
      throw Errors.forbidden('Deletion needs admin approval — submit a delete request instead');
    }
    await dropoutRepository.delete(id);
  },
};
