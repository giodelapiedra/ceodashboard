import { z } from 'zod';
import { DRAFT_KINDS, DraftKind } from './draft.repository';

const kindEnum = z.enum([...DRAFT_KINDS] as [DraftKind, ...DraftKind[]]);

// form_data is an opaque object snapshot of the form. We don't validate its
// inner shape (a draft is partial on purpose) — only that it's an object and
// not absurdly large, so a runaway client can't store megabytes per draft.
const formData = z
  .record(z.unknown())
  .refine((v) => JSON.stringify(v).length <= 20_000, {
    message: 'Draft is too large to save',
  });

// Denormalised display fields — kept loose; clinic_id is whatever the form
// holds (may be '' before a clinic is picked), normalised to null in the route.
const clinicField  = z.string().max(40).nullable().optional();
const patientField = z.string().max(200).nullable().optional();

export const createDraftSchema = z.object({
  kind:         kindEnum,
  clinic_id:    clinicField,
  patient_name: patientField,
  form_data:    formData,
});

export const updateDraftSchema = z.object({
  clinic_id:    clinicField,
  patient_name: patientField,
  form_data:    formData,
});

export const listDraftsQuerySchema = z.object({
  kind: kindEnum,
});

export type CreateDraftBody = z.infer<typeof createDraftSchema>;
export type UpdateDraftBody = z.infer<typeof updateDraftSchema>;
