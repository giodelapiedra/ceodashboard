import { env } from '../config/env';

// ── Nookal API Types ──────────────────────────────────────────

export interface NookalResponse<T> {
  details: {
    code: number;
    message: string;
    results: T;
    pages: number;
    page: number;
  };
}

export interface NookalInvoice {
  invoice_id: string;
  patient_id: string;
  location_id: string;
  invoice_date: string;
  total_amount: number;
  paid_amount: number;
  payment_type: string;
  invoice_type: string;
  status: string;
}

export interface NookalAppointment {
  appointment_id: string;
  patient_id: string;
  location_id: string;
  appointment_date: string;
  status: string;
  cancelled_rebooked: boolean;
  case_acceptance?: number;
}

export interface NookalPatient {
  patient_id: string;
  location_id: string;
  created_date: string;
  last_appointment_date: string | null;
  is_new: boolean;
}

export interface NookalInventoryItem {
  item_id: string;
  item_name: string;
  category: string;
  location_id: string;
  qty_sold: number;
  total_sales: number;
  profit: number;
}

// ── Dashboard Types ──────────────────────────────────────────

export interface DateRange {
  dateFrom: string; // YYYY-MM-DD
  dateTo:   string; // YYYY-MM-DD
}

export interface WeekRange extends DateRange {
  label: string; // e.g. "Week 1 [6-10]"
  weekNum: 1 | 2 | 3 | 4 | 'remainder';
}

export interface WeekMetrics {
  weekNum: 1 | 2 | 3 | 4 | 'remainder';
  label: string;
  dateFrom: string;
  dateTo: string;

  // Finance
  totalRevenue: number;
  productSalesRevenue: number;
  upfrontRevenue: number;
  cashFromInsurance: number;
  debtCollection: number;

  // Marketing
  newPatients: number;
  patientReactivations: number;
  newOptIns: number;
  // Ad spend is GLOBAL (no clinic). Same figure on every clinic view; the
  // Overall view recomputes it from raw daily totals (not summed per clinic).
  adSpend: number;
  // adSpend / newPatients — null when newPatients === 0 (renders "—").
  costPerPatient: number | null;

  // Operations
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

export interface MonthlyDashboard {
  clinic:   string;
  clinicId: string;
  month:    number;
  year:     number;
  weeks:    WeekMetrics[];
  monthly:  MonthlyTotals;
}

export interface MonthlyTotals {
  // Finance
  totalRevenue: number;
  productSalesRevenue: number;
  upfrontRevenue: number;
  cashFromInsurance: number;
  debtCollection: number;

  // Marketing
  newPatients: number;
  patientReactivations: number;
  newOptIns: number;
  adSpend: number;                 // global, recomputed (not summed per clinic)
  costPerPatient: number | null;   // adSpend / newPatients

  // Operations
  totalPatients: number;
  appointmentsAttended: number;
  appointmentsCancelled: number;
  appointmentsRebooked: number;
  noShows: number;
  showUpRate: number | null;      // avg
  cancellationRate: number | null; // avg
  caseAcceptance: number | null;   // avg
  upfrontPlanAccepted: number;
  productsUpsold: number;
  complementaryTransitions: number;
  activePatients: number;
}

export interface Clinic {
  id:            string;
  name:          string;
  locationId:    string;  // v2 REST location ID (string)
  v3LocationId:  number;  // v3 GraphQL location ID (int)
}

export const CLINICS: Clinic[] = [
  {
    id:           'newport',
    name:         'Newport',
    locationId:   env.NOOKAL_LOCATION_NEWPORT,
    v3LocationId: env.NOOKAL_V3_LOCATION_NEWPORT,
  },
  {
    id:           'narrabeen',
    name:         'Narrabeen',
    locationId:   env.NOOKAL_LOCATION_NARRABEEN,
    v3LocationId: env.NOOKAL_V3_LOCATION_NARRABEEN,
  },
  {
    id:           'brookvale',
    name:         'Brookvale',
    locationId:   env.NOOKAL_LOCATION_BROOKVALE,
    v3LocationId: env.NOOKAL_V3_LOCATION_BROOKVALE,
  },
];
