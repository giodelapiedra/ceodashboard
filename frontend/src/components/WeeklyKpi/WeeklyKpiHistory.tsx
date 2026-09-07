import React, { useCallback, useEffect, useState } from 'react'
import { weeklyKpiApi } from '../../api/weeklyKpi.api'
import { WeeklyKpiDTO } from '../../types'
import Pagination from '../shared/Pagination'
import WeeklyKpiComments from './WeeklyKpiComments'
import DeleteReportButton from './DeleteReportButton'
import WeeklyKpiDrawer from './WeeklyKpiDrawer'
import { useKpiModel } from '../../lib/useKpiModel'
import {
  ACCENT, ACCENT_SOFT, SURFACE, SURFACE_ALT, BORDER, TEXT, TEXT_SOFT, TEXT_MUTED, TEXT_FAINT,
  BAND_COLORS, bandKeyFor, captionStyle,
  weekLabel, Chip, RatingMeter, EmptyState, ErrorBanner, Loading, WeeklyKpiDetail,
} from './weeklyKpi.ui'

const PAGE_SIZE = 26   // ~6 months of weeks

/**
 * A clinician's weekly KPI history, newest week first, each week expanding to
 * the full report.
 *
 * Mounted twice on purpose — Sam asked for the reports to live "sa kanya kanya
 * profile nila para may history", and that means the same list in two places:
 *   * `mine` — the physio reading back their own weeks, under their form.
 *   * `clinicianId` — the super admin reading one physio's weeks, on the KPI
 *     tab of that person's profile page.
 * The two differ only in which endpoint they call, so they share one component
 * rather than drifting apart as two.
 *
 * Visually this is the flat white system in weeklyKpi.ui (2026-08-24): one
 * bordered list, hairlines between weeks, no card-per-row and no shadows. A
 * stack of floating cards was making twenty-six quiet weeks look like
 * twenty-six things demanding attention.
 */
export default function WeeklyKpiHistory({
  clinicianId,
  mine = false,
  /** Re-fetch when this changes — the form bumps it after a submit. */
  refreshKey = 0,
  /**
   * Open a week in the right-hand drawer instead of expanding it under its row.
   * On for the profile page's KPI tab (Sam, 2026-08-24: "pati dito ganon din
   * dapat") — same reasoning as the tracker: the report is long enough that
   * expanding it in place pushes the rest of the list off the screen.
   *
   * NOW ON FOR THE PHYSIO'S OWN PAGE TOO (Sam, 2026-09-01, looking at
   * /weekly-kpi: "imbis pababa yan pa sidebar na din details"). The earlier
   * reasoning for leaving it off there — "a form with its history underneath,
   * nothing needs to stay put" — stopped holding when the Weekly Check-In
   * landed: a week now carries a 30-behaviour breakdown, five group bars and
   * the counts block, so expanding one in place pushes the physio a long way
   * down a page they were reading, and closing it strands them there.
   *
   * The default stays false so a future caller has to choose, rather than
   * inheriting a drawer it did not ask for.
   */
  drawer = false,
}: {
  clinicianId?: string
  mine?: boolean
  refreshKey?: number
  drawer?: boolean
}) {
  const [rows,    setRows]    = useState<WeeklyKpiDTO[]>([])
  const [total,   setTotal]   = useState(0)
  const [offset,  setOffset]  = useState(0)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [openId,  setOpenId]  = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = mine
        ? await weeklyKpiApi.myHistory(PAGE_SIZE, offset)
        : await weeklyKpiApi.clinicianHistory(clinicianId!, PAGE_SIZE, offset)
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (e: any) {
      setError(e.response?.data?.error?.message || 'Failed to load history')
    } finally { setLoading(false) }
  }, [mine, clinicianId, offset])

  useEffect(() => { if (mine || clinicianId) load() }, [load, refreshKey])

  // A new page of a different length would otherwise leave a row from the old
  // page expanded and invisible.
  useEffect(() => { setOpenId(null) }, [offset])

  if (!mine && !clinicianId) return null

  // Resolved from the current page of rows, so the drawer redraws with fresh
  // comment counts after a reload rather than holding a stale copy.
  const openReport = openId ? rows.find(r => String(r.id) === String(openId)) ?? null : null

  return (
    <div>
      <ErrorBanner message={error} />

      {loading && rows.length === 0 && <Loading text="Loading history…" />}

      {!loading && rows.length === 0 && !error && (
        <EmptyState
          title="No weekly KPI reports yet"
          body={mine
            ? 'Fill in the Monday half above and your weeks will start collecting here.'
            : 'This clinician has not submitted a weekly KPI report yet.'}
        />
      )}

      {rows.length > 0 && (
        <div style={{
          border: `1px solid ${BORDER}`, borderRadius: 14, overflow: 'hidden', background: SURFACE,
        }}>
          {rows.map((r, i) => (
            <HistoryRow
              key={r.id}
              report={r}
              first={i === 0}
              open={openId === r.id}
              drawer={drawer}
              onToggle={() => setOpenId(openId === r.id ? null : r.id)}
              onDataChanged={load}
            />
          ))}
        </div>
      )}

      {/* The open week, beside the list rather than inside it. No
          onOpenProfile: this list only ever renders on a profile page or under
          the physio's own form, so "full history" is where you already are. */}
      {drawer && openReport && (
        <WeeklyKpiDrawer
          report={openReport}
          onClose={() => setOpenId(null)}
          onChanged={load}
          onDeleted={() => { setOpenId(null); load() }}
        />
      )}

      {total > PAGE_SIZE && (
        <div style={{
          marginTop: 14, border: `1px solid ${BORDER}`, borderRadius: 14, overflow: 'hidden',
        }}>
          <Pagination
            total={total}
            limit={PAGE_SIZE}
            offset={offset}
            onChange={setOffset}
          />
        </div>
      )}
    </div>
  )
}

function HistoryRow({
  report, open, first, drawer, onToggle, onDataChanged,
}: {
  report:   WeeklyKpiDTO
  /** Expanded (inline mode) or selected (drawer mode) — same state, two shapes. */
  open:     boolean
  first:    boolean
  drawer:   boolean
  onToggle: () => void
  /** Re-read the page after a comment or a deletion changes this row. */
  onDataChanged: () => void
}) {
  const [hover, setHover] = useState(false)
  const closed   = report.friday_submitted_at !== null
  const comments = report.comment_count ?? 0
  const unread   = report.unread_count  ?? 0

  // The model THIS week was scored under, so an older week keeps being
  // explained by the weights and band labels that produced it. Fetched here
  // rather than inside the presentational detail component, and cached per
  // version in the api layer — a page of 26 weeks on one model is one request.
  const { model } = useKpiModel(report.effectiveness.model_version)

  // Same rule as the tracker's row marker: a critical mojo, then a requested
  // check-in. Nothing else earns colour. Mojo is null until Friday closes the
  // loop, so there is nothing to band yet on a still-open week.
  const mojoBand = report.mojo_rating !== null ? bandKeyFor(report.mojo_rating, true) : null
  const flag =
    mojoBand === 'bad'      ? BAND_COLORS.bad.fg
    : report.checkin_needed ? BAND_COLORS.mid.fg
    : null

  return (
    <div style={{ borderTop: first ? undefined : `1px solid ${BORDER}` }}>
      <div
        onClick={onToggle}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        role="button"
        tabIndex={0}
        aria-expanded={drawer ? undefined : open}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}
        aria-haspopup={drawer ? 'dialog' : undefined}
        style={{
          cursor: 'pointer', padding: '16px 18px',
          background: open ? ACCENT_SOFT : hover ? SURFACE_ALT : SURFACE,
          // In drawer mode the row is a selection, so it carries the same
          // accent edge the tracker's open row does.
          boxShadow: open && drawer ? `inset 3px 0 0 ${ACCENT}` : 'none',
          transition: 'background .12s',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
          {/* Week */}
          <div style={{ minWidth: 150, display: 'flex', alignItems: 'center', gap: 9 }}>
            {flag && (
              <span aria-hidden style={{
                width: 6, height: 6, borderRadius: '50%', background: flag, flexShrink: 0,
              }} />
            )}
            <span style={{ fontSize: 15, fontWeight: 600, color: TEXT, letterSpacing: '-0.015em' }}>
              {weekLabel(report.week_start)}
            </span>
          </div>

          <RatingMeter value={report.effectiveness_rating} label="Effectiveness" compact />
          <RatingMeter value={report.mojo_rating} isMojo label="Mojo" compact />

          <div style={{ marginLeft: 'auto', display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
            {/* A comment waiting is the one thing on this row that needs the
                physio to do something, so it is the only thing in accent. */}
            {unread > 0
              ? <span style={{
                  background: ACCENT, color: '#fff', padding: '3px 10px', borderRadius: 7,
                  fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap',
                }}>{unread} new comment{unread === 1 ? '' : 's'}</span>
              : comments > 0 && <Chip text={`${comments} comment${comments === 1 ? '' : 's'}`} />}
            {report.checkin_needed && <Chip text="⚑ Check-in" tone="warn" />}
            {closed
              ? <Chip text={report.goal_achieved ? 'Goal hit' : 'Goal missed'} tone={report.goal_achieved ? 'good' : 'warn'} />
              : <Chip text="Friday open" tone="warn" />}
            <span aria-hidden style={{
              fontSize: 11, marginLeft: 2, display: 'inline-block',
              color: open && drawer ? ACCENT : TEXT_FAINT,
              transform: !drawer && open ? 'rotate(90deg)' : 'none',
              transition: 'transform .16s, color .12s',
            }}>▸</span>
          </div>
        </div>

        {/* The one-line preview of the intention is what makes the collapsed
            list scannable — a column of week dates and two scores says nothing
            about what the week was actually for. */}
        {(drawer || !open) && (
          <div style={{
            marginTop: 10, fontSize: 13, color: TEXT_SOFT, lineHeight: 1.55,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}>
            <span style={{ ...captionStyle, color: TEXT_MUTED, marginRight: 8 }}>Intention</span>
            {report.intention}
          </div>
        )}
      </div>

      {open && !drawer && (
        <div style={{ padding: '6px 18px 26px', background: SURFACE }}>
          <WeeklyKpiDetail report={report} model={model} />
          <WeeklyKpiComments
            reportId={report.id}
            ownerName={report.clinician_name}
            onChanged={onDataChanged}
          />
          {/* Renders nothing for the physio reading their own history — the
              gate is role-based, so this is the same super-admin-only control
              that sits on the tracker row. */}
          <div style={{ marginTop: 20 }}>
            <DeleteReportButton report={report} onDeleted={onDataChanged} />
          </div>
        </div>
      )}
    </div>
  )
}
