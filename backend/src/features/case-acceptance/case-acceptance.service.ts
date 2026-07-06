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

    // Resolve the entry's clinic. FRONT_DESK_GLOBAL and CLINICIAN both pick
    // per entry — physios rotate between clinics, so a CLINICIAN account
    // can log entries against any clinic regardless of their primary
    // users.clinic_id. FRONT_DESK (single-clinic receptionist) remains
    // pinned by scope so they can't cross clinics.
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

    const clinician = await userRepository.findById(input.clinician_id);
    if (!clinician || !clinician.is_active) {
      throw Errors.validation(`Clinician ${input.clinician_id} not found or inactive`);
    }
    if (clinician.role !== 'CLINICIAN') {
      throw Errors.validation(`User ${input.clinician_id} is not a clinician`);
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
      transition_notes:        input.transition_notes ?? null,
      notes:                   input.notes ?? null,
    });
  },

  async update(scope: RequestScope, id: string, patch: UpdateCaseAcceptanceBody): Promise<CaseAcceptanceDTO> {
    const existing = await caseAcceptanceRepository.findRawById(id);
    if (!existing) throw Errors.notFound(`Case acceptance ${id} not found`);

    // Non-admin users must go through the edit-request approval flow.
    // ADMIN edits entries directly.
    if (scope.role !== 'ADMIN') {
      throw Errors.forbidden(
        'Your edits need admin approval — submit an edit request (POST /api/edit-requests) instead'
      );
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

    // Cross-field invariant against the merged result: booked <= recs. The DB
    // CHECK enforces this too, but raising a 400 here gives a friendlier error.
    const nextRecs   = patch.case_recommendations ?? existing.case_recommendations;
    const nextBooked = patch.appointments_booked  ?? existing.appointments_booked;
    if (nextBooked > nextRecs) {
      throw Errors.validation('Booked cannot exceed case recommendations');
    }

    await caseAcceptanceRepository.update(id, patch, scope.userId);
    return this.get(scope, id);
  },

  async delete(scope: RequestScope, id: string): Promise<void> {
    const existing = await caseAcceptanceRepository.findRawById(id);
    if (!existing) throw Errors.notFound(`Case acceptance ${id} not found`);

    // Only ADMIN deletes directly. Clinician / front-desk must file a delete
    // request (POST /api/delete-requests) which an ADMIN approves.
    if (scope.role !== 'ADMIN') {
      throw Errors.forbidden('Deletion needs admin approval — submit a delete request instead');
    }
    await caseAcceptanceRepository.delete(id);
  },
};
