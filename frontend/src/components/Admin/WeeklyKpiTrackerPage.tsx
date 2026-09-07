import React, { useCallback, useEffect, useState } from 'react'
import { weeklyKpiApi, TrackerView } from '../../api/weeklyKpi.api'
import { WeeklyKpiDTO, CLINIC_LABEL, ClinicId } from '../../types'
import { useNavStore } from '../../store/nav.store'
import AppShell from '../shared/AppShell'
import WeeklyKpiDrawer from '../WeeklyKpi/WeeklyKpiDrawer'
import { exportWeeklyKpiXlsx } from '../../lib/exportWeeklyKpiXlsx'
import {
  ACCENT, ACCENT_SOFT, SURFACE, SURFACE_ALT, BORDER, BORDER_MID, TRACK,
  TEXT, TEXT_SOFT, TEXT_MUTED, TEXT_FAINT, AMBER,
  BAND_COLORS, bandKeyFor, FONT, MONO, captionStyle, pageSurface,
  weekLabel, mondayOf, todayISO, addDays, clinicLabel,
  Chip, RatingMeter, Avatar, ProgressRing, Panel, PageHeader, PanelHeader,
  PillBtn, PillGroup, EmptyState, ErrorBanner, Loading, smallBtnStyle,
  CLINIC_ORDER,
} from '../WeeklyKpi/weeklyKpi.ui'

/**
 * Team Performance KPI Reporting — the shared tracker.
 *
 * This is spec section 8, "Teams tab — shared visibility", rebuilt as a page in
 * this app: Sam's instruction was to do the dashboard first and leave Teams
 * alone. Same job the SharePoint list tab was for — one row per physio per
 * week, everyone's week visible in one place, no separate report to run.
 *
 * The spec calls out a column trade-off and picks a side, which is what this
 * follows: the table carries only the fields worth a quick scan (Name, Clinic,
 * Week, Intention, Effectiveness, Mojo, Goal hit, Check-in needed) and the rest
 * — KPI detail, wins, reflections, the case to discuss — is behind clicking
 * into the row. "Too much on the surface means Sam scans nothing properly."
 *
 * Clicking a row opens that report in a right-hand DRAWER (WeeklyKpiDrawer),
 * not in an accordion under the row. Sam, 2026-08-24: "imbis na pababa ung info
 * … sidebar dapat". A report is long enough that expanding it in place pushed
 * the rest of the team off the screen — which defeats the point of a page whose
 * job is comparing people within one week.
 *
 * One addition the spec does not have, because a SharePoint list cannot show
 * it: who has NOT submitted. A list only ever shows rows that exist, so a
 * physio who skipped the week is invisible in it — which is exactly the person
 * Sam most needs to see.
 *
 * ── On the visual design (revised 2026-08-24) ──
 * Sam's brief: minimalist, white, flat, Apple-like. So: no hero band, no
 * gradients, no glows, no shadows. Structure comes from hairlines and spacing,
 * hierarchy from type size and weight, and colour is spent only where it means
 * something — a critical mojo, a requested check-in, a selected control. Every
 * primitive lives in weeklyKpi.ui so this page and the physio's form cannot
 * drift apart.
 */

export default function WeeklyKpiTrackerPage() {
  const { navigate } = useNavStore()

  const [week,        setWeek]        = useState(() => mondayOf(todayISO()))
  const [clinic,      setClinic]      = useState<ClinicId | ''>('')
  const [checkinOnly, setCheckinOnly] = useState(false)
  const [openOnly,    setOpenOnly]    = useState(false)

  const [view,    setView]    = useState<TrackerView | null>(null)
  const [exporting, setExporting] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  /** The row whose report is open in the side drawer. */
  const [openId,  setOpenId]  = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const v = await weeklyKpiApi.tracker({
        week,
        clinic_id:    clinic || undefined,
        checkin_only: checkinOnly,
        open_only:    openOnly,
      })
      setView(v)
    } catch (e: any) {
      setError(e.response?.data?.error?.message || 'Failed to load the tracker')
    } finally { setLoading(false) }
  }, [week, clinic, checkinOnly, openOnly])

  useEffect(() => { load() }, [load])

  /** Build the .xlsx from the view already on screen — no refetch, so the file
   *  and the page can never disagree. Errors surface in the page's own banner
   *  rather than a browser alert. */
  const onExport = useCallback(async () => {
    if (!view) return
    setExporting(true); setError('')
    try {
      await exportWeeklyKpiXlsx(view, {
        clinic, checkinOnly, openOnly,
      })
    } catch (e: any) {
      setError(e?.message || 'Could not build the Excel file')
    } finally { setExporting(false) }
  }, [view, clinic, checkinOnly, openOnly])
  // A drawer open on one week must not survive a change of week or filter —
  // the row behind it may no longer be in the list.
  useEffect(() => { setOpenId(null) }, [week, clinic, checkinOnly, openOnly])

  const rows      = view?.rows ?? []
  const missing   = view?.missing ?? []
  const rosterAll = rows.length + missing.length
  const isThisWeek = week === mondayOf(todayISO())
  const filtered   = checkinOnly || openOnly

  // Grouped by clinic — the spec's "grouped by Clinic or Name". Clinic wins:
  // the pilot is per-clinic (Brookvale first) and the clinics run differently
  // enough that a mixed list invites comparing across ones that don't compare.
  const grouped = CLINIC_ORDER
    .map(c => ({ clinic: c, items: rows.filter(r => r.clinic_id === c) }))
    .filter(g => g.items.length > 0)

  // Resolved from the freshly loaded rows rather than stashed on open, so the
  // drawer redraws with the row after a comment changes its counts.
  const openReport = openId ? rows.find(r => String(r.id) === String(openId)) ?? null : null
  // Nothing loaded, nothing in it, or a build already running — a button that
  // can produce an empty file makes a loaded week look like a missing one.
  const canExport = !!view && !exporting && (rows.length > 0 || missing.length > 0)

  // Effectiveness and Mojo are null on any row still open on Friday, so this
  // averages over the rows that HAVE a number, not over every row in the group.
  const avg = (items: WeeklyKpiDTO[], pick: (r: WeeklyKpiDTO) => number | null) => {
    const vals = items.map(pick).filter((v): v is number => v !== null)
    return vals.length === 0 ? null
      : Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10
  }

  return (
    // withHeader={false}: the PageHeader below is this page's header.
    <AppShell withHeader={false} title="Team Performance KPI">
      <div style={pageSurface}>
        <div className="pw-page" style={{ maxWidth: 1240, margin: '0 auto', padding: '34px 28px 80px' }}>

          {/* ══ Header ═════════════════════════════════════════════════════
              The week is the page's subject, so it is the page's title. The
              navigator sits with it, and roster completion sits opposite as
              the one number Sam checks before reading anything else. */}
          <PageHeader
            eyebrow="Team performance KPI"
            title={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <NavBtn label="‹" title="Previous week" onClick={() => setWeek(w => addDays(w, -7))} />
                {weekLabel(week)}
                <NavBtn label="›" title="Next week" onClick={() => setWeek(w => addDays(w, 7))} />
              </span>
            }
            meta={
              <>
                <span>Monday–Sunday · one report per physio per week</span>
                {isThisWeek
                  ? <Chip text="This week" tone="good" />
                  : <button onClick={() => setWeek(mondayOf(todayISO()))} style={{
                      ...smallBtnStyle, padding: '4px 11px', fontSize: 12, borderRadius: 7,
                    }}>Jump to this week</button>}
                {/* Any date snaps to that week's Monday, same rule as the server. */}
                <input
                  type="date"
                  value={week}
                  onChange={e => { if (e.target.value) setWeek(mondayOf(e.target.value)) }}
                  aria-label="Jump to the week containing this date"
                  style={{
                    background: SURFACE, border: `1px solid ${BORDER_MID}`, color: TEXT_SOFT,
                    padding: '4px 9px', borderRadius: 7, fontSize: 12, fontFamily: FONT,
                  }}
                />
              </>
            }
            right={
              // Deliberately counts the WHOLE roster, not the filtered rows —
              // "9 of 12 in" has to keep meaning that even while Sam is looking
              // at the check-in-only view.
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <ProgressRing done={rows.length} total={rosterAll} />
                <div>
                  <div style={captionStyle}>Reported</div>
                  <div style={{
                    fontSize: 22, fontWeight: 500, color: TEXT, marginTop: 4,
                    fontFamily: MONO, lineHeight: 1,
                  }}>
                    {rows.length}<span style={{ fontSize: 14, color: TEXT_FAINT }}> / {rosterAll}</span>
                  </div>
                  <div style={{ fontSize: 12.5, color: TEXT_MUTED, marginTop: 5 }}>
                    {missing.length === 0 ? 'Whole roster in' : `${missing.length} still to come`}
                  </div>
                </div>
              </div>
            }
          />

          {/* ══ Toolbar ══════════════════════════════════════════════════ */}
          <div className="pw-wrap" style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 22,
          }}>
            <PillGroup>
              <PillBtn label="All clinics" active={clinic === ''} onClick={() => setClinic('')} />
              {CLINIC_ORDER.map(c => (
                <PillBtn key={c} label={CLINIC_LABEL[c]} active={clinic === c} onClick={() => setClinic(c)} />
              ))}
            </PillGroup>

            {/* The spec's "optional second view filtered to Check-in needed =
                Yes so Sam can scan for who needs attention first". */}
            <PillGroup>
              <PillBtn
                label={<>⚑ Check-in requested{view && view.summary.checkin_needed > 0 && !checkinOnly
                  ? ` · ${view.summary.checkin_needed}` : ''}</>}
                active={checkinOnly}
                onClick={() => setCheckinOnly(v => !v)}
              />
              <PillBtn
                label="Friday still open"
                active={openOnly}
                onClick={() => setOpenOnly(v => !v)}
              />
            </PillGroup>

            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              {/* Exports the week that is on screen, filters and all — see
                  exportWeeklyKpiXlsx. Disabled while there is nothing loaded
                  or nothing in it, so the button can never produce an empty
                  file that looks like a missing week. */}
              <button
                onClick={onExport}
                disabled={!canExport}
                title="Download this week as a formatted Excel file"
                style={{
                  ...smallBtnStyle,
                  opacity: canExport ? 1 : 0.5,
                  cursor:  exporting ? 'wait' : canExport ? 'pointer' : 'default',
                }}
              >
                {exporting ? 'Preparing…' : '↓ Download Excel'}
              </button>

              <button onClick={load} disabled={loading} style={{
                ...smallBtnStyle,
                opacity: loading ? 0.5 : 1, cursor: loading ? 'wait' : 'pointer',
              }}>
                {loading ? 'Loading…' : 'Refresh'}
              </button>
            </div>
          </div>

          <ErrorBanner message={error} />

          {/* ══ Summary ════════════════════════════════════════════════════
              One bordered strip of four figures rather than four cards — the
              numbers relate to each other, and four separate boxes made them
              read as four unrelated things. */}
          {/* gap:1px over a hairline background draws the dividers — inline
              styles cannot do :first-child, and this stays correct when the
              grid drops to two columns on a phone. */}
          {view && (
            <div className="pw-grid-2" style={{
              display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 1,
              background: BORDER, border: `1px solid ${BORDER}`,
              borderRadius: 14, overflow: 'hidden', marginBottom: 22,
            }}>
              <Stat
                label="Submitted"
                value={`${view.summary.submitted}`}
                caption={missing.length === 0
                  ? 'Everyone on the roster reported'
                  : `of ${rosterAll} active clinicians`}
                bar={{ done: rows.length, total: rosterAll }}
              />
              <Stat
                label="Loop closed"
                value={`${view.summary.friday_closed}/${view.summary.submitted}`}
                caption="Friday half submitted"
                bar={{ done: view.summary.friday_closed, total: view.summary.submitted }}
              />
              <Stat
                label="Avg effectiveness"
                value={view.summary.avg_effectiveness?.toFixed(1) ?? '—'}
                caption="Team, this week"
                score={view.summary.avg_effectiveness}
              />
              <Stat
                label="Avg mojo"
                value={view.summary.avg_mojo?.toFixed(1) ?? '—'}
                caption={view.summary.checkin_needed > 0
                  ? `${view.summary.checkin_needed} check-in${view.summary.checkin_needed === 1 ? '' : 's'} requested`
                  : 'No check-ins requested'}
                score={view.summary.avg_mojo}
                isMojo
              />
            </div>
          )}

          {loading && !view && <Loading text="Loading the tracker…" />}

          {view && rows.length === 0 && (
            <div style={{ marginBottom: 22 }}>
              <EmptyState
                title={filtered || clinic ? 'Nothing matches these filters' : 'No reports for this week yet'}
                body={filtered || clinic
                  ? 'Clear a filter above to see the rest of the week.'
                  : missing.length > 0
                    ? 'The physios below have not filled in their Monday half yet. Their reports will appear here as they come in.'
                    : 'Reports appear here as physios submit their Monday half.'}
              />
            </div>
          )}

          {/* ══ The tracker ══════════════════════════════════════════════ */}
          {grouped.map(g => {
            const e = avg(g.items, r => r.effectiveness_rating)
            const m = avg(g.items, r => r.mojo_rating)
            return (
              <Panel key={g.clinic} pad="20px 22px" style={{ marginBottom: 16 }}>
                <PanelHeader
                  title={CLINIC_LABEL[g.clinic]}
                  subtitle={`${g.items.length} report${g.items.length === 1 ? '' : 's'} · ${
                    g.items.filter(r => r.friday_submitted_at).length} closed`}
                  right={
                    <div style={{ display: 'flex', gap: 22 }}>
                      <MiniStat label="Avg eff" value={e?.toFixed(1) ?? '—'} />
                      <MiniStat label="Avg mojo" value={m?.toFixed(1) ?? '—'} />
                    </div>
                  }
                />

                {/* Wide content scrolls inside its own box — the page body never
                    scrolls sideways. */}
                <div style={{ overflowX: 'auto', margin: '0 -4px' }}>
                  <div style={{ minWidth: 900, padding: '0 4px' }}>
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: '200px 1fr 120px 120px 92px 112px',
                      gap: 14, padding: '0 12px 10px',
                      borderBottom: `1px solid ${BORDER}`,
                      ...captionStyle,
                    }}>
                      <div>Physio</div>
                      <div>Intention for the week</div>
                      <div>Effectiveness</div>
                      <div>Mojo</div>
                      <div>Goal hit</div>
                      <div>Check-in</div>
                    </div>

                    {g.items.map((r, i) => (
                      <TrackerRow
                        key={r.id}
                        report={r}
                        last={i === g.items.length - 1}
                        open={openId === r.id}
                        onToggle={() => setOpenId(openId === r.id ? null : r.id)}
                        onOpenProfile={() => navigate('admin-clinician-profile', { clinicianId: r.clinician_id })}
                      />
                    ))}
                  </div>
                </div>
              </Panel>
            )
          })}

          {/* ══ Who has not submitted ══════════════════════════════════════
              Not in the spec, because a SharePoint list can only show rows that
              exist. The physio who skipped the week is the one Sam needs first. */}
          {view && missing.length > 0 && (
            <Panel pad="20px 22px">
              <PanelHeader
                title={
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
                    <span style={{
                      width: 7, height: 7, borderRadius: '50%', background: AMBER, flexShrink: 0,
                    }} />
                    Not submitted · {missing.length}
                  </span>
                }
                subtitle={`Active clinicians with nothing recorded for ${weekLabel(week)}. Accounts hidden from the clinician pickers (former physios) are not counted.`}
              />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {missing.map(mm => (
                  <MissingChip
                    key={mm.clinician_id}
                    name={mm.full_name}
                    clinic={clinicLabel(mm.clinic_id)}
                    onClick={() => navigate('admin-clinician-profile', { clinicianId: mm.clinician_id })}
                  />
                ))}
              </div>
            </Panel>
          )}
        </div>
      </div>

      {/* The report opens beside the table, not inside it — Sam, 2026-08-24:
          "imbis na pababa ung info … sidebar dapat". See WeeklyKpiDrawer. */}
      {openReport && (
        <WeeklyKpiDrawer
          report={openReport}
          onClose={() => setOpenId(null)}
          onChanged={load}
          onDeleted={() => { setOpenId(null); load() }}
          onOpenProfile={() => navigate('admin-clinician-profile', { clinicianId: openReport.clinician_id })}
        />
      )}
    </AppShell>
  )
}

// ── Row ─────────────────────────────────────────────────────────────────────

function TrackerRow({
  report, open, last, onToggle, onOpenProfile,
}: {
  report:   WeeklyKpiDTO
  open:     boolean
  /** The last row in a clinic drops its rule — the panel edge is already there. */
  last:     boolean
  /** Opens (or closes) this row's report in the side drawer. */
  onToggle: () => void
  onOpenProfile: () => void
}) {
  const [hover, setHover] = useState(false)
  const closed = report.friday_submitted_at !== null

  // Left marker = why this row might need Sam first. A requested check-in and a
  // critical mojo are the two things the spec says to act on, so they get the
  // only colour on the row edge; everything else stays quiet.
  // Null until Friday closes the loop — a still-open week has nothing to band.
  const mojoBand = report.mojo_rating !== null ? bandKeyFor(report.mojo_rating, true) : null
  const flag =
    mojoBand === 'bad'      ? BAND_COLORS.bad.fg
    : report.checkin_needed ? BAND_COLORS.mid.fg
    : null

  return (
    <div style={{ borderBottom: last ? undefined : `1px solid ${BORDER}` }}>
      <div
        onClick={onToggle}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        role="button"
        tabIndex={0}
        /* Not aria-expanded any more: this row does not contain the detail, it
           opens a dialog beside the table. */
        aria-haspopup="dialog"
        aria-pressed={open}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}
        style={{
          display: 'grid',
          gridTemplateColumns: '200px 1fr 120px 120px 92px 112px',
          gap: 14, padding: '14px 12px', alignItems: 'center', cursor: 'pointer',
          background: open ? ACCENT_SOFT : hover ? SURFACE_ALT : SURFACE,
          borderRadius: 10,
          /* The open row keeps a marker so it is obvious which of twelve rows
             the panel on the right belongs to. */
          boxShadow: open ? `inset 3px 0 0 ${ACCENT}` : 'none',
          transition: 'background .12s',
        }}
      >
        {/* Physio */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
          <Avatar name={report.clinician_name} size={34} />
          <div style={{ minWidth: 0 }}>
            <div
              onClick={e => { e.stopPropagation(); onOpenProfile() }}
              title="Open this clinician's profile"
              style={{
                fontSize: 14, fontWeight: 500, color: TEXT, cursor: 'pointer',
                letterSpacing: '-0.01em',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                textDecoration: hover ? 'underline' : 'none',
              }}
            >
              {report.clinician_name ?? 'Unknown'}
            </div>
            <div style={{ fontSize: 12, color: TEXT_MUTED, display: 'flex', alignItems: 'center', gap: 6 }}>
              {flag && (
                <span aria-hidden style={{
                  width: 6, height: 6, borderRadius: '50%', background: flag, flexShrink: 0,
                }} />
              )}
              {closed ? 'Week complete' : 'Friday open'}
            </div>
          </div>
        </div>

        {/* Intention */}
        <div style={{
          fontSize: 13.5, color: TEXT_SOFT, lineHeight: 1.5,
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }} title={report.intention}>
          {report.intention}
        </div>

        <RatingMeter value={report.effectiveness_rating} />
        <RatingMeter value={report.mojo_rating} isMojo />

        <div>
          {closed
            ? <Chip text={report.goal_achieved ? 'Yes' : 'No'} tone={report.goal_achieved ? 'good' : 'warn'} />
            : <Chip text="Pending" tone="neutral" />}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {report.checkin_needed
            ? <Chip text="⚑ Requested" tone="warn" />
            : <span style={{ color: TEXT_FAINT, fontSize: 13 }}>—</span>}
          <CommentMarker
            total={report.comment_count ?? 0}
            unread={report.unread_count ?? 0}
          />
          <span aria-hidden style={{
            marginLeft: 'auto', fontSize: 11,
            color: open ? ACCENT : TEXT_FAINT, transition: 'color .12s',
          }}>▸</span>
        </div>
      </div>

    </div>
  )
}

// ── Small pieces ────────────────────────────────────────────────────────────

/** One figure in the summary strip. Cells are divided by a hairline, not by a
 *  card each — the four numbers are one thought. */
function Stat({
  label, value, caption, score, isMojo, bar,
}: {
  label:   string
  value:   string
  caption: string
  /** A 1–10 average — draws its bar in the band's colour. */
  score?:  number | null
  isMojo?: boolean
  /** A "x of y" proportion — for the two counting figures. */
  bar?:    { done: number; total: number }
}) {
  const pct = score != null
    ? score * 10
    : bar && bar.total > 0 ? Math.min(100, (bar.done / bar.total) * 100) : 0
  const fill = score != null ? BAND_COLORS[bandKeyFor(Math.round(score), isMojo)].fg : ACCENT

  return (
    <div style={{
      padding: '18px 20px', background: SURFACE,
      display: 'flex', flexDirection: 'column', minWidth: 0,
    }}>
      <div style={captionStyle}>{label}</div>
      <div style={{
        fontSize: 30, fontWeight: 500, color: TEXT, marginTop: 8,
        fontFamily: MONO, lineHeight: 1, letterSpacing: '-0.02em',
      }}>{value}</div>
      <div aria-hidden style={{
        marginTop: 14, height: 3, borderRadius: 999, background: TRACK, overflow: 'hidden',
      }}>
        <div style={{
          width: `${pct}%`, height: '100%', borderRadius: 999,
          background: fill, transition: 'width .3s ease',
        }} />
      </div>
      <div style={{
        fontSize: 12, color: TEXT_MUTED, marginTop: 'auto', paddingTop: 10, lineHeight: 1.45,
      }}>{caption}</div>
    </div>
  )
}

/** Per-clinic average, in the panel header. Plain figures — a tinted box around
 *  a number this small is more chrome than information. */
function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ textAlign: 'right' }}>
      <div style={captionStyle}>{label}</div>
      <div style={{
        fontSize: 16, fontWeight: 500, color: TEXT, fontFamily: MONO, marginTop: 4, lineHeight: 1,
      }}>{value}</div>
    </div>
  )
}

/** Someone with nothing recorded this week — click through to their profile. */
function MissingChip({
  name, clinic, onClick,
}: {
  name:    string | null
  clinic:  string
  onClick: () => void
}) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Open this clinician's profile"
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        background: hover ? SURFACE_ALT : SURFACE,
        border: `1px solid ${BORDER_MID}`, borderRadius: 999,
        padding: '5px 15px 5px 5px', cursor: 'pointer', fontFamily: FONT,
        transition: 'background .12s',
      }}
    >
      <Avatar name={name} size={26} tone="amber" />
      <span style={{ textAlign: 'left' }}>
        <span style={{ display: 'block', fontSize: 13, fontWeight: 500, color: TEXT, lineHeight: 1.25 }}>
          {name ?? 'Unnamed'}
        </span>
        <span style={{ display: 'block', fontSize: 11, color: TEXT_MUTED }}>{clinic}</span>
      </span>
    </button>
  )
}

/**
 * How much conversation a week already has, and whether any of it is waiting on
 * the viewer. Unread wins the colour: the whole point of the marker is to say
 * "a physio has replied to you here", and a plain count cannot say that.
 */
function CommentMarker({ total, unread }: { total: number; unread: number }) {
  if (total === 0) return null
  const waiting = unread > 0
  return (
    <span
      title={waiting
        ? `${unread} new comment${unread === 1 ? '' : 's'} — open the row to read`
        : `${total} comment${total === 1 ? '' : 's'}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 11.5, fontWeight: waiting ? 600 : 500,
        color: waiting ? ACCENT : TEXT_MUTED,
      }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.1A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z" />
      </svg>
      {waiting ? unread : total}
    </span>
  )
}

/** Week stepper. A bordered circle, no fill — it sits inside an h1, so it has
 *  to stay quieter than the date it moves. */
function NavBtn({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: hover ? SURFACE_ALT : SURFACE,
        border: `1px solid ${BORDER_MID}`,
        color: hover ? ACCENT : TEXT_SOFT,
        borderRadius: '50%', width: 30, height: 30,
        fontSize: 17, lineHeight: 1, cursor: 'pointer', padding: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, transition: 'background .12s, color .12s',
        fontFamily: FONT,
      }}
    >{label}</button>
  )
}
