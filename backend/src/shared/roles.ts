export const ROLES = {
  ADMIN:             'ADMIN',
  CLINICIAN:         'CLINICIAN',
  FRONT_DESK:        'FRONT_DESK',
  // Multi-clinic receptionist: cross-clinic data entry for dropouts and
  // case acceptance. clinic_id is NULL and picked per entry.
  FRONT_DESK_GLOBAL: 'FRONT_DESK_GLOBAL',
  // Marketing-spend encoder: the ONLY thing this account does is log ad spend
  // line items. No dashboard, no dropouts, no case acceptance. clinic_id is
  // NULL and picked per entry (ad budgets differ per clinic).
  ADSPEND:           'ADSPEND',
} as const;

export type Role = typeof ROLES[keyof typeof ROLES];

// Front-desk accounts allowed into the Meta/Google Leads (ad-leads) section.
// It is NOT a role — only these specific logins may encode/view leads; every
// other front-desk account has no access at all. Mirrored in frontend types.ts.
export const AD_LEADS_ENCODER_EMAILS: readonly string[] = [
  'bella@physioward.com.au',
];

/**
 * Who may touch the Meta/Google Leads section. ADMIN always can (read-only
 * admin view); front-desk logins only if explicitly allow-listed above.
 * Everyone else (CLINICIAN, ADSPEND, non-listed front desk) is denied.
 */
export function canAccessAdLeads(role: Role, email: string | null | undefined): boolean {
  if (role === 'ADMIN') return true;
  if (role !== 'FRONT_DESK' && role !== 'FRONT_DESK_GLOBAL') return false;
  return !!email && AD_LEADS_ENCODER_EMAILS.includes(email.toLowerCase());
}

export const ROLE_VALUES: readonly Role[] =
  Object.values(ROLES) as readonly Role[];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLE_VALUES as readonly string[]).includes(value);
}

// Clinics that staff can be scoped to. Mirrors backend/src/types CLINICS.
export const CLINIC_IDS = ['newport', 'narrabeen', 'brookvale'] as const;
export type ClinicId = typeof CLINIC_IDS[number];

export function isClinicId(value: unknown): value is ClinicId {
  return typeof value === 'string' && (CLINIC_IDS as readonly string[]).includes(value);
}

// Status / reason vocabularies for dropouts — mirror DB CHECK constraints.
export const DROPOUT_STATUSES = [
  'Re-scheduled',
  'Cancelled - not rescheduled',
  'No Future Bookings',
  'Completed Treatment Plan',
] as const;
export type DropoutStatus = typeof DROPOUT_STATUSES[number];

// Fixed list of front-of-staff names that can be tagged on a dropout entry.
// These are NOT user accounts — receptionists and physios who handle calls
// are recorded by name only. "Other - Physio" covers the case where a clinician
// (any clinician) took the call themselves.
export const FRONT_STAFF_NAMES = [
  'Ann Maree',
  'Bella',
  'Brooke',
  'Holly',
  'Jenny',
  'Tanya',
  'Tilly',
  'Vanessa',
  'Other - Physio',
] as const;
export type FrontStaffName = typeof FRONT_STAFF_NAMES[number];

export function isFrontStaffName(value: unknown): value is FrontStaffName {
  return typeof value === 'string' && (FRONT_STAFF_NAMES as readonly string[]).includes(value);
}

// Marketing channels an ad-spend line item can be tagged with. "Other"
// covers anything not in the fixed list; the optional campaign_name field
// carries the specifics. Mirrored on the frontend in types.ts.
export const AD_CHANNELS = [
  'Facebook',
  'Google',
  'Instagram',
  'TikTok',
  'Other',
] as const;
export type AdChannel = typeof AD_CHANNELS[number];

export function isAdChannel(value: unknown): value is AdChannel {
  return typeof value === 'string' && (AD_CHANNELS as readonly string[]).includes(value);
}

// Ad-lead platforms for the Meta/Google ADS Leads feature. EXACT copy of the
// sheet's "Platform Source" dropdown (same options, same order) so the entry
// form is gayang-gaya with the source. The DB column is NOT constrained to
// these so the importer can preserve any historical value verbatim.
// Mirrored on the frontend in types.ts.
export const AD_LEAD_PLATFORMS = [
  'Facebook Lead Form Ads',
  'FB Athlete Landing Page Ad',
  'Google Ads',
  'FB Paid Ad Quiz',
  "FB Over 40's Landing Page Ad",
] as const;
export type AdLeadPlatform = typeof AD_LEAD_PLATFORMS[number];

// EXACT copy of the sheet's "Bella Called?" / "Bella SMS?" dropdowns. Used to
// populate those selects on the entry form. The DB stores free text (the
// validator stays lenient) so imported/legacy values are never rejected.
export const BELLA_CONTACT_OPTIONS = [
  'Y',
  'N',
  'already booked in',
  'booked in during call',
  'Double called and left message',
  'Triple called within 24 hours',
  'Not interested',
] as const;
export type BellaContactOption = typeof BELLA_CONTACT_OPTIONS[number];

export function isAdLeadPlatform(value: unknown): value is AdLeadPlatform {
  return typeof value === 'string' && (AD_LEAD_PLATFORMS as readonly string[]).includes(value);
}

export const DROPOUT_REASONS = [
  'Sick',
  'Away',
  'Work Commitments',
  'Family',
  'Financial',
  'Other',
  'Discharged',
  'Early Discharge',
  'Self Discharge',
] as const;
export type DropoutReason = typeof DROPOUT_REASONS[number];
