import {
  deleteRequestRepository, DeleteRequestDTO, DeleteEntityType,
} from './delete-request.repository';
import { dropoutRepository } from '../dropouts/dropout.repository';
import { caseAcceptanceRepository } from '../case-acceptance/case-acceptance.repository';
import { adLeadRepository } from '../ad-leads/ad-leads.repository';
import { RequestScope } from '../../middleware/auth.middleware';
import { withTransaction } from '../../db/pool';
import { Errors } from '../../shared/errors';
import { CreateDeleteRequestBody } from './delete-request.validators';
import { notifyDeleteRequest } from '../../services/teams-notify.service';
import type { PoolClient } from 'pg';

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
  if (entityType === 'ad_lead') {
    const row = await adLeadRepository.findRawById(entityId);
    if (!row) return null;
    return {
      entered_by:   String(row.entered_by),
      clinic_id:    row.clinic_id,
      patient_name: row.patient_name,
      // Ad-leads have no date_logged — snapshot date_added instead.
      entry_date:   dateOnly(row.date_added),
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
async function deleteEntity(
  entityType: DeleteEntityType,
  entityId: string,
  client?: PoolClient
): Promise<void> {
  if (entityType === 'dropout') {
    await dropoutRepository.delete(entityId, client);
  } else if (entityType === 'ad_lead') {
    await adLeadRepository.delete(entityId, client);
  } else {
    await caseAcceptanceRepository.delete(entityId, client);
  }
}

export const deleteRequestService = {
  /** Non-admin files a request to delete one of their own entries. */
  async create(scope: RequestScope, body: CreateDeleteRequestBody): Promise<DeleteRequestDTO> {
    const entity = await loadEntity(body.entity_type, body.entity_id);
    if (!entity) throw Errors.notFound('Entry not found (it may already be deleted)');

    // ADMIN never needs this flow (they delete directly).
    if (scope.role === 'ADMIN') {
      throw Errors.validation('ADMIN deletes entries directly — no request needed');
    }
    if (body.entity_type === 'ad_lead') {
      // Shared team inbox — any front-desk user who can SEE the lead may request
      // its deletion, not just the creator (mirrors ad-leads list scope).
      const canSee =
        scope.role === 'FRONT_DESK_GLOBAL' ||
        (scope.role === 'FRONT_DESK' && entity.clinic_id === scope.clinic_id);
      if (!canSee) throw Errors.forbidden('You cannot request deletion of this lead');
    } else if (entity.entered_by !== scope.userId) {
      // Dropout / case-acceptance keep the "your own entries only" rule.
      throw Errors.forbidden('You can only request deletion of your own entries');
    }

    if (await deleteRequestRepository.hasPending(body.entity_type, body.entity_id)) {
      throw Errors.conflict('A delete request for this entry is already pending');
    }

    try {
      const created = await deleteRequestRepository.create({
        entity_type:  body.entity_type,
        entity_id:    body.entity_id,
        requested_by: scope.userId,
        reason:       body.reason?.trim() || null,
        clinic_id:    entity.clinic_id,
        patient_name: entity.patient_name,
        entry_date:   entity.entry_date,
      });
      // Ping the Teams group so the admin sees it without watching the queue.
      // Fire-and-forget by design — a Teams outage must not fail this request.
      notifyDeleteRequest({
        entity_type:       created.entity_type,
        patient_name:      created.patient_name,
        entry_date:        created.entry_date,
        clinic_id:         created.clinic_id,
        reason:            created.reason,
        requested_by_name: created.requested_by_name ?? scope.full_name,
      });
      return created;
    } catch (err: any) {
      // Unique partial index delete_requests_one_pending — a concurrent submit
      // won the race between hasPending() and the INSERT. Surface as 409.
      if (err?.code === '23505') {
        throw Errors.conflict('A delete request for this entry is already pending');
      }
      throw err;
    }
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

  /** Admin approves → the entry is actually deleted and the request is closed.
   *  Runs in ONE transaction with the request row locked FOR UPDATE, so a
   *  concurrent approve/reject cannot interleave (no "entry deleted but
   *  request says rejected" state). */
  async approve(scope: RequestScope, id: string): Promise<void> {
    if (scope.role !== 'ADMIN') throw Errors.forbidden('Only ADMIN can approve delete requests');

    await withTransaction(async (client) => {
      const req = await deleteRequestRepository.findRawByIdForUpdate(client, id);
      if (!req) throw Errors.notFound(`Delete request ${id} not found`);
      if (req.status !== 'pending') throw Errors.conflict(`Request already ${req.status}`);

      // Delete the entry (no-op if it's already gone), then close the request —
      // both inside the same transaction.
      await deleteEntity(req.entity_type, req.entity_id, client);
      const closed = await deleteRequestRepository.setStatus(id, 'approved', scope.userId, client);
      if (!closed) throw Errors.conflict('Request was reviewed by someone else — refresh and try again');
    });
  },

  /** Admin rejects → the entry stays; the request is closed as rejected. */
  async reject(scope: RequestScope, id: string): Promise<void> {
    if (scope.role !== 'ADMIN') throw Errors.forbidden('Only ADMIN can reject delete requests');
    const req = await deleteRequestRepository.findRawById(id);
    if (!req) throw Errors.notFound(`Delete request ${id} not found`);
    if (req.status !== 'pending') throw Errors.conflict(`Request already ${req.status}`);

    // Guarded UPDATE (status = 'pending') — if a concurrent admin already
    // reviewed it, do NOT overwrite their decision.
    const closed = await deleteRequestRepository.setStatus(id, 'rejected', scope.userId);
    if (!closed) throw Errors.conflict('Request was reviewed by someone else — refresh and try again');
  },
};
