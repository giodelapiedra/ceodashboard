import {
  caseAcceptanceRepository, CaseAcceptanceDTO, ListFilters,
  PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX,
} from './case-acceptance.repository';
import { userRepository } from '../../repositories/user.repository';
import { RequestScope } from '../../middleware/auth.middleware';
import { Errors } from '../../shared/errors';
import {
  CreateCaseAcceptanceBody, UpdateCaseAcceptanceBody,
} from './case-acceptance.validators';

export interface PagedCaseAcceptance {
  data: CaseAcceptanceDTO[];
  pagination: {
    limit:    number;
    offset:   number;
    total:    number;
    hasMore:  boolean;
  };
}

const SAME_DAY_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

function withinSameDayWindow(createdAt: Date): boolean {
  return Date.now() - createdAt.getTime() <= SAME_DAY_EDIT_WINDOW_MS;
}

export const caseAcceptanceService = {
  async list(scope: RequestScope, filters: ListFilters): Promise<PagedCaseAcceptance> {
    const limit  = Math.min(Math.max(filters.limit ?? PAGE_LIMIT_DEFAULT, 1), PAGE_LIMIT_MAX);
    const offset = Math.max(filters.offset ?? 0, 0);
    const effective: ListFilters = { ...filters, limit, offset };

    const [data, total] = await Promise.all([
      caseAcceptanceRepository.list(scope, effective),
      caseAcceptanceRepository.count(scope, effective),
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
    return caseAcceptanceRepository.aggregate(scope, filters);
  },

  /**
   * Like list() but unpaginated — used by the XLSX export endpoint to dump
   * the entire filtered set at once. Pages through the repo (which caps at
   * PAGE_LIMIT_MAX per call) and stops when nothing more comes back.
   * HARD_CAP guards against an unbounded scope filter.
   */
  async listAll(scope: RequestScope, filters: ListFilters): Promise<CaseAcceptanceDTO[]> {
    const HARD_CAP = 25_000;
    const out: CaseAcceptanceDTO[] = [];
    let offset = 0;
    for (;;) {
      const page = await caseAcceptanceRepository.list(scope, {
        ...filters,
        limit:  PAGE_LIMIT_MAX,
        offset,
      });
      out.push(...page);
      if (page.length < PAGE_LIMIT_MAX) break;
      offset += page.length;
      if (out.length >= HARD_CAP) break;
    }
    return out;
  },

  async get(scope: RequestScope, id: string): Promise<CaseAcceptanceDTO> {
    const row = await caseAcceptanceRepository.findById(scope, id);
    if (!row) throw Errors.notFound(`Case acceptance ${id} not found`);
    return row;
  },

  async create(scope: RequestScope, input: CreateCaseAcceptanceBody): Promise<CaseAcceptanceDTO> {
    if (scope.role === 'ADMIN') {
      throw Errors.forbidden('ADMIN cannot create case acceptance entries — use a clinician/front-desk account');
    }

    // Resolve the entry's clinic. FRONT_DESK_GLOBAL has no clinic on their
    // account and must pick one per entry; everyone else is pinned by scope.
    let clinicId: string;
    if (scope.role === 'FRONT_DESK_GLOBAL') {
      if (!input.clinic_id) {
        throw Errors.validation('clinic_id is required for global front-desk accounts');
      }
      clinicId = input.clinic_id;
    } else {
      if (!scope.clinic_id) throw Errors.forbidden('User has no clinic assigned');
      clinicId = scope.clinic_id;
    }

    const clinician = await userRepository.findById(input.clinician_id);
    if (!clinician || !clinician.is_active) {
      throw Errors.validation(`Clinician ${input.clinician_id} not found or inactive`);
    }
    if (clinician.role !== 'CLINICIAN') {
      throw Errors.validation(`User ${input.clinician_id} is not a clinician`);
    }
    if (clinician.clinic_id !== clinicId) {
      throw Errors.validation(`Clinician ${input.clinician_id} is not in clinic ${clinicId}`);
    }

    // Receptionist accounts (FRONT_DESK / FRONT_DESK_GLOBAL) get their
    // front_staff_name stamped from their login — anything client-side is ignored.
    const isReceptionist =
      scope.role === 'FRONT_DESK' || scope.role === 'FRONT_DESK_GLOBAL';
    let frontStaffName: string | null;
    if (isReceptionist) {
      if (!scope.full_name) {
        throw Errors.validation('Your account has no name set — ask an admin to update it');
      }
      frontStaffName = scope.full_name;
    } else {
      frontStaffName = input.front_staff_name ?? null;
    }

    return caseAcceptanceRepository.create({
      clinic_id:               clinicId,
      entered_by:              scope.userId,
      front_staff_name:        frontStaffName,
      clinician_id:            input.clinician_id,
      patient_name:            input.patient_name,
      date_logged:             input.date_logged,
      treatment_plan_provided: input.treatment_plan_provided ?? null,
      case_recommendations:    input.case_recommendations,
      appointments_booked:     input.appointments_booked,
      prepay_offered:          input.prepay_offered ?? null,
      prepay_accepted:         input.prepay_accepted ?? null,
      transition_completed:    input.transition_completed ?? null,
      notes:                   input.notes ?? null,
    });
  },

  async update(scope: RequestScope, id: string, patch: UpdateCaseAcceptanceBody): Promise<CaseAcceptanceDTO> {
    const existing = await caseAcceptanceRepository.findRawById(id);
    if (!existing) throw Errors.notFound(`Case acceptance ${id} not found`);

    // ADMIN can edit any entry at any time (data-correction privilege). Every
    // change is captured in audit_log so the trail is preserved. All other
    // roles are restricted to their own entries within the 24h same-day window.
    if (scope.role !== 'ADMIN') {
      if (existing.entered_by !== scope.userId) {
        throw Errors.forbidden('You can only edit your own case acceptance entries');
      }
      if (!withinSameDayWindow(existing.created_at)) {
        throw Errors.forbidden('Edit window has passed (24h since creation)');
      }
    }

    if (patch.clinician_id) {
      const clinician = await userRepository.findById(patch.clinician_id);
      if (!clinician || !clinician.is_active) {
        throw Errors.validation(`Clinician ${patch.clinician_id} not found or inactive`);
      }
      if (clinician.role !== 'CLINICIAN' || clinician.clinic_id !== existing.clinic_id) {
        throw Errors.validation('Clinician must be in the same clinic');
      }
    }

    // Cross-field invariant against the merged result: booked <= recs. The DB
    // CHECK enforces this too, but raising a 400 here gives a friendlier error.
    const nextRecs   = patch.case_recommendations ?? existing.case_recommendations;
    const nextBooked = patch.appointments_booked  ?? existing.appointments_booked;
    if (nextBooked > nextRecs) {
      throw Errors.validation('Booked cannot exceed case recommendations');
    }

    // Receptionist accounts cannot rewrite their stamped front_staff_name.
    const isReceptionist =
      scope.role === 'FRONT_DESK' || scope.role === 'FRONT_DESK_GLOBAL';
    const safePatch = isReceptionist
      ? { ...patch, front_staff_name: undefined }
      : patch;

    await caseAcceptanceRepository.update(id, safePatch, scope.userId);
    return this.get(scope, id);
  },

  async delete(scope: RequestScope, id: string): Promise<void> {
    const existing = await caseAcceptanceRepository.findRawById(id);
    if (!existing) throw Errors.notFound(`Case acceptance ${id} not found`);

    if (scope.role !== 'ADMIN') {
      if (existing.entered_by !== scope.userId) {
        throw Errors.forbidden('You can only delete your own case acceptance entries');
      }
      if (!withinSameDayWindow(existing.created_at)) {
        throw Errors.forbidden('Delete window has passed (24h since creation)');
      }
    }
    await caseAcceptanceRepository.delete(id);
  },
};
