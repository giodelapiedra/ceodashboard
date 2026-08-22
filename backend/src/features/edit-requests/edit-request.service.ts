import {
  editRequestRepository, EditRequestDTO, EditEntityType,
} from './edit-request.repository';
import { caseAcceptanceRepository, UpdateInput } from '../case-acceptance/case-acceptance.repository';
import { dropoutRepository, UpdateDropoutInput } from '../dropouts/dropout.repository';
import { adLeadRepository, UpdateAdLeadInput } from '../ad-leads/ad-leads.repository';
import { userRepository, canBeTreatingClinician } from '../../repositories/user.repository';
import { RequestScope } from '../../middleware/auth.middleware';
import { withTransaction } from '../../db/pool';
import { Errors } from '../../shared/errors';
import { seesAllAdLeadClinics } from '../../shared/roles';
import { CreateEditRequestBody } from './edit-request.validators';
import { notifyEditRequest } from '../../services/teams-notify.service';

interface EntitySnapshot {
  entered_by:   string;
  clinic_id:    string | null;
  patient_name: string | null;
  entry_date:   string | null;
}

function dateOnly(d: Date | null | undefined): string | null {
  if (!d) return null;
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

async function loadEntity(
  entityType: EditEntityType,
  entityId: string
): Promise<EntitySnapshot | null> {
  if (entityType === 'case_acceptance') {
    const row = await caseAcceptanceRepository.findRawById(entityId);
    if (!row) return null;
    return {
      entered_by:   String(row.entered_by),
      clinic_id:    row.clinic_id,
      patient_name: row.patient_name,
      entry_date:   dateOnly(row.date_logged),
    };
  }
  if (entityType === 'dropout') {
    const row = await dropoutRepository.findRawById(entityId);
    if (!row) return null;
    return {
      entered_by:   String(row.entered_by),
      clinic_id:    row.clinic_id,
      patient_name: row.patient_name,
      entry_date:   dateOnly(row.date_logged),
    };
  }
  if (entityType === 'ad_lead') {
    const row = await adLeadRepository.findRawById(entityId);
    if (!row) return null;
    return {
      entered_by:   String(row.entered_by),
      clinic_id:    row.clinic_id,
      patient_name: row.patient_name,
      // Ad-leads use date_added as their entry date (no date_logged column).
      entry_date:   dateOnly(row.date_added),
    };
  }
  return null;
}

/**
 * Front desk works the same shared queue, so any of them may correct any entry
 * they can already SEE — mirrors the list scope exactly: FRONT_DESK_GLOBAL sees
 * every clinic, FRONT_DESK is pinned to its own.
 *
 * Sam, 2026-08-12: "make it so all frontstaff can edit each others entries."
 * Only the ownership gate moved — the edit still goes to him for approval, and
 * delete requests are deliberately NOT included (see delete-request.service).
 */
function frontDeskCanSee(scope: RequestScope, entityClinicId: string | null): boolean {
  return (
    scope.role === 'FRONT_DESK_GLOBAL' ||
    (scope.role === 'FRONT_DESK' && entityClinicId === scope.clinic_id)
  );
}

export const editRequestService = {
  /**
   * Non-admin submits a proposed edit + mandatory reason. Front desk may do this
   * for any entry in their scope; a clinician only for entries they encoded.
   */
  async create(scope: RequestScope, body: CreateEditRequestBody): Promise<EditRequestDTO> {
    if (scope.role === 'ADMIN') {
      throw Errors.validation('ADMIN edits entries directly — no request needed');
    }

    const entity = await loadEntity(body.entity_type, body.entity_id);
    if (!entity) throw Errors.notFound('Entry not found (it may have been deleted)');

    if (body.entity_type === 'ad_lead') {
      // Ad-leads are a shared team inbox (many bulk-imported under one account),
      // so ANY login that can SEE the lead may request edits — not just whoever
      // first encoded it. Since 2026-08-12 that includes the ad-spend encoder:
      // this request flow is its ONLY way to correct a lead (ad-leads.service
      // still refuses its direct PATCH).
      const canSee =
        seesAllAdLeadClinics(scope.role) ||
        (scope.role === 'FRONT_DESK' && entity.clinic_id === scope.clinic_id);
      if (!canSee) throw Errors.forbidden('You cannot request edits for this lead');
    } else if (scope.role === 'FRONT_DESK' || scope.role === 'FRONT_DESK_GLOBAL') {
      // Dropout / case acceptance: front desk covers for each other, so the rule
      // is "can you see it", not "did you type it" (changed 2026-08-12).
      if (!frontDeskCanSee(scope, entity.clinic_id)) {
        throw Errors.forbidden('You cannot request edits for this entry');
      }
    } else if (entity.entered_by !== scope.userId) {
      // CLINICIAN — unchanged: their own entries only.
      throw Errors.forbidden('You can only request edits to your own entries');
    }

    if (await editRequestRepository.hasPending(body.entity_type, body.entity_id)) {
      throw Errors.conflict('An edit request for this entry is already pending admin approval');
    }

    // Validate clinician_id if it's being changed.
    if (body.patch.clinician_id) {
      const clinician = await userRepository.findById(body.patch.clinician_id);
      if (!clinician || !clinician.is_active) {
        throw Errors.validation(`Clinician ${body.patch.clinician_id} not found or inactive`);
      }
      if (!canBeTreatingClinician(clinician)) {
        throw Errors.validation(
          `${clinician.full_name || clinician.email} cannot be tagged as the treating clinician`
        );
      }
    }

    // Receptionist accounts (FRONT_DESK / FRONT_DESK_GLOBAL) have their
    // front_staff_name stamped server-side on create/update — the approval
    // flow must enforce the same rule, otherwise it becomes a side door for
    // rewriting the stamped name.
    const patch: Record<string, unknown> = { ...body.patch };
    const isReceptionist =
      scope.role === 'FRONT_DESK' || scope.role === 'FRONT_DESK_GLOBAL';
    if (isReceptionist) delete patch.front_staff_name;
    if (Object.keys(patch).length === 0) {
      throw Errors.validation('Patch must contain at least one changed field');
    }

    try {
      const created = await editRequestRepository.create({
        entity_type:  body.entity_type,
        entity_id:    body.entity_id,
        requested_by: scope.userId,
        reason:       body.reason,
        patch,
        clinic_id:    entity.clinic_id,
        patient_name: entity.patient_name,
        entry_date:   entity.entry_date,
      });
      // Ping the Teams group so the admin sees it without watching the queue.
      // Fire-and-forget by design — a Teams outage must not fail this request.
      notifyEditRequest({
        entity_type:       created.entity_type,
        patient_name:      created.patient_name,
        entry_date:        created.entry_date,
        clinic_id:         created.clinic_id,
        reason:            created.reason,
        patch:             created.patch,
        requested_by_name: created.requested_by_name ?? scope.full_name,
      });
      return created;
    } catch (err: any) {
      // Unique partial index edit_requests_one_pending — a concurrent submit
      // won the race between hasPending() and the INSERT. Surface as 409.
      if (err?.code === '23505') {
        throw Errors.conflict('An edit request for this entry is already pending admin approval');
      }
      throw err;
    }
  },

  /** Admin review queue — pending requests, newest first. */
  async listPending(scope: RequestScope): Promise<EditRequestDTO[]> {
    if (scope.role !== 'ADMIN') throw Errors.forbidden('Only ADMIN can view edit requests');
    return editRequestRepository.listByStatus('pending');
  },

  /** Entity refs the caller currently has an open edit request for (drives their UI). */
  myPending(scope: RequestScope) {
    return editRequestRepository.listPendingRefsByRequester(scope.userId);
  },

  /** Admin approves → patch applied to the entry, request closed as approved.
   *  Runs in ONE transaction with the request row locked FOR UPDATE, so a
   *  concurrent approve/reject on the same request cannot interleave (no
   *  double-apply, no "patched but rejected" state). */
  async approve(scope: RequestScope, id: string): Promise<void> {
    if (scope.role !== 'ADMIN') throw Errors.forbidden('Only ADMIN can approve edit requests');

    await withTransaction(async (client) => {
      const req = await editRequestRepository.findRawByIdForUpdate(client, id);
      if (!req) throw Errors.notFound(`Edit request ${id} not found`);
      if (req.status !== 'pending') throw Errors.conflict(`Request already ${req.status}`);

      if (req.entity_type === 'case_acceptance') {
        const existing = await caseAcceptanceRepository.findRawById(String(req.entity_id));
        if (existing) {
          const patch = req.patch as UpdateInput;

          // Cross-field invariant: booked <= recs on the merged result.
          const nextRecs   = (patch.case_recommendations ?? existing.case_recommendations) as number;
          const nextBooked = (patch.appointments_booked  ?? existing.appointments_booked)  as number;
          if (nextBooked > nextRecs) {
            throw Errors.validation(
              'Cannot apply patch: booked would exceed case recommendations — reject this request instead'
            );
          }

          await caseAcceptanceRepository.update(String(req.entity_id), patch, scope.userId, client);
        }
        // If the entry is already gone, close the request without error (it's harmless).
      }

      if (req.entity_type === 'dropout') {
        const existing = await dropoutRepository.findRawById(String(req.entity_id));
        if (existing) {
          await dropoutRepository.update(
            String(req.entity_id), req.patch as UpdateDropoutInput, scope.userId, client
          );
        }
      }

      if (req.entity_type === 'ad_lead') {
        const existing = await adLeadRepository.findRawById(String(req.entity_id));
        if (existing) {
          await adLeadRepository.update(
            String(req.entity_id), req.patch as UpdateAdLeadInput, scope.userId, client
          );
        }
        // If the lead is already gone, close the request without error.
      }

      const closed = await editRequestRepository.setStatus(id, 'approved', scope.userId, null, client);
      if (!closed) throw Errors.conflict('Request was reviewed by someone else — refresh and try again');
    });
  },

  /** Admin rejects → entry stays unchanged, request closed as rejected with a mandatory reason. */
  async reject(scope: RequestScope, id: string, rejectionReason: string): Promise<void> {
    if (scope.role !== 'ADMIN') throw Errors.forbidden('Only ADMIN can reject edit requests');

    const req = await editRequestRepository.findRawById(id);
    if (!req) throw Errors.notFound(`Edit request ${id} not found`);
    if (req.status !== 'pending') throw Errors.conflict(`Request already ${req.status}`);

    // Guarded UPDATE (status = 'pending') — if a concurrent admin already
    // reviewed it, do NOT overwrite their decision.
    const closed = await editRequestRepository.setStatus(id, 'rejected', scope.userId, rejectionReason);
    if (!closed) throw Errors.conflict('Request was reviewed by someone else — refresh and try again');
  },

  /** Rejected requests for the caller within the last 30 days — drives the notification banner. */
  myRejected(scope: RequestScope) {
    return editRequestRepository.listRejectedByRequester(scope.userId);
  },

  /** Caller dismisses a rejection banner — persisted so it stays gone on every device. */
  async ackRejected(scope: RequestScope, id: string): Promise<void> {
    const ok = await editRequestRepository.ackRejectedByRequester(scope.userId, id);
    if (!ok) throw Errors.notFound(`Rejected edit request ${id} not found for this user`);
  },
};
