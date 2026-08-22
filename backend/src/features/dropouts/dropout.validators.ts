import { z } from 'zod';
import {
  DROPOUT_STATUSES, DROPOUT_REASONS, CLINIC_IDS,
  DropoutStatus, DropoutReason, ClinicId,
} from '../../shared/roles';

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

const statusEnum = z.enum([...DROPOUT_STATUSES] as [DropoutStatus, ...DropoutStatus[]]);
const reasonEnum = z.enum([...DROPOUT_REASONS]  as [DropoutReason, ...DropoutReason[]]);
const clinicEnum = z.enum([...CLINIC_IDS]       as [ClinicId,      ...ClinicId[]]);

// front_staff_name is free-form text. CLINICIAN posts may carry a value
// (typically from FRONT_STAFF_NAMES), but receptionist accounts have it
// stamped server-side from their login regardless of what they send.
const frontStaffField = z.string().min(1).max(120).trim().nullable();

// What to do when an entry with the same natural key already exists. Absent
// (= 'reject') is the safe default: an old client, or a direct API call, gets
// the 409 rather than silently creating the duplicate this feature exists to
// prevent.
const onDuplicateEnum = z.enum(['reject', 'allow']);

export const createDropoutSchema = z.object({
  on_duplicate:               onDuplicateEnum.optional(),
  // FRONT_DESK_GLOBAL must set clinic_id; for other non-admin roles it's
  // derived from scope. ADMIN cannot create.
  clinic_id:                  clinicEnum.optional(),
  front_staff_name:           frontStaffField.optional(),
  clinician_id:               idStr,
  patient_name:                z.string().min(1).max(200).trim(),
  date_logged:                 isoDate,
  // Multiple cancelled-appointment dates per entry. Cap at 50 so a fat-finger
  // bulk-paste can't blow up the row. Empty array is valid (no cancellations
  // recorded yet).
  appointment_cancelled_dates: z.array(isoDate).max(50).optional(),
  status:                      statusEnum,
  reason:                      reasonEnum,
  notes:                       z.string().max(2000).nullable().optional(),
});

export const updateDropoutSchema = z.object({
  front_staff_name:            frontStaffField.optional(),
  clinician_id:                idStr.optional(),
  patient_name:                z.string().min(1).max(200).trim().optional(),
  date_logged:                 isoDate.optional(),
  appointment_cancelled_dates: z.array(isoDate).max(50).optional(),
  status:                      statusEnum.optional(),
  reason:                      reasonEnum.optional(),
  notes:                       z.string().max(2000).nullable().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });

export const listDropoutsQuerySchema = z.object({
  clinic_id:    clinicEnum.optional(),
  date_from:    isoDate.optional(),
  date_to:      isoDate.optional(),
  clinician_id: idStr.optional(),
  status:       statusEnum.optional(),
  reason:       reasonEnum.optional(),
  search:       z.string().trim().min(1).max(100).optional(),
  limit:        z.coerce.number().int().min(1).max(500).optional(),
  offset:       z.coerce.number().int().min(0).optional(),
});

// Pre-flight duplicate check — just the natural key. exclude_id lets the edit
// form ask "would this collide with anything other than the row I'm editing?".
export const checkDropoutDuplicateSchema = z.object({
  clinic_id:    clinicEnum.optional(),
  clinician_id: idStr,
  patient_name: z.string().min(1).max(200).trim(),
  date_logged:  isoDate,
  exclude_id:   idStr.optional(),
});

export type CreateDropoutBody         = z.infer<typeof createDropoutSchema>;
export type UpdateDropoutBody         = z.infer<typeof updateDropoutSchema>;
export type CheckDropoutDuplicateBody = z.infer<typeof checkDropoutDuplicateSchema>;
