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
  'Rose Turner',
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

// ── Team Performance KPI Reporting (weekly-kpi) ─────────────────────────────
// Built from "Weekly KPI & Wins Process — Build spec" (Sam, 2026-08-22). The
// spec targets Teams Adaptive Cards; Sam's instruction was to build it here in
// the dashboard first and leave Teams alone, so the fields and the
// one-row-per-person-per-week rule are followed and the Teams plumbing is not.
//
// Access mirrors backend/src/shared/roles.ts, which is the source of truth —
// the server re-checks both on every call. Spec section 2 is the whole model:
// physios are the only ones who submit; Sam only ever views the tracker.

/** Who fills in the form. Physios only. */
export function canSubmitWeeklyKpi(role: Role): boolean {
  return role === 'CLINICIAN'
}

/** Who sees the whole team's tracker. */
export function canViewWeeklyKpiTracker(role: Role): boolean {
  return role === 'ADMIN'
}

/**
 * Who may delete a whole weekly KPI report — super admin only (Sam,
 * 2026-08-24). A physio cannot delete their own week: the current week is
 * corrected by re-submitting it, and past weeks stay frozen. Mirrors
 * backend/src/shared/roles.ts, which re-checks on every call.
 */
export function canDeleteWeeklyKpiReport(role: Role): boolean {
  return role === 'ADMIN'
}

/** One of the three KPI rows on the Monday half. */
export interface KpiLine {
  name:   string | null
  target: string | null
  result: string | null
  /** focus_kpis[].hit from the Weekly Check-In reference. Three-valued: null is
   *  "not answered", which is not the same answer as "did not hit". */
  hit:    boolean | null
}

// ── Weekly Check-In: the 30 behaviour signals (migration 034) ───────────────
//
// The registry itself is NOT in this file. It is served by
// GET /api/weekly-kpi/model from the backend's weekly-kpi.model.ts, which is
// its only copy — thirty rows of question text, weights and Standard flags
// mirrored here would be thirty chances for the form to ask something the
// scorer does not know about, and a physio would never see the difference:
// their score would just be computed from a different set of questions than the
// one they answered. Only the SHAPES live here.

/** 0-3, or null for "N/A — did not arise this week." */
export type SignalRating = 0 | 1 | 2 | 3 | null

export interface KpiSignal {
  signal_id: string
  group_id:  string
  /** Weight within the group, 1-3. */
  weight:    number
  /** A Standard: expected every week, not a stretch goal. Seven of the thirty. */
  standard:  boolean
  text:      string
}

export interface KpiSignalGroup {
  group_id:     string
  name:         string
  group_weight: number
  drives:       string
}

export type KpiBandId = 'ceiling' | 'model' | 'strong' | 'gap' | 'intervene'

export interface KpiScoreBand {
  band_id: KpiBandId
  /** Inclusive lower bound on the ROUNDED score. */
  min:     number
  label:   string
}

export interface KpiDrainType {
  type:         string
  label:        string
  signs:        string
  first_action: string
}

/** Everything the form needs to render and preview a score, in one payload with
 *  one version stamp — so a client can never render one model's questions and
 *  be scored against another's. */
export interface KpiModel {
  model_version:         string
  point_map:             Record<string, number>
  max_points:            number
  groups:                KpiSignalGroup[]
  signals:               KpiSignal[]
  bands:                 KpiScoreBand[]
  drain_types:           KpiDrainType[]
  mojo_flag_at_or_below: number
  na_count_review_at:    number
}

/** The nine self-reported weekly counts. They do not affect the score. */
export interface WeeklyCounts {
  initials_seen:         number | null
  recommendations_full:  number | null
  plans_accepted_full:   number | null
  plans_accepted_part:   number | null
  dropouts_contacted:    number | null
  consults_recorded:     number | null
  calls_due:             number | null
  calls_made:            number | null
  cancellations_noshows: number | null
}

/** The score snapshot the server computed and stored. Every field is null on a
 *  week submitted before the signal model existed — that is how the UI knows to
 *  fall back to the older hand-picked `effectiveness_rating` rather than
 *  printing a gap. */
export interface EffectivenessSnapshot {
  effectiveness_score: number | null
  group_pcts:          Record<string, number | null>
  standards_missed:    number | null
  standards_na:        number | null
  na_count:            number | null
  band_id:             KpiBandId | null
  model_version:       string | null
  is_incomplete:       boolean
}

export interface WeeklyKpiDTO {
  id:             string
  clinician_id:   string
  clinician_name: string | null
  clinic_id:      ClinicId
  week_start:     string        // YYYY-MM-DD (Monday)
  week_end:       string        // YYYY-MM-DD (Sunday)

  // Monday half
  kpis:                 [KpiLine, KpiLine, KpiLine]
  missed_goal_actions:  string | null
  /** Whole-number 0–10 display score. Hand-picked by the physio before the
   *  signal model; from migration 034 on it is ROUND(effectiveness_score), so
   *  the tracker, the team averages and the Excel export keep reading one
   *  column across both eras. Read `effectiveness.effectiveness_score` when you
   *  want the precise number and it is not null.
   *
   *  NULL until the Friday half is submitted (2026-09-04: Effectiveness moved
   *  to Friday) — except on a row submitted before that change. */
  effectiveness_rating: number | null
  /** 1–10. Same NULL-until-Friday rule as effectiveness_rating — see above. */
  mojo_rating:          number | null
  /** Mojo question 2 — any of 'physical' | 'emotional' | 'mental' |
   *  'relational' | 'none'. Multi-select since 2026-09-04; 'none' ("No drain")
   *  is exclusive. Null on weeks submitted before the drain question existed. */
  mojo_drain:           string[] | null
  /** Mojo question 3 — the one action, and when. */
  mojo_action:          string | null
  intention:            string
  case_to_discuss:      string | null
  help_needed:          string | null
  checkin_needed:       boolean
  checkin_focus:        string | null
  monday_submitted_at:  string

  /** The computed score and its breakdown. Nulls throughout for a pre-034 week. */
  effectiveness: EffectivenessSnapshot
  counts:        WeeklyCounts
  /** The thirty raw ratings. Only present on a SINGLE-report read (the form's
   *  own week, or a report fetched by id) — a tracker listing would need one
   *  query per row for something no list shows. Undefined is "not asked for". */
  signals?:      Record<string, SignalRating>

  // Friday half — null until the loop is closed. friday_submitted_at is the
  // canonical "still open" test; every Friday text field is optional, so an
  // honest submission can leave all three blank.
  wins:                string | null
  goal_achieved:       boolean | null
  goal_reflection:     string | null
  flag_for_sam:        string | null
  /** The Weekly Check-In `reflection` block. Its fourth field, `flag`, is the
   *  flag_for_sam above — not duplicated under a second name. */
  best_behaviour:      string | null
  slipped:             string | null
  commitment:          string | null
  friday_submitted_at: string | null

  created_at: string
  updated_at: string

  // ── Comment thread (migration 033) ────────────────────────────────────────
  // Set by the server on every list/read, from the CALLER's point of view —
  // `unread_count` is "waiting for you", so the same report carries different
  // numbers for Sam and for the physio. Optional because an older cached
  // response may not have them; treat undefined as 0, never as "unknown".
  comment_count?: number
  unread_count?:  number
}

/** One message in a weekly KPI thread. Two parties only: the physio the report
 *  belongs to, and the super admin. */
export interface WeeklyKpiComment {
  id:          string
  report_id:   string
  author_id:   string
  author_name: string | null
  author_role: Role
  body:        string
  created_at:  string
  updated_at:  string
  /** updated_at is meaningfully later than created_at — the UI prints "edited". */
  edited:      boolean
}

/**
 * The Effectiveness and Mojo scoring rubrics, shown under each 1–10 scale.
 * Spec section 5: "keep this visible so the scale stays consistent across the
 * team" — so these render inline on the form, not behind a tooltip or a help
 * link. Wording is verbatim from the spec's HTML preview; do not paraphrase,
 * because the team is being scored against these exact sentences.
 */
export interface RubricBand {
  score:   string
  meaning: string
  /** Inclusive numeric bounds, so a stored score can be mapped back to its
   *  band without parsing the "9–10" display string. */
  min:     number
  max:     number
  /** Two or three words summarising the band, for places too narrow to carry
   *  the full sentence (the tracker's rating meters). Condensed from `meaning`
   *  — never shown INSTEAD of the rubric on the form itself, where the spec
   *  requires the full wording. */
  short:   string
}

export const EFFECTIVENESS_RUBRIC: readonly RubricBand[] = [
  { min: 9, max: 10, score: '9–10', short: 'All targets hit', meaning: 'Hit all KPI targets. Full, clinically justified recommendations every time. Notes and Nookal done same-day. Ran the consult framework consistently, including when no one was watching.' },
  { min: 7, max: 8,  score: '7–8',  short: 'Mostly on track',  meaning: 'Mostly on track — one or two lapses (a late note, a target slightly missed) but no pattern of shortcuts.' },
  { min: 5, max: 6,  score: '5–6',  short: 'Mixed week',       meaning: 'Mixed week — did the job, but visible gaps: documentation backlog, inconsistent use of the framework, or a missed target with no fix plan yet.' },
  { min: 3, max: 4,  score: '3–4',  short: 'Frequent gaps',    meaning: 'Frequent gaps — steps skipped under pressure, notes piling up, targets missed without a corrective action.' },
  { min: 1, max: 2,  score: '1–2',  short: 'Care at risk',     meaning: 'Patient care or documentation put at risk. No real adherence to process this week.' },
]

export const MOJO_RUBRIC: readonly RubricBand[] = [
  { min: 9, max: 10, score: '9–10', short: 'Energised',      meaning: 'Energised and present in every session. Confident, proactive, helping others without being asked.' },
  { min: 7, max: 8,  score: '7–8',  short: 'Solid energy',   meaning: 'Solid energy most of the week, maybe one dip — still showed up fully for patients.' },
  { min: 5, max: 6,  score: '5–6',  short: 'Up and down',    meaning: 'Up and down. Some fatigue, had to push through at points, but still functional.' },
  { min: 3, max: 4,  score: '3–4',  short: 'Running empty',  meaning: 'Running on empty most of the week — flat, withdrawn, or irritable, and masking it to get through.' },
  { min: 1, max: 2,  score: '1–2',  short: 'Depleted',       meaning: 'Depleted. Struggling to show up. This is a "talk to me now," not "note it and move on."' },
]

/** Mojo of 1–2 is the spec's "talk to me now" band, so the tracker flags it
 *  rather than leaving Sam to spot a small number in a column of numbers. */
export const MOJO_ALERT_AT_OR_BELOW = 2

/** The band a stored score falls in. Never returns null for a valid 1–10 score
 *  (the bands cover the range with no gaps), but a corrupt value shouldn't
 *  crash a tracker row, so the caller still handles null. */
export function rubricBandFor(score: number, bands: readonly RubricBand[]): RubricBand | null {
  return bands.find(b => score >= b.min && score <= b.max) ?? null
}
