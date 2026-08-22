import { z } from 'zod';
import { EDIT_ENTITY_TYPES, EditEntityType } from './edit-request.repository';
import {
  DROPOUT_STATUSES, DROPOUT_REASONS,
  DropoutStatus, DropoutReason,
  AD_LEAD_PLATFORMS, AdLeadPlatform,
} from '../../shared/roles';
import { patientNameProblem } from '../../shared/patient-name';

const entityTypeEnum = z.enum(
  [...EDIT_ENTITY_TYPES] as [EditEntityType, ...EditEntityType[]]
);
const idStr = z.string().regex(/^\d+$/, 'Must be a numeric id');

// Same calendar-date check as the direct-entry validators — a patch with an
// impossible date (2026-02-30) or a typo year (0226) must not be storable,
// otherwise approve() fails at the DB or writes an invisible row.
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
  .refine((s) => {
    const [y, m, d] = s.split('-').map(Number);
    if (y < 2000 || y > 2100) return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }, 'Date must be a real calendar date between 2000 and 2100');

// Field limits deliberately MATCH the direct-entry validators
// (dropout.validators.ts / case-acceptance.validators.ts) — the approval flow
// must not accept values the entry form would reject.
const patchSchema = z.object({
  // case_acceptance fields
  front_staff_name:        z.string().min(1).max(120).trim().nullable().optional(),
  clinician_id:            idStr.optional(),
  // Shared by all three entity types. A date here would be approved into the
  // row and then never match anything downstream — reject it at request time.
  patient_name:            z.string().min(1).max(200).trim()
                             .superRefine((v, ctx) => {
                               const problem = patientNameProblem(v);
                               if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
                             })
                             .optional(),
  date_logged:             isoDate.optional(),
  treatment_plan_provided: z.boolean().nullable().optional(),
  case_recommendations:    z.number().int().min(0).max(1000).optional(),
  appointments_booked:     z.number().int().min(0).max(1000).optional(),
  prepay_offered:          z.boolean().nullable().optional(),
  prepay_accepted:         z.boolean().nullable().optional(),
  transition_notes:        z.string().max(2000).nullable().optional(),
  notes:                   z.string().max(2000).nullable().optional(),
  // dropout-specific fields
  appointment_cancelled_dates: z.array(isoDate).max(50).optional(),
  // Must match the patient_dropouts CHECK whitelists — a free string here
  // passes creation but then makes approve() fail forever on the constraint.
  status: z.enum([...DROPOUT_STATUSES] as [DropoutStatus, ...DropoutStatus[]]).optional(),
  reason: z.enum([...DROPOUT_REASONS]  as [DropoutReason, ...DropoutReason[]]).optional(),
  // ad_lead-specific fields — limits MATCH ad-leads.validators.ts so the
  // approval flow can't store a value the entry form would reject.
  platform:      z.enum([...AD_LEAD_PLATFORMS] as [AdLeadPlatform, ...AdLeadPlatform[]]).optional(),
  campaign_name: z.string().max(200).trim().nullable().optional(),
  date_added:    isoDate.optional(),
  booked:        z.boolean().optional(),
  bella_called:  z.string().max(200).trim().nullable().optional(),
  bella_sms:     z.string().max(200).trim().nullable().optional(),
  bella_remarks: z.string().max(2000).trim().nullable().optional(),
}).refine(obj => Object.keys(obj).length > 0, {
  message: 'Patch must contain at least one changed field',
});

export const createEditRequestSchema = z.object({
  entity_type: entityTypeEnum,
  entity_id:   idStr,
  reason:      z.string().min(1, 'Reason is required').max(1000).trim(),
  patch:       patchSchema,
});

export type CreateEditRequestBody = z.infer<typeof createEditRequestSchema>;

export const rejectEditRequestSchema = z.object({
  rejection_reason: z.string().min(1, 'Rejection reason is required').max(1000).trim(),
});

export type RejectEditRequestBody = z.infer<typeof rejectEditRequestSchema>;
