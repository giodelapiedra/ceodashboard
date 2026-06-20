import { draftRepository, DraftDTO, DraftKind } from './draft.repository';
import { RequestScope } from '../../middleware/auth.middleware';
import { Errors } from '../../shared/errors';
import { CreateDraftBody, UpdateDraftBody } from './draft.validators';

// Soft cap so a user can't accumulate unbounded drafts of one kind. Generous —
// front desk may have many patients mid-entry, but this stops runaway growth.
const MAX_DRAFTS_PER_KIND = 100;

/** Empty string (clinic not picked yet) is stored as NULL. */
function normClinic(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
}
function normPatient(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
}

export const draftService = {
  list(scope: RequestScope, kind: DraftKind): Promise<DraftDTO[]> {
    return draftRepository.listByOwner(scope.userId, kind);
  },

  async create(scope: RequestScope, body: CreateDraftBody): Promise<DraftDTO> {
    const count = await draftRepository.countByOwner(scope.userId, body.kind);
    if (count >= MAX_DRAFTS_PER_KIND) {
      throw Errors.validation(
        `You have ${count} saved drafts — delete some before saving more (max ${MAX_DRAFTS_PER_KIND})`
      );
    }
    return draftRepository.create({
      owner_id:     scope.userId,
      kind:         body.kind,
      clinic_id:    normClinic(body.clinic_id),
      patient_name: normPatient(body.patient_name),
      form_data:    body.form_data,
    });
  },

  async update(scope: RequestScope, id: string, patch: UpdateDraftBody): Promise<DraftDTO> {
    const existing = await draftRepository.findRawById(id);
    if (!existing) throw Errors.notFound(`Draft ${id} not found`);
    // Drafts are private — you can only ever touch your own.
    if (existing.owner_id !== scope.userId) {
      throw Errors.forbidden('You can only edit your own drafts');
    }
    return draftRepository.update(id, {
      clinic_id:    normClinic(patch.clinic_id),
      patient_name: normPatient(patch.patient_name),
      form_data:    patch.form_data,
    });
  },

  async delete(scope: RequestScope, id: string): Promise<void> {
    const existing = await draftRepository.findRawById(id);
    // Idempotent: deleting an already-gone draft is a no-op success.
    if (!existing) return;
    if (existing.owner_id !== scope.userId) {
      throw Errors.forbidden('You can only delete your own drafts');
    }
    await draftRepository.delete(id);
  },
};
