import { z } from 'zod';
import { AD_LEAD_PLATFORMS, CLINIC_IDS, AdLeadPlatform, ClinicId } from '../../shared/roles';
import { patientNameProblem } from '../../shared/patient-name';

// A date in the name cell passes every other check but can never match a
// Nookal patient, so the lead silently counts $0 toward Leads Paid vs Spend.
const patientName = z.string().min(1).max(200).trim()
  .superRefine((v, ctx) => {
    const problem = patientNameProblem(v);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  });

// Shape + real-calendar refine (rejects e.g. 2026-02-30 and year typos).
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
  .refine((s) => {
    const [y, m, d] = s.split('-').map(Number);
    if (y < 2000 || y > 2100) return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }, 'Date must be a real calendar date between 2000 and 2100');

const platformEnum = z.enum([...AD_LEAD_PLATFORMS] as [AdLeadPlatform, ...AdLeadPlatform[]]);
const clinicEnum   = z.enum([...CLINIC_IDS]       as [ClinicId,       ...ClinicId[]]);

// Platform Source is optional on new leads — front desk doesn't always know
// which ad channel a lead actually came from at the time of entry. Accepts a
// real platform, an explicit '' ("not specified"), or omitted entirely.
const platformField = z.union([platformEnum, z.literal('')]).optional();

const shortText = z.string().max(200).trim().nullable().optional();
const longText  = z.string().max(2000).trim().nullable().optional();

// What to do when a lead with the same natural key already exists. Absent
// (= 'reject') is the safe default: an old client, or a direct API call, gets
// the 409 rather than silently creating the duplicate this feature prevents.
const onDuplicateEnum = z.enum(['reject', 'allow']);

export const createAdLeadSchema = z.object({
  on_duplicate:  onDuplicateEnum.optional(),
  // FRONT_DESK is pinned by scope; FRONT_DESK_GLOBAL / ADMIN / ADSPEND must set
  // clinic_id (those accounts have no clinic of their own).
  clinic_id:     clinicEnum.optional(),
  patient_name:  patientName,
  platform:      platformField,
  campaign_name: shortText,
  date_added:    isoDate,
  booked:        z.boolean().optional(),
  bella_called:  shortText,
  bella_sms:     shortText,
  bella_remarks: longText,
});

export const updateAdLeadSchema = z.object({
  patient_name:  patientName.optional(),
  platform:      platformEnum.optional(),
  campaign_name: shortText,
  date_added:    isoDate.optional(),
  booked:        z.boolean().optional(),
  bella_called:  shortText,
  bella_sms:     shortText,
  bella_remarks: longText,
}).refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });

export const listAdLeadsQuerySchema = z.object({
  clinic_id: clinicEnum.optional(),
  date_from: isoDate.optional(),
  date_to:   isoDate.optional(),
  // A repeated ?platform= query key arrives as an array (multi-select filter);
  // a single pick arrives as a bare string.
  platform:  z.union([platformEnum, z.array(platformEnum).min(1)]).optional(),
  // Query strings arrive as 'true' / 'false'.
  booked:    z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  search:    z.string().trim().min(1).max(100).optional(),
  limit:     z.coerce.number().int().min(1).max(500).optional(),
  offset:    z.coerce.number().int().min(0).optional(),
});

// Pre-flight duplicate check — just the natural key. exclude_id lets the edit
// form ask "would this collide with anything other than the row I'm editing?".
export const checkAdLeadDuplicateSchema = z.object({
  clinic_id:    clinicEnum.optional(),
  patient_name: z.string().min(1).max(200).trim(),
  platform:     platformField,
  date_added:   isoDate,
  exclude_id:   z.string().regex(/^\d+$/, 'Must be a numeric id').optional(),
});

export type CreateAdLeadBody         = z.infer<typeof createAdLeadSchema>;
export type UpdateAdLeadBody         = z.infer<typeof updateAdLeadSchema>;
export type CheckAdLeadDuplicateBody = z.infer<typeof checkAdLeadDuplicateSchema>;
