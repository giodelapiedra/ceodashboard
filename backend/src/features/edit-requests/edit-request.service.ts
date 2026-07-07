import {
  editRequestRepository, EditRequestDTO, EditEntityType,
} from './edit-request.repository';
import { caseAcceptanceRepository, UpdateInput } from '../case-acceptance/case-acceptance.repository';
import { dropoutRepository, UpdateDropoutInput } from '../dropouts/dropout.repository';
import { userRepository } from '../../repositories/user.repository';
import { RequestScope } from '../../middleware/auth.middleware';
import { Errors } from '../../shared/errors';
import { CreateEditRequestBody } from './edit-request.validators';

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
  return null;
}

export const editRequestService = {
  /** Non-admin submits a proposed edit + mandatory reason for one of their own entries. */
  async create(scope: RequestScope, body: CreateEditRequestBody): Promise<EditRequestDTO> {
    if (scope.role === 'ADMIN') {
      throw Errors.validation('ADMIN edits entries directly — no request needed');
    }

    const entity = await loadEntity(body.entity_type, body.entity_id);
    if (!entity) throw Errors.notFound('Entry not found (it may have been deleted)');

    if (entity.entered_by !== scope.userId) {
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
      if (clinician.role !== 'CLINICIAN') {
        throw Errors.validation(`User ${body.patch.clinician_id} is not a clinician`);
      }
    }

    return editRequestRepository.create({
      entity_type:  body.entity_type,
      entity_id:    body.entity_id,
      requested_by: scope.userId,
      reason:       body.reason,
      patch:        body.patch as Record<string, unknown>,
      clinic_id:    entity.clinic_id,
      patient_name: entity.patient_name,
      entry_date:   entity.entry_date,
    });
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

  /** Admin approves → patch applied to the entry, request closed as approved. */
  async approve(scope: RequestScope, id: string): Promise<void> {
    if (scope.role !== 'ADMIN') throw Errors.forbidden('Only ADMIN can approve edit requests');

    const req = await editRequestRepository.findRawById(id);
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

        await caseAcceptanceRepository.update(String(req.entity_id), patch, scope.userId);
      }
      // If the entry is already gone, close the request without error (it's harmless).
    }

    if (req.entity_type === 'dropout') {
      const existing = await dropoutRepository.findRawById(String(req.entity_id));
      if (existing) {
        await dropoutRepository.update(String(req.entity_id), req.patch as UpdateDropoutInput, scope.userId);
      }
    }

    await editRequestRepository.setStatus(id, 'approved', scope.userId);
  },

  /** Admin rejects → entry stays unchanged, request closed as rejected with a mandatory reason. */
  async reject(scope: RequestScope, id: string, rejectionReason: string): Promise<void> {
    if (scope.role !== 'ADMIN') throw Errors.forbidden('Only ADMIN can reject edit requests');

    const req = await editRequestRepository.findRawById(id);
    if (!req) throw Errors.notFound(`Edit request ${id} not found`);
    if (req.status !== 'pending') throw Errors.conflict(`Request already ${req.status}`);

    await editRequestRepository.setStatus(id, 'rejected', scope.userId, rejectionReason);
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
