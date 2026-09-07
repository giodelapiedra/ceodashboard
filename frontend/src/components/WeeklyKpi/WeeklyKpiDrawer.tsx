import React, { useEffect, useRef } from 'react'
import { WeeklyKpiDTO } from '../../types'
import { useKpiModel } from '../../lib/useKpiModel'
import WeeklyKpiComments from './WeeklyKpiComments'
import DeleteReportButton from './DeleteReportButton'
import {
  ACCENT, SURFACE, BORDER, TEXT, TEXT_MUTED, TEXT_FAINT, FONT,
  captionStyle, clinicLabel, weekLabel, Avatar, Chip, RatingMeter, smallBtnStyle,
  WeeklyKpiDetail,
} from './weeklyKpi.ui'

/**
 * One week's full report, in a right-hand drawer.
 *
 * Sam, 2026-08-24, looking at the tracker: *"imbis na pababa ung info … sidebar
 * dapat"*. He was right about the shape. The report is long — a KPI table, two
 * meters, six free-text answers, the Friday half and a comment thread — and
 * opening all of that INSIDE a table row pushed every physio below it off the
 * screen. Reading one person's week meant losing the week you were comparing
 * them against.
 *
 * A drawer fixes exactly that: the table never moves, the row stays visible and
 * highlighted next to what you are reading, and clicking the next physio swaps
 * the panel instead of collapsing one accordion and opening another.
 *
 * Deliberately NOT applied to the history list (`WeeklyKpiHistory`): that page
 * is one narrow column of one person's own weeks, where "expand in place" is
 * the right idiom and there is no table to hold still.
 */
export default function WeeklyKpiDrawer({
  report, onClose, onOpenProfile, onChanged, onDeleted,
}: {
  report:        WeeklyKpiDTO
  onClose:       () => void
  /** Omitted when the drawer is already open ON that clinician's profile —
   *  a "full history" button that reloads the page you are on is furniture. */
  onOpenProfile?: () => void
  /** A comment was posted / edited / deleted — refresh the list behind. */
  onChanged:     () => void
  /** The whole week was deleted — refresh AND close. */
  onDeleted:     () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)

  // The model THIS week was scored under, not whatever is current — a week
  // scored on 1.0 has to keep being explained by 1.0's groups and band labels.
  // Cached per version in the api layer, so paging through a history costs one
  // request per distinct model, not one per week.
  const { model } = useKpiModel(report.effectiveness.model_version)

  // Esc closes, and the close button takes focus on open so the panel is
  // reachable from the keyboard without tabbing through the whole table.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    closeRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Lock the page behind the drawer. Without this the wheel scrolls the table
  // under the panel, which reads as the page having come loose.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  const closed = report.friday_submitted_at !== null

  return (
    <>
      {/* Scrim. Light — this is a side panel, not a modal dialog, and the table
          behind it is meant to stay readable. */}
      <div
        onClick={onClose}
        aria-hidden
        style={{
          position: 'fixed', inset: 0, zIndex: 60,
          background: 'rgba(15,23,42,0.14)',
          animation: 'pwKpiFade .16s ease',
        }}
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`${report.clinician_name ?? 'Clinician'} — ${weekLabel(report.week_start)}`}
        className="pw-kpi-drawer"
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 61,
          width: 'min(560px, 100vw)',
          background: SURFACE, borderLeft: `1px solid ${BORDER}`,
          display: 'flex', flexDirection: 'column',
          fontFamily: FONT,
          animation: 'pwKpiSlide .18s cubic-bezier(0.32, 0.72, 0, 1)',
        }}
      >
        {/* ── Header. Sticky by being outside the scroll area: the name and the
            week are what tell you which row you are reading, so they must not
            scroll away halfway down a long report. ── */}
        <div style={{
          padding: '18px 22px 16px', borderBottom: `1px solid ${BORDER}`, flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <Avatar name={report.clinician_name} size={40} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{
                fontSize: 18, fontWeight: 600, color: TEXT, letterSpacing: '-0.02em',
                lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {report.clinician_name ?? 'Unknown'}
              </div>
              <div style={{ fontSize: 12.5, color: TEXT_MUTED, marginTop: 3 }}>
                {clinicLabel(report.clinic_id)} · {weekLabel(report.week_start)}
              </div>
            </div>
            <button
              ref={closeRef}
              onClick={onClose}
              aria-label="Close"
              title="Close (Esc)"
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 4,
                color: TEXT_MUTED, fontSize: 20, lineHeight: 1, flexShrink: 0,
                fontFamily: FONT,
              }}
            >✕</button>
          </div>

          {/* The three things worth seeing before reading a word of prose: the
              two scores and whether this person asked for time with Sam. */}
          <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap', marginTop: 16 }}>
            <RatingMeter value={report.effectiveness_rating} label="Effectiveness" />
            <RatingMeter value={report.mojo_rating} isMojo label="Mojo (energy)" />
            <div>
              <div style={{ ...captionStyle, marginBottom: 7 }}>Status</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {report.checkin_needed && <Chip text="⚑ Check-in" tone="warn" />}
                <Chip
                  text={closed ? (report.goal_achieved ? 'Goal hit' : 'Goal missed') : 'Friday open'}
                  tone={closed ? (report.goal_achieved ? 'good' : 'warn') : 'neutral'}
                />
              </div>
            </div>
          </div>
        </div>

        {/* ── Body ── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 22px 28px' }}>
          {/* `compact` drops the meters and the check-in block the header above
              already carries — printing them twice in a 560px column was the
              "ayusin mo ang format" half of the ask. */}
          <WeeklyKpiDetail report={report} compact model={model} />
          <WeeklyKpiComments
            reportId={report.id}
            ownerName={report.clinician_name}
            onChanged={onChanged}
          />
        </div>

        {/* ── Footer. Actions pinned where they can be found, rather than at the
            bottom of a thread that grows every week. ── */}
        <div style={{
          borderTop: `1px solid ${BORDER}`, padding: '12px 22px', flexShrink: 0,
          display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
        }}>
          {onOpenProfile && (
            <button onClick={onOpenProfile} style={{ ...smallBtnStyle, color: ACCENT }}>
              Full history →
            </button>
          )}
          <span style={{ fontSize: 11.5, color: TEXT_FAINT }}>Esc to close</span>
          <span style={{ marginLeft: 'auto' }}>
            <DeleteReportButton report={report} onDeleted={onDeleted} />
          </span>
        </div>
      </aside>

      <style>{`
        @keyframes pwKpiFade  { from { opacity: 0 } to { opacity: 1 } }
        @keyframes pwKpiSlide { from { transform: translateX(18px); opacity: .6 } to { transform: none; opacity: 1 } }
        @media (prefers-reduced-motion: reduce) {
          .pw-kpi-drawer { animation: none !important }
        }
      `}</style>
    </>
  )
}
