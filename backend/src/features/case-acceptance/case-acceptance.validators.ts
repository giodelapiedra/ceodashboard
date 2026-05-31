import { z } from 'zod';
import { CLINIC_IDS, ClinicId } from '../../shared/roles';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
const idStr   = z.string().regex(/^\d+$/, 'Must be a numeric id').or(z.string().min(1));

const clinicEnum = z.enum([...CLINIC_IDS] as [ClinicId, ...ClinicId[]]);

// front_staff_name is free-form text. Receptionist accounts have it stamped
// server-side from their login.
const frontStaffField = z.string().min(1).max(120).trim().nullable();

// Counts: bounded so a fat-finger entry can't blow the table.
const countField = z.coerce.number().int().min(0).max(1000);

// Tri-state booleans on the form ("", true, false). Validators here see the
// already-normalized JSON: null | true | false.
const triBool = z.boolean().nullable();

const baseShape = {
  clinic_id:                clinicEnum.optional(),
  front_staff_name:         frontStaffField.optional(),
  clinician_id:             idStr,
  patient_name:             z.string().min(1).max(200).trim(),
  date_logged:              isoDate,
  treatment_plan_provided:  triBool.optional(),
  case_recommendations:     countField,
  appointments_booked:      countField,
  prepay_offered:           triBool.optional(),
  prepay_accepted:          triBool.optional(),
  transition_notes:         z.string().max(2000).nullable().optional(),
  notes:                    z.string().max(2000).nullable().optional(),
};

export const createCaseAcceptanceSchema = z
  .object(baseShape)
  .refine(
    (v) => v.appointments_booked <= v.case_recommendations,
    { path: ['appointments_booked'], message: 'Booked cannot exceed case recommendations' }
  );

export const updateCaseAcceptanceSchema = z.object({
  front_staff_name:         frontStaffField.optional(),
  clinician_id:             idStr.optional(),
  patient_name:             z.string().min(1).max(200).trim().optional(),
  date_logged:              isoDate.optional(),
  treatment_plan_provided:  triBool.optional(),
  case_recommendations:     countField.optional(),
  appointments_booked:      countField.optional(),
  prepay_offered:           triBool.optional(),
  prepay_accepted:          triBool.optional(),
  transition_notes:         z.string().max(2000).nullable().optional(),
  notes:                    z.string().max(2000).nullable().optional(),
})
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' })
  // Cross-field check only fires when both are in the patch — partial updates
  // that touch only one of the two are validated against the stored row in the
  // service layer / DB CHECK.
  .refine(
    (v) =>
      v.appointments_booked === undefined ||
      v.case_recommendations === undefined ||
      v.appointments_booked <= v.case_recommendations,
    { path: ['appointments_booked'], message: 'Booked cannot exceed case recommendations' }
  );

// Query strings arrive as strings — z.coerce.boolean would treat "false" as
// truthy. Map explicitly.
const boolQuery = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((v) => v === true || v === 'true');

export const listCaseAcceptanceQuerySchema = z.object({
  clinic_id:    clinicEnum.optional(),
  date_from:    isoDate.optional(),
  date_to:      isoDate.optional(),
  clinician_id: idStr.optional(),
  tp_provided:  boolQuery.optional(),
  search:       z.string().trim().min(1).max(100).optional(),
  limit:        z.coerce.number().int().min(1).max(500).optional(),
  offset:       z.coerce.number().int().min(0).optional(),
});

export type CreateCaseAcceptanceBody = z.infer<typeof createCaseAcceptanceSchema>;
export type UpdateCaseAcceptanceBody = z.infer<typeof updateCaseAcceptanceSchema>;
