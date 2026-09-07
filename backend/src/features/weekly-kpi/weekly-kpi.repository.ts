import { query, withTransaction } from '../../db/pool';
import { getWeekRanges } from '../../services/week.calculator';
import { RatingMap, SIGNALS, SignalRating } from './weekly-kpi.model';

/** One of the three KPI rows on the Monday half. */
export interface KpiLine {
  name:   string | null;
  target: string | null;
  result: string | null;
  /** focus_kpis[].hit — null means "not answered", not "missed". */
  hit:    boolean | null;
}

/** The nine self-reported weekly counts (migration 034). None of them affect
 *  the score; five of them have an authoritative source elsewhere in the
 *  database — see the migration's header before building on them. */
export interface WeeklyCounts {
  initials_seen:         number | null;
  recommendations_full:  number | null;
  plans_accepted_full:   number | null;
  plans_accepted_part:   number | null;
  dropouts_contacted:    number | null;
  consults_recorded:     number | null;
  calls_due:             number | null;
  calls_made:            number | null;
  cancellations_noshows: number | null;
}

/** The persisted score snapshot (migration 034). Every field is null on a row
 *  submitted before the signal model existed. */
export interface EffectivenessSnapshot {
  effectiveness_score: number | null;
  group_pcts:          Record<string, number | null>;
  standards_missed:    number | null;
  standards_na:        number | null;
  na_count:            number | null;
  band_id:             string | null;
  model_version:       string | null;
  is_incomplete:       boolean;
}

export interface WeeklyKpiDTO {
  id:             string;
  clinician_id:   string;
  clinician_name: string | null;
  clinic_id:      string;
  week_start:     string;   // YYYY-MM-DD (Monday)
  week_end:       string;   // YYYY-MM-DD (Sunday) — derived, never stored

  // Monday half
  kpis:                 [KpiLine, KpiLine, KpiLine];
  missed_goal_actions:  string | null;
  /** Whole-number 1-10 display score. Hand-picked before migration 034; from
   *  034 on it is ROUND(effectiveness_score), so the tracker, the team averages
   *  and the Excel export keep reading one column across both eras. NULL until
   *  the Friday half is submitted (migration 035 moved Effectiveness to
   *  Friday) — except on rows submitted before that migration. */
  effectiveness_rating: number | null;
  /** NULL until Friday, same reason as effectiveness_rating — see above. */
  mojo_rating:          number | null;
  /** Migration 035: multi-select. 'none' ("No drain") is exclusive. */
  mojo_drain:           string[] | null;
  mojo_action:          string | null;
  intention:            string;
  case_to_discuss:      string | null;
  help_needed:          string | null;
  checkin_needed:       boolean;
  checkin_focus:        string | null;
  monday_submitted_at:  string;

  /** The Weekly Check-In score snapshot. Null throughout for pre-034 rows. */
  effectiveness: EffectivenessSnapshot;
  counts:        WeeklyCounts;

  /** The thirty raw ratings. Only loaded for a SINGLE report (findById /
   *  findByPersonWeek) — a tracker listing would need one query per row for
   *  something no list view shows, so lists leave this undefined. Undefined is
   *  "not asked for"; an empty object is "asked for, and there are none". */
  signals?: RatingMap;

  // Friday half — null until the loop is closed.
  wins:                string | null;
  goal_achieved:       boolean | null;
  goal_reflection:     string | null;
  flag_for_sam:        string | null;
  best_behaviour:      string | null;
  slipped:             string | null;
  commitment:          string | null;
  friday_submitted_at: string | null;

  created_at: string;
  updated_at: string;

  // ── Comment thread (migration 033) ──────────────────────────────────────
  // Filled in by the service, not by the SQL above: the counts depend on WHO
  // is asking (unread is per viewer), and threading that through every query
  // in this file would put the caller's identity into the row reader. Absent
  // means "not asked for", which is different from zero.
  comment_count?: number;
  unread_count?:  number;
}

interface WeeklyKpiJoinedRow {
  id:                    string;
  clinician_id:          string;
  clinician_name:        string | null;
  clinic_id:             string;
  week_start:            Date;
  kpi1_name:             string | null;
  kpi1_target:           string | null;
  kpi1_result:           string | null;
  kpi2_name:             string | null;
  kpi2_target:           string | null;
  kpi2_result:           string | null;
  kpi3_name:             string | null;
  kpi3_target:           string | null;
  kpi3_result:           string | null;
  kpi1_hit:              boolean | null;
  kpi2_hit:              boolean | null;
  kpi3_hit:              boolean | null;
  missed_goal_actions:   string | null;
  effectiveness_rating:  number | null;
  mojo_rating:           number | null;
  mojo_drain:            string[] | null;
  mojo_action:           string | null;
  intention:             string;
  case_to_discuss:       string | null;
  help_needed:           string | null;
  checkin_needed:        boolean;
  checkin_focus:         string | null;
  monday_submitted_at:   Date;
  wins:                  string | null;
  goal_achieved:         boolean | null;
  goal_reflection:       string | null;
  flag_for_sam:          string | null;
  best_behaviour:        string | null;
  slipped:               string | null;
  commitment:            string | null;
  friday_submitted_at:   Date | null;
  created_at:            Date;
  updated_at:            Date;

  // ── Migration 034: the persisted score snapshot ───────────────────────────
  // NUMERIC comes back from node-postgres as a STRING (it does not fit a JS
  // number safely in the general case), so every one of these is normalised
  // through Number() in toDTO rather than being handed to the client as "8.4".
  effectiveness_score:   string | number | null;
  group_pct_g1:          string | number | null;
  group_pct_g2:          string | number | null;
  group_pct_g3:          string | number | null;
  group_pct_g4:          string | number | null;
  group_pct_g5:          string | number | null;
  standards_missed:      number | null;
  standards_na:          number | null;
  na_count:              number | null;
  band_id:               string | null;
  model_version:         string | null;
  is_incomplete:         boolean;

  initials_seen:         number | null;
  recommendations_full:  number | null;
  plans_accepted_full:   number | null;
  plans_accepted_part:   number | null;
  dropouts_contacted:    number | null;
  consults_recorded:     number | null;
  calls_due:             number | null;
  calls_made:            number | null;
  cancellations_noshows: number | null;
}

/** NUMERIC -> number, keeping NULL as null. `Number(null)` is 0, which would
 *  turn "this row was never scored" into a real zero on the tracker. */
function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** pg hands back a DATE column as a JS Date at LOCAL midnight, so toISOString()
 *  can roll back a day east of UTC. Read the local parts instead. */
function isoDateOnly(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function sundayAfter(mondayISO: string): string {
  const d = new Date(`${mondayISO}T12:00:00`);
  d.setDate(d.getDate() + 6);
  return isoDateOnly(d);
}

function toDTO(r: WeeklyKpiJoinedRow): WeeklyKpiDTO {
  const week_start = isoDateOnly(r.week_start);
  return {
    id:             r.id,
    clinician_id:   r.clinician_id,
    clinician_name: r.clinician_name,
    clinic_id:      r.clinic_id,
    week_start,
    week_end:       sundayAfter(week_start),

    kpis: [
      { name: r.kpi1_name, target: r.kpi1_target, result: r.kpi1_result, hit: r.kpi1_hit },
      { name: r.kpi2_name, target: r.kpi2_target, result: r.kpi2_result, hit: r.kpi2_hit },
      { name: r.kpi3_name, target: r.kpi3_target, result: r.kpi3_result, hit: r.kpi3_hit },
    ],
    missed_goal_actions:  r.missed_goal_actions,
    // SMALLINT comes back as a JS number already, but a driver/type change
    // shouldn't be able to leak a string into the tracker's sort. Null stays
    // null rather than becoming Number(null) === 0 — a week not yet rated on
    // Friday must not read as a real zero.
    effectiveness_rating: num(r.effectiveness_rating),
    mojo_rating:          num(r.mojo_rating),
    mojo_drain:           r.mojo_drain,
    mojo_action:          r.mojo_action,
    intention:            r.intention,
    case_to_discuss:      r.case_to_discuss,
    help_needed:          r.help_needed,
    checkin_needed:       r.checkin_needed,
    checkin_focus:        r.checkin_focus,
    monday_submitted_at:  r.monday_submitted_at.toISOString(),

    effectiveness: {
      effectiveness_score: num(r.effectiveness_score),
      group_pcts: {
        G1: num(r.group_pct_g1),
        G2: num(r.group_pct_g2),
        G3: num(r.group_pct_g3),
        G4: num(r.group_pct_g4),
        G5: num(r.group_pct_g5),
      },
      standards_missed: r.standards_missed,
      standards_na:     r.standards_na,
      na_count:         r.na_count,
      band_id:          r.band_id,
      model_version:    r.model_version,
      is_incomplete:    r.is_incomplete ?? false,
    },

    counts: {
      initials_seen:         r.initials_seen,
      recommendations_full:  r.recommendations_full,
      plans_accepted_full:   r.plans_accepted_full,
      plans_accepted_part:   r.plans_accepted_part,
      dropouts_contacted:    r.dropouts_contacted,
      consults_recorded:     r.consults_recorded,
      calls_due:             r.calls_due,
      calls_made:            r.calls_made,
      cancellations_noshows: r.cancellations_noshows,
    },

    wins:                r.wins,
    goal_achieved:       r.goal_achieved,
    goal_reflection:     r.goal_reflection,
    flag_for_sam:        r.flag_for_sam,
    best_behaviour:      r.best_behaviour,
    slipped:             r.slipped,
    commitment:          r.commitment,
    friday_submitted_at: r.friday_submitted_at?.toISOString() ?? null,

    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

const SELECT_JOINED = `
  SELECT w.*, u.full_name AS clinician_name
    FROM weekly_kpi_reports w
    LEFT JOIN users u ON u.id = w.clinician_id
`;

export interface MondayInput {
  clinician_id:         string;
  clinic_id:            string;
  week_start:           string;
  kpis:                 KpiLine[];
  missed_goal_actions:  string | null;
  intention:            string;
  case_to_discuss:      string | null;
  help_needed:          string | null;
  checkin_needed:       boolean;
  checkin_focus:        string | null;
  counts:               WeeklyCounts;
}

export interface FridayInput {
  wins:            string | null;
  goal_achieved:   boolean;
  goal_reflection: string | null;
  flag_for_sam:    string | null;
  best_behaviour:  string | null;
  slipped:         string | null;
  commitment:      string | null;

  /** Derived by the service from `signals`, never sent by the client. */
  effectiveness_rating: number;
  mojo_rating:          number;

  /** Mojo question 2 — 'What kind of drain/s was it?'. Moved here from Monday
   *  2026-09-07: the drain and the rating describe the same week, so they are
   *  answered together at its close. */
  mojo_drain:           string[] | null;
  /** Mojo question 3 — 'one thing you will do next week, and when'. */
  mojo_action:          string | null;

  /** The thirty raw ratings. Written to weekly_kpi_signal_ratings inside the
   *  same transaction as the row itself. */
  signals:       RatingMap;
  effectiveness: EffectivenessSnapshot;
}

export interface TrackerFilters {
  week_start:     string;
  clinic_id?:     string;
  /** Spec section 8's optional second view: only rows asking for a check-in. */
  checkin_only?:  boolean;
  /** Only rows whose Friday half is still open. */
  open_only?:     boolean;
}

/** A clinician on the roster who has NOT submitted for the tracker's week.
 *  The spec's tracker shows who reported; Sam also needs who didn't. */
export interface MissingClinician {
  clinician_id: string;
  full_name:    string | null;
  clinic_id:    string | null;
}

/** "4 of 10 submitted" — the counts behind the Teams alert on every submit.
 *  `expected` is the same roster `missingForWeek` measures against, so the two
 *  can never disagree about who was supposed to fill the form in. */
export interface WeekProgress {
  /** Clinicians with a row for the week (Monday half done). */
  submitted:     number;
  /** Of those, how many have also closed their Friday half. */
  friday_closed: number;
  /** Roster size — active, picker-visible clinicians. */
  expected:      number;
}

/**
 * Who the weekly KPI form is expected FROM — the roster, in SQL.
 *
 * show_in_picker = false is excluded on purpose: that flag (migration 018)
 * marks ex-physios like Jesse and Tim whose accounts stay active so their
 * historical data keeps counting. Listing them as "did not submit" every
 * single week would be permanent noise. Same reason `also_clinician` admin
 * accounts are not counted — the spec puts Sam on the viewing side.
 *
 * One constant, two readers (missingForWeek and progressForWeek), because the
 * denominator in "4 of 10 submitted" and the names under "Not submitted" have
 * to be the same ten people. Assumes the users table is aliased `u`.
 */
const ROSTER_CLINICIAN = `u.role = 'CLINICIAN' AND u.is_active = true AND u.show_in_picker = true`;

export const PAGE_LIMIT_DEFAULT = 26;   // ~6 months of weeks
export const PAGE_LIMIT_MAX     = 200;

/**
 * The Cancellation % numerator: EVERY Patient Dropout Tracking entry for the
 * clinician that week except 'Completed Treatment Plan'.
 *
 * Sam, 2026-09-07: "Patient Dropout Tracking ng clinician Total entries pero
 * hindi kasama Completed Treatment Plan status ... divided by Total Appts".
 * Finishing a course of care is a success, so it is the one status left out;
 * everything else the front desk logged counts, INCLUDING 'Re-scheduled'
 * (which the earlier, narrower reading excluded because the patient still has
 * a booking). Kept in step with practitioner-stats.repository's
 * CANCELLATION_STATUSES — the same figure must not read two ways.
 *
 * Counted per ENTRY on date_logged - the day the entry was made, the same day
 * the Patient Dropout Tracking list is filtered by - not on a cancelled date.
 * Same rule as practitioner-stats' cancellation_dropouts, so the KPI form and
 * the board cannot disagree.
 *
 * Queried directly here rather than through practitioner-stats.repository's
 * cancellationsByDay: that module has known drift between this codebase and
 * what is actually deployed on prod (see [[project_occupancy_nookal]] /
 * deployment_ubuntu.md — prod's copy predates the 'cancellation_dropouts'
 * split), so the auto-fill KPI boxes would 500 there. This one query has no
 * shared-file dependency to drift.
 */
const CANCELLATION_DROPOUT_STATUSES = [
  'Cancelled - not rescheduled',
  'No Future Bookings',
  'Re-scheduled',
];

export const weeklyKpiRepository = {
  /**
   * The thirty raw ratings for one report, as the map the model scores.
   *
   * A signal with no row is left OUT of the map rather than set to null. Both
   * read as N/A to `scoreSignals`, but only the absent one is honestly "never
   * answered" — which is what lets the service log a short payload as the
   * client bug section 5 says it is.
   */
  async signalsFor(reportId: string): Promise<RatingMap> {
    const { rows } = await query<{ signal_id: string; rating: number | null }>(
      `SELECT signal_id, rating FROM weekly_kpi_signal_ratings
        WHERE report_id = $1`,
      [reportId]
    );
    const map: RatingMap = {};
    for (const r of rows) {
      map[r.signal_id] = (r.rating === null ? null : Number(r.rating)) as SignalRating;
    }
    return map;
  },

  async findByPersonWeek(clinicianId: string, weekStart: string): Promise<WeeklyKpiDTO | null> {
    const { rows } = await query<WeeklyKpiJoinedRow>(
      `${SELECT_JOINED} WHERE w.clinician_id = $1 AND w.week_start = $2::date LIMIT 1`,
      [clinicianId, weekStart]
    );
    if (!rows[0]) return null;
    const dto = toDTO(rows[0]);
    // Single-report read, so the extra query is one query, not one per row.
    dto.signals = await this.signalsFor(dto.id);
    return dto;
  },

  /**
   * One report by id.
   *
   * The thirty raw ratings are OPT-IN. Most callers of this method are not
   * rendering the form: the comment thread's participant check runs on every
   * comment read, post and mark-as-read, and the delete path only needs the row
   * to write an audit entry. Loading thirty rows none of them look at would put
   * a second query on the busiest path in the feature.
   *
   * `withSignals` is therefore false by default, and the two callers that
   * actually show a form or a full report ask for them explicitly. When it is
   * false, `dto.signals` stays undefined — which is already documented as "not
   * asked for", distinct from "asked for and empty".
   */
  async findById(id: string, opts: { withSignals?: boolean } = {}): Promise<WeeklyKpiDTO | null> {
    const { rows } = await query<WeeklyKpiJoinedRow>(
      `${SELECT_JOINED} WHERE w.id = $1 LIMIT 1`,
      [id]
    );
    if (!rows[0]) return null;
    const dto = toDTO(rows[0]);
    if (opts.withSignals) dto.signals = await this.signalsFor(dto.id);
    return dto;
  },

  /** One clinician's history, newest week first. */
  async listForClinician(
    clinicianId: string,
    limit:  number,
    offset: number
  ): Promise<WeeklyKpiDTO[]> {
    const { rows } = await query<WeeklyKpiJoinedRow>(
      `${SELECT_JOINED}
        WHERE w.clinician_id = $1
        ORDER BY w.week_start DESC
        LIMIT $2 OFFSET $3`,
      [clinicianId, limit, offset]
    );
    return rows.map(toDTO);
  },

  async countForClinician(clinicianId: string): Promise<number> {
    const { rows } = await query<{ total: string }>(
      `SELECT COUNT(*)::bigint AS total FROM weekly_kpi_reports WHERE clinician_id = $1`,
      [clinicianId]
    );
    return Number(rows[0]?.total ?? 0);
  },

  /** The shared tracker: every submission for one week. */
  async tracker(filters: TrackerFilters): Promise<WeeklyKpiDTO[]> {
    const params: unknown[] = [filters.week_start];
    const where: string[]   = ['w.week_start = $1::date'];

    if (filters.clinic_id) {
      params.push(filters.clinic_id);
      where.push(`w.clinic_id = $${params.length}`);
    }
    if (filters.checkin_only) where.push('w.checkin_needed = true');
    if (filters.open_only)    where.push('w.friday_submitted_at IS NULL');

    const { rows } = await query<WeeklyKpiJoinedRow>(
      `${SELECT_JOINED}
        WHERE ${where.join(' AND ')}
        ORDER BY w.clinic_id ASC, u.full_name ASC NULLS LAST`,
      params
    );
    return rows.map(toDTO);
  },

  /**
   * Roster clinicians with nothing recorded for `weekStart`.
   *
   * Who counts as "on the roster" is ROSTER_CLINICIAN — see the note there.
   */
  async missingForWeek(weekStart: string, clinicId?: string): Promise<MissingClinician[]> {
    const params: unknown[] = [weekStart];
    const where: string[] = [
      ROSTER_CLINICIAN,
      `NOT EXISTS (
         SELECT 1 FROM weekly_kpi_reports w
          WHERE w.clinician_id = u.id AND w.week_start = $1::date
       )`,
    ];
    if (clinicId) {
      params.push(clinicId);
      where.push(`u.clinic_id = $${params.length}`);
    }

    const { rows } = await query<{ id: string; full_name: string | null; clinic_id: string | null }>(
      `SELECT u.id, u.full_name, u.clinic_id
         FROM users u
        WHERE ${where.join(' AND ')}
        ORDER BY u.clinic_id ASC NULLS LAST, u.full_name ASC NULLS LAST`,
      params
    );
    return rows.map(r => ({ clinician_id: r.id, full_name: r.full_name, clinic_id: r.clinic_id }));
  },

  /**
   * How far the week has got: submitted / Friday-closed / roster size.
   *
   * The roster half is ROSTER_CLINICIAN, the same predicate `missingForWeek`
   * measures against, so "4 of 10 submitted" and the tracker's Not-yet-
   * submitted list are always two views of the same ten people.
   *
   * `expected` is floored at `submitted` for the edge case where someone
   * submitted and was later hidden from the picker or deactivated — the alert
   * must never read "11 of 10".
   */
  async progressForWeek(weekStart: string): Promise<WeekProgress> {
    const { rows } = await query<{ submitted: string; friday_closed: string; roster: string }>(
      `SELECT
         (SELECT COUNT(*) FROM weekly_kpi_reports w
           WHERE w.week_start = $1::date)                       AS submitted,
         (SELECT COUNT(*) FROM weekly_kpi_reports w
           WHERE w.week_start = $1::date
             AND w.friday_submitted_at IS NOT NULL)             AS friday_closed,
         (SELECT COUNT(*) FROM users u
           WHERE ${ROSTER_CLINICIAN})                           AS roster`,
      [weekStart]
    );
    const submitted     = Number(rows[0]?.submitted ?? 0);
    const friday_closed = Number(rows[0]?.friday_closed ?? 0);
    const roster        = Number(rows[0]?.roster ?? 0);
    return { submitted, friday_closed, expected: Math.max(roster, submitted) };
  },

  /** Weeks that have at least one submission, newest first — the tracker's
   *  week picker, so Sam is never offered an empty week. */
  async weeksWithData(limit: number): Promise<string[]> {
    const { rows } = await query<{ week_start: Date }>(
      `SELECT DISTINCT week_start FROM weekly_kpi_reports
        ORDER BY week_start DESC LIMIT $1`,
      [limit]
    );
    return rows.map(r => isoDateOnly(r.week_start));
  },

  /**
   * One physio's own past weeks whose Friday half was never submitted, newest
   * first. Drives the reminder on their form (2026-09-07).
   *
   * Deliberately NOT a gate. Sam asked whether a physio should be blocked from
   * filling Monday until the previous week is closed; that would deadlock them,
   * because a past week is frozen (isCurrentWeek) and so can no longer be
   * closed at all — they could neither finish the old week nor start the new
   * one. It would also cost the tracker the new week's data to punish the old
   * week's omission. So this only tells them, and the tracker's open_only
   * filter tells Sam.
   *
   * Strictly BEFORE the current week: the week in progress is not late yet.
   */
  async openWeeksBefore(clinicianId: string, weekStart: string): Promise<string[]> {
    const { rows } = await query<{ week_start: Date }>(
      `SELECT week_start FROM weekly_kpi_reports
        WHERE clinician_id = $1
          AND week_start < $2::date
          AND friday_submitted_at IS NULL
        ORDER BY week_start DESC`,
      [clinicianId, weekStart]
    );
    return rows.map(r => isoDateOnly(r.week_start));
  },

  /**
   * The commitment this physio made on the most recent Friday BEFORE the week
   * being viewed — "What are you committing to next week?" — carried forward so
   * the next Monday's "Intentions for the week" box opens with it already in
   * (Sam, 2026-09-07).
   *
   * The newest earlier week that actually HAS one, not strictly last week: a
   * physio who missed a week should still see the last thing they committed to
   * rather than an empty box. The week it came from comes back with it, so the
   * form can say which Friday wrote it — an old commitment shown as this week's
   * own would be worse than none.
   *
   * Read-only, and never written back on its own: what Monday stores is
   * whatever is in the box when the physio submits it, edited or not.
   */
  async lastCommitmentBefore(
    clinicianId: string,
    weekStart: string
  ): Promise<{ week_start: string; commitment: string } | null> {
    const { rows } = await query<{ week_start: Date; commitment: string }>(
      `SELECT week_start, commitment FROM weekly_kpi_reports
        WHERE clinician_id = $1
          AND week_start < $2::date
          AND commitment IS NOT NULL
          AND btrim(commitment) <> ''
        ORDER BY week_start DESC
        LIMIT 1`,
      [clinicianId, weekStart]
    );
    if (!rows[0]) return null;
    return { week_start: isoDateOnly(rows[0].week_start), commitment: rows[0].commitment };
  },

  /**
   * Count of cancellation/no-show drop-offs for one clinician over a date
   * range — the auto-filled "Cancellation" KPI box. See
   * CANCELLATION_DROPOUT_STATUSES above for exactly which statuses count and
   * why this is not borrowed from practitioner-stats.repository.
   *
   * Bucketed on the LAST cancelled-appointment date, falling back to
   * date_logged when none was recorded — identical logic to
   * practitioner-stats' own churn query, just scoped to one clinician and
   * summed rather than grouped per day.
   */
  async cancellationDropoutCount(
    clinicianId: string,
    dateFrom:    string,
    dateTo:      string,
  ): Promise<number> {
    const { rows } = await query<{ n: string }>(
      `SELECT COUNT(*)::bigint AS n
         FROM patient_dropouts d
        WHERE d.clinician_id = $1
          AND d.status = ANY($2::text[])
          AND d.date_logged >= $3::date
          AND d.date_logged <= $4::date`,
      [clinicianId, CANCELLATION_DROPOUT_STATUSES, dateFrom, dateTo]
    );
    return Number(rows[0]?.n ?? 0);
  },

  /**
   * The Cancellation % DENOMINATOR: this clinician's Total Appts for the week —
   * Nookal Completed Consults, written by the Practitioner Stats sync
   * (practitioner-stats.nookal.ts) into practitioner_week_inputs.
   *
   * Sam, 2026-09-07: Cancellation % = dropout entries ÷ Total Appts. That
   * figure only exists on the CEO's month/week grid (year, month, week_num),
   * so an arbitrary Mon-Sun KPI week has to be matched onto it. Matched by
   * OVERLAP, taking the grid week that shares the most days with the KPI week,
   * and only when at least 4 of the 7 days line up — a KPI week that straddles
   * two grid weeks (or falls in the gap the grid leaves at the start of a
   * month, e.g. 1-6 Sep 2026) has no honest Total Appts, and returning the
   * wrong week's would be worse than returning none.
   *
   * Null means "no denominator" — the caller must show a blank, never a 0%.
   */
  async totalApptsForWeek(
    clinicianId: string,
    weekStart:   string,
    weekEnd:     string,
  ): Promise<number | null> {
    const overlapDays = (aFrom: string, aTo: string, bFrom: string, bTo: string): number => {
      const from = aFrom > bFrom ? aFrom : bFrom;
      const to   = aTo   < bTo   ? aTo   : bTo;
      if (from > to) return 0;
      const ms = Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z');
      return Math.round(ms / 86_400_000) + 1;
    };

    // Both months, because a Mon-Sun week can start in one and end in the next.
    const months = new Set<string>([weekStart.slice(0, 7), weekEnd.slice(0, 7)]);
    let best: { year: number; month: number; weekNum: number; days: number } | null = null;

    for (const ym of months) {
      const year  = Number(ym.slice(0, 4));
      const month = Number(ym.slice(5, 7));
      for (const w of getWeekRanges(year, month)) {
        if (w.dateFrom.startsWith('9999')) continue;   // unused Remainder slot
        const days = overlapDays(weekStart, weekEnd, w.dateFrom, w.dateTo);
        if (days === 0) continue;
        const weekNum = w.weekNum === 'remainder' ? 5 : w.weekNum;
        if (!best || days > best.days) best = { year, month, weekNum, days };
      }
    }

    if (!best || best.days < 4) return null;

    const { rows } = await query<{ total_appts: number | null }>(
      `SELECT total_appts FROM practitioner_week_inputs
        WHERE clinician_id = $1 AND year = $2 AND month = $3 AND week_num = $4`,
      [clinicianId, best.year, best.month, best.weekNum]
    );
    const v = rows[0]?.total_appts;
    return v === null || v === undefined ? null : Number(v);
  },

  /**
   * Upsert the Monday half onto (clinician_id, week_start) — the spec's match
   * key. Re-submitting the same week corrects it in place rather than creating
   * a second row the tracker would show twice.
   *
   * The Friday-only columns — mojo_rating, mojo_drain, mojo_action,
   * effectiveness_score/band_id/etc, and the signal ratings — are
   * DELIBERATELY ABSENT from both the column list and
   * the ON CONFLICT SET clause. Since 2026-09-04 (migration 035) those are
   * Friday's to write — see saveFriday (mojo_drain / mojo_action joined them
   * there 2026-09-07). If a re-submitted Monday touched them
   * here, a physio correcting their KPI boxes midweek would silently wipe out
   * whatever Friday had already scored, the same trap the Friday text fields
   * (wins, goal_achieved, ...) were already kept out of below.
   */
  async upsertMonday(input: MondayInput): Promise<WeeklyKpiDTO> {
    const [k1, k2, k3] = input.kpis;
    const c = input.counts;

    const id = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO weekly_kpi_reports (
           clinician_id, clinic_id, week_start,
           kpi1_name, kpi1_target, kpi1_result, kpi1_hit,
           kpi2_name, kpi2_target, kpi2_result, kpi2_hit,
           kpi3_name, kpi3_target, kpi3_result, kpi3_hit,
           missed_goal_actions,
           intention, case_to_discuss, help_needed,
           checkin_needed, checkin_focus, monday_submitted_at,
           initials_seen, recommendations_full, plans_accepted_full,
           plans_accepted_part, dropouts_contacted, consults_recorded,
           calls_due, calls_made, cancellations_noshows
         ) VALUES (
           $1,$2,$3::date,
           $4,$5,$6,$7,
           $8,$9,$10,$11,
           $12,$13,$14,$15,
           $16,
           $17,$18,$19,
           $20,$21,NOW(),
           $22,$23,$24,
           $25,$26,$27,
           $28,$29,$30
         )
         ON CONFLICT (clinician_id, week_start) DO UPDATE SET
           clinic_id            = EXCLUDED.clinic_id,
           kpi1_name            = EXCLUDED.kpi1_name,
           kpi1_target          = EXCLUDED.kpi1_target,
           kpi1_result          = EXCLUDED.kpi1_result,
           kpi1_hit             = EXCLUDED.kpi1_hit,
           kpi2_name            = EXCLUDED.kpi2_name,
           kpi2_target          = EXCLUDED.kpi2_target,
           kpi2_result          = EXCLUDED.kpi2_result,
           kpi2_hit             = EXCLUDED.kpi2_hit,
           kpi3_name            = EXCLUDED.kpi3_name,
           kpi3_target          = EXCLUDED.kpi3_target,
           kpi3_result          = EXCLUDED.kpi3_result,
           kpi3_hit             = EXCLUDED.kpi3_hit,
           missed_goal_actions  = EXCLUDED.missed_goal_actions,
           intention            = EXCLUDED.intention,
           case_to_discuss      = EXCLUDED.case_to_discuss,
           help_needed          = EXCLUDED.help_needed,
           checkin_needed       = EXCLUDED.checkin_needed,
           checkin_focus        = EXCLUDED.checkin_focus,
           monday_submitted_at  = NOW(),
           initials_seen         = EXCLUDED.initials_seen,
           recommendations_full  = EXCLUDED.recommendations_full,
           plans_accepted_full   = EXCLUDED.plans_accepted_full,
           plans_accepted_part   = EXCLUDED.plans_accepted_part,
           dropouts_contacted    = EXCLUDED.dropouts_contacted,
           consults_recorded     = EXCLUDED.consults_recorded,
           calls_due             = EXCLUDED.calls_due,
           calls_made            = EXCLUDED.calls_made,
           cancellations_noshows = EXCLUDED.cancellations_noshows,
           updated_at           = NOW()
         RETURNING id`,
        [
          input.clinician_id, input.clinic_id, input.week_start,
          k1.name, k1.target, k1.result, k1.hit,
          k2.name, k2.target, k2.result, k2.hit,
          k3.name, k3.target, k3.result, k3.hit,
          input.missed_goal_actions,
          input.intention, input.case_to_discuss, input.help_needed,
          input.checkin_needed, input.checkin_focus,
          c.initials_seen, c.recommendations_full, c.plans_accepted_full,
          c.plans_accepted_part, c.dropouts_contacted, c.consults_recorded,
          c.calls_due, c.calls_made, c.cancellations_noshows,
        ]
      );
      return rows[0].id;
    });

    const saved = await this.findById(id, { withSignals: true });
    if (!saved) throw new Error('Failed to read back the saved weekly KPI report');
    return saved;
  },

  /**
   * Delete one report outright.
   *
   * Its comment thread and both sides' read stamps go with it — the two tables
   * in migration 033 reference this row ON DELETE CASCADE, which is exactly the
   * behaviour wanted here: a thread about a week that no longer exists is not
   * something anyone can act on.
   *
   * Hard delete, matching every other delete in this app (dropouts, case
   * acceptance, ad leads): the audit log is the record of the action, not a
   * tombstone row. Sam chose this over a recoverable soft delete on 2026-08-24.
   */
  async deleteById(id: string): Promise<boolean> {
    const { rowCount } = await query('DELETE FROM weekly_kpi_reports WHERE id = $1', [id]);
    return !!rowCount;
  },

  /**
   * Write the Friday half onto an existing row. Scoped by clinician_id as well
   * as id so a caller can never close someone else's loop, whatever the route
   * thought it was doing.
   *
   * Since 2026-09-04 (migration 035) this also writes Effectiveness and the
   * Mojo rating — moved here from upsertMonday — inside one transaction with
   * the thirty signal ratings, for the same reason upsertMonday used to: a
   * failure between the row and its ratings must never leave a stored score
   * describing ratings that are not the ones actually saved.
   *
   * mojo_drain / mojo_action are written here too since 2026-09-07 — Sam moved
   * the rest of the Mojo reflection off Monday, so this half now owns all three
   * Mojo answers and upsertMonday no longer writes any of them.
   */
  async saveFriday(
    id: string,
    clinicianId: string,
    input: FridayInput
  ): Promise<WeeklyKpiDTO | null> {
    const e = input.effectiveness;

    const rowCount = await withTransaction(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE weekly_kpi_reports SET
           wins                 = $3,
           goal_achieved        = $4,
           goal_reflection      = $5,
           flag_for_sam         = $6,
           best_behaviour       = $7,
           slipped              = $8,
           commitment           = $9,
           effectiveness_rating = $10,
           mojo_rating          = $11,
           mojo_drain           = $24,
           mojo_action          = $25,
           effectiveness_score  = $12,
           band_id              = $13,
           model_version        = $14,
           is_incomplete        = $15,
           standards_missed     = $16,
           standards_na         = $17,
           na_count             = $18,
           group_pct_g1         = $19,
           group_pct_g2         = $20,
           group_pct_g3         = $21,
           group_pct_g4         = $22,
           group_pct_g5         = $23,
           friday_submitted_at  = NOW(),
           updated_at           = NOW()
         WHERE id = $1 AND clinician_id = $2`,
        [
          id, clinicianId, input.wins, input.goal_achieved, input.goal_reflection,
          input.flag_for_sam, input.best_behaviour, input.slipped, input.commitment,
          input.effectiveness_rating, input.mojo_rating,
          e.effectiveness_score, e.band_id, e.model_version, e.is_incomplete,
          e.standards_missed, e.standards_na, e.na_count,
          e.group_pcts.G1, e.group_pcts.G2, e.group_pcts.G3, e.group_pcts.G4, e.group_pcts.G5,
          input.mojo_drain, input.mojo_action,
        ]
      );
      if (!rowCount) return 0;

      // Replace, do not merge — a re-submitted Friday is the physio's whole
      // week as they now say it went, same reasoning the old Monday upsert
      // used before this moved here.
      await client.query(
        'DELETE FROM weekly_kpi_signal_ratings WHERE report_id = $1',
        [id]
      );

      const present = SIGNALS.filter(s => s.signal_id in input.signals);
      if (present.length > 0) {
        const values = present
          .map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`)
          .join(', ');
        const params: unknown[] = [id];
        for (const s of present) {
          params.push(s.signal_id, input.signals[s.signal_id] ?? null);
        }
        await client.query(
          `INSERT INTO weekly_kpi_signal_ratings (report_id, signal_id, rating)
           VALUES ${values}`,
          params
        );
      }

      return rowCount;
    });

    if (!rowCount) return null;
    // Same reason as the Monday readback: the form re-prefills from this.
    return this.findById(id, { withSignals: true });
  },
};
