import { WeekRange } from '../../types';
import { getWeekRanges } from '../../services/week.calculator';
import {
  practitionerStatsRepository,
  PractitionerDayRow,
  CancellationDayRow,
  WeekInputRow,
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
  /**
   * True for the three figures that cannot be pulled from Nookal and are typed
   * in by hand (Total Appts, Occupancy, NC), plus Cancellation % which is
   * derived from one of them. Lets the UI mark them and offer editing.
   */
  manual?: boolean;
  /** Why the cell is blank, or a warning about the value that is there. */
  note?: string;
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

  /** Hand-entered (migration 024) — no Nookal API path exists to these. */
  totalAppts: Metric;
  occupancy:  Metric;
  newCases:   Metric;
  /** Computed: cancellation events ÷ hand-entered Total Appts. */
  cancellationPct: Metric;
}

export interface PractitionerStatsWeek {
  weekNum:  WeekRange['weekNum'];
  label:    string;
  dateFrom: string;
  dateTo:   string;
  rows:     PractitionerWeekStats[];
  team:     PractitionerWeekStats;
  /**
   * Most recent Nookal sync covering this week, or null if never synced.
   *
   * The report itself is served from Postgres — pressing Sync is what talks to
   * Nookal, and a read costs about 10-50ms against 30+ seconds for a sync. This
   * timestamp is what tells the CEO whether a sync is actually needed, instead
   * of pressing it every visit on the assumption the figures might be stale.
   */
  syncedAt: string | null;
}

export interface PractitionerStatsReport {
  year:     number;
  month:    number;
  clinicId: string | null;
  weeks:    PractitionerStatsWeek[];
}

// ── Zone thresholds ────────────────────────────────────────────────────────
// Verbatim from the workbook's KPI dictionary tab. Kept as data, not inlined
// into the comparisons, so changing a target is a one-line edit here.

// Sam confirmed (2026-08-04) that Total Appts, Occupancy and NC cannot be pulled
// from Nookal. They are read off two Nookal report screens by hand (SOP steps
// 7-18) and are now entered in the app instead of the spreadsheet, so all nine
// SOP columns can be shown in one place.
const NOT_ENTERED = {
  totalAppts:
    'Not entered yet. Nookal → Reports → Providers & Practice → Completed Consults (SOP steps 7-11). No API path exists to this figure.',
  newCases:
    'Not entered yet. Same Providers & Practice report → New Cases (SOP steps 12-14).',
  occupancy:
    'Not entered yet. Nookal → Reports → Occupancy (SOP steps 15-18). The appointment feed carries no working-hours field, so this cannot be derived.',
  cancellationPct:
    'Needs Total Appts as its denominator. The numerator is already computed — see Cxl events.',
} as const;

/** Occupancy above 100% is arithmetically impossible: it means the practitioner's
 *  roster hours in Nookal are shorter than what was actually booked. Surfaced as
 *  a warning rather than rejected, so the underlying roster error stays visible. */
const OCCUPANCY_IMPOSSIBLE =
  'Above 100% — the roster/working hours for this practitioner in Nookal are wrong, not their performance.';

/** Attached to every Cancellation % so nobody acts on it before the definition
 *  is settled. See the comment at the cancellationPct assignment for the
 *  reconciliation evidence. */
const CANCELLATION_UNRECONCILED =
  'PARTLY VERIFIED — Nookal cancelled appointments ÷ Total Appts. Matches the spreadsheet exactly for some practitioners (Angus, July 2026 W1: 3/40 = 7.50%) but runs high for others, because Nookal\'s Cancelled status includes appointments that were rescheduled while the spreadsheet excludes them. Treat as an upper bound until the rescheduled exclusion is added.';

/** Higher is better, with an explicit target band. */
function zoneHigher(value: number, thriving: number, refining: number): Zone {
  if (value >= thriving) return 'thriving';
  if (value >= refining) return 'refining';
  return 'reset';
}

/** Lower is better (cancellation-style metrics). */
export function zoneLower(value: number, thriving: number, refining: number): Zone {
  if (value < thriving) return 'thriving';
  if (value <= refining) return 'refining';
  return 'reset';
}

function metric(value: number | null, zone: (v: number) => Zone): Metric {
  if (value === null || !Number.isFinite(value)) return { value: null, zone: null };
  return { value, zone: zone(value) };
}

/**
 * A real figure with no zone, for KPIs the dictionary sets no target band for.
 * Deliberately not given invented thresholds — a made-up "refining" boundary
 * would look identical to a documented one on screen.
 */
function plain(value: number | null): Metric {
  if (value === null || !Number.isFinite(value)) return { value: null, zone: null };
  return { value, zone: null };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Recommendations: dictionary says 8–12 is the target band. The upper bound is
// not penalised — more treatment-plan recommendations is not a worse outcome —
// so anything at or above 8 reads as thriving.
const zoneRecommendations = (v: number) => zoneHigher(v, 8, 6);
const zoneConversion      = (v: number) => zoneHigher(v, 6, 5);
const zoneCaseAcceptance  = (v: number) => zoneHigher(v, 80, 70);
const zoneTpDocumented    = (v: number) => zoneHigher(v, 100, 80);
// Both documented in the KPI dictionary: Occupancy >80 / >70 / <70, Cancellation
// Rates <10% / 11-15% / >15%.
const zoneOccupancy       = (v: number) => zoneHigher(v, 80, 70);
const zoneCancellation    = (v: number) => zoneLower(v, 10, 15);
// The prepay rates get NO zone. The KPI dictionary defines no bands for them —
// the Prepayment tab only states bare targets (100% offer, 80% acceptance) with
// nothing in between — so any three-way split would be invented. The targets are
// surfaced in the column tooltips instead.

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

  // Hand-entered figures, held as sum + count so one code path serves both a
  // single practitioner (n = 0 or 1) and the Team row (n = however many were
  // entered). Total Appts and NC pool by summing; Occupancy can only be meaned —
  // pooling it properly would need the roster hours behind each percentage, and
  // those are exactly what Nookal does not give us.
  apptsSum: number; apptsN: number;
  ncSum:    number; ncN:    number;
  occSum:   number; occN:   number;
  /** Nookal 'Cancelled' appointments — the Cancellation % numerator. Distinct
   *  from `cancellations`, which counts hand-logged dropout entries. */
  nookalCancelled: number; nookalCancelledN: number;
  /** Any contributing occupancy over 100%, so the Team row can flag it too. */
  occImpossible: boolean;
}

const emptyCounters = (): Counters => ({
  initials: 0, sumRecs: 0, sumBooked: 0, rowsWithRecs: 0,
  tpYes: 0, tpNo: 0, prepayOffered: 0, prepayAccepted: 0,
  cancellations: 0, churns: 0,
  apptsSum: 0, apptsN: 0, ncSum: 0, ncN: 0, occSum: 0, occN: 0,
  nookalCancelled: 0, nookalCancelledN: 0,
  occImpossible: false,
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

function addWeekInput(c: Counters, r: WeekInputRow): void {
  if (r.total_appts !== null)   { c.apptsSum += r.total_appts; c.apptsN += 1; }
  if (r.new_cases   !== null)   { c.ncSum    += r.new_cases;   c.ncN    += 1; }
  if (r.occupancy_pct !== null) {
    c.occSum += r.occupancy_pct;
    c.occN   += 1;
    if (r.occupancy_pct > 100) c.occImpossible = true;
  }
  if (r.cancelled_count !== null) {
    c.nookalCancelled  += r.cancelled_count;
    c.nookalCancelledN += 1;
  }
}

function toStats(
  clinicianId:   string,
  clinicianName: string,
  clinicId:      string | null,
  c:             Counters
): PractitionerWeekStats {
  // AVG denominator is EVERY initial consult, including those that received no
  // treatment plan (recommendations = 0).
  //
  // Verified against the spreadsheet for June 2026 Week 1: dividing by all rows
  // reproduces its Recommendations figure exactly for 8 of 10 practitioners
  // (Angus 6.67, Ben 6.17, Caitlin 3.67, Emma 7.00, Gabriella 5.67, Isabella
  // 11.00, Jervis 9.50, Noah 3.50), while excluding the zero rows does not.
  //
  // An earlier pass excluded them on the theory that Sheets' AVG skips blanks.
  // It does — but those cells hold a literal 0, not a blank, so they are in the
  // average. The KPI dictionary agrees with the sheet here: Recommendations
  // measures "how many patients are provided with clear treatment plans", so a
  // patient who got no plan should pull the figure down rather than vanish.
  // rowsWithRecs stays on the row for reference; tpDocumented is what surfaces
  // the plan rate.
  const recsAvg   = c.initials > 0 ? round2(c.sumRecs   / c.initials) : null;
  const convAvg   = c.initials > 0 ? round2(c.sumBooked / c.initials) : null;
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
    prepayOfferedPct:  plain(prepayOffPct),
    prepayAcceptedPct: plain(prepayAccPct),
    cancellations:     c.cancellations,
    churns:            c.churns,

    totalAppts: c.apptsN > 0
      ? { value: c.apptsSum, zone: null, manual: true }
      : { value: null, zone: null, manual: true, note: NOT_ENTERED.totalAppts },

    occupancy: c.occN > 0
      ? {
          // Mean, not a pooled rate — see Counters.occSum.
          value:   round2(c.occSum / c.occN),
          zone:    zoneOccupancy(c.occSum / c.occN),
          manual:  true,
          ...(c.occImpossible ? { note: OCCUPANCY_IMPOSSIBLE } : {}),
        }
      : { value: null, zone: null, manual: true, note: NOT_ENTERED.occupancy },

    newCases: c.ncN > 0
      ? { value: c.ncSum, zone: null, manual: true }
      : { value: null, zone: null, manual: true, note: NOT_ENTERED.newCases },

    // DELIBERATELY UNZONED — this figure does not yet reconcile with the
    // spreadsheet and must not drive decisions until it does.
    //
    // Checked against Isabella, June 2026 Week 1: the sheet shows 12.00% on 50
    // appts, implying a numerator of 6. The database holds 15 dropout entries for
    // her that week bucketed on date_logged, or 23 bucketed on the cancelled
    // appointment date. Neither is 6, and excluding churns leaves about 1.
    //
    // The SOP contradicts itself on what to count, which is likely the root
    // cause: step 39 says "count the cancelled patients … churns are not
    // included in this count", while its own examples say a cancelled sole
    // appointment "is both a cancellation and a churn statistic". Until Sam
    // settles that, the value is shown bare with the discrepancy attached rather
    // than dressed in a green or red zone it has not earned.
    cancellationPct: (c.nookalCancelledN > 0 && c.apptsSum > 0)
      ? {
          value: round2((c.nookalCancelled / c.apptsSum) * 100),
          zone:  null,
          note:  CANCELLATION_UNRECONCILED,
        }
      : { value: null, zone: null, note: NOT_ENTERED.cancellationPct },
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

    const [caseRows, cancelRows, clinicians, weekInputs] = await Promise.all([
      practitionerStatsRepository.caseAcceptanceByDay(dateFrom, dateTo, clinicId),
      practitionerStatsRepository.cancellationsByDay(dateFrom, dateTo, clinicId),
      practitionerStatsRepository.activeClinicians(clinicId),
      practitionerStatsRepository.weekInputsFor(year, month),
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
      // Hand-entered figures are keyed by week number, not by date — the
      // Remainder column is stored as 5.
      const wkNum = w.weekNum === 'remainder' ? 5 : w.weekNum;
      let syncedAt: string | null = null;
      for (const r of weekInputs) {
        if (r.week_num !== wkNum) continue;
        if (r.synced_at && (!syncedAt || r.synced_at > syncedAt)) syncedAt = r.synced_at;
        // A figure for a clinician outside the current clinic filter must not
        // leak into this view's Team row.
        if (!byClinician.has(r.clinician_id) && !nameOf.has(r.clinician_id)) continue;
        addWeekInput(bump(r.clinician_id), r);
        addWeekInput(teamTotals, r);
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
        syncedAt,
      };
    });

    return {
      year,
      month,
      clinicId,
      // No `notes` array. Every caveat that used to live in a wall of text under
      // the table is now attached to the thing it describes — the column tooltip
      // or the cell's own `note` — so it is read at the moment it matters instead
      // of being scrolled past.
      weeks: outWeeks,
    };
  },
};
