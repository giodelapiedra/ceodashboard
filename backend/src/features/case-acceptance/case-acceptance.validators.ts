import { z } from 'zod';
import { CLINIC_IDS, ClinicId } from '../../shared/roles';

// Regex catches the shape; the refine rejects impossible calendar dates
// (e.g. 2026-02-30) and obvious year typos (e.g. 0226) that would otherwise
// either 500 at the DB or silently vanish from every date-filtered view.
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
  .refine((s) => {
    const [y, m, d] = s.split('-').map(Number);
    if (y < 2000 || y > 2100) return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }, 'Date must be a real calendar date between 2000 and 2100');
// ids are BIGSERIAL — must be numeric strings, otherwise Postgres throws a
// type error (500) instead of a clean 400.
const idStr   = z.string().regex(/^\d+$/, 'Must be a numeric id');

const clinicEnum = z.enum([...CLINIC_IDS] as [ClinicId, ...ClinicId[]]);

// front_staff_name is free-form text. Receptionist accounts have it stamped
// server-side from their login.
const frontStaffField = z.string().min(1).max(120).trim().nullable();

// Counts: bounded so a fat-finger entry can't blow the table.
const countField = z.coerce.number().int().min(0).max(1000);

// Tri-state booleans on the form ("", true, false). Validators here see the
// already-normalized JSON: null | true | false.
const triBool = z.boolean().nullable();

// Prepay fields are required going forward: the form must have Y or N picked
// before it can submit, so a create request with no value (or an explicit
// null) is either a stale client or a direct API call bypassing the form.
const requiredPrepay = z.boolean({
  required_error:   'Prepay field is required',
  invalid_type_error: 'Prepay field must be true or false',
});

// What to do when an entry with the same natural key already exists. Absent
// (= 'reject') is the safe default: an old client, or a direct API call, gets
// the 409 rather than silently creating the duplicate this feature prevents.
const onDuplicateEnum = z.enum(['reject', 'allow']);

const baseShape = {
  on_duplicate:             onDuplicateEnum.optional(),
  clinic_id:                clinicEnum.optional(),
  front_staff_name:         frontStaffField.optional(),
  clinician_id:             idStr,
  patient_name:             z.string().min(1).max(200).trim(),
  date_logged:              isoDate,
  treatment_plan_provided:  triBool.optional(),
  case_recommendations:     countField,
  appointments_booked:      countField,
  prepay_offered:           requiredPrepay,
  prepay_accepted:          requiredPrepay,
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
  prepay_offered:           requiredPrepay.optional(),
  prepay_accepted:          requiredPrepay.optional(),
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

// Pre-flight duplicate check — just the natural key. exclude_id lets the edit
// form ask "would this collide with anything other than the row I'm editing?".
export const checkCaseAcceptanceDuplicateSchema = z.object({
  clinic_id:    clinicEnum.optional(),
  clinician_id: idStr,
  patient_name: z.string().min(1).max(200).trim(),
  date_logged:  isoDate,
  exclude_id:   idStr.optional(),
});

export type CreateCaseAcceptanceBody         = z.infer<typeof createCaseAcceptanceSchema>;
export type UpdateCaseAcceptanceBody         = z.infer<typeof updateCaseAcceptanceSchema>;
export type CheckCaseAcceptanceDuplicateBody = z.infer<typeof checkCaseAcceptanceDuplicateSchema>;
