import { z } from 'zod';
import { CLINIC_IDS, ROLE_VALUES, Role, ClinicId } from '../../shared/roles';

const roleEnum   = z.enum([...ROLE_VALUES] as [Role,     ...Role[]]);
const clinicEnum = z.enum([...CLINIC_IDS]  as [ClinicId, ...ClinicId[]]);

const baseUserShape = {
  email:     z.string().email().max(254),
  full_name: z.string().min(1).max(120).trim(),
  role:      roleEnum,
  clinic_id: clinicEnum.nullable(),
};

/** Roles that have NO clinic_id (cross-clinic). Mirror of the DB CHECK
 *  constraint in 010_adspend_role_and_table.sql. */
const CROSS_CLINIC_ROLES = ['ADMIN', 'FRONT_DESK_GLOBAL', 'ADSPEND'] as const;
type CrossClinicRole = typeof CROSS_CLINIC_ROLES[number];
const isCrossClinic = (r: string): r is CrossClinicRole =>
  (CROSS_CLINIC_ROLES as readonly string[]).includes(r);

export const createUserSchema = z.object({
  ...baseUserShape,
  password: z.string().min(8).max(200),
}).superRefine((val, ctx) => {
  if (isCrossClinic(val.role) && val.clinic_id !== null) {
    ctx.addIssue({
      code:    z.ZodIssueCode.custom,
      path:    ['clinic_id'],
      message: `${val.role} users must not be assigned to a clinic`,
    });
  }
  if (!isCrossClinic(val.role) && val.clinic_id === null) {
    ctx.addIssue({
      code:    z.ZodIssueCode.custom,
      path:    ['clinic_id'],
      message: 'CLINICIAN and FRONT_DESK must be assigned to a clinic',
    });
  }
});

export const updateUserSchema = z.object({
  full_name: z.string().min(1).max(120).trim().optional(),
  role:      roleEnum.optional(),
  clinic_id: clinicEnum.nullable().optional(),
  is_active: z.boolean().optional(),
}).superRefine((val, ctx) => {
  if (val.role !== undefined && val.clinic_id !== undefined) {
    if (isCrossClinic(val.role) && val.clinic_id !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom, path: ['clinic_id'],
        message: `${val.role} users must not be assigned to a clinic`,
      });
    }
    if (!isCrossClinic(val.role) && val.clinic_id === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom, path: ['clinic_id'],
        message: 'CLINICIAN and FRONT_DESK must be assigned to a clinic',
      });
    }
  }
});

export const resetPasswordSchema = z.object({
  password: z.string().min(8).max(200),
});

export const listUsersQuerySchema = z.object({
  clinic_id: clinicEnum.optional(),
  role:      roleEnum.optional(),
  active:    z.enum(['true', 'false']).optional().transform((v) => (v === undefined ? undefined : v === 'true')),
});

export type CreateUserBody    = z.infer<typeof createUserSchema>;
export type UpdateUserBody    = z.infer<typeof updateUserSchema>;
export type ResetPasswordBody = z.infer<typeof resetPasswordSchema>;
