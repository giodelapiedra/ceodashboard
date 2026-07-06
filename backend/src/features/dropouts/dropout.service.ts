import {
  dropoutRepository, DropoutDTO, ListFilters,
  PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX,
} from './dropout.repository';
import { userRepository } from '../../repositories/user.repository';
import { RequestScope } from '../../middleware/auth.middleware';
import { Errors } from '../../shared/errors';
import { CreateDropoutBody, UpdateDropoutBody } from './dropout.validators';

export interface PagedDropouts {
  data: DropoutDTO[];
  pagination: {
    limit:    number;
    offset:   number;
    total:    number;
    hasMore:  boolean;
  };
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

  async create(scope: RequestScope, input: CreateDropoutBody): Promise<DropoutDTO> {
    if (scope.role === 'ADMIN') {
      throw Errors.forbidden('ADMIN cannot create dropout entries — use a clinician/front-desk account');
    }

    // Resolve clinic for the entry. FRONT_DESK_GLOBAL has no clinic pin and
    // must pick one per entry. CLINICIAN also picks per entry — physios
    // rotate between clinics, so the entry's clinic_id is independent of
    // their primary users.clinic_id. FRONT_DESK (single-clinic receptionist)
    // remains pinned by scope so they can't log entries for other clinics.
    let clinicId: string;
    if (scope.role === 'FRONT_DESK_GLOBAL' || scope.role === 'CLINICIAN') {
      if (!input.clinic_id) {
        throw Errors.validation('clinic_id is required — pick which clinic this entry is for');
      }
      clinicId = input.clinic_id;
    } else {
      if (!scope.clinic_id) throw Errors.forbidden('User has no clinic assigned');
      clinicId = scope.clinic_id;
    }

    // Clinician must exist + active + actually be a CLINICIAN. Their primary
    // users.clinic_id is intentionally NOT compared against clinicId here —
    // any active clinician can be tagged on an entry for any clinic.
    const clinician = await userRepository.findById(input.clinician_id);
    if (!clinician || !clinician.is_active) {
      throw Errors.validation(`Clinician ${input.clinician_id} not found or inactive`);
    }
    if (clinician.role !== 'CLINICIAN') {
      throw Errors.validation(`User ${input.clinician_id} is not a clinician`);
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

    return dropoutRepository.create({
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
      if (clinician.role !== 'CLINICIAN') {
        throw Errors.validation(`User ${patch.clinician_id} is not a clinician`);
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
    return this.get(scope, id);
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
