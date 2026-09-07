import React, { useCallback, useEffect, useRef, useState } from 'react'
import { weeklyKpiApi, MyWeekView, SubmitMondayPayload, SubmitFridayPayload } from '../../api/weeklyKpi.api'
import {
  KpiLine, MOJO_RUBRIC, CLINIC_LABEL, ClinicId, SignalRating,
} from '../../types'
import { useKpiModel } from '../../lib/useKpiModel'
import { scoreLocally } from '../../lib/weeklyKpi.score'
import { useAuthStore } from '../../store/auth.store'
import { toast } from '../../store/toast.store'
import { confirmDialog } from '../../store/confirm.store'
import AppShell from '../shared/AppShell'
import WeeklyKpiHistory from './WeeklyKpiHistory'
import WeeklyKpiComments from './WeeklyKpiComments'
import { useWeeklyKpiUnreadStore } from '../../store/weeklyKpiUnread.store'
import {
  ACCENT, SURFACE, SURFACE_ALT, TEXT, TEXT_SOFT, TEXT_MUTED, TEXT_FAINT,
  BORDER, BORDER_MID, DANGER,
  weekLabel, stamp, Field, RatingScale, Rubric, YesNo, ErrorBanner, Note,
  Panel, PanelHeader, PageHeader, PillBtn, PillGroup, Loading, SectionLabel,
  captionStyle, pageSurface, inputStyle, textareaStyle, primaryBtnStyle,
  RatingLegend, SignalGroupPanel, ScoreSummary, DrainPicker,
  WeeklyKpiResponsiveStyles,
} from './weeklyKpi.ui'

/** The three KPI boxes are fixed to these since 2026-09-04 — Sam: "each
 *  clinician already has their own [numbers] automatically". Result is pulled
 *  from case_acceptances / patient_dropouts for the previous week (see
 *  AutoKpiTotals on the server) and is not typed in; only Target stays free
 *  text, in the same order these numbers come back from the API.
 *  Recommendation = Recs (avg), Conversion = Booked (avg) — the per-initial
 *  averages off the practitioner boards, per Sam 2026-09-07. */
const KPI_LABELS = ['Recommendation', 'Conversion', 'Cancellation %'] as const

/**
 * Team Performance KPI Reporting — the physio's own form.
 *
 * From "Weekly KPI & Wins Process — Build spec" (Sam, 2026-08-22). The spec
 * describes a Teams Adaptive Card driven by Power Automate; Sam's instruction
 * was to build it in the dashboard first ("sa teams wala na muna, sa dashboard
 * ko talaga gagawin muna yan"), so the fields, wording and Monday/Friday cycle
 * follow the spec exactly and none of the Teams plumbing exists.
 *
 * The spec's first two fields — Name and Clinic — are NOT on this form. A Teams
 * card has to ask because it does not know who is filling it in; this app does.
 * Both are shown read-only in the header so the physio can see what the report
 * will be filed against, and both come off the server's copy of the account.
 *
 * One card per person per week, Monday half then Friday half, both writing to
 * the same row — the spec's section 3, minus the message-ID bookkeeping that
 * only a Teams card needs. Here the row itself is the card.
 *
 * Visually this is the flat white system in weeklyKpi.ui (2026-08-24): a white
 * page, a typographic header instead of a dark hero band, and no gradient
 * anywhere. A form is a reading task before it is a filling-in task, so the
 * page gives it a single column, a lot of white space, and no decoration
 * competing with the questions.
 */

type Tab = 'monday' | 'friday'

/** Form state keeps '' rather than null: a controlled <input> with value={null}
 *  warns and goes uncontrolled. Nulling happens once, on submit. */
type KpiDraft = { name: string; target: string; result: string; hit: boolean | null }
const emptyDraft = (): KpiDraft => ({ name: '', target: '', result: '', hit: null })

function toKpiLine(d: KpiDraft): KpiLine {
  const t = (s: string) => { const v = s.trim(); return v === '' ? null : v }
  return { name: t(d.name), target: t(d.target), result: t(d.result), hit: d.hit }
}
function fromKpiLine(k: KpiLine): KpiDraft {
  return { name: k.name ?? '', target: k.target ?? '', result: k.result ?? '', hit: k.hit ?? null }
}
const orNull = (s: string): string | null => { const v = s.trim(); return v === '' ? null : v }

/** "The week in numbers" — hidden since 2026-09-04 on Sam's instruction
 *  ("wala pa naman ako month"): there is nowhere to move it to yet, so it is
 *  simply no longer collected. Always sent empty; the nine columns stay on the
 *  server and on the tracker/Excel export for whatever history already has. */
const EMPTY_COUNTS = {
  initials_seen: null, recommendations_full: null, plans_accepted_full: null,
  plans_accepted_part: null, dropouts_contacted: null, consults_recorded: null,
  calls_due: null, calls_made: null, cancellations_noshows: null,
}

export default function WeeklyKpiPage() {
  const { user } = useAuthStore()
  // Comments Sam has left that this physio has not opened yet. Polled in
  // App.tsx; read here to put the count where the work is.
  const unreadTotal   = useWeeklyKpiUnreadStore(s => s.total)
  const refreshUnread = useWeeklyKpiUnreadStore(s => s.refresh)

  const [view,    setView]    = useState<MyWeekView | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState('')
  const [tab,     setTab]     = useState<Tab>('monday')
  /** The server's `phase` only picks the tab on the FIRST load. Re-applying it
   *  after every submit bounced the physio back to Monday the moment they
   *  submitted Friday — phase stops saying 'friday' once the loop is closed. */
  const tabInitialised = useRef(false)
  /** Bumped after every successful submit so the history list below re-reads. */
  const [historyKey, setHistoryKey] = useState(0)

  // The 30-signal registry. Fetched, never mirrored into this app — the form
  // renders whatever the scorer says the questions are, so the two cannot drift.
  const { model, error: modelErr } = useKpiModel()

  // ── Monday half ───────────────────────────────────────────────────────────
  const [kpis,       setKpis]       = useState<KpiDraft[]>([emptyDraft(), emptyDraft(), emptyDraft()])
  const [missed,     setMissed]     = useState('')
  const [intention,  setIntention]  = useState('')
  /** Set when the intention box was opened with last Friday's commitment
   *  already in it (Sam, 2026-09-07). Holds the week that commitment came
   *  from, so the note under the box can say which Friday wrote it. Cleared
   *  the moment the physio edits the text — from then on it is their own
   *  sentence, not a carried-over draft. */
  const [carriedFrom, setCarriedFrom] = useState<string | null>(null)
  const [caseNote,   setCaseNote]   = useState('')
  const [helpNeeded, setHelpNeeded] = useState('')
  const [checkin,    setCheckin]    = useState<boolean | null>(null)
  const [checkinWhat, setCheckinWhat] = useState('')
  const [monErr,     setMonErr]     = useState('')
  const [savingMon,  setSavingMon]  = useState(false)

  // ── Friday half ───────────────────────────────────────────────────────────
  const [wins,       setWins]       = useState('')
  const [goalHit,    setGoalHit]    = useState<boolean | null>(null)
  const [bestBehav,  setBestBehav]  = useState('')
  const [slipped,    setSlipped]    = useState('')
  const [commitment, setCommitment] = useState('')
  const [flagSam,    setFlagSam]    = useState('')
  // Effectiveness + the Mojo RATING (only), moved here from Monday 2026-09-04
  // — the week is scored at its close, not its start. `answers`: signal_id ->
  // rating. `undefined` (absent) is "not answered yet", distinct from an
  // explicit N/A.
  const [answers,    setAnswers]    = useState<Record<string, SignalRating>>({})
  const [mojoRating, setMojoRating] = useState<number | null>(null)
  // Mojo questions 2 + 3 (drain type, one action for next week) followed the
  // rating here 2026-09-07 — the whole reflection is answered at the close of
  // the week it describes.
  const [drain,      setDrain]      = useState<string[]>([])
  const [mojoAction, setMojoAction] = useState('')
  const [friErr,     setFriErr]     = useState('')
  const [savingFri,  setSavingFri]  = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setLoadErr('')
    try {
      const v = await weeklyKpiApi.myWeek()
      setView(v)
      if (!tabInitialised.current) { setTab(v.phase); tabInitialised.current = true }

      // Prefill from whatever is already saved, so a re-submit corrects the week
      // instead of starting from blank and quietly wiping the rest of it.
      if (v.report) {
        const r = v.report
        setKpis(r.kpis.map(fromKpiLine))
        setMissed(r.missed_goal_actions ?? '')
        // Only a single-report read carries the ratings; if they are absent the
        // form stays empty rather than showing a half-remembered week.
        setAnswers(r.signals ?? {})
        setMojoRating(r.mojo_rating)
        setDrain(r.mojo_drain ?? [])
        setMojoAction(r.mojo_action ?? '')
        setIntention(r.intention)
        setCaseNote(r.case_to_discuss ?? '')
        setHelpNeeded(r.help_needed ?? '')
        setCheckin(r.checkin_needed)
        setCheckinWhat(r.checkin_focus ?? '')

        setWins(r.wins ?? '')
        setGoalHit(r.goal_achieved)
        setBestBehav(r.best_behaviour ?? '')
        setSlipped(r.slipped ?? '')
        setCommitment(r.commitment ?? '')
        setFlagSam(r.flag_for_sam ?? '')
        setCarriedFrom(null)
      } else {
        // No row for the week being served, so every field starts empty.
        //
        // The reset is NOT redundant. load() runs again after each submit, and
        // since 2026-09-07 the week it comes back with can be a DIFFERENT one:
        // closing a late week moves the form on to the current week, whose row
        // does not exist yet. Without this, last week's answers — its thirty
        // ratings, its mojo, its wins — would still be sitting in the form,
        // one click away from being submitted as the new week's.
        setKpis([emptyDraft(), emptyDraft(), emptyDraft()])
        setMissed('')
        setAnswers({})
        setMojoRating(null)
        setDrain([])
        setMojoAction('')
        setCaseNote('')
        setHelpNeeded('')
        setCheckin(null)
        setCheckinWhat('')
        setWins('')
        setGoalHit(null)
        setBestBehav('')
        setSlipped('')
        setCommitment('')
        setFlagSam('')
        setMonErr('')
        setFriErr('')

        if (v.lastCommitment) {
          // The intention box opens with what they committed to on the last
          // Friday they closed. A DRAFT — stored only if they submit it, and
          // editable first. Never applied over a saved intention (the branch
          // above), which would silently replace what they already wrote.
          setIntention(v.lastCommitment.commitment)
          setCarriedFrom(v.lastCommitment.week_start)
        } else {
          setIntention('')
          setCarriedFrom(null)
        }
      }

      // KPI boxes: name is always the fixed label, and Result always shows the
      // auto-computed figure for the previous week — never something the
      // physio typed. Applied after the report-prefill above (functional
      // update, so it composes with it rather than racing it) so Target and
      // `hit` stay whatever the saved report has. Cancellation is the one
      // percentage of the three (Sam, 2026-09-04); Recommendation and
      // Conversion are the clinician's own Recs (avg) / Booked (avg) — per
      // initial consult, not weekly totals (Sam, 2026-09-07).
      const autoVals = [v.autoKpis.recommendation, v.autoKpis.conversion, v.autoKpis.cancellationPct]
      const formatAuto = (i: number): string => {
        const val = autoVals[i]
        if (val === null) return ''
        return i === 2 ? `${val}%` : String(val)
      }
      setKpis(prev => prev.map((k, i) => ({
        ...k,
        name:   KPI_LABELS[i],
        result: formatAuto(i),
      })))
    } catch (e: any) {
      setLoadErr(e.response?.data?.error?.message || 'Could not load your week')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const report      = view?.report ?? null
  const openWeeks   = view?.open_weeks ?? []
  /** Past weeks still open and still closable, oldest first (server-computed).
   *  While this is non-empty the server is serving the FIRST of them instead of
   *  the current week, and the current week's Monday half is locked — Sam,
   *  2026-09-07: finish the old week before starting a new one. */
  const pendingClose  = view?.pending_close ?? []
  const closingLate   = pendingClose.length > 0 && view?.week_start === pendingClose[0]
  /** Open weeks too old to close — the block never applies to these, so they
   *  are the only ones that stay a dead loss, and they are reported as such. */
  const lapsedWeeks   = openWeeks.filter(w => !pendingClose.includes(w))

  // A late close leaves nothing to do on the Monday tab, and the server refuses
  // it anyway. Snap to Friday if a stale tab selection survives a reload.
  useEffect(() => { if (closingLate && tab === 'monday') setTab('friday') }, [closingLate, tab])
  const mondayDone  = report !== null
  const fridayDone  = report?.friday_submitted_at != null
  const clinicName  = user?.clinic_id ? CLINIC_LABEL[user.clinic_id as ClinicId] : null

  // The live score. Recomputed on every answer, and explicitly a PREVIEW: the
  // server scores the raw ratings again on submit and its number is the one
  // that is stored. Nothing below ever sends this.
  const liveScore = model ? scoreLocally(model, answers) : null
  const unanswered = model
    ? model.signals.filter(s => answers[s.signal_id] === undefined).length
    : 0

  const setAnswer = useCallback((signalId: string, v: SignalRating) => {
    setAnswers(prev => ({ ...prev, [signalId]: v }))
  }, [])

  const submitMonday = async () => {
    setMonErr('')

    // Client-side mirror of the server's rules, purely so the physio is told
    // which box to fix instead of getting one banner back from the API.
    const first = toKpiLine(kpis[0])
    if (!first.name && !first.target && !first.result) {
      setMonErr('Fill in at least KPI #1 — its name, target or result.'); return
    }
    if (!intention.trim())   { setMonErr('Intentions for the week is required.'); return }
    if (checkin === null)    { setMonErr('Answer whether you need a 15-minute check-in.'); return }

    // "basta lagi meron validation, are you sure submit" — Sam, 2026-08-24.
    const okToSubmit = await confirmDialog.ask({
      title: mondayDone ? 'Update your Monday half?' : 'Submit your Monday half?',
      message: [
        weekLabel(view!.week_start),
        '',
        `15-minute check-in: ${checkin ? 'Yes, please' : 'Not needed'}`,
        '',
        mondayDone
          ? `This replaces what you submitted on ${stamp(report!.monday_submitted_at)}.`
          : 'This shows on the team tracker. You can still change it any time this week.',
      ].join('\n'),
      confirmLabel: mondayDone ? 'Update Monday' : 'Submit Monday',
      cancelLabel:  'Keep editing',
    })
    if (!okToSubmit) return

    const payload: SubmitMondayPayload = {
      kpis: [
        toKpiLine(kpis[0] ?? emptyDraft()),
        toKpiLine(kpis[1] ?? emptyDraft()),
        toKpiLine(kpis[2] ?? emptyDraft()),
      ] as [KpiLine, KpiLine, KpiLine],
      missed_goal_actions:  orNull(missed),
      counts:               EMPTY_COUNTS,
      intention:            intention.trim(),
      case_to_discuss:      orNull(caseNote),
      help_needed:          orNull(helpNeeded),
      checkin_needed:       checkin,
      // Only send the focus when a check-in was actually asked for; the server
      // rejects the contradiction rather than storing a note against a
      // check-in nobody wants.
      checkin_focus:        checkin ? orNull(checkinWhat) : null,
    }

    setSavingMon(true)
    try {
      await weeklyKpiApi.submitMonday(payload)
      toast.success(mondayDone ? 'Monday updated' : 'Monday submitted — come back Friday to close the loop')
      setHistoryKey(k => k + 1)
      await load()
    } catch (e: any) {
      const msg = e.response?.data?.error?.message || 'Could not submit'
      setMonErr(msg); toast.error(msg)
    } finally { setSavingMon(false) }
  }

  const submitFriday = async () => {
    setFriErr('')
    if (goalHit === null) {
      setFriErr('Answer whether you achieved your Monday intention.'); return
    }
    // Effectiveness + the Mojo rating moved here from Monday, 2026-09-04 —
    // same rule the Monday half used to enforce for the rating, just closing
    // out the week instead of opening it. Drain/action stayed on Monday.
    if (!model) { setFriErr('The check-in questions have not loaded yet. Reload the page.'); return }
    if (unanswered > 0) {
      setFriErr(
        `${unanswered} behaviour${unanswered === 1 ? '' : 's'} still unrated. ` +
        'Use N/A for anything that did not arise this week.'
      )
      return
    }
    if (mojoRating === null)   { setFriErr('Pick a Mojo (energy) rating from 1–10.'); return }
    if (drain.length === 0)    { setFriErr('Pick what kind of drain the week was — or "No drain".'); return }

    // Same confirmation on this half — "para ganon lagi". Submitting Friday is
    // the same act as Monday from the physio's side: it goes straight onto
    // Sam's tracker.
    const okToSubmit = await confirmDialog.ask({
      title: fridayDone ? 'Update your Friday half?' : 'Close the loop on this week?',
      message: [
        weekLabel(view!.week_start),
        '',
        `Achieved your Monday intention: ${goalHit ? 'Yes' : 'No'}`,
        '',
        // The score is quoted as a preview, not as a result — the server has the
        // last word on it, and a dialog that states it flatly would be wrong on
        // the day the two ever disagree.
        `Effectiveness ${liveScore?.score?.toFixed(1) ?? '—'}/10 (preview) · Mojo ${mojoRating}/10`,
        ...(liveScore && liveScore.standards_missed.length > 0
          ? [`${liveScore.standards_missed.length} Standard${liveScore.standards_missed.length === 1 ? '' : 's'} rated 0 or 1`]
          : []),
        ...(liveScore && liveScore.na_count >= model.na_count_review_at
          ? [`${liveScore.na_count} of 30 marked N/A — this gets flagged for review`]
          : []),
        '',
        fridayDone
          ? `This replaces what you submitted on ${stamp(report!.friday_submitted_at!)}.`
          : 'This closes your week. You can still change it until the week rolls over.',
      ].join('\n'),
      confirmLabel: fridayDone ? 'Update Friday' : 'Submit Friday',
      cancelLabel:  'Keep editing',
    })
    if (!okToSubmit) return

    const payload: SubmitFridayPayload = {
      // Always explicit, even for the current week: the server must close the
      // week the physio was actually looking at. Reading the week off the view
      // rather than off the clock is also what makes a late close safe — the
      // page cannot answer one week's questions into another week's row.
      week_start:      view!.week_start,
      wins:            orNull(wins),
      goal_achieved:   goalHit,
      // No longer asked (2026-09-07) — always null. The server still accepts
      // the field, and only when the goal was missed, so sending null is valid
      // on both branches.
      goal_reflection: null,
      flag_for_sam:    orNull(flagSam),
      best_behaviour:  orNull(bestBehav),
      slipped:         orNull(slipped),
      commitment:      orNull(commitment),
      // Ratings only. The score is deliberately NOT sent: it is computed on the
      // server from exactly these values.
      signals:         answers,
      mojo_rating:     mojoRating,
      mojo_drain:      drain,
      mojo_action:     orNull(mojoAction),
    }

    setSavingFri(true)
    try {
      await weeklyKpiApi.submitFriday(payload)
      toast.success(
        fridayDone   ? 'Friday updated'
        : closingLate ? `Week of ${weekLabel(view!.week_start)} closed — your current week is open now.`
        : 'Thanks for closing the loop on your week. See you Monday.')
      setHistoryKey(k => k + 1)
      // A late close hands the physio the week they actually came for, and that
      // week starts on its Monday half — so land them there rather than on a
      // Friday tab telling them to go and fill Monday in.
      if (closingLate) setTab('monday')
      await load()
    } catch (e: any) {
      const msg = e.response?.data?.error?.message || 'Could not submit'
      setFriErr(msg); toast.error(msg)
    } finally { setSavingFri(false) }
  }

  return (
    // withHeader={false}: the PageHeader below is this page's header.
    <AppShell withHeader={false} title="Team Performance KPI Reporting">
      <div style={pageSurface}>
        <div className="pw-page pw-kpi-page" style={{ maxWidth: 780, margin: '0 auto', padding: '34px 24px 80px' }}>

          {/* ══ Header ═════════════════════════════════════════════════════
              The physio's name, as read-only identity rather than as an input,
              so they can see what they are filing as.

              The CLINIC was dropped from this line 2026-09-07 (Sam) — it is
              still what the report is filed against, taken from the account and
              never typed, but the physio already knows which clinic they work
              at and it was the longest thing in the header. The one case that
              still has to be said out loud is the account with NO clinic, since
              nothing can be filed then — that is the warning below, not here. */}
          <PageHeader
            eyebrow="Team performance KPI"
            title={view ? weekLabel(view.week_start) : 'This week'}
            meta={
              <span style={{ color: TEXT, fontWeight: 500 }}>
                {user?.full_name || 'Your account'}
              </span>
            }
          />

          {!clinicName && (
            <Note tone="warn">
              Your account has no default clinic, so a report cannot be filed yet.
              Ask the admin to set your clinic in User Management.
            </Note>
          )}

          {/* Weeks this physio never closed on Friday (2026-09-07).
              A REMINDER, not a gate. Sam asked whether Monday should be locked
              until the previous week is closed; it must not be — a past week is
              frozen, so they could neither finish the old week nor start the
              new one, and the tracker would lose the new week's data to punish
              the old week's omission. Sam sees the same thing from his side via
              the tracker's "Friday still open" filter. */}
          {closingLate && (
            <Note tone="warn">
              <strong>Finish the week of {weekLabel(view!.week_start)} first.</strong> Its Friday
              half was never filled in, so the form is showing that week — close it below and
              the week of {weekLabel(view!.current_week_start)} opens straight after.
              {pendingClose.length > 1 && <> {pendingClose.length - 1} older week
                {pendingClose.length > 2 ? 's' : ''} after this one.</>}
            </Note>
          )}

          {lapsedWeeks.length > 0 && (
            <Note tone="warn">
              {lapsedWeeks.length === 1
                ? <>The week of {weekLabel(lapsedWeeks[0])} was never closed.</>
                : <>{lapsedWeeks.length} earlier weeks were never closed, the most recent being {weekLabel(lapsedWeeks[0])}.</>}
              {' '}Too long ago to fill in now — those stay open on the tracker.
            </Note>
          )}

          {/* The notification. No push channel exists in this app (Teams is off
              on prod, no email sender), so the physio is told here and by the
              badge on the hub card — both fed by the same polled count. */}
          {unreadTotal > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
              background: SURFACE_ALT, borderRadius: 12, padding: '13px 16px', marginBottom: 20,
            }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%', background: ACCENT, flexShrink: 0,
              }} />
              <span style={{ fontSize: 13.5, color: TEXT_SOFT, lineHeight: 1.5 }}>
                <strong style={{ color: TEXT, fontWeight: 600 }}>
                  {unreadTotal} new comment{unreadTotal === 1 ? '' : 's'} from Sam
                </strong>{' '}
                on your weekly KPI. Open the week below to read and reply.
              </span>
            </div>
          )}

          <ErrorBanner message={loadErr} />

          {loading && <Loading text="Loading your week…" />}

          {!loading && view && (
            <>
              {/* ── Monday / Friday toggle ──
                  Both halves stay reachable all week. The spec has the Friday
                  fields appear on Friday, but a physio whose week ends Thursday
                  still has to be able to close it — so the day only decides which
                  tab OPENS (see `phase` on the server), never which is allowed. */}
              <div style={{ marginBottom: 20 }}>
                <PillGroup>
                  {/* Locked, not hidden: the physio has to be able to see that
                      the week they came for exists and why it is not open yet. */}
                  <TabBtn
                    label={closingLate ? 'Monday · locked' : 'Monday'}
                    active={tab === 'monday'}
                    done={mondayDone}
                    disabled={closingLate}
                    onClick={() => { if (!closingLate) setTab('monday') }}
                  />
                  <TabBtn label="Friday" active={tab === 'friday'} done={fridayDone} onClick={() => setTab('friday')} />
                </PillGroup>
              </div>

              {tab === 'monday' && (
                <Panel pad="26px 28px 30px">
                  <PanelHeader
                    title="Monday — set up your week"
                    subtitle="Last week's KPIs, how the week went, and what you are working on next."
                  />
                  {mondayDone && (
                    <Note tone="good">
                      Submitted {stamp(report!.monday_submitted_at)}. You can still change
                      it this week — saving again replaces what is here.
                    </Note>
                  )}

                  <ErrorBanner message={monErr} />

                  <Field
                    label="My KPIs for the previous week"
                    required
                    hint="Recommendation, Conversion and Cancellation % — Result is filled in automatically from last week's numbers: Recommendation and Conversion are your Recs (avg) and Booked (avg) per initial consult; Cancellation % is your dropout entries (excluding Completed Treatment Plan) divided by Total Appts. Target is yours to set."
                  >
                    {/* Column headers for the wide layout. Hidden on a phone,
                        where the row stacks — a header row over a stacked
                        column labels nothing. Nothing is LOST there: each
                        field carries its own label below, which is hidden
                        here instead. The two are exclusive, never both, never
                        neither. */}
                    <div className="pw-kpi-row pw-kpi-head" style={{
                      display:'grid', gridTemplateColumns:'1fr 108px 108px', gap:8,
                      ...captionStyle, marginBottom:7,
                    }}>
                      <span>KPI</span><span>Target</span><span>Result</span>
                    </div>
                    {kpis.map((k, i) => (
                      <div key={i} className="pw-kpi-row" style={{
                        display:'grid', gridTemplateColumns:'1fr 108px 108px', gap:8, marginBottom:8,
                      }}>
                        <div style={{ display:'block', minWidth:0 }}>
                          <span className="pw-kpi-fieldlabel" style={captionStyle}>KPI</span>
                          <span style={{ fontSize:13.5, fontWeight:500, color:TEXT }}>{KPI_LABELS[i]}</span>
                        </div>
                        <label style={{ display:'block', minWidth:0 }}>
                          <span className="pw-kpi-fieldlabel" style={captionStyle}>Target</span>
                          <input
                            value={k.target}
                            onChange={e => setKpis(prev => prev.map((p, j) => j === i ? { ...p, target: e.target.value } : p))}
                            placeholder="Target"
                            style={inputStyle}
                          />
                        </label>
                        <label style={{ display:'block', minWidth:0 }}>
                          <span className="pw-kpi-fieldlabel" style={captionStyle}>Result</span>
                          <input
                            value={k.result}
                            readOnly
                            disabled
                            placeholder="—"
                            title="Filled in automatically from last week's numbers"
                            style={{ ...inputStyle, color:TEXT_MUTED, background:SURFACE_ALT, cursor:'not-allowed' }}
                          />
                        </label>
                      </div>
                    ))}
                  </Field>

                  <Field
                    label="If you did not hit the goal"
                    hint="What will you do differently this week to ensure you hit your target. Focus on what actions you are going to take, not the numbers themselves."
                  >
                    <textarea value={missed} onChange={e => setMissed(e.target.value)} style={textareaStyle} />
                  </Field>

                  {/* The whole Effectiveness / Mojo block is on the Friday
                      half: the signals and the rating moved 2026-09-04, the
                      drain type and the one action followed 2026-09-07 — the
                      week is reflected on at its close, not its start.
                      "The week in numbers" is hidden the same way (Sam: no
                      Monthly view exists yet to move it to). */}

                  <Field
                    label="Intentions for the week"
                    required
                    hint="One thing you want to work on, and the action you are taking to get there."
                  >
                    {/* While the box still holds the carried-over commitment
                        it is labelled INSIDE its own frame, italic, exactly as
                        Sam mocked it up: "Last Friday's Commitment (Draft):"
                        sitting above the text. The label is markup, never part
                        of the value — it must not end up submitted as part of
                        the intention. Both the label and the italics go on the
                        first keystroke: from then on the sentence is theirs. */}
                    <div style={carriedFrom ? {
                      border: `1px solid ${BORDER_MID}`, borderRadius: 9,
                      background: SURFACE, padding: '10px 12px',
                    } : undefined}>
                      {carriedFrom && (
                        <div style={{
                          fontSize: 13, fontStyle: 'italic', color: TEXT_SOFT, marginBottom: 4,
                        }}>
                          Last Friday's Commitment (Draft):
                        </div>
                      )}
                      <textarea
                        value={intention}
                        onChange={e => { setIntention(e.target.value); setCarriedFrom(null) }}
                        placeholder="e.g. I want to reduce documentation backlog — I'll block 20 minutes after each patient to finish notes immediately."
                        style={carriedFrom ? {
                          // Borderless inside the frame above — one box, not a
                          // box within a box.
                          ...textareaStyle,
                          border: 'none', padding: 0, minHeight: 56,
                          fontStyle: 'italic', color: TEXT_SOFT,
                        } : textareaStyle}
                      />
                    </div>
                    {carriedFrom && (
                      <div style={{ ...captionStyle, marginTop: 8, fontStyle: 'italic' }}>
                        Carried over from Friday of {weekLabel(carriedFrom)} — edit it or write
                        something else. Nothing is saved until you submit.
                      </div>
                    )}
                  </Field>

                  <Field
                    label="Is there a case you want to touch on at this week's meeting?"
                    hint="If so, add a note here so we can run through it together."
                  >
                    <textarea value={caseNote} onChange={e => setCaseNote(e.target.value)} style={textareaStyle} />
                  </Field>

                  <Field label="What do you need help with">
                    <textarea
                      value={helpNeeded}
                      onChange={e => setHelpNeeded(e.target.value)}
                      placeholder="Be clear and direct. This helps managers support you faster and better."
                      style={textareaStyle}
                    />
                  </Field>

                  <Field
                    label="Do you need a 15-minute check-in?"
                    required
                    hint="If you've filled in the box above about needing help, select Yes."
                  >
                    <YesNo value={checkin} onChange={setCheckin} />
                    {/* Conditional, exactly as the spec has it: shown only on Yes. */}
                    {checkin === true && (
                      <div style={{ marginTop: 18 }}>
                        <Field
                          label="If yes, what do you want to discuss?"
                          hint="For example, KPIs, workload, confidence, process clarity, etc."
                        >
                          <textarea
                            value={checkinWhat}
                            onChange={e => setCheckinWhat(e.target.value)}
                            style={textareaStyle}
                          />
                        </Field>
                      </div>
                    )}
                  </Field>

                  <button
                    onClick={submitMonday}
                    disabled={savingMon || !clinicName}
                    style={{
                      ...primaryBtnStyle, width:'100%',
                      opacity: savingMon || !clinicName ? 0.4 : 1,
                      cursor:  savingMon || !clinicName ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {savingMon ? 'Saving…' : mondayDone ? 'Update Monday' : 'Submit Monday'}
                  </button>
                </Panel>
              )}

              {tab === 'friday' && (
                <Panel pad="26px 28px 30px">
                  <PanelHeader
                    title={closingLate
                      ? `Friday — close the week of ${weekLabel(view!.week_start)}`
                      : 'Friday — close the loop on this week'}
                    subtitle={closingLate
                      ? 'Filling this in late. The submitted-on stamp is today, so the tracker shows it was closed after the week ended.'
                      : 'How the week actually went against the intention you set on Monday.'}
                  />

                  {/* The Friday half answers "did you achieve your Monday goal",
                      so with no Monday row there is nothing to answer against.
                      The server refuses it too; this just says so up front. */}
                  {!mondayDone ? (
                    <>
                      <Note tone="warn">
                        Fill in the Monday half first — these questions close the loop on
                        that week's intention.
                      </Note>
                      <button onClick={() => setTab('monday')} style={{ ...primaryBtnStyle, width:'100%' }}>
                        Go to the Monday half
                      </button>
                    </>
                  ) : (
                    <>
                      {fridayDone && (
                        <Note tone="good">
                          Submitted {stamp(report!.friday_submitted_at!)}. You can still change
                          it this week — saving again replaces what is here.
                        </Note>
                      )}

                      {/* Reminding the physio what they committed to on Monday is
                          the whole point of the Friday half — asking "did you hit
                          it?" without showing the goal invites a guess. The two
                          questions that answer it sit directly under this recap
                          since 2026-09-07: the goal, then how it went, before
                          the form moves on to the thirty behaviours. */}
                      <div style={{
                        background: SURFACE_ALT, borderRadius: 12,
                        padding: '15px 18px', marginBottom: 26,
                      }}>
                        <div style={{ ...captionStyle, marginBottom: 7 }}>Your Monday intention</div>
                        <div style={{ fontSize: 14, color: TEXT, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                          {report!.intention}
                        </div>
                      </div>

                      <ErrorBanner message={friErr} />

                      <Field label="What went well this week?">
                        <textarea value={wins} onChange={e => setWins(e.target.value)} style={textareaStyle} />
                      </Field>

                      {/* Yes/No only. The spec's follow-up on No — "why do you
                          think that was?" — was removed 2026-09-07: it asked for
                          the same answer as "What slipped" further down, and one
                          question answered twice is one answer thinned out. The
                          goal_reflection column stays, so weeks that already have
                          one still show it in the history view. */}
                      <Field label="Did you achieve your Monday intention?" required>
                        <YesNo value={goalHit} onChange={setGoalHit} />
                      </Field>

                      {/* ══ Effectiveness — the 30 behaviours ══════════════════
                          Moved here from Monday, 2026-09-04: the week is rated
                          at its close, not its start. Replaces the old
                          hand-picked 1–10 — the number now comes from what you
                          actually did rather than from where you feel you
                          landed on a scale. The score is computed on the
                          server from these ratings.

                          Questions, weights and bands all come from the served
                          registry — this file contains none of them, so the
                          form cannot ask something the scorer does not know
                          about. */}
                      <div style={{ margin:'8px 0 26px' }}>
                        <SectionLabel>Effectiveness · what you did</SectionLabel>
                        <div style={{ fontSize:13.5, color:TEXT_SOFT, lineHeight:1.6, marginBottom:18 }}>
                          Rate every line honestly — not what you meant to do, what you actually
                          did. A Standard is expected every week, not a stretch goal. This rates
                          the behaviours you controlled, not whether you hit your numbers.
                        </div>

                        <ErrorBanner message={modelErr} />

                        {!model && !modelErr && <Loading text="Loading the check-in questions…" />}

                        {model && (
                          <>
                            <RatingLegend />
                            {liveScore && <ScoreSummary model={model} score={liveScore} />}

                            {model.groups.map(g => (
                              <SignalGroupPanel
                                key={g.group_id}
                                group={g}
                                signals={model.signals.filter(s => s.group_id === g.group_id)}
                                answers={answers}
                                onChange={setAnswer}
                                pct={liveScore?.groups.find(x => x.group_id === g.group_id)?.pct ?? null}
                              />
                            ))}
                          </>
                        )}
                      </div>

                      {/* ══ Mojo — three questions ═════════════════════════════
                          Kept visually separate from Effectiveness above, because
                          the sheet is emphatic that the two are not the same kind
                          of thing: "Your Mojo number is never used to rate you." */}
                      <div style={{ margin:'36px 0 8px' }}>
                        <SectionLabel>Mojo · how you are holding up</SectionLabel>
                        <div style={{ fontSize:13.5, color:TEXT_SOFT, lineHeight:1.6, marginBottom:18 }}>
                          Never used to rate you. Not compared to anyone else's, not part of your
                          Effectiveness score, not part of a performance conversation. It is a
                          thermometer — its job is to point you at the right response, and to
                          flag when you need support before it becomes a problem.
                          A low number here is information, not failure.
                        </div>
                      </div>

                      <Field
                        label="Mojo (energy) rating (1–10)"
                        required
                        hint="This is about your state — not what you produced."
                      >
                        <RatingScale value={mojoRating} onChange={setMojoRating} isMojo />
                        <Rubric bands={MOJO_RUBRIC} active={mojoRating} />
                      </Field>

                      {/* Mojo questions 2 + 3, moved off the Monday half
                          2026-09-07. They sit directly under the rating: the
                          drain explains the number just given, and the action
                          is the response to it. */}
                      <Field
                        label="What kind of drain/s was it?"
                        required
                        hint="Choose every kind that applied — different drains need different responses, and the wrong strategy on the right drain does nothing."
                      >
                        {model
                          ? <DrainPicker types={model.drain_types} value={drain} onChange={setDrain} />
                          : <div style={{ fontSize:13, color:TEXT_FAINT }}>Loading…</div>}
                      </Field>

                      <Field
                        label="One thing you will do next week — and when"
                        hint="One action, matched to the drain you picked. Not a list. Put it in your calendar before you finish."
                      >
                        <textarea
                          value={mojoAction}
                          onChange={e => setMojoAction(e.target.value)}
                          placeholder="e.g. Wednesday 6am gym before the early list — booked in my calendar."
                          style={textareaStyle}
                        />
                      </Field>

                      {/* The reflection block from the Weekly Check-In sheet.
                          Its fourth question is the flag below — one field, not
                          two under different names. */}
                      <Field
                        label="Which behaviour made the biggest difference this week?"
                        hint="The one thing worth repeating. Name it so you can do it again on purpose."
                      >
                        <textarea value={bestBehav} onChange={e => setBestBehav(e.target.value)} style={textareaStyle} />
                      </Field>

                      <Field
                        label="What slipped?"
                        hint="Honestly. A named gap is worth more than a clean-looking week."
                      >
                        <textarea value={slipped} onChange={e => setSlipped(e.target.value)} style={textareaStyle} />
                      </Field>

                      <Field
                        label="What are you committing to next week?"
                        hint="One commitment, specific enough that you will know on Friday whether you did it."
                      >
                        <textarea value={commitment} onChange={e => setCommitment(e.target.value)} style={textareaStyle} />
                      </Field>

                      <Field label="Anything else you want to flag before the week ends?">
                        <textarea value={flagSam} onChange={e => setFlagSam(e.target.value)} style={textareaStyle} />
                      </Field>

                      <button
                        onClick={submitFriday}
                        disabled={savingFri}
                        style={{
                          ...primaryBtnStyle, width:'100%',
                          opacity: savingFri ? 0.4 : 1,
                          cursor:  savingFri ? 'not-allowed' : 'pointer',
                        }}
                      >
                        {savingFri ? 'Saving…' : fridayDone ? 'Update Friday' : 'Submit Friday'}
                      </button>
                    </>
                  )}
                </Panel>
              )}

              {/* This week's thread. Only once the Monday half exists — there
                  is no report to comment on before that, and the endpoint is
                  keyed on the report, not on the week. */}
              {report && (
                <Panel pad="4px 28px 26px" style={{ marginTop: 16 }}>
                  <WeeklyKpiComments
                    reportId={report.id}
                    ownerName={user?.full_name ?? null}
                    onChanged={() => { refreshUnread(); setHistoryKey(k => k + 1) }}
                  />
                </Panel>
              )}

              {/* ── Own history — "para may history" ── */}
              <div style={{ marginTop: 48, borderTop: `1px solid ${BORDER}`, paddingTop: 28 }}>
                <h2 style={{
                  margin: 0, fontSize: 19, fontWeight: 600, color: TEXT, letterSpacing: '-0.02em',
                }}>
                  Previous weeks
                </h2>
                <div style={{ fontSize: 13.5, color: TEXT_MUTED, margin: '6px 0 18px' }}>
                  Every week you have reported, newest first. Select one to open it
                  in the side panel.
                </div>
                {/* drawer: Sam, 2026-09-01 — "imbis pababa yan pa sidebar na din
                    details". A week now carries the 30-behaviour breakdown and
                    the counts block, so opening one in place pushed the rest of
                    the list far off the screen. */}
                <WeeklyKpiHistory mine drawer refreshKey={historyKey} />
              </div>
            </>
          )}
        </div>
      </div>

      {/* Every breakpoint this feature has, in one place — see the component. */}
      <WeeklyKpiResponsiveStyles />
    </AppShell>
  )
}

/** Segment in the Monday/Friday control. The tick says which half is already
 *  in, so the physio can see at a glance which of the two still needs them. */
function TabBtn({
  label, active, done, onClick, disabled = false,
}: {
  label: string
  active: boolean
  done: boolean
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <PillBtn
      active={active}
      onClick={onClick}
      disabled={disabled}
      label={
        <span style={{ display:'inline-flex', alignItems:'center', gap:7 }}>
          {label}
          {done && (
            <span style={{ color: active ? ACCENT : TEXT_MUTED, fontSize: 12, lineHeight: 1 }} title="Submitted">
              ✓
            </span>
          )}
        </span>
      }
    />
  )
}
