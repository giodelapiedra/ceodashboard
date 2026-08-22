export interface WeekMetrics {
  weekNum: number | string;
  label: string;
  dateFrom: string;
  dateTo: string;
  totalRevenue: number;
  productSalesRevenue: number;
  upfrontRevenue: number;
  cashFromInsurance: number;
  debtCollection: number;
  newPatients: number;
  patientReactivations: number;
  newOptIns: number;
  adSpend: number;
  costPerPatient: number | null;
  totalPatients: number;
  appointmentsAttended: number;
  appointmentsCancelled: number;
  appointmentsRebooked: number;
  noShows: number;
  showUpRate: number | null;
  cancellationRate: number | null;
  caseAcceptance: number | null;
  upfrontPlanAccepted: number;
  productsUpsold: number;
  complementaryTransitions: number;
  activePatients: number;
}

export interface MonthlyTotals {
  totalRevenue: number;
  productSalesRevenue: number;
  upfrontRevenue: number;
  cashFromInsurance: number;
  debtCollection: number;
  newPatients: number;
  patientReactivations: number;
  newOptIns: number;
  adSpend: number;
  costPerPatient: number | null;
  totalPatients: number;
  appointmentsAttended: number;
  appointmentsCancelled: number;
  appointmentsRebooked: number;
  noShows: number;
  showUpRate: number | null;
  cancellationRate: number | null;
  caseAcceptance: number | null;
  upfrontPlanAccepted: number;
  productsUpsold: number;
  complementaryTransitions: number;
  activePatients: number;
}

export interface DashboardData {
  clinic: string;
  clinicId: string;
  month: number;
  year: number;
  weeks: WeekMetrics[];
  monthly: MonthlyTotals;
  fetchedAt: string;
  duration: number;
  fromCache?: boolean;
}

// ── Auth / users ───────────────────────────────────────────────
export type Role = 'ADMIN' | 'CLINICIAN' | 'FRONT_DESK' | 'FRONT_DESK_GLOBAL' | 'ADSPEND';

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN:             'Super Admin',
  CLINICIAN:         'Clinician',
  FRONT_DESK:        'Front Desk',
  FRONT_DESK_GLOBAL: 'Front Desk (All Clinics)',
  ADSPEND:           'Ad Spend Encoder',
};

/** Roles whose users.clinic_id is NULL (cross-clinic accounts). */
export const CROSS_CLINIC_ROLES: readonly Role[] = ['ADMIN', 'FRONT_DESK_GLOBAL', 'ADSPEND'];
export function isCrossClinicRole(role: Role): boolean {
  return CROSS_CLINIC_ROLES.includes(role);
}

export type ClinicId = 'newport' | 'narrabeen' | 'brookvale';

export const CLINIC_LABEL: Record<ClinicId, string> = {
  newport:   'Newport',
  narrabeen: 'Narrabeen',
  brookvale: 'Brookvale',
};

export interface User {
  id:         string;
  email:      string;
  role:       Role;
  full_name:  string | null;
  clinic_id:  ClinicId | null;
  is_active:  boolean;
  created_at: string;
}

// ── Dropouts ───────────────────────────────────────────────────
export const DROPOUT_STATUSES = [
  'Re-scheduled',
  'Cancelled - not rescheduled',
  'No Future Bookings',
  'Completed Treatment Plan',
] as const;
export type DropoutStatus = typeof DROPOUT_STATUSES[number];

// Fixed list of front-of-staff names (NOT user accounts). Source: live sheet.
export const FRONT_STAFF_NAMES = [
  'Ann Maree',
  'Bella',
  'Brooke',
  'Catherine',
  'Holly',
  'Jenny',
  'Lisa Miller',
  'Tanya',
  'Tilly',
  'Vanessa',
  'Other - Physio',
] as const;
export type FrontStaffName = typeof FRONT_STAFF_NAMES[number];

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

export interface DropoutDTO {
  id:                          string;
  clinic_id:                   ClinicId;
  entered_by:                  string;
  entered_by_name:             string | null;
  front_staff_name:            FrontStaffName | null;
  clinician_id:                string;
  clinician_name:              string | null;
  patient_name:                string;
  date_logged:                 string; // YYYY-MM-DD
  /** All recorded cancellation dates (may be empty). YYYY-MM-DD strings. */
  appointment_cancelled_dates: string[];
  // Nullable for legacy 2026 import rows that had blank Status/Reason in the
  // source spreadsheet. The entry form still requires both for new entries.
  status:                      DropoutStatus | null;
  reason:                      DropoutReason | null;
  notes:                       string | null;
  created_at:                  string;
  updated_at:                  string;
}

// ── Ad Spend ───────────────────────────────────────────────────
// Mirror of backend/src/shared/roles.ts AD_CHANNELS.
export const AD_CHANNELS = [
  'Facebook',
  'Google',
  'Instagram',
  'TikTok',
  'Other',
] as const;
export type AdChannel = typeof AD_CHANNELS[number];

// Ad spend is GLOBAL (no clinic) — one pool for the whole business.
export interface AdSpendDTO {
  id:              string;
  entered_by:      string;
  entered_by_name: string | null;
  spend_date:      string; // YYYY-MM-DD
  channel:         AdChannel;
  campaign_name:   string | null;
  amount:          number;
  notes:           string | null;
  created_at:      string;
  updated_at:      string;
}

// ── Meta/Google ADS Leads ──────────────────────────────────────
// Mirror of backend/src/shared/roles.ts. EXACT copy of the sheet's "Platform
// Source" dropdown (same options + order) so the form is gayang-gaya.
export const AD_LEAD_PLATFORMS = [
  'Facebook Lead Form Ads',
  'FB Athlete Landing Page Ad',
  'Google Ads',
  'FB Paid Ad Quiz',
  "FB Over 40's Landing Page Ad",
  // Added 2026-08-16 — mirrored in backend roles.ts. See the note there.
  'Facebook NEW Landing Ad',
] as const;
export type AdLeadPlatform = typeof AD_LEAD_PLATFORMS[number];

// EXACT copy of the sheet's "Bella Called?" / "Bella SMS?" dropdown options.
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

// ── Meta/Google Leads (ad-leads) access ──────────────────────────────────────
// Mirrors backend/src/shared/roles.ts, which is the source of truth — the
// server re-checks both of these on every call. Two separate questions:
//   1. canAccessAdLeads — may this login open the section at all?
//   2. canRemoveAdLead  — once in, may it also DELETE?
// Edit BOTH files when either list changes.

/** Logins outside the front-desk roles that are still allowed in. */
export const AD_LEADS_EXTRA_EMAILS: readonly string[] = [
  'adspend@physioward.com.au',
];

/**
 * Who may open the Meta/Google Leads section: ADMIN, every front-desk login
 * (re-opened to the whole team 2026-08-12), plus AD_LEADS_EXTRA_EMAILS.
 */
export function canAccessAdLeads(role: Role, email: string | null | undefined): boolean {
  if (role === 'ADMIN') return true;
  if (role === 'FRONT_DESK' || role === 'FRONT_DESK_GLOBAL') return true;
  return !!email && AD_LEADS_EXTRA_EMAILS.includes(email.toLowerCase());
}

/**
 * Who may REMOVE a lead — directly for ADMIN, via a delete request for the front
 * desk. Everyone who can open the section may add and edit; only deleting is
 * still withheld from the ad-spend encoder (Sam, 2026-08-12).
 */
export function canRemoveAdLead(role: Role): boolean {
  return role === 'ADMIN' || role === 'FRONT_DESK' || role === 'FRONT_DESK_GLOBAL';
}

export interface AdLeadDTO {
  id:              string;
  clinic_id:       ClinicId;
  entered_by:      string;
  entered_by_name: string | null;
  patient_name:    string;
  platform:        string;
  campaign_name:   string | null;
  date_added:      string;          // YYYY-MM-DD
  booked:          boolean;
  bella_called:    string | null;
  bella_sms:       string | null;
  bella_remarks:   string | null;
  created_at:      string;
  updated_at:      string;
  // Persisted Nookal account totals (written by the Sync Paid button).
  nookal_status:     'matched' | 'multiple' | 'not_found' | 'error' | null;
  nookal_candidates: { clientID: number; fullName: string; invoiceCount: number; invoiced: number; paid: number }[] | null;
  nookal_paid:       number | null;
  nookal_synced_at:  string | null;
}

// ── Case Recommendation & Acceptance ───────────────────────────
export interface CaseAcceptanceDTO {
  id:                       string;
  clinic_id:                ClinicId;
  entered_by:               string;
  entered_by_name:          string | null;
  front_staff_name:         FrontStaffName | null;
  clinician_id:             string;
  clinician_name:           string | null;
  patient_name:             string;
  date_logged:              string; // YYYY-MM-DD
  treatment_plan_provided:  boolean | null;
  case_recommendations:     number;
  appointments_booked:      number;
  /** booked / recommendations × 100 — null when recommendations === 0. */
  case_acceptance_pct:      number | null;
  prepay_offered:           boolean | null;
  prepay_accepted:          boolean | null;
  transition_notes:         string | null;
  notes:                    string | null;
  created_at:               string;
  updated_at:               string;
}
