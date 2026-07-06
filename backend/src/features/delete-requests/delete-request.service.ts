import {
  deleteRequestRepository, DeleteRequestDTO, DeleteEntityType,
} from './delete-request.repository';
import { dropoutRepository } from '../dropouts/dropout.repository';
import { caseAcceptanceRepository } from '../case-acceptance/case-acceptance.repository';
import { RequestScope } from '../../middleware/auth.middleware';
import { Errors } from '../../shared/errors';
import { CreateDeleteRequestBody } from './delete-request.validators';

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

/** Load the target entry's owner + display snapshot, or null if it's gone. */
async function loadEntity(
  entityType: DeleteEntityType,
  entityId: string
): Promise<EntitySnapshot | null> {
  if (entityType === 'dropout') {
    const row = await dropoutRepository.findRawById(entityId);
    if (!row) return null;
    return {
      entered_by:   row.entered_by,
      clinic_id:    row.clinic_id,
      patient_name: row.patient_name,
      entry_date:   dateOnly(row.date_logged),
    };
  }
  const row = await caseAcceptanceRepository.findRawById(entityId);
  if (!row) return null;
  return {
    entered_by:   row.entered_by,
    clinic_id:    row.clinic_id,
    patient_name: row.patient_name,
    entry_date:   dateOnly(row.date_logged),
  };
}

/** Perform the actual delete once an admin approves. */
async function deleteEntity(entityType: DeleteEntityType, entityId: string): Promise<void> {
  if (entityType === 'dropout') {
    await dropoutRepository.delete(entityId);
  } else {
    await caseAcceptanceRepository.delete(entityId);
  }
}

export const deleteRequestService = {
  /** Non-admin files a request to delete one of their own entries. */
  async create(scope: RequestScope, body: CreateDeleteRequestBody): Promise<DeleteRequestDTO> {
    const entity = await loadEntity(body.entity_type, body.entity_id);
    if (!entity) throw Errors.notFound('Entry not found (it may already be deleted)');

    // You can only request deletion of an entry you created — same ownership
    // rule as editing. ADMIN never needs this flow (they delete directly).
    if (scope.role === 'ADMIN') {
      throw Errors.validation('ADMIN deletes entries directly — no request needed');
    }
    if (entity.entered_by !== scope.userId) {
      throw Errors.forbidden('You can only request deletion of your own entries');
    }

    if (await deleteRequestRepository.hasPending(body.entity_type, body.entity_id)) {
      throw Errors.conflict('A delete request for this entry is already pending');
    }

    return deleteRequestRepository.create({
      entity_type:  body.entity_type,
      entity_id:    body.entity_id,
      requested_by: scope.userId,
      reason:       body.reason?.trim() || null,
      clinic_id:    entity.clinic_id,
      patient_name: entity.patient_name,
      entry_date:   entity.entry_date,
    });
  },

  /** Admin review queue — pending requests, newest first. */
  async listPending(scope: RequestScope): Promise<DeleteRequestDTO[]> {
    if (scope.role !== 'ADMIN') throw Errors.forbidden('Only ADMIN can view delete requests');
    return deleteRequestRepository.listByStatus('pending');
  },

  /** Entity refs the caller currently has an open request for (drives their UI). */
  myPending(scope: RequestScope) {
    return deleteRequestRepository.listPendingRefsByRequester(scope.userId);
  },

  /** Admin approves → the entry is actually deleted and the request is closed. */
  async approve(scope: RequestScope, id: string): Promise<void> {
    if (scope.role !== 'ADMIN') throw Errors.forbidden('Only ADMIN can approve delete requests');
    const req = await deleteRequestRepository.findRawById(id);
    if (!req) throw Errors.notFound(`Delete request ${id} not found`);
    if (req.status !== 'pending') throw Errors.conflict(`Request already ${req.status}`);

    // Delete the entry (no-op if it's already gone), then close the request.
    await deleteEntity(req.entity_type, req.entity_id);
    await deleteRequestRepository.setStatus(id, 'approved', scope.userId);
  },

  /** Admin rejects → the entry stays; the request is closed as rejected. */
  async reject(scope: RequestScope, id: string): Promise<void> {
    if (scope.role !== 'ADMIN') throw Errors.forbidden('Only ADMIN can reject delete requests');
    const req = await deleteRequestRepository.findRawById(id);
    if (!req) throw Errors.notFound(`Delete request ${id} not found`);
    if (req.status !== 'pending') throw Errors.conflict(`Request already ${req.status}`);

    await deleteRequestRepository.setStatus(id, 'rejected', scope.userId);
  },
};
