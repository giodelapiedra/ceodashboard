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
   * True for the figures a person can type in — Total Appts, Occupancy, NC, plus
   * Cancellation % which is derived from one of them. Lets the UI mark them and
   * offer editing. On Occupancy it means more than "editable": it says this
   * particular figure IS somebody's own entry rather than the sync's, which is
   * the difference between a number to trust and a number to check.
   */
  manual?: boolean;
  /** Why the cell is blank, or a warning about the value that is there. */
  note?: string;
  /**
   * Neutral explanation of how the figure was arrived at — the hours behind a
   * synced occupancy, for instance. Separate from `note` because the UI paints
   * anything with a note as a warning, and "18.5h booked of 24.0h bookable" is
   * not a warning; it is the number's working, which is what makes it checkable
   * against Nookal.
   */
  detail?: string;
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

  /** Total Appts and NC come from the appointment feed; Occupancy from the diary
   *  (migration 029). All three remain hand-editable — see Metric.manual. */
  totalAppts: Metric;
  occupancy:  Metric;
  newCases:   Metric;
  /** Computed: churns (no future booking) ÷ hand-entered Total Appts. */
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

// Sam confirmed (2026-08-04) that Total Appts, Occupancy and NC could not be
// pulled from Nookal, and they were typed into the app instead of the
// spreadsheet. All three have since been found in the API — Total Appts and NC in
// the appointment feed (migration 026), Occupancy in `availabilities`
// (migration 029) — so these notes now describe what a BLANK cell means and
// where to go if the sync could not fill it, not a permanent limitation.
const NOT_ENTERED = {
  totalAppts:
    'Not entered yet. Nookal → Reports → Providers & Practice → Completed Consults (SOP steps 7-11). No API path exists to this figure.',
  newCases:
    'Not entered yet. Same Providers & Practice report → New Cases (SOP steps 12-14).',
  occupancy:
    'Not filled yet. Occupancy is Occupied ÷ Scheduled Minutes, where Scheduled Minutes is ROSTERED time. Two ways to get it: run db:sync:occupancy, which reads the roster straight from the Nookal v2 API (accurate only while the week is fresh — the Nookal roster moves on, so this is meant to run weekly); or for an older week, Nookal → Reports → Occupancy, set the date range to this week, Locations = All Locations, press Export, then run db:import:occupancy. Typing it in by hand still beats both and is never overwritten.',
  cancellationPct:
    'Needs Total Appts as its denominator. The numerator is already computed — see Cxl events.',
} as const;

/** Occupancy above 100% is arithmetically impossible: it means the practitioner's
 *  roster hours in Nookal are shorter than what was actually booked. Surfaced as
 *  a warning rather than rejected, so the underlying roster error stays visible. */
const OCCUPANCY_IMPOSSIBLE =
  'Above 100% — more time was booked than the practitioner is rostered for. Nookal shows this too (its 03/08/2026 report has Gabriella at 102.17%, 1410 minutes booked against 1380 rostered), so it is normally a roster that needs correcting in Nookal rather than a performance reading. Note the diary-derived figure cannot exceed 100 at all: it divides by booked + still-bookable.';

/** Nookal prints 100% when a practitioner has zero rostered minutes but booked
 *  time anyway. That is a missing roster, not a full diary. */
const OCCUPANCY_NO_ROSTER =
  'No rostered hours in Nookal for this week, yet time was booked — so the percentage is meaningless. Nookal shows 100% here for the same reason. Fix the roster in Nookal, then re-import.';

/** A row mixing Nookal-computed and hand-typed weeks. The two are not measured
 *  the same way, so the roll-up falls back to a mean of percentages and says so
 *  rather than presenting it as one pooled rate. */
const OCCUPANCY_MIXED =
  'Mixed sources — some weeks were computed from the Nookal diary and some typed in by hand, so this is an average of percentages rather than a pooled rate.';

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
  /** Cancellation % numerator — a subset of churns. See
   *  CancellationDayRow.cancellation_dropouts for which statuses and why. */
  cxlDropouts:     number;

  // Hand-entered figures, held as sum + count so one code path serves both a
  // single practitioner (n = 0 or 1) and the Team row (n = however many were
  // entered). Total Appts and NC pool by summing.
  apptsSum: number; apptsN: number;
  ncSum:    number; ncN:    number;
  occSum:   number; occN:   number;

  // Occupancy pools properly whenever the sync supplied the minutes behind the
  // percentage (migration 029): SUM(booked) ÷ SUM(booked + available). Averaging
  // percentages — all migration 024 could do — weights a practitioner with four
  // rostered hours the same as one with thirty-five. occSum/occN above is still
  // the fallback for weeks a person typed in, where no minutes exist.
  occBookedMinutes:    number;
  occAvailableMinutes: number;
  occBlockedMinutes:   number;
  /**
   * Denominator minutes, which are NOT always booked + available.
   *
   * A week imported from Nookal's own Occupancy report divides by ROSTERED
   * minutes (its "Scheduled Minutes"), which is a different and larger quantity
   * than booked + still-bookable — blocked-out time sits inside the roster.
   * Accumulating the denominator each row actually used is what lets report
   * weeks and derived weeks pool together without silently mixing two rates.
   */
  occDenomMinutes:     number;
  /** Contributing weeks by who owns the figure. Counted separately so a mixed
   *  row can say so instead of picking a side. */
  occManualN: number;
  occSyncedN: number;
  /** Weeks whose figure is the exact one off Nookal's Occupancy report. */
  occReportN: number;
  /** Weeks computed from the Nookal v2 API on the report's own formula
   *  (migration 031). Pooled the same way as occReportN, counted apart only so
   *  the cell's working can name where the minutes came from. */
  occApiN: number;
  /** Any contributing occupancy over 100%, so the Team row can flag it too. */
  occImpossible: boolean;
}

const emptyCounters = (): Counters => ({
  initials: 0, sumRecs: 0, sumBooked: 0, rowsWithRecs: 0,
  tpYes: 0, tpNo: 0, prepayOffered: 0, prepayAccepted: 0,
  cancellations: 0, churns: 0, cxlDropouts: 0,
  apptsSum: 0, apptsN: 0, ncSum: 0, ncN: 0, occSum: 0, occN: 0,
  occBookedMinutes: 0, occAvailableMinutes: 0, occBlockedMinutes: 0, occDenomMinutes: 0,
  occManualN: 0, occSyncedN: 0, occReportN: 0, occApiN: 0,
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
  c.cxlDropouts   += r.cancellation_dropouts;
}

function addWeekInput(c: Counters, r: WeekInputRow): void {
  if (r.total_appts !== null)   { c.apptsSum += r.total_appts; c.apptsN += 1; }
  if (r.new_cases   !== null)   { c.ncSum    += r.new_cases;   c.ncN    += 1; }
  if (r.occupancy_pct !== null) {
    // Diary-derived by the abandoned migration-029 sync. Dropped on the floor
    // deliberately: Sam's call 2026-08-20, after it read up to 23 points high
    // against Nookal's own report and flipped 5 of 11 practitioners into the
    // wrong zone. Rows like this only exist if a build that wrote them ever ran;
    // nothing writes them now.
    //
    // This test comes BEFORE the counters on purpose. Behind the branch below it
    // still incremented occSum and occN first, so a 'nookal' row was never
    // actually dropped — it went on polluting the mean-of-percentages fallback
    // and, on a board with no minutes to pool, WAS the figure shown.
    if (r.occupancy_source === 'nookal') return;

    c.occSum += r.occupancy_pct;
    c.occN   += 1;
    if (r.occupancy_pct > 100) c.occImpossible = true;

    // A NULL source on a row with a value predates migration 029, and every one
    // of those was typed in by hand — so it counts as manual, not as unknown.
    if (r.occupancy_source === 'nookal_report' || r.occupancy_source === 'nookal_api') {
      if (r.occupancy_source === 'nookal_report') c.occReportN += 1; else c.occApiN += 1;
      c.occSyncedN += 1;
      c.occBookedMinutes += r.occupancy_booked_minutes ?? 0;
      // Nookal's own denominator: rostered minutes less breaks, not booked +
      // free. The API path (migration 031) computes exactly the same quantity
      // from getSchedules, so the two pool together honestly.
      c.occDenomMinutes  += r.occupancy_scheduled_minutes ?? 0;
      c.occBlockedMinutes += r.occupancy_blocked_minutes ?? 0;
    } else {
      c.occManualN += 1;
    }
  }
}

/**
 * Occupancy, pooled from minutes where the sync supplied them.
 *
 * Three cases, in order:
 *
 *  1. Every contributing week came from Nookal — pool the minutes. On a single
 *     practitioner-week this is just booked ÷ (booked + available) again, so the
 *     figure the row shows and the figure stored agree exactly. On a Team row or
 *     a multi-week roll-up it is the honest weighted rate.
 *  2. Some weeks are hand-typed — fall back to the mean of the percentages,
 *     because a typed-in percentage carries no minutes to pool, and flag the
 *     mixture rather than pretend the result is one clean measure.
 *  3. Nothing at all — blank, with the note explaining where it comes from.
 *
 * `manual` stays true whenever any contributing week is a person's own figure,
 * so the UI keeps offering the edit box for exactly those cells.
 */
function occupancyMetric(c: Counters): Metric {
  if (c.occN === 0) {
    return { value: null, zone: null, manual: true, note: NOT_ENTERED.occupancy };
  }

  // Whatever denominator each contributing week actually used — rostered
  // minutes for report weeks, booked + bookable for derived ones.
  const denominator = c.occDenomMinutes;
  const pooled      = c.occManualN === 0 && denominator > 0;

  const value = pooled
    ? round2((c.occBookedMinutes / denominator) * 100)
    : round2(c.occSum / c.occN);

  const notes: string[] = [];
  if (c.occImpossible) notes.push(OCCUPANCY_IMPOSSIBLE);
  // Genuinely mixed only when BOTH kinds contribute. Keying this off `pooled`
  // instead would also fire on a lone week with zero rostered minutes, where
  // nothing is mixed at all.
  if (c.occManualN > 0 && c.occSyncedN > 0) notes.push(OCCUPANCY_MIXED);

  // The working, so the figure can be checked against Nookal without opening
  // the database. Blocked time is named too, because it is deliberately outside
  // the denominator and that is the first thing to query about the number.
  const hrs = (m: number) => (m / 60).toFixed(1);
  const hand = c.occManualN > 0 ? ` · ${c.occManualN} week(s) hand-entered` : '';

  let detail: string | undefined;
  // Both machine sources divide by the same thing — rostered minutes less
  // breaks — so the working reads the same either way, and only the provenance
  // line differs. Occupied ÷ Scheduled is the report's own formula.
  const rostered = `${hrs(c.occBookedMinutes)}h occupied of ${hrs(c.occDenomMinutes)}h rostered (Scheduled Minutes)`;
  const breaks   = c.occBlockedMinutes > 0 ? ` — ${hrs(c.occBlockedMinutes)}h of rostered breaks already excluded` : '';

  if (c.occSyncedN > 0 && c.occReportN === c.occSyncedN) {
    // Straight off Nookal's Occupancy report, so name its own two columns —
    // those are what someone re-running the report will be looking at.
    detail = `Nookal Occupancy report: ${rostered}${hand}`;
  } else if (c.occSyncedN > 0 && c.occApiN === c.occSyncedN) {
    detail = `Nookal API, the report's own formula: ${rostered}${breaks}${hand}`;
  } else if (c.occSyncedN > 0) {
    detail = `${c.occReportN} week(s) off the Nookal Occupancy report and `
           + `${c.occApiN} from the Nookal API, same formula — ${rostered}${hand}`;
  }

  // Rostered time of zero with time booked is what Nookal shows as 100%. It is a
  // roster gap, not a full diary, and must not read as a perfect score.
  if (c.occSyncedN > 0 && c.occDenomMinutes === 0 && c.occBookedMinutes > 0) {
    notes.push(OCCUPANCY_NO_ROSTER);
  }

  return {
    value,
    zone:   zoneOccupancy(value),
    manual: c.occManualN > 0,
    ...(notes.length  ? { note: notes.join(' ') } : {}),
    ...(detail        ? { detail } : {}),
  };
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

    occupancy: occupancyMetric(c),

    newCases: c.ncN > 0
      ? { value: c.ncSum, zone: null, manual: true }
      : { value: null, zone: null, manual: true, note: NOT_ENTERED.newCases },

    // Sam settled the definition 2026-08-20: patients left with NO FUTURE
    // BOOKING, divided by Total Appts.
    //
    // The numerator is 'No Future Bookings' + 'Cancelled - not rescheduled',
    // NOT the full churn set. A 'Completed Treatment Plan' also leaves no future
    // booking, but the patient finished their course of care — counting that as
    // a cancellation would mark a practitioner down for doing the job right.
    // Sam picked this reading explicitly over the wider one (June 2026 W1,
    // practice-wide: 22.4% here against 24.4% with completed plans folded in).
    //
    // Counted per PATIENT, not per cancelled appointment: three cancellations by
    // one patient who then left is one drop-off. And not Nookal's 'Cancelled'
    // appointment status, which over-counts because it includes appointments
    // that were merely rescheduled.
    cancellationPct: c.apptsSum > 0
      ? metric(round2((c.cxlDropouts / c.apptsSum) * 100), zoneCancellation)
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
