import { z } from 'zod';
import { EDIT_ENTITY_TYPES, EditEntityType } from './edit-request.repository';
import {
  DROPOUT_STATUSES, DROPOUT_REASONS,
  DropoutStatus, DropoutReason,
} from '../../shared/roles';

const entityTypeEnum = z.enum(
  [...EDIT_ENTITY_TYPES] as [EditEntityType, ...EditEntityType[]]
);
const idStr = z.string().regex(/^\d+$/, 'Must be a numeric id');

const patchSchema = z.object({
  // case_acceptance fields
  front_staff_name:        z.string().max(100).nullable().optional(),
  clinician_id:            idStr.optional(),
  patient_name:            z.string().min(1).max(200).trim().optional(),
  date_logged:             z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  treatment_plan_provided: z.boolean().nullable().optional(),
  case_recommendations:    z.number().int().min(0).optional(),
  appointments_booked:     z.number().int().min(0).optional(),
  prepay_offered:          z.boolean().nullable().optional(),
  prepay_accepted:         z.boolean().nullable().optional(),
  transition_notes:        z.string().max(5000).nullable().optional(),
  notes:                   z.string().max(5000).nullable().optional(),
  // dropout-specific fields
  appointment_cancelled_dates: z.array(
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  ).optional(),
  // Must match the patient_dropouts CHECK whitelists — a free string here
  // passes creation but then makes approve() fail forever on the constraint.
  status: z.enum([...DROPOUT_STATUSES] as [DropoutStatus, ...DropoutStatus[]]).optional(),
  reason: z.enum([...DROPOUT_REASONS]  as [DropoutReason, ...DropoutReason[]]).optional(),
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
