import api from './client'
import {
  WeeklyKpiDTO, WeeklyKpiComment, KpiLine, ClinicId,
  KpiModel, SignalRating, WeeklyCounts,
} from '../types'

/** The auto-filled Recommendation/Conversion/Cancellation figures for the
 *  PREVIOUS week — see weekly-kpi.service.ts `autoKpiTotals` on the server.
 *  Cancellation is a PERCENTAGE (cancellations ÷ initials seen that week) —
 *  not the same figure as Practitioner Stats' own Cancellation % (that one
 *  divides by Total Appts, which does not exist per arbitrary ISO week) —
 *  see that file for the full reasoning. */
export interface AutoKpiTotals {
  week_start:      string
  week_end:        string
  /** Average case recommendations per initial consult — the same figure as
   *  the "Recs (avg)" column/card on the practitioner boards. */
  recommendation:  number | null
  /** Average appointments booked per initial consult — the same figure as
   *  the "Booked (avg)" column/card. */
  conversion:      number | null
  cancellationPct: number | null
}

/** The physio's own form load — one call gives it everything it needs to render. */
export interface MyWeekView {
  week_start: string
  week_end:   string
  /** Which half to open on. Advisory: both halves stay reachable, because a
   *  physio finishing their week on Thursday still has to be able to close it. */
  phase:      'monday' | 'friday'
  report:     WeeklyKpiDTO | null
  /** False for a past week — history is read-only. */
  editable:   boolean
  autoKpis:   AutoKpiTotals
  /** This physio's own earlier weeks never closed on Friday, newest first.
   *  Shown as a reminder on the form — deliberately not a gate: a past week is
   *  frozen, so blocking Monday on it would leave them unable to finish either
   *  week. */
  open_weeks: string[]
  /** Last Friday's "What are you committing to next week?", with the week it
   *  came from. Offered as the starting text of this week's intention box;
   *  null when there is nothing to carry forward. */
  lastCommitment: { week_start: string; commitment: string } | null
  /** Past weeks still open AND still closable, oldest first. Non-empty means
   *  the form is showing pending_close[0] rather than the current week, and
   *  the current week's Monday half is locked until it is closed. */
  pending_close: string[]
  /** The week the physio would be on if nothing were pending — so the form can
   *  name the week that is waiting while it shows an older one. */
  current_week_start: string
}

/**
 * Name and clinic are deliberately absent: the server takes both from the
 * logged-in account. Sending them would let one physio file under another.
 *
 * The whole Effectiveness / Mojo block lives on SubmitFridayPayload: `signals`
 * and the Mojo rating moved there 2026-09-04, `mojo_drain` / `mojo_action`
 * followed 2026-09-07. Monday is intention-setting only.
 */
export interface SubmitMondayPayload {
  kpis:                 [KpiLine, KpiLine, KpiLine]
  missed_goal_actions:  string | null
  counts:               WeeklyCounts
  intention:            string
  case_to_discuss:      string | null
  help_needed:          string | null
  checkin_needed:       boolean
  checkin_focus:        string | null
}

/**
 * effectiveness_rating is absent for a different reason than the rest — it is
 * DERIVED from `signals`, server side. The form shows a live score as the
 * physio answers, but that number is a preview: sending it would turn the
 * score from a calculation into a claim.
 *
 * mojo_drain / mojo_action joined this half on 2026-09-07 — the drain and the
 * action about it are end-of-week reflection, asked next to the rating they
 * explain.
 */
export interface SubmitFridayPayload {
  /** Which week to close. Omitted = the current week. A past week is accepted
   *  only while it is still open and inside the server's late-close window. */
  week_start?:     string
  wins:            string | null
  goal_achieved:   boolean
  goal_reflection: string | null
  flag_for_sam:    string | null
  best_behaviour:  string | null
  slipped:         string | null
  commitment:      string | null

  /** signal_id -> 0|1|2|3|null. Null is N/A. A signal left out entirely is
   *  treated as N/A too, and logged by the server as a client bug. */
  signals:      Record<string, SignalRating>
  mojo_rating:  number
  /** Multi-select — see DrainPicker. 'none' ("No drain") is exclusive. */
  mojo_drain:   string[]
  mojo_action:  string | null
}

export interface MissingClinician {
  clinician_id: string
  full_name:    string | null
  clinic_id:    ClinicId | null
}

export interface TrackerView {
  week_start: string
  week_end:   string
  rows:       WeeklyKpiDTO[]
  /** Roster clinicians with nothing recorded for this week. */
  missing:    MissingClinician[]
  /** Weeks that hold data, newest first — the week picker's options. */
  weeks:      string[]
  summary: {
    submitted:         number
    friday_closed:     number
    checkin_needed:    number
    avg_effectiveness: number | null
    avg_mojo:          number | null
  }
}

export interface TrackerFilters {
  /** Any date inside the week; the server normalises it to that Monday. */
  week?:         string
  clinic_id?:    ClinicId
  checkin_only?: boolean
  open_only?:    boolean
}

export interface PagedWeeklyKpi {
  data: WeeklyKpiDTO[]
  pagination: { limit: number; offset: number; total: number; hasMore: boolean }
}

/** One thread plus the id of whoever asked for it — the UI needs the viewer to
 *  tell its own messages from the other party's without trusting local state. */
export interface CommentThread {
  report_id: string
  viewer_id: string
  comments:  WeeklyKpiComment[]
}

/** A week with comments the caller has not read yet. */
export interface UnreadThread {
  report_id:  string
  week_start: string
  unread:     number
}

export interface UnreadSummary {
  total:   number
  threads: UnreadThread[]
}

/**
 * The signal registry, cached per version for the life of the page.
 *
 * It is the questionnaire — thirty rows of text, weights and bands that change
 * only when the model is retuned and the app redeployed — so re-fetching it per
 * mount would be a round trip for an identical answer. The promise itself is
 * cached rather than the value, so two components mounting together share one
 * request instead of racing two.
 *
 * Keyed by version because a history list can hold weeks scored under different
 * models, and each has to be explained by the one that produced it. '' is the
 * current model — the key the form uses.
 *
 * A failed fetch drops its entry: a form that could not load its questions must
 * be able to retry, not be stuck with a rejected promise for the session.
 */
const modelCache = new Map<string, Promise<KpiModel>>()

export const weeklyKpiApi = {
  /** The 30-signal registry. Omit `version` for the current model — what the
   *  form renders. Pass a row's `model_version` to explain a past score with
   *  the weights and band labels that actually produced it. */
  model: (version?: string): Promise<KpiModel> => {
    const key = version ?? ''
    const hit = modelCache.get(key)
    if (hit) return hit

    const p = api.get('/api/weekly-kpi/model', { params: { version } })
      .then(r => r.data as KpiModel)
      .catch(err => { modelCache.delete(key); throw err })

    modelCache.set(key, p)
    return p
  },

  /** Own current week (or a past one by any date inside it). */
  myWeek: (week?: string): Promise<MyWeekView> =>
    api.get('/api/weekly-kpi/me', { params: { week } }).then(r => r.data),

  myHistory: (limit?: number, offset?: number): Promise<PagedWeeklyKpi> =>
    api.get('/api/weekly-kpi/me/history', { params: { limit, offset } }).then(r => r.data),

  submitMonday: (payload: SubmitMondayPayload): Promise<WeeklyKpiDTO> =>
    api.post('/api/weekly-kpi/monday', payload).then(r => r.data),

  submitFriday: (payload: SubmitFridayPayload): Promise<WeeklyKpiDTO> =>
    api.post('/api/weekly-kpi/friday', payload).then(r => r.data),

  /** Super admin: the shared tracker for one week. */
  tracker: (filters: TrackerFilters = {}): Promise<TrackerView> =>
    api.get('/api/weekly-kpi/tracker', {
      params: {
        week:         filters.week || undefined,
        clinic_id:    filters.clinic_id || undefined,
        // Only send these when true — the server reads the literal 'true'.
        checkin_only: filters.checkin_only ? 'true' : undefined,
        open_only:    filters.open_only    ? 'true' : undefined,
      },
    }).then(r => r.data),

  /** Super admin: one physio's history, for the KPI tab on their profile. */
  clinicianHistory: (clinicianId: string, limit?: number, offset?: number): Promise<PagedWeeklyKpi> =>
    api.get(`/api/weekly-kpi/clinician/${clinicianId}/history`, { params: { limit, offset } })
      .then(r => r.data),

  /** One report in full — owner or super admin. */
  get: (id: string): Promise<WeeklyKpiDTO> =>
    api.get(`/api/weekly-kpi/${id}`).then(r => r.data),

  /** Super admin only: remove one week outright, comment thread and all. */
  deleteReport: (id: string): Promise<void> =>
    api.delete(`/api/weekly-kpi/${id}`).then(() => undefined),

  // ── Comment thread (migration 033) ─────────────────────────────────────────
  // Both sides of a thread use the same four calls; the server decides who is
  // allowed in. A non-participant gets a 404, so there is nothing to branch on
  // here by role.

  comments: (reportId: string): Promise<CommentThread> =>
    api.get(`/api/weekly-kpi/${reportId}/comments`).then(r => r.data),

  addComment: (reportId: string, body: string): Promise<WeeklyKpiComment> =>
    api.post(`/api/weekly-kpi/${reportId}/comments`, { body }).then(r => r.data),

  editComment: (commentId: string, body: string): Promise<WeeklyKpiComment> =>
    api.patch(`/api/weekly-kpi/comments/${commentId}`, { body }).then(r => r.data),

  deleteComment: (commentId: string): Promise<void> =>
    api.delete(`/api/weekly-kpi/comments/${commentId}`).then(() => undefined),

  /** "This thread is on screen." Clears the caller's unread count for it. */
  markThreadRead: (reportId: string): Promise<void> =>
    api.post(`/api/weekly-kpi/${reportId}/comments/read`).then(() => undefined),

  /** The notification poll: what is waiting for the logged-in account. */
  unread: (): Promise<UnreadSummary> =>
    api.get('/api/weekly-kpi/me/unread').then(r => r.data),
}
