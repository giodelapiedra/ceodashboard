import {
  weeklyKpiRepository, WeeklyKpiDTO, MissingClinician, WeekProgress,
  PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX,
} from './weekly-kpi.repository';
import {
  weeklyKpiCommentRepository, WeeklyKpiCommentDTO, UnreadThread,
} from './weekly-kpi.comments.repository';
import { RequestScope } from '../../middleware/auth.middleware';
import { Errors } from '../../shared/errors';
import {
  canSubmitWeeklyKpi, canViewWeeklyKpiTracker, canDeleteWeeklyKpiReport, isClinicId,
} from '../../shared/roles';
import { SubmitMondayBody, SubmitFridayBody, TrackerQuery } from './weekly-kpi.validators';
import {
  currentWeekStart, mondayOf, weekEnd, isCurrentWeek, isoDayOfWeek,
} from './weekly-kpi.week';
import { notifyKpiMonday, notifyKpiFriday } from '../../services/teams-notify.service';
import {
  scoreSignals, signalById, SIGNALS, SIGNAL_GROUPS,
  KpiModelPayload, kpiModelPayload, modelFor, knownModelVersions,
  MOJO_FLAG_AT_OR_BELOW, NA_COUNT_REVIEW_AT, RatingMap,
} from './weekly-kpi.model';
import { WeeklyCounts } from './weekly-kpi.repository';
import { practitionerStatsRepository } from '../practitioner-stats/practitioner-stats.repository';
import { addDays } from './weekly-kpi.week';

/** The day of the ISO week from which the form opens on its Friday half.
 *  Thursday, not Friday: physios finishing a week on Thursday were the reason
 *  a hard Friday-only gate is not workable (see `phase` below). */
const FRIDAY_TAB_FROM_ISO_DAY = 4;

/**
 * How far back a physio may still close a week they never closed (Sam,
 * 2026-09-07). Four weeks.
 *
 * This one number governs BOTH halves of that decision, and it has to, or the
 * feature deadlocks:
 *
 *   - it is the set of weeks the physio may still close late, and
 *   - it is the set of weeks that BLOCK the new week's Monday half.
 *
 * A week that ages out of the window therefore stops blocking at the same
 * moment it stops being closable. Split those two into different rules and a
 * physio with a five-week-old open week would be locked out of the form
 * permanently, with nothing they could do about it — the exact deadlock that
 * made a hard block unworkable before late-closing existed.
 */
const LATE_CLOSE_MAX_WEEKS = 4;

/**
 * The "4 of 10 submitted" counts that ride along with the Teams alert.
 *
 * Swallows its own errors and returns null: this is decoration on a
 * fire-and-forget notification, and a failed COUNT must never turn a physio's
 * saved report into an error response. The alert simply goes out without the
 * line.
 */
async function weekProgress(week_start: string): Promise<WeekProgress | null> {
  try {
    return await weeklyKpiRepository.progressForWeek(week_start);
  } catch (e) {
    console.error('[weekly-kpi] submission progress count failed:',
      e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Section 5, "Counts contradict each other": WARN, do not block. "The clinician
 * may have a legitimate reason; store the values and surface the warning."
 *
 * So this returns sentences, never an error. Each pair is only compared when
 * BOTH numbers were given — a blank is "I don't know", and comparing against it
 * would invent a contradiction out of a missing answer.
 */
function countWarnings(c: WeeklyCounts): string[] {
  const out: string[] = [];
  const both = (a: number | null, b: number | null): boolean => a !== null && b !== null;

  if (both(c.calls_made, c.calls_due) && c.calls_made! > c.calls_due!) {
    out.push(`More follow-up calls made (${c.calls_made}) than were due (${c.calls_due})`);
  }
  if (both(c.consults_recorded, c.initials_seen) && c.consults_recorded! > c.initials_seen!) {
    out.push(`More consults recorded (${c.consults_recorded}) than initials seen (${c.initials_seen})`);
  }
  if (both(c.recommendations_full, c.initials_seen) && c.recommendations_full! > c.initials_seen!) {
    out.push(`More full recommendations (${c.recommendations_full}) than initials seen (${c.initials_seen})`);
  }
  const accepted = (c.plans_accepted_full ?? 0) + (c.plans_accepted_part ?? 0);
  if ((c.plans_accepted_full !== null || c.plans_accepted_part !== null)
      && c.recommendations_full !== null && accepted > c.recommendations_full) {
    out.push(`More plans accepted (${accepted}) than recommendations given (${c.recommendations_full})`);
  }
  return out;
}

/**
 * The three KPI boxes, auto-filled from data the front desk and Nookal already
 * record — Sam's ask, 2026-09-04: "each clinician already has their own [numbers]
 * automatically", so the physio should not have to type them.
 *
 * Sourced from case_acceptances (recommendations, conversion) and
 * patient_dropouts (cancellations) for the ISO week immediately BEFORE the one
 * being viewed — the KPI boxes are captioned "for the previous week".
 * Recommendation/Conversion reuse practitioner-stats' own caseAcceptanceByDay
 * query (filtered down to this one clinician), so a physio's own number can
 * never disagree with what Sam sees on the Practitioner Stats board for the
 * same week.
 *
 * Recommendation and Conversion are the PER-INITIAL AVERAGES — exactly the
 * board's "Recs (avg)" and "Booked (avg)" columns (Sam, 2026-09-07: those two
 * boxes should read the same as the clinician's Recs (avg) / Booked (avg)) —
 * not the raw weekly sums they used to show. Same arithmetic as
 * practitioner-stats' toStats: sum ÷ every initial consult that week
 * (including initials that got no plan, i.e. recommendations = 0), 2dp, and
 * null rather than 0 when there were no initials at all. Cancellation does NOT reuse that module's cancellationsByDay —
 * see weeklyKpiRepository.cancellationDropoutCount for why (prod/local drift
 * on that file) — but uses the identical status definition, so the number
 * still matches what the same figure would read on that board.
 *
 * Cancellation IS a percentage (Sam, 2026-09-04), and since 2026-09-07 it is
 * the SAME figure as the Practitioner Stats board's Cancellation %:
 *
 *     every Patient Dropout Tracking entry for that clinician that week,
 *     except 'Completed Treatment Plan'   ÷   Total Appts
 *
 * Sam's words: "Patient Dropout Tracking ng clinician Total entries pero hindi
 * kasama Completed Treatment Plan status ... example entries 5 divided by
 * Total Appts". Total Appts is Nookal Completed Consults, written per
 * practitioner-week by the Practitioner Stats sync — see
 * weeklyKpiRepository.totalApptsForWeek for how a Mon-Sun KPI week is matched
 * onto the CEO's month/week grid, and why it can legitimately come back null.
 *
 * It used to divide by initial consults seen instead, because no per-ISO-week
 * Total Appts existed to divide by. It does now, so the two boards agree.
 */
export interface AutoKpiTotals {
  week_start:      string;
  week_end:        string;
  /** Average case recommendations per initial consult — the board's
   *  "Recs (avg)". 2dp; null when there were no initials that week. */
  recommendation:  number | null;
  /** Average appointments booked per initial consult — the board's
   *  "Booked (avg)". 2dp; null when there were no initials that week. */
  conversion:      number | null;
  /** Percentage, 0-100+, 1dp. Null when there is no Total Appts to divide by —
   *  the week was never synced from Nookal, or it does not line up with the
   *  CEO's week grid. Not the same as 0%: "no data" must never read as "no
   *  cancellations". */
  cancellationPct: number | null;
}

async function autoKpiTotals(clinicianId: string, weekStart: string): Promise<AutoKpiTotals> {
  const week_end   = addDays(weekStart, -1);
  const week_start = addDays(weekStart, -7);

  // Decoration on the form's initial load, not something the physio can act
  // on — a failed lookup here must never stop the week from loading.
  try {
    const [caseRows, cxlDropouts, totalAppts] = await Promise.all([
      practitionerStatsRepository.caseAcceptanceByDay(week_start, week_end, null),
      weeklyKpiRepository.cancellationDropoutCount(clinicianId, week_start, week_end),
      weeklyKpiRepository.totalApptsForWeek(clinicianId, week_start, week_end),
    ]);

    let sumRecs = 0, sumBooked = 0, initials = 0;
    for (const r of caseRows) if (r.clinician_id === clinicianId) {
      sumRecs += r.sum_recs; sumBooked += r.sum_booked; initials += r.initials;
    }
    // Dropout entries ÷ Total Appts. A null or 0 Total Appts leaves this blank
    // rather than dividing — see AutoKpiTotals.cancellationPct.
    const cancellationPct = totalAppts && totalAppts > 0
      ? Math.round((cxlDropouts / totalAppts) * 1000) / 10
      : null;
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const recommendation = initials > 0 ? round2(sumRecs   / initials) : null;
    const conversion     = initials > 0 ? round2(sumBooked / initials) : null;

    return { week_start, week_end, recommendation, conversion, cancellationPct };
  } catch (e) {
    console.error('[weekly-kpi] auto KPI totals failed:', e instanceof Error ? e.message : e);
    return { week_start, week_end, recommendation: null, conversion: null, cancellationPct: null };
  }
}

/** What the physio's own form needs to render itself in one call. */
export interface MyWeekView {
  week_start: string;
  week_end:   string;
  /** Which half of the form to open on. Advisory — both halves stay reachable. */
  phase:      'monday' | 'friday';
  /** The current week's row, or null when Monday has not been filled in yet. */
  report:     WeeklyKpiDTO | null;
  /** False once the week has rolled over — past weeks are read-only. */
  editable:   boolean;
  /** The auto-filled Recommendation/Conversion/Cancellation figures for the
   *  PREVIOUS week — see AutoKpiTotals. */
  autoKpis:   AutoKpiTotals;
  /** Last Friday's "What are you committing to next week?", offered as the
   *  starting text of this week's intention box. Null when there is none to
   *  carry. The physio edits or replaces it; nothing is stored until they
   *  submit Monday themselves. */
  lastCommitment: { week_start: string; commitment: string } | null;
  /** Past weeks still open AND still closable, oldest first. Non-empty means
   *  the current week's Monday half is locked until the first of these is
   *  closed — see myWeek and LATE_CLOSE_MAX_WEEKS. */
  pending_close: string[];
  /** The week the physio would be on if nothing were pending. Lets the form
   *  say which week is waiting while it shows an older one. */
  current_week_start: string;
  /** This physio's own earlier weeks that were never closed on Friday, newest
   *  first. A reminder on their form, never a gate — see
   *  weeklyKpiRepository.openWeeksBefore for why blocking them would deadlock. */
  open_weeks: string[];
}

export interface TrackerView {
  week_start: string;
  week_end:   string;
  rows:       WeeklyKpiDTO[];
  /** Roster clinicians with nothing recorded for this week. */
  missing:    MissingClinician[];
  /** Weeks that actually hold data, newest first — drives the week picker. */
  weeks:      string[];
  summary: {
    submitted:      number;
    friday_closed:  number;
    checkin_needed: number;
    /** Team averages over the rows in view. Null when the week is empty. */
    avg_effectiveness: number | null;
    avg_mojo:          number | null;
  };
}

export interface PagedHistory {
  data: WeeklyKpiDTO[];
  pagination: { limit: number; offset: number; total: number; hasMore: boolean };
}

/** One thread, plus who is reading it — the UI needs the viewer id to tell
 *  "mine" from "theirs" without trusting its own copy of the session. */
export interface CommentThread {
  report_id: string;
  viewer_id: string;
  comments:  WeeklyKpiCommentDTO[];
}

/** The physio's notification payload: how many comments are waiting, and on
 *  which weeks. Polled by the frontend the same way the approval queues are. */
export interface UnreadSummary {
  total:   number;
  threads: UnreadThread[];
}

/**
 * The clinic a report is filed against: the account's own default clinic.
 *
 * Sam's instruction was that a physio should not have to pick this ("hindi need
 * lagay ... clinic nila kasi meron na sila default clinic"). A CLINICIAN account
 * always has clinic_id set — the role is single-clinic by definition, and
 * CROSS_CLINIC_ROLES does not include it — so a NULL here means the account was
 * mis-created, not that the physio needs a picker. Fail loudly and say what to
 * fix rather than defaulting to a clinic and filing the report to the wrong one.
 */
function clinicForSubmission(scope: RequestScope): string {
  if (!scope.clinic_id || !isClinicId(scope.clinic_id)) {
    throw Errors.validation(
      'Your account has no default clinic set, so the report cannot be filed. ' +
      'Ask the admin to set your clinic in User Management.'
    );
  }
  return scope.clinic_id;
}

function assertCanSubmit(scope: RequestScope): void {
  if (!canSubmitWeeklyKpi(scope.role)) {
    // Spec section 2: physios are the only ones who fill this in. The super
    // admin is a viewer here by design, so this rejects ADMIN too.
    throw Errors.forbidden(
      'Only clinicians submit the weekly KPI report — everyone else views the tracker'
    );
  }
}

/**
 * Hang each report's comment counts off the rows, from `viewerId`'s point of
 * view. One extra query per list, never one per row.
 *
 * Mutates in place and returns the same array: every caller here has just
 * built these DTOs and is about to hand them to res.json(), so a copy would be
 * churn for nothing.
 */
async function withCommentCounts(rows: WeeklyKpiDTO[], viewerId: string): Promise<WeeklyKpiDTO[]> {
  if (rows.length === 0) return rows;
  const counts = await weeklyKpiCommentRepository.countsFor(rows.map(r => r.id), viewerId);
  for (const r of rows) {
    const c = counts.get(String(r.id));
    r.comment_count = c?.total  ?? 0;
    r.unread_count  = c?.unread ?? 0;
  }
  return rows;
}

/**
 * This physio's own past weeks that are still open AND still closable —
 * OLDEST FIRST, because a week is closed in the order it happened.
 *
 * The single source of truth for the late-close feature: `myWeek` serves the
 * first of these instead of the current week, `submitMonday` refuses while any
 * exist, and `submitFriday` accepts a past week only if it is in here. One
 * function, so those three can never disagree about which weeks are pending.
 *
 * The current week is never in here — it is not late until it is over.
 */
async function pendingCloseWeeks(clinicianId: string): Promise<string[]> {
  const current = currentWeekStart();
  const cutoff  = addDays(current, -7 * LATE_CLOSE_MAX_WEEKS);
  const open    = await weeklyKpiRepository.openWeeksBefore(clinicianId, current);
  return open.filter(w => w >= cutoff).sort();   // ISO dates sort chronologically
}

export const weeklyKpiService = {
  /**
   * The physio's own current week — the form's initial load.
   *
   * FINISH THE OLD WEEK FIRST (Sam, 2026-09-07). With no `week` asked for, this
   * does NOT always serve the current week: while the physio has an unclosed
   * week still inside the late-close window, it serves the OLDEST of those
   * instead, on its Friday half, and reports the current week's Monday half as
   * locked. "Hindi siya makapag-fill up muna ng latest, lalabas lang yung
   * previous na Monday para ma-close ang Friday."
   *
   * The lock is safe only because that same week is closable — see
   * LATE_CLOSE_MAX_WEEKS. Serving the pending week rather than merely flagging
   * it also means the Friday half is answered against the intention that week
   * actually carries, not against the new week's.
   *
   * An explicit `week` still serves exactly that week, so history stays
   * readable while the lock is on.
   */
  async myWeek(scope: RequestScope, weekParam?: string): Promise<MyWeekView> {
    assertCanSubmit(scope);

    const current = currentWeekStart();
    const pending = await pendingCloseWeeks(scope.userId);

    const week_start = weekParam ? mondayOf(weekParam)
      : pending[0] ?? current;
    const report     = await weeklyKpiRepository.findByPersonWeek(scope.userId, week_start);
    if (report) await withCommentCounts([report], scope.userId);

    // Open on the Friday half once the week is far enough along AND there is a
    // Monday half to close the loop on. With no Monday row the Friday tab has
    // nothing to reflect against, so the form starts where the work starts.
    // A pending week is always past, so it always opens on Friday — that is the
    // only thing left to do on it.
    const isPending  = pending.includes(week_start);
    const lateInWeek = isoDayOfWeek() >= FRIDAY_TAB_FROM_ISO_DAY;
    const phase: 'monday' | 'friday' =
      report && (isPending || lateInWeek) && !report.friday_submitted_at ? 'friday' : 'monday';

    return {
      week_start,
      week_end: weekEnd(week_start),
      phase,
      report,
      // A pending week is editable too — its Friday half is exactly what the
      // physio is here to fill in. Its Monday half stays frozen; that is
      // enforced by submitMonday, which only ever writes the current week.
      editable: isCurrentWeek(week_start) || isPending,
      autoKpis: await autoKpiTotals(scope.userId, week_start),
      open_weeks: await weeklyKpiRepository.openWeeksBefore(scope.userId, current),
      lastCommitment: await weeklyKpiRepository.lastCommitmentBefore(scope.userId, week_start),
      pending_close: pending,
      current_week_start: current,
    };
  },

  /**
   * Save the Monday half of the CURRENT week. Upserts, so a physio who spots a
   * typo in their own intention can re-submit the same week and correct it.
   *
   * No edit-request/approval flow, unlike dropouts and case acceptance. Those
   * are shared operational records where one person's typo becomes another
   * person's wrong number. This is a self-report: the only person a correction
   * concerns is the author, and routing "I meant 7 not 8 on my own mojo" through
   * the CEO's approval queue would be friction with nothing on the other side
   * of it. Past weeks are frozen instead, which is what actually protects the
   * tracker from moving under Sam.
   */
  async submitMonday(scope: RequestScope, body: SubmitMondayBody): Promise<WeeklyKpiDTO> {
    assertCanSubmit(scope);
    const clinic_id  = clinicForSubmission(scope);
    const week_start = currentWeekStart();

    // Finish the old week first (Sam, 2026-09-07). Refused rather than queued:
    // a new intention written while a past week is still unanswered is how a
    // week quietly disappears from the tracker.
    //
    // This can never be a dead end. Every week that blocks here is, by the same
    // definition, a week submitFriday will still accept — see
    // LATE_CLOSE_MAX_WEEKS — and one that ages out of that window stops
    // blocking at the same moment.
    const pending = await pendingCloseWeeks(scope.userId);
    if (pending.length > 0) {
      throw Errors.validation(
        `Close the week of ${pending[0]} first — its Friday half was never filled in. ` +
        'The form is showing that week; this week opens once it is closed.'
      );
    }

    const warnings = countWarnings(body.counts);
    if (warnings.length > 0) {
      console.warn(
        `[weekly-kpi] contradictory counts from user ${scope.userId} ` +
        `(week ${week_start}): ${warnings.join(' | ')}`
      );
    }

    // No Effectiveness and no Mojo answer of any kind is collected here. The
    // signals and the Mojo rating moved to the Friday half 2026-09-04, and the
    // drain type and action followed 2026-09-07 — the whole reflection is now
    // answered at the week's close, and Monday is intention-setting only. This
    // upsert never touches the Friday-only columns; see the comment in
    // weekly-kpi.repository.upsertMonday for why.
    const saved = await weeklyKpiRepository.upsertMonday({
      clinician_id: scope.userId,
      clinic_id,
      week_start,
      kpis: body.kpis,
      missed_goal_actions:  body.missed_goal_actions,
      intention:            body.intention,
      case_to_discuss:      body.case_to_discuss,
      help_needed:          body.help_needed,
      // A check-in focus is only stored when the physio asked for a check-in.
      // The validator already refuses the contradiction; this is belt-and-braces
      // for the case where a client sends Yes, then flips to No on a re-submit
      // without clearing the box it had already hidden.
      checkin_needed:       body.checkin_needed,
      checkin_focus:        body.checkin_needed ? body.checkin_focus : null,
      counts:               body.counts,
    });

    // The card carries the physio's own sentence and nothing measured about
    // them. No clinic either (Sam, same day) — the row still stores it.
    notifyKpiMonday({
      clinician_name: saved.clinician_name,
      week_start:     saved.week_start,
      intention:      saved.intention,
      // Counted AFTER the upsert, so this physio is already in the numerator.
      progress:  await weekProgress(saved.week_start),
    });

    return saved;
  },

  /**
   * The signal registry the form renders itself from.
   *
   * Served rather than mirrored into the frontend: thirty rows of question
   * text, weights and Standard flags copied into a second file is thirty
   * chances for the form to ask something the scorer does not know about. Open
   * to any authenticated account — it is the questionnaire, not anyone's
   * answers.
   */
  model(version?: string): KpiModelPayload {
    // No version asked for: the current model, which is what the form wants.
    if (!version) return kpiModelPayload();

    // A version asked for: the model that scored those rows. Unknown versions
    // 404 rather than falling back to the current model — describing an old
    // score with today's weights and band labels would be a wrong explanation
    // presented as a right one, which is worse than no explanation at all.
    const found = modelFor(version);
    if (!found) {
      throw Errors.notFound(
        `Unknown check-in model version "${version}". Known: ${knownModelVersions().join(', ')}`
      );
    }
    return kpiModelPayload(found);
  },

  /**
   * Close the loop on the current week. Requires the Monday half to exist —
   * the whole Friday half is "did you achieve your Monday goal", so there is
   * nothing to answer against without it.
   *
   * Also where Effectiveness (the 30 signals) and Mojo are scored, since
   * 2026-09-04 — moved here from submitMonday so the week is rated at its
   * close rather than its start. See the header note on submitFridaySchema.
   */
  async submitFriday(scope: RequestScope, body: SubmitFridayBody): Promise<WeeklyKpiDTO> {
    assertCanSubmit(scope);

    // Which week is being closed. The current one unless the client names an
    // older one, which is only allowed for a week that is still pending — see
    // pendingCloseWeeks. Everything below then runs against `week_start`, so a
    // late close is the same code path as an on-time one, not a second one that
    // could drift from it.
    const current    = currentWeekStart();
    const week_start = body.week_start ? mondayOf(body.week_start) : current;

    if (week_start !== current) {
      const pending = await pendingCloseWeeks(scope.userId);
      if (!pending.includes(week_start)) {
        // Covers all three refusals at once: a week already closed, a week more
        // than LATE_CLOSE_MAX_WEEKS old, and a week belonging to someone else
        // (it would not be in this caller's pending list).
        throw Errors.validation(
          `The week of ${week_start} can no longer be closed. Only your own weeks that are ` +
          `still open and less than ${LATE_CLOSE_MAX_WEEKS} weeks old can be filled in late.`
        );
      }
    }

    const existing = await weeklyKpiRepository.findByPersonWeek(scope.userId, week_start);
    if (!existing) {
      throw Errors.validation(
        'Fill in the Monday half first — the Friday questions close the loop on that week’s goal'
      );
    }

    // Section 5: "Signal missing from the payload -> treat identically to NA.
    // Log it — a missing signal means a form or client bug." Scored as N/A
    // below; logged here so the bug is visible rather than absorbed.
    const missing = SIGNALS
      .filter(s => !(s.signal_id in body.signals))
      .map(s => s.signal_id);
    if (missing.length > 0) {
      console.warn(
        `[weekly-kpi] submission from user ${scope.userId} omitted ${missing.length} ` +
        `signal(s): ${missing.join(', ')} — scored as N/A. Check the form version.`
      );
    }

    // THE score is computed here, from the raw ratings, and nowhere else. The
    // client computes its own copy only to show the physio a live number; it is
    // never sent and never trusted.
    const result = scoreSignals(body.signals as RatingMap);

    // The validator refuses an all-N/A submission, so this cannot fire from the
    // form. It stays because `scoreSignals` is allowed to return null and a
    // future caller must not be able to write a NULL score into a NOT NULL
    // column and find out in production.
    if (result.score === null) {
      throw Errors.validation(
        'Rate at least one behaviour — a week marked N/A throughout cannot be scored'
      );
    }

    const saved = await weeklyKpiRepository.saveFriday(existing.id, scope.userId, {
      wins:            body.wins,
      goal_achieved:   body.goal_achieved,
      // Mirrors the check-in rule above: a reflection is only kept when the
      // goal was actually missed.
      goal_reflection: body.goal_achieved ? null : body.goal_reflection,
      flag_for_sam:    body.flag_for_sam,
      best_behaviour:  body.best_behaviour,
      slipped:         body.slipped,
      commitment:      body.commitment,

      // Derived, not submitted: the whole-number column every existing reader
      // (tracker, averages, Excel export) already reads. Rounding the computed
      // score keeps those working unchanged across both eras of this form.
      effectiveness_rating: Math.round(result.score),
      mojo_rating:          body.mojo_rating,
      // The other two Mojo answers moved here from Monday 2026-09-07, so this
      // half writes all three. upsertMonday no longer touches these columns,
      // so there is nothing for a Friday re-submit to overwrite.
      mojo_drain:           body.mojo_drain,
      mojo_action:          body.mojo_action,
      signals:              body.signals as RatingMap,
      effectiveness: {
        effectiveness_score: result.score,
        group_pcts: SIGNAL_GROUPS.reduce<Record<string, number | null>>((acc, g) => {
          const r = result.groups.find(x => x.group_id === g.group_id);
          // 4dp to match the column; a NULL group is a group that was fully N/A.
          acc[g.group_id] = r?.pct == null ? null : Math.round(r.pct * 10000) / 10000;
          return acc;
        }, {}),
        standards_missed: result.standards_missed.length,
        standards_na:     result.standards_na.length,
        na_count:         result.na_count,
        band_id:          result.band_id,
        // Taken from the result, not from the constant: the version stamped on
        // the row is then always the version that did the arithmetic, even if a
        // future caller scores against an older model on purpose.
        model_version:    result.model_version,
        is_incomplete:    result.incomplete,
      },
    });
    if (!saved) throw Errors.notFound('Weekly KPI report not found');

    // ── Section 8 triggers ────────────────────────────────────────────────
    // Deliberately NOT sent to Teams. TEAMS_KPI_WEBHOOK_URL posts into a group
    // chat the whole team reads, and Sam's instruction on 2026-09-01 was that
    // nothing measured about a physio goes there: "We only want the Intention
    // on a Monday, and their wins on a Friday."
    //
    // The triggers are not lost, they are made private. Every one of them is a
    // stored column driving the tracker and the physio's own results screen —
    // standards_missed, na_count, band_id and mojo_rating, two of them with
    // partial indexes from migration 034 precisely so the super admin can pull
    // the flagged weeks. They are logged here as well, so a week that needs
    // attention is greppable in the server log the day it happens.
    const flags = [
      result.standards_missed.length > 0
        ? `standards missed — ${result.standards_missed.map(id => signalById(id)?.text ?? id).join('; ')}`
        : null,
      body.mojo_rating <= MOJO_FLAG_AT_OR_BELOW ? `mojo ${body.mojo_rating}/10` : null,
      result.na_count >= NA_COUNT_REVIEW_AT ? `${result.na_count} of 30 marked N/A` : null,
    ].filter(Boolean);

    if (flags.length > 0) {
      console.warn(
        `[weekly-kpi] review flags for ${saved.clinician_name ?? `user ${scope.userId}`} ` +
        `(week ${saved.week_start}): ${flags.join(' | ')}`
      );
    }

    // Their wins, in their words — not whether they hit the goal. A pass/fail
    // on a person published to their colleagues is exactly what the group chat
    // is not for; it stays on the tracker.
    notifyKpiFriday({
      clinician_name: saved.clinician_name,
      week_start:     saved.week_start,
      wins:           saved.wins,
      progress:       await weekProgress(saved.week_start),
    });

    return saved;
  },

  /** The physio's own history — "para may history", newest week first. */
  async myHistory(scope: RequestScope, limit?: number, offset?: number): Promise<PagedHistory> {
    assertCanSubmit(scope);
    return this.historyFor(scope.userId, scope.userId, limit, offset);
  },

  /** One clinician's history. Used by the physio's own page and, for the admin,
   *  by the KPI tab on that clinician's profile.
   *
   *  `viewerId` is who is READING (not whose history it is) — the unread counts
   *  differ per side of the thread, so the two callers must pass their own id.
   */
  async historyFor(
    clinicianId: string,
    viewerId: string,
    limit?: number,
    offset?: number,
  ): Promise<PagedHistory> {
    const lim = Math.min(Math.max(limit ?? PAGE_LIMIT_DEFAULT, 1), PAGE_LIMIT_MAX);
    const off = Math.max(offset ?? 0, 0);

    const [data, total] = await Promise.all([
      weeklyKpiRepository.listForClinician(clinicianId, lim, off),
      weeklyKpiRepository.countForClinician(clinicianId),
    ]);

    await withCommentCounts(data, viewerId);

    return {
      data,
      pagination: { limit: lim, offset: off, total, hasMore: off + data.length < total },
    };
  },

  /**
   * One report in full — the spec's "available by clicking into that person's
   * row". Readable by the super admin (a viewer of everything) or by the physio
   * who wrote it. Anyone else gets a 404 rather than a 403: whether a given id
   * exists is not information a third party needs.
   */
  async getOne(scope: RequestScope, id: string): Promise<WeeklyKpiDTO> {
    // The one read that renders a report in full, so it is the one that pays
    // for the ratings. The comment-thread and delete paths below do not.
    const row = await weeklyKpiRepository.findById(id, { withSignals: true });
    if (!row) throw Errors.notFound('Weekly KPI report not found');

    const isOwner = String(row.clinician_id) === String(scope.userId);
    if (!isOwner && !canViewWeeklyKpiTracker(scope.role)) {
      throw Errors.notFound('Weekly KPI report not found');
    }
    await withCommentCounts([row], scope.userId);
    return row;
  },

  /**
   * The shared tracker — spec section 8. One week at a time, every clinician,
   * plus who has not submitted and the two team averages Sam scans for.
   */
  async tracker(scope: RequestScope, q: TrackerQuery): Promise<TrackerView> {
    if (!canViewWeeklyKpiTracker(scope.role)) {
      throw Errors.forbidden('Only the super admin can view the team KPI tracker');
    }

    const week_start = q.week ? mondayOf(q.week) : currentWeekStart();

    const [rows, missing, weeks] = await Promise.all([
      weeklyKpiRepository.tracker({
        week_start,
        clinic_id:    q.clinic_id,
        checkin_only: q.checkin_only,
        open_only:    q.open_only,
      }),
      weeklyKpiRepository.missingForWeek(week_start, q.clinic_id),
      weeklyKpiRepository.weeksWithData(52),
    ]);

    await withCommentCounts(rows, scope.userId);

    // Effectiveness and Mojo are null on any row still open on Friday, so the
    // average is over the rows that HAVE a number, not over every row in view —
    // otherwise a week with three closed loops and two still-open ones would
    // silently average the open ones' missing scores as if they were zero.
    const avg = (pick: (r: WeeklyKpiDTO) => number | null): number | null => {
      const vals = rows.map(pick).filter((v): v is number => v !== null);
      return vals.length === 0
        ? null
        : Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10;
    };

    return {
      week_start,
      week_end: weekEnd(week_start),
      rows,
      missing,
      // Always offer the current week even before anyone has submitted to it,
      // otherwise the picker is empty every Monday morning.
      weeks: weeks.includes(currentWeekStart()) ? weeks : [currentWeekStart(), ...weeks],
      summary: {
        submitted:      rows.length,
        friday_closed:  rows.filter(r => r.friday_submitted_at !== null).length,
        checkin_needed: rows.filter(r => r.checkin_needed).length,
        avg_effectiveness: avg(r => r.effectiveness_rating),
        avg_mojo:          avg(r => r.mojo_rating),
      },
    };
  },

  /**
   * Delete one report outright — super admin only (Sam, 2026-08-24).
   *
   * This is the one destructive operation in the feature, and it takes the
   * week's comment thread with it (ON DELETE CASCADE, migration 033). Three
   * things make that acceptable rather than reckless:
   *   * only ADMIN can reach it — a physio cannot delete their own week, and
   *     re-submitting the current one already covers "I typed it wrong";
   *   * the row is read BEFORE the delete so the audit entry can name the
   *     physio and the week, which is what makes the action reviewable after
   *     the row itself is gone;
   *   * the client confirms with the physio's name and the week spelled out.
   *
   * No delete-request queue, unlike dropouts and case acceptance: there, the
   * asker and the approver are different people. Here they are the same
   * account, so a queue would just be Sam approving Sam.
   */
  async deleteReport(scope: RequestScope, id: string): Promise<WeeklyKpiDTO> {
    if (!canDeleteWeeklyKpiReport(scope.role)) {
      throw Errors.forbidden('Only the super admin can delete a weekly KPI report');
    }

    const existing = await weeklyKpiRepository.findById(id);
    if (!existing) throw Errors.notFound('Weekly KPI report not found');
    // Count the thread BEFORE it cascades away, so the audit entry can say how
    // much conversation went with the row.
    await withCommentCounts([existing], scope.userId);

    const removed = await weeklyKpiRepository.deleteById(id);
    if (!removed) throw Errors.notFound('Weekly KPI report not found');

    // Returned so the route can put the physio and the week in the audit log.
    return existing;
  },

  // ── Comment threads (migration 033) ────────────────────────────────────────
  //
  // Sam's ask, 2026-08-24: he wanted to be able to answer a submitted week, and
  // the physio to be told about it. Two rules run through everything below.
  //
  // 1. A thread has exactly TWO parties: the physio the report belongs to, and
  //    the super admin. Anyone else gets a 404, never a 403 — whether a given
  //    report id exists is not information a third party needs. Same reasoning
  //    as getOne above.
  // 2. Only the author may change or remove what they wrote. Sam does not get
  //    to edit a physio's reply and the physio does not get to delete Sam's
  //    comment; there is no approval queue here because a comment is not a
  //    shared operational record, it is a message with one author.

  /**
   * The two-party check. Returns the report so callers do not fetch it twice.
   * `also_clinician` deliberately changes nothing: sam@ is on the viewing side
   * of this feature by spec, and ADMIN already passes.
   */
  async assertThreadParticipant(scope: RequestScope, reportId: string): Promise<WeeklyKpiDTO> {
    const report = await weeklyKpiRepository.findById(reportId);
    if (!report) throw Errors.notFound('Weekly KPI report not found');

    const isOwner = String(report.clinician_id) === String(scope.userId);
    if (!isOwner && !canViewWeeklyKpiTracker(scope.role)) {
      throw Errors.notFound('Weekly KPI report not found');
    }
    return report;
  },

  /** One thread. Reading it does NOT mark it read — the client says when it
   *  actually put the thread on screen (markThreadRead), so a count fetched to
   *  render a badge can never clear the badge it is for. */
  async listComments(scope: RequestScope, reportId: string): Promise<CommentThread> {
    await this.assertThreadParticipant(scope, reportId);
    return {
      report_id: String(reportId),
      viewer_id: String(scope.userId),
      comments:  await weeklyKpiCommentRepository.listForReport(reportId),
    };
  },

  /**
   * Post a comment. Both sides may write: Sam asking, the physio answering.
   *
   * The author's own read stamp is refreshed at the same time — having just
   * written in the thread, they have by definition read everything above it,
   * and without this a reply would leave the replier's own badge lit.
   */
  async addComment(scope: RequestScope, reportId: string, body: string): Promise<WeeklyKpiCommentDTO> {
    await this.assertThreadParticipant(scope, reportId);
    const saved = await weeklyKpiCommentRepository.add(reportId, scope.userId, body);
    await weeklyKpiCommentRepository.markRead(reportId, scope.userId);
    return saved;
  },

  /** Edit your own comment. The 404-for-non-author is deliberate: an id that
   *  belongs to someone else is not yours to know about. */
  async editComment(scope: RequestScope, commentId: string, body: string): Promise<WeeklyKpiCommentDTO> {
    const existing = await weeklyKpiCommentRepository.findById(commentId);
    if (!existing) throw Errors.notFound('Comment not found');
    if (String(existing.author_id) !== String(scope.userId)) {
      throw Errors.notFound('Comment not found');
    }
    const saved = await weeklyKpiCommentRepository.update(commentId, scope.userId, body);
    if (!saved) throw Errors.notFound('Comment not found');
    return saved;
  },

  /** Delete your own comment. Hard delete: a tombstone ("comment removed") in a
   *  two-person thread tells the other party nothing they cannot already infer,
   *  and the audit log keeps the record of the action. */
  async deleteComment(scope: RequestScope, commentId: string): Promise<{ report_id: string }> {
    const existing = await weeklyKpiCommentRepository.findById(commentId);
    if (!existing) throw Errors.notFound('Comment not found');
    if (String(existing.author_id) !== String(scope.userId)) {
      throw Errors.notFound('Comment not found');
    }
    const removed = await weeklyKpiCommentRepository.remove(commentId, scope.userId);
    if (!removed) throw Errors.notFound('Comment not found');
    return { report_id: existing.report_id };
  },

  /** "I have this thread on screen." Clears the unread count for this viewer. */
  async markThreadRead(scope: RequestScope, reportId: string): Promise<void> {
    await this.assertThreadParticipant(scope, reportId);
    await weeklyKpiCommentRepository.markRead(reportId, scope.userId);
  },

  /**
   * What is waiting for the caller — the notification.
   *
   * For a physio: comments on their own weeks that they have not read. For the
   * super admin: replies on threads HE has written in. Not "every comment on
   * every report", which would make his badge a count of the whole team's
   * conversation with itself.
   */
  async unreadForMe(scope: RequestScope): Promise<UnreadSummary> {
    const threads = canViewWeeklyKpiTracker(scope.role)
      ? await weeklyKpiCommentRepository.unreadForAdmin(scope.userId)
      : await weeklyKpiCommentRepository.unreadForClinician(scope.userId);

    return { total: threads.reduce((s, t) => s + t.unread, 0), threads };
  },
};
