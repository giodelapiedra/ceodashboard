import { WeekRange } from '../../types';
import { getWeekRanges } from '../../services/week.calculator';
import {
  practitionerStatsRepository,
  PractitionerDayRow,
  CancellationDayRow,
} from './practitioner-stats.repository';

/**
 * Practitioner Stats — the in-app rebuild of the "Practitioner Stats 2026" tab
 * in the PhysioWard Clinical Impact Markers spreadsheet.
 *
 * Two deliberate departures from that sheet, both because the sheet is wrong:
 *
 *  1. Prepay % is offers ÷ initial consults. The SOP divides by NC (a Nookal
 *     New-Cases figure from a different system), which is how the sheet ended
 *     up printing 125% for one practitioner. Two counts from two systems cannot
 *     form a rate.
 *
 *  2. Case Acceptance is pooled — SUM(booked) ÷ SUM(recommendations) — matching
 *     the workbook's own KPI dictionary and the existing caseAcceptance
 *     aggregate(). The sheet instead averages per-patient percentages, which
 *     weights a 2-recommendation patient the same as a 12-recommendation one
 *     and diverges by up to 12 points on low-volume weeks.
 *
 * Team rows pool the underlying counts rather than averaging the per-clinician
 * averages, so a practitioner with 2 initials cannot swing the team figure as
 * hard as one with 20.
 */

export type Zone = 'thriving' | 'refining' | 'reset';

/** A metric with its zone resolved, or null when there is no data behind it. */
export interface Metric {
  value: number | null;
  zone:  Zone | null;
}

/** A metric the DB genuinely cannot produce yet, with the reason attached. */
export interface UnavailableMetric {
  value:  null;
  zone:   null;
  reason: string;
}

export interface PractitionerWeekStats {
  clinicianId:   string;
  clinicianName: string;
  clinicId:      string | null;

  /** Initial consultations logged — the denominator for the prepay rates. */
  initials:      number;

  recommendations:  Metric;
  conversion:       Metric;
  caseAcceptance:   Metric;
  /** Present in the KPI dictionary at a 100% target; tracked nowhere in the sheet. */
  tpDocumented:     Metric;

  prepayOfferedPct:  Metric;
  /** Null when nothing was offered — per the SOP's own note, not a 0%. */
  prepayAcceptedPct: Metric;

  /** Raw counts from patient_dropouts. */
  cancellations: number;
  churns:        number;

  totalAppts:     UnavailableMetric;
  newCases:       UnavailableMetric;
  occupancy:      UnavailableMetric;
  cancellationPct: UnavailableMetric;
}

export interface PractitionerStatsWeek {
  weekNum:  WeekRange['weekNum'];
  label:    string;
  dateFrom: string;
  dateTo:   string;
  rows:     PractitionerWeekStats[];
  team:     PractitionerWeekStats;
}

export interface PractitionerStatsReport {
  year:     number;
  month:    number;
  clinicId: string | null;
  weeks:    PractitionerStatsWeek[];
  /** Surfaced to the UI so the gaps are stated, not silently blank. */
  notes:    string[];
}

// ── Zone thresholds ────────────────────────────────────────────────────────
// Verbatim from the workbook's KPI dictionary tab. Kept as data, not inlined
// into the comparisons, so changing a target is a one-line edit here.

const NOT_AVAILABLE = {
  totalAppts:
    'Needs a Nookal providerID → users mapping (users.nookal_provider_id does not exist yet).',
  newCases:
    'Needs a Nookal providerID → users mapping (users.nookal_provider_id does not exist yet).',
  occupancy:
    'Needs practitioner roster / availability hours. Nookal appointment data has no working-hours field.',
  cancellationPct:
    'Cancellations are counted, but the rate needs Total Appts as its denominator — blocked on the same Nookal mapping.',
} as const;

/** Higher is better, with an explicit target band. */
function zoneHigher(value: number, thriving: number, refining: number): Zone {
  if (value >= thriving) return 'thriving';
  if (value >= refining) return 'refining';
  return 'reset';
}

/** Lower is better (cancellation-style metrics). Unused until Total Appts lands. */
export function zoneLower(value: number, thriving: number, refining: number): Zone {
  if (value < thriving) return 'thriving';
  if (value <= refining) return 'refining';
  return 'reset';
}

function metric(value: number | null, zone: (v: number) => Zone): Metric {
  if (value === null || !Number.isFinite(value)) return { value: null, zone: null };
  return { value, zone: zone(value) };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Recommendations: dictionary says 8–12 is the target band. The upper bound is
// not penalised — more treatment-plan recommendations is not a worse outcome —
// so anything at or above 8 reads as thriving.
const zoneRecommendations = (v: number) => zoneHigher(v, 8, 6);
const zoneConversion      = (v: number) => zoneHigher(v, 6, 5);
const zoneCaseAcceptance  = (v: number) => zoneHigher(v, 80, 70);
const zoneTpDocumented    = (v: number) => zoneHigher(v, 100, 80);
// No target zone is defined for the prepay rates in the KPI dictionary; the
// Prepayment tab's own summary uses 100% offer / 80% acceptance as targets.
const zonePrepayOffered   = (v: number) => zoneHigher(v, 100, 50);
const zonePrepayAccepted  = (v: number) => zoneHigher(v, 80, 50);

// ── Aggregation ────────────────────────────────────────────────────────────

/** The raw counters a stats row is computed from. Summing these is what makes
 *  the team row pooled rather than an average of averages. */
interface Counters {
  initials:        number;
  sumRecs:         number;
  sumBooked:       number;
  rowsWithRecs:    number;
  tpYes:           number;
  tpNo:            number;
  prepayOffered:   number;
  prepayAccepted:  number;
  cancellations:   number;
  churns:          number;
}

const emptyCounters = (): Counters => ({
  initials: 0, sumRecs: 0, sumBooked: 0, rowsWithRecs: 0,
  tpYes: 0, tpNo: 0, prepayOffered: 0, prepayAccepted: 0,
  cancellations: 0, churns: 0,
});

function addCaseRow(c: Counters, r: PractitionerDayRow): void {
  c.initials       += r.initials;
  c.sumRecs        += r.sum_recs;
  c.sumBooked      += r.sum_booked;
  c.rowsWithRecs   += r.rows_with_recs;
  c.tpYes          += r.tp_yes;
  c.tpNo           += r.tp_no;
  c.prepayOffered  += r.prepay_offered;
  c.prepayAccepted += r.prepay_accepted;
}

function addCancelRow(c: Counters, r: CancellationDayRow): void {
  c.cancellations += r.cancellations;
  c.churns        += r.churns;
}

function toStats(
  clinicianId:   string,
  clinicianName: string,
  clinicId:      string | null,
  c:             Counters
): PractitionerWeekStats {
  // AVG denominators exclude rows with no treatment plan (recommendations = 0).
  // See PractitionerDayRow.rows_with_recs for why.
  const recsAvg   = c.rowsWithRecs > 0 ? round2(c.sumRecs   / c.rowsWithRecs) : null;
  const convAvg   = c.rowsWithRecs > 0 ? round2(c.sumBooked / c.rowsWithRecs) : null;
  const casePct   = c.sumRecs > 0 ? round2((c.sumBooked / c.sumRecs) * 100) : null;
  const tpTotal   = c.tpYes + c.tpNo;
  const tpPct     = tpTotal > 0 ? round2((c.tpYes / tpTotal) * 100) : null;

  // The fix for the sheet's 125%: initials, never NC.
  const prepayOffPct = c.initials > 0
    ? round2((c.prepayOffered / c.initials) * 100)
    : null;
  // Blank, not 0%, when nothing was offered — the SOP says so explicitly and
  // a 0% would read as a coaching failure rather than "not applicable".
  const prepayAccPct = c.prepayOffered > 0
    ? round2((c.prepayAccepted / c.prepayOffered) * 100)
    : null;

  return {
    clinicianId,
    clinicianName,
    clinicId,
    initials:          c.initials,
    recommendations:   metric(recsAvg,      zoneRecommendations),
    conversion:        metric(convAvg,      zoneConversion),
    caseAcceptance:    metric(casePct,      zoneCaseAcceptance),
    tpDocumented:      metric(tpPct,        zoneTpDocumented),
    prepayOfferedPct:  metric(prepayOffPct, zonePrepayOffered),
    prepayAcceptedPct: metric(prepayAccPct, zonePrepayAccepted),
    cancellations:     c.cancellations,
    churns:            c.churns,
    totalAppts:      { value: null, zone: null, reason: NOT_AVAILABLE.totalAppts },
    newCases:        { value: null, zone: null, reason: NOT_AVAILABLE.newCases },
    occupancy:       { value: null, zone: null, reason: NOT_AVAILABLE.occupancy },
    cancellationPct: { value: null, zone: null, reason: NOT_AVAILABLE.cancellationPct },
  };
}

const inRange = (day: string, w: WeekRange) => day >= w.dateFrom && day <= w.dateTo;

export const practitionerStatsService = {
  async getReport(
    year:     number,
    month:    number,
    clinicId: string | null
  ): Promise<PractitionerStatsReport> {
    const weeks = getWeekRanges(year, month);

    // One fetch spanning every week, then bucket in memory. The ranges are
    // contiguous from the first Monday, so the span is min(from)..max(to).
    const real     = weeks.filter((w) => w.dateFrom !== '9999-12-31');
    const dateFrom = real.reduce((a, w) => (w.dateFrom < a ? w.dateFrom : a), real[0].dateFrom);
    const dateTo   = real.reduce((a, w) => (w.dateTo   > a ? w.dateTo   : a), real[0].dateTo);

    const [caseRows, cancelRows, clinicians] = await Promise.all([
      practitionerStatsRepository.caseAcceptanceByDay(dateFrom, dateTo, clinicId),
      practitionerStatsRepository.cancellationsByDay(dateFrom, dateTo, clinicId),
      practitionerStatsRepository.activeClinicians(clinicId),
    ]);

    // Names for anyone who appears in the data but is no longer in the active
    // picker — a physio who left mid-month still owns their weeks.
    const nameOf = new Map<string, string>();
    const clinicOf = new Map<string, string | null>();
    for (const c of clinicians) {
      nameOf.set(c.id, c.full_name ?? `Clinician ${c.id}`);
      clinicOf.set(c.id, c.clinic_id);
    }
    for (const r of caseRows) {
      if (!nameOf.has(r.clinician_id)) {
        nameOf.set(r.clinician_id, r.clinician_name ?? `Clinician ${r.clinician_id}`);
        clinicOf.set(r.clinician_id, r.clinic_id);
      }
    }

    const outWeeks: PractitionerStatsWeek[] = weeks.map((w) => {
      const byClinician = new Map<string, Counters>();
      const teamTotals  = emptyCounters();

      // Every active clinician gets a row even with nothing logged, so a blank
      // week is visible rather than absent.
      for (const c of clinicians) byClinician.set(c.id, emptyCounters());

      const bump = (id: string): Counters => {
        let c = byClinician.get(id);
        if (!c) byClinician.set(id, c = emptyCounters());
        return c;
      };

      for (const r of caseRows) {
        if (!inRange(r.day, w)) continue;
        addCaseRow(bump(r.clinician_id), r);
        addCaseRow(teamTotals, r);
      }
      for (const r of cancelRows) {
        if (!inRange(r.day, w)) continue;
        addCancelRow(bump(r.clinician_id), r);
        addCancelRow(teamTotals, r);
      }

      const rows = [...byClinician.entries()]
        .map(([id, c]) => toStats(id, nameOf.get(id) ?? `Clinician ${id}`, clinicOf.get(id) ?? null, c))
        .sort((a, b) => a.clinicianName.localeCompare(b.clinicianName));

      return {
        weekNum:  w.weekNum,
        label:    w.label,
        dateFrom: w.dateFrom,
        dateTo:   w.dateTo,
        rows,
        team:     toStats('team', 'Team', null, teamTotals),
      };
    });

    return {
      year,
      month,
      clinicId,
      weeks: outWeeks,
      notes: [
        `Total Appts, NC and Occupancy are not shown: ${NOT_AVAILABLE.totalAppts}`,
        `Occupancy specifically: ${NOT_AVAILABLE.occupancy}`,
        'Case Acceptance is pooled (sum booked ÷ sum recommendations), per the KPI dictionary. The spreadsheet averages per-patient percentages and can differ by up to 12 points.',
        'Prepay % uses initial consultations as its denominator, not NC. The spreadsheet divides by NC, which is what produced its 125% value.',
        'Recommendations and Conversion averages exclude rows with no treatment plan, matching the blank cells the spreadsheet skips. See the Treatment Plans column for how many were excluded.',
      ],
    };
  },
};
