import { V3Appointment } from './nookal-v3/queries';
import { fetchAppointmentsInRange } from './nookal-v3/fetchers';
import { NookalDataCache } from './nookal-v3/data-cache';
import { Clinic } from '../types';

/**
 * New Patients + Patient Reactivations. Counts native Nookal flags
 * `isNewClient` / `isNewCase` on appointments in the clinic+range,
 * matching Nookal's Providers and Practice "Consultations & Classes"
 * totals exactly.
 *
 * Reactivations = New Cases − New Patients (Sam's manual formula).
 */

export interface PatientMetricsReport {
  clinicId:             string;
  clinicName:           string;
  dateFrom:             string;
  dateTo:               string;
  newPatients:          number;
  newCaseCount:         number;
  patientReactivations: number;
}

/**
 * Nookal returns `appointmentDate` already as YYYY-MM-DD (unlike entry.date
 * which is a full "Fri Jan 31 2025 …" string). No parsing needed.
 */
function apptDay(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

async function loadAppointments(
  clinic:   Clinic,
  dateFrom: string,
  dateTo:   string,
  cache?:   NookalDataCache
): Promise<V3Appointment[]> {
  if (cache) return cache.appointments(clinic.v3LocationId);
  return fetchAppointmentsInRange(clinic.v3LocationId, dateFrom, dateTo);
}

export const patientMetricsService = {
  async getReport(
    clinic:   Clinic,
    dateFrom: string,
    dateTo:   string,
    cache?:   NookalDataCache
  ): Promise<PatientMetricsReport> {
    const all = await loadAppointments(clinic, dateFrom, dateTo, cache);

    let newPatients  = 0;
    let newCaseCount = 0;
    for (const a of all) {
      const day = apptDay(a.appointmentDate);
      if (!day || day < dateFrom || day > dateTo) continue;
      if (a.isNewClient) newPatients++;
      if (a.isNewCase)   newCaseCount++;
    }

    return {
      clinicId:   clinic.id,
      clinicName: clinic.name,
      dateFrom, dateTo,
      newPatients,
      newCaseCount,
      patientReactivations: newCaseCount - newPatients,
    };
  },
};
