import {
  NookalInvoice,
  NookalAppointment,
  NookalPatient,
  NookalInventoryItem,
  WeekMetrics,
  MonthlyTotals,
  WeekRange,
} from '../types';

interface RawData {
  invoices:     NookalInvoice[];
  appointments: NookalAppointment[];
  patients:     NookalPatient[];
  inventory:    NookalInventoryItem[];
}

export function calculateWeekMetrics(
  data: RawData,
  week: WeekRange
): WeekMetrics {
  const { invoices, appointments, patients } = data;

  // ── Finance ──────────────────────────────────────────────
  const totalRevenue = invoices.reduce((s, i) => s + (i.paid_amount || 0), 0);

  const productSalesRevenue = invoices
    .filter(i => i.invoice_type?.toUpperCase() === 'PRODUCT')
    .reduce((s, i) => s + (i.paid_amount || 0), 0);

  const upfrontRevenue = invoices
    .filter(i => i.payment_type?.toUpperCase() === 'UPFRONT')
    .reduce((s, i) => s + (i.paid_amount || 0), 0);

  const cashFromInsurance = invoices
    .filter(i => i.payment_type?.toUpperCase() === 'INSURANCE')
    .reduce((s, i) => s + (i.paid_amount || 0), 0);

  // ── Marketing ─────────────────────────────────────────────
  const newPatients = patients.filter(p => p.is_new).length;

  const patientReactivations = patients.filter(p => {
    if (!p.last_appointment_date || p.is_new) return false;
    const daysDiff =
      (new Date(p.created_date).getTime() - new Date(p.last_appointment_date).getTime())
      / (1000 * 60 * 60 * 24);
    return daysDiff > 90;
  }).length;

  // ── Operations ────────────────────────────────────────────
  const attended  = appointments.filter(a => a.status?.toUpperCase() === 'ATTENDED').length;
  const cancelled = appointments.filter(a => a.status?.toUpperCase() === 'CANCELLED' && !a.cancelled_rebooked).length;
  const rebooked  = appointments.filter(a => a.cancelled_rebooked).length;
  const noShows   = appointments.filter(a => a.status?.toUpperCase() === 'NO_SHOW').length;
  const totalBooked = appointments.length;

  const showUpRate      = totalBooked > 0 ? +((attended / totalBooked) * 100).toFixed(2) : null;
  const cancellationRate = attended > 0   ? +((cancelled / attended) * 100).toFixed(2)   : null;

  // Case acceptance — average across appointments that have it set
  const withCA = appointments.filter(a => a.case_acceptance !== undefined && a.case_acceptance !== null);
  const caseAcceptance = withCA.length > 0
    ? +(withCA.reduce((s, a) => s + (a.case_acceptance || 0), 0) / withCA.length).toFixed(2)
    : null;

  const totalPatients    = new Set(appointments.map(a => a.patient_id)).size;
  const upfrontPlanAccepted = invoices.filter(i => i.payment_type?.toUpperCase() === 'UPFRONT').length;
  const productsUpsold      = invoices.filter(i => i.invoice_type?.toUpperCase() === 'PRODUCT').length;

  return {
    weekNum: week.weekNum,
    label:   week.label,
    dateFrom: week.dateFrom,
    dateTo:   week.dateTo,
    totalRevenue,
    productSalesRevenue,
    upfrontRevenue,
    cashFromInsurance,
    debtCollection:           0,
    newPatients,
    patientReactivations,
    newOptIns:                0,
    adSpend:                  0,
    costPerPatient:           null,
    totalPatients,
    appointmentsAttended:     attended,
    appointmentsCancelled:    cancelled,
    appointmentsRebooked:     rebooked,
    noShows,
    showUpRate,
    cancellationRate,
    caseAcceptance,
    upfrontPlanAccepted,
    productsUpsold,
    complementaryTransitions: 0,
    activePatients:           0,
  };
}

export function calculateMonthlyTotals(weeks: WeekMetrics[]): MonthlyTotals {
  const sum = (key: keyof WeekMetrics) => {
    const total = weeks.reduce((s, w) => s + ((w[key] as number) || 0), 0);
    return Math.round(total * 100) / 100;
  };

  const avg  = (key: keyof WeekMetrics) => {
    const vals = weeks.filter(w => w[key] !== null && w[key] !== undefined);
    if (!vals.length) return null;
    return +(vals.reduce((s, w) => s + (w[key] as number), 0) / vals.length).toFixed(2);
  };

  return {
    totalRevenue:             sum('totalRevenue'),
    productSalesRevenue:      sum('productSalesRevenue'),
    upfrontRevenue:           sum('upfrontRevenue'),
    cashFromInsurance:        sum('cashFromInsurance'),
    debtCollection:           0,
    newPatients:              sum('newPatients'),
    patientReactivations:     sum('patientReactivations'),
    newOptIns:                0,
    adSpend:                  0,
    costPerPatient:           null,
    totalPatients:            sum('totalPatients'),
    appointmentsAttended:     sum('appointmentsAttended'),
    appointmentsCancelled:    sum('appointmentsCancelled'),
    appointmentsRebooked:     sum('appointmentsRebooked'),
    noShows:                  sum('noShows'),
    showUpRate:               avg('showUpRate'),
    cancellationRate:         avg('cancellationRate'),
    caseAcceptance:           avg('caseAcceptance'),
    upfrontPlanAccepted:      sum('upfrontPlanAccepted'),
    productsUpsold:           sum('productsUpsold'),
    complementaryTransitions: 0,
    activePatients:           0,
  };
}
