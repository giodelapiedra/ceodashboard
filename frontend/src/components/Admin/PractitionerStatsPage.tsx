import React, { useEffect, useState, useCallback } from 'react'
import {
  practitionerStatsApi,
  PractitionerStatsReport,
  PractitionerWeekStats,
  Metric,
  UnavailableMetric,
  Zone,
} from '../../api/practitionerStats.api'
import { ClinicId, CLINIC_LABEL } from '../../types'
import AppShell from '../shared/AppShell'

const TEAL      = '#0f6e56'
const TEXT      = '#111827'
const TEXT_SOFT = '#4b5563'
const TEXT_MUTE = '#9ca3af'
const BORDER    = '#e5e7eb'

// Zone palette. Checked for colour-vision separation against a white surface
// before use, and each zone also carries a glyph below so the state never
// depends on colour alone (print, CVD, forced-colors).
const ZONE: Record<Zone, { fg: string; bg: string; glyph: string; label: string }> = {
  thriving: { fg: '#0a8a72', bg: '#e6f4f0', glyph: '▲', label: 'Thriving'   },
  refining: { fg: '#a8880c', bg: '#f7f2df', glyph: '●', label: 'Refining'   },
  reset:    { fg: '#bd2f45', bg: '#fbeaec', glyph: '▼', label: 'Reset Zone' },
}
const BLOCKED_FG = '#7c3aed'
const BLOCKED_BG = '#f2ecfd'

type ClinicTab = ClinicId | 'overall'
const TABS: { id: ClinicTab; label: string }[] = [
  { id: 'newport',   label: 'Newport'   },
  { id: 'narrabeen', label: 'Narrabeen' },
  { id: 'brookvale', label: 'Brookvale' },
  { id: 'overall',   label: 'Overall'   },
]

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/**
 * Column spec — header and body both render from this one list, so the two can
 * never drift out of order.
 *
 * The first nine entries are the nine figures SOP step 6 lists, in that order,
 * under the labels the SOP and the Practitioner Stats 2026 tab actually use
 * (Therapist is the row label, not a figure):
 *
 *   Total Appts | Occupancy | NC | Recommendations | Conversion |
 *   Case Accept | Cancellation % | Prepay % | Prepay Acceptance %
 *
 * Renaming or reordering them would break the weekly cross-check against the
 * spreadsheet this report is meant to replace.
 *
 * Where the sheet disagrees with itself, operational usage wins over the KPI
 * dictionary — Cath reads the SOP and the tab, not the dictionary:
 *   "Case Accept"  — SOP step 6, its section heading, its final check, the
 *                    physio tabs, and 6 of 10 week blocks. Only the KPI
 *                    dictionary says "Case Acceptance".
 *   "Prepay %"     — 8 of 10 week blocks, over "Prepay Offered%" (2).
 *
 * Columns this report ADDS come last, after a divider, so nothing the CEO
 * already reads shifts position.
 */
type Col =
  | { kind: 'metric';  label: string; title: string; get: (r: PractitionerWeekStats) => Metric; suffix?: string; added?: boolean }
  | { kind: 'count';   label: string; title: string; get: (r: PractitionerWeekStats) => number; added?: boolean }
  | { kind: 'blocked'; label: string; get: (r: PractitionerWeekStats) => UnavailableMetric }

const COLUMNS: Col[] = [
  // ── the sheet's columns, in the sheet's order ──
  { kind: 'blocked', label: 'Total Appts', get: (r) => r.totalAppts },
  { kind: 'blocked', label: 'Occupancy',   get: (r) => r.occupancy  },
  { kind: 'blocked', label: 'NC',          get: (r) => r.newCases   },
  { kind: 'metric',  label: 'Recommendations', suffix: '',
    title: 'Average treatment-plan recommendations per initial consult. Target 8–12.',
    get: (r) => r.recommendations },
  { kind: 'metric',  label: 'Conversion',
    title: 'Average appointments booked from initial. Target >6.',
    get: (r) => r.conversion },
  { kind: 'metric',  label: 'Case Accept', suffix: '%',
    title: 'Pooled: sum booked ÷ sum recommendations, per the KPI dictionary. Target >80%. The sheet averages per-patient percentages instead and can differ by 17 points.',
    get: (r) => r.caseAcceptance },
  { kind: 'blocked', label: 'Cancellation %', get: (r) => r.cancellationPct },
  { kind: 'metric',  label: 'Prepay %', suffix: '%',
    title: 'Prepay offered ÷ initial consults. Target 100%. The sheet divides by NC, which is how it produced 125%. No zone band — the KPI dictionary defines none.',
    get: (r) => r.prepayOfferedPct },
  { kind: 'metric',  label: 'Prepay Acceptance %', suffix: '%',
    title: 'Prepay accepted ÷ prepay offered. Target 80%. Blank when nothing was offered. No zone band — the KPI dictionary defines none.',
    get: (r) => r.prepayAcceptedPct },

  // ── added by this report, not in the sheet ──
  { kind: 'count',   label: 'Initials', added: true,
    title: 'ADDED: initial consultations logged. The honest denominator for the prepay rates — the sheet has no such column.',
    get: (r) => r.initials },
  { kind: 'metric',  label: 'TP Documented', suffix: '%', added: true,
    title: 'ADDED: treatment plans documented. A KPI with a 100% target in the dictionary that the sheet tracks nowhere.',
    get: (r) => r.tpDocumented },
  { kind: 'count',   label: 'Cxl events', added: true,
    title: 'ADDED: cancellation events, per cancelled appointment date. One entry with three cancelled dates is three events.',
    get: (r) => r.cancellations },
  { kind: 'count',   label: 'Churns', added: true,
    title: 'ADDED: churns per patient, on their last cancelled date. A reschedule keeps a future booking, so it is not a churn.',
    get: (r) => r.churns },
]

/** Index of the first added column — where the divider goes. */
const FIRST_ADDED = COLUMNS.findIndex((c) => 'added' in c && c.added)

function fmt(m: Metric, suffix = ''): string {
  if (m.value === null) return '—'
  return `${m.value}${suffix}`
}

function ZoneCell({ m, suffix = '', extra }: { m: Metric; suffix?: string; extra?: React.CSSProperties }) {
  // No figure at all — nothing was logged.
  if (m.value === null) {
    return (
      <td style={{ ...cellBase, ...extra, color: TEXT_MUTE, fontWeight: 400 }} title="No data logged for this week">
        —
      </td>
    )
  }
  // A real figure the KPI dictionary sets no target band for (the prepay rates).
  // Render the number plainly — never swallow it just because there is no zone.
  if (!m.zone) {
    return <td style={{ ...cellBase, ...extra }}>{fmt(m, suffix)}</td>
  }
  const z = ZONE[m.zone]
  return (
    <td style={{ ...cellBase, ...extra }}>
      <span
        title={z.label}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          background: z.bg, color: z.fg,
          padding: '3px 8px', borderRadius: 5, fontWeight: 600,
        }}
      >
        <span style={{ fontSize: 9, lineHeight: 1 }}>{z.glyph}</span>
        {fmt(m, suffix)}
      </span>
    </td>
  )
}

const cellBase: React.CSSProperties = {
  padding: '7px 10px',
  textAlign: 'right',
  fontFamily: "'DM Mono', ui-monospace, monospace",
  fontSize: 12.5,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
  borderBottom: `1px solid #f1f3f6`,
  color: TEXT_SOFT,
}

const thBase: React.CSSProperties = {
  padding: '9px 10px',
  textAlign: 'right',
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: TEXT_SOFT,
  background: '#f9fafb',
  borderBottom: `1px solid ${BORDER}`,
  whiteSpace: 'nowrap',
}

function StatsRow({ r, isTeam }: { r: PractitionerWeekStats; isTeam?: boolean }) {
  const rowBg = isTeam ? '#f9fafb' : '#fff'
  return (
    <tr style={{ background: rowBg }}>
      <td
        style={{
          padding: '7px 14px', textAlign: 'left',
          fontFamily: "'DM Sans', sans-serif", fontSize: 13,
          fontWeight: isTeam ? 700 : 600, color: TEXT,
          borderBottom: `1px solid #f1f3f6`,
          borderRight: `1px solid ${BORDER}`,
          background: rowBg,
          position: 'sticky', left: 0, zIndex: 1,
        }}
      >
        {r.clinicianName}
      </td>
      {COLUMNS.map((c, i) => {
        // Divider marks where the sheet's own columns end and this report's
        // additions begin.
        const extra: React.CSSProperties =
          i === FIRST_ADDED ? { borderLeft: `2px solid ${BORDER}` } : {}

        if (c.kind === 'blocked') {
          return (
            <td
              key={c.label}
              style={{ ...cellBase, ...extra, color: BLOCKED_FG, background: BLOCKED_BG, opacity: 0.85 }}
              title={c.get(r).reason}
            >
              ⚠
            </td>
          )
        }
        if (c.kind === 'count') {
          // A genuine zero prints as 0, never as an em dash — conflating "none"
          // with "not recorded" is the exact defect this board exists to remove.
          return <td key={c.label} style={{ ...cellBase, ...extra }}>{c.get(r)}</td>
        }
        return <ZoneCell key={c.label} m={c.get(r)} suffix={c.suffix} extra={extra} />
      })}
    </tr>
  )
}

export default function PractitionerStatsPage() {
  const now = new Date()
  const [tab,   setTab]   = useState<ClinicTab>('overall')
  const [year,  setYear]  = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [weekIdx, setWeekIdx] = useState(0)

  const [report,  setReport]  = useState<PractitionerStatsReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const data = await practitionerStatsApi.get(
        year, month, tab === 'overall' ? undefined : tab
      )
      // The axios generic is a promise, not a check — a misrouted request can
      // resolve 200 with an HTML body and no `weeks` at all. Verify the shape
      // before trusting it rather than throwing deep inside the render.
      if (!data || !Array.isArray(data.weeks)) {
        throw new Error('Unexpected response from /api/practitioner-stats')
      }
      setReport(data)
      // A month has 4 weeks plus a remainder that is often empty — the
      // calculator marks an empty one with a 9999-12-31 range. Clamp against the
      // SELECTABLE count, not weeks.length (always 5): coming from a month that
      // had a real remainder would otherwise leave the tab parked on the empty
      // sentinel, showing an all-zero week with no button highlighted.
      const selectable = data.weeks.filter((w) => w.dateFrom !== '9999-12-31').length
      setWeekIdx((i) => Math.min(i, Math.max(selectable - 1, 0)))
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load practitioner stats'
      setError(msg)
      setReport(null)
    } finally {
      setLoading(false)
    }
  }, [year, month, tab])

  useEffect(() => { load() }, [load])

  const week = report?.weeks[weekIdx] ?? null
  // The calculator emits an empty remainder as 9999-12-31 when a month ends on
  // Week 4's Sunday — don't offer a tab for a range that does not exist.
  const selectableWeeks = (report?.weeks ?? []).filter((w) => w.dateFrom !== '9999-12-31')

  return (
    <AppShell>
      <div className="pw-page" style={{ padding: '20px 28px' }}>

        <div style={{ marginBottom: 16 }}>
          <h1 style={{
            margin: 0, fontFamily: "'DM Sans', sans-serif",
            fontSize: 22, fontWeight: 700, color: TEXT, letterSpacing: '-0.02em',
          }}>
            Practitioner Stats
          </h1>
          <p style={{
            margin: '4px 0 0', fontSize: 13, color: TEXT_SOFT,
            fontFamily: "'DM Sans', sans-serif",
          }}>
            Weekly clinical impact per practitioner, Monday–Sunday. Zones follow the
            Clinical Impact KPI targets.
          </p>
        </div>

        {/* Clinic tabs */}
        <div className="pw-wrap" style={{
          display: 'flex', gap: 4, background: '#fff', padding: 4, borderRadius: 8,
          border: `1px solid ${BORDER}`, width: 'fit-content', maxWidth: '100%',
          marginBottom: 12,
        }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                padding: '7px 15px', border: 'none', borderRadius: 6,
                background: tab === t.id ? TEAL : 'transparent',
                color:      tab === t.id ? '#fff' : TEXT_SOFT,
                fontFamily: "'DM Sans', sans-serif",
                fontSize: 13, fontWeight: 600, cursor: 'pointer',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Period + week selector */}
        <div className="pw-wrap" style={{
          display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap',
        }}>
          <select
            value={month}
            onChange={(e) => setMonth(Number(e.target.value))}
            style={selectStyle}
          >
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            style={selectStyle}
          >
            {[now.getFullYear(), now.getFullYear() - 1, now.getFullYear() - 2].map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>

          {selectableWeeks.length > 0 && (
            <div style={{ display: 'flex', gap: 4, marginLeft: 4, flexWrap: 'wrap' }}>
              {selectableWeeks.map((w, i) => (
                <button
                  key={String(w.weekNum)}
                  onClick={() => setWeekIdx(i)}
                  title={`${w.dateFrom} → ${w.dateTo}`}
                  style={{
                    padding: '6px 12px', borderRadius: 6,
                    border: `1px solid ${weekIdx === i ? TEAL : BORDER}`,
                    background: weekIdx === i ? '#f0faf7' : '#fff',
                    color:      weekIdx === i ? TEAL : TEXT_SOFT,
                    fontFamily: "'DM Sans', sans-serif",
                    fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
                  }}
                >
                  {w.weekNum === 'remainder' ? 'Remainder' : `Week ${w.weekNum}`}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Zone legend */}
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 12 }}>
          {(Object.keys(ZONE) as Zone[]).map((z) => (
            <span key={z} style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontSize: 11.5, fontWeight: 600, color: ZONE[z].fg,
              fontFamily: "'DM Sans', sans-serif",
            }}>
              <span style={{ fontSize: 9 }}>{ZONE[z].glyph}</span>{ZONE[z].label}
            </span>
          ))}
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            fontSize: 11.5, fontWeight: 600, color: BLOCKED_FG,
            fontFamily: "'DM Sans', sans-serif",
          }}>
            <span style={{ fontSize: 10 }}>⚠</span>Hand-read from Nookal — not in the app yet
          </span>
          <span style={{
            fontSize: 11.5, fontWeight: 600, color: TEXT_MUTE,
            fontFamily: "'DM Sans', sans-serif", fontStyle: 'italic',
          }}>
            Italic = added here, not in the spreadsheet
          </span>
        </div>

        {error && (
          <div style={{
            background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c',
            borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 12,
            fontFamily: "'DM Sans', sans-serif",
          }}>
            {error}
          </div>
        )}

        {loading ? (
          <div style={{ padding: 30, color: TEXT_SOFT, fontSize: 13, fontFamily: "'DM Sans', sans-serif" }}>
            Loading…
          </div>
        ) : !week ? (
          <div style={{ padding: 30, color: TEXT_SOFT, fontSize: 13, fontFamily: "'DM Sans', sans-serif" }}>
            No data for this period.
          </div>
        ) : (
          <>
            <div style={{
              fontSize: 12.5, color: TEXT_SOFT, marginBottom: 8,
              fontFamily: "'DM Mono', ui-monospace, monospace",
            }}>
              {week.label} · {week.dateFrom} → {week.dateTo}
              {tab !== 'overall' && ` · ${CLINIC_LABEL[tab]}`}
            </div>

            <div style={{
              background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10,
              overflowX: 'auto',
            }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 1040 }}>
                <thead>
                  <tr>
                    {/* Same label as the sheet's first column, not "Practitioner". */}
                    <th style={{
                      ...thBase, textAlign: 'left', position: 'sticky', left: 0, zIndex: 2,
                      borderRight: `1px solid ${BORDER}`,
                    }}>
                      Therapist
                    </th>
                    {COLUMNS.map((c, i) => (
                      <th
                        key={c.label}
                        title={c.kind === 'blocked' ? undefined : c.title}
                        style={{
                          ...thBase,
                          ...(i === FIRST_ADDED ? { borderLeft: `2px solid ${BORDER}` } : {}),
                          ...(c.kind === 'blocked' ? { color: BLOCKED_FG, background: BLOCKED_BG } : {}),
                          ...('added' in c && c.added ? { fontStyle: 'italic' } : {}),
                        }}
                      >
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {week.rows.map((r) => <StatsRow key={r.clinicianId} r={r} />)}
                  <StatsRow r={week.team} isTeam />
                </tbody>
              </table>
            </div>

            {report && report.notes.length > 0 && (
              <div style={{
                marginTop: 14, background: '#fff', border: `1px solid ${BORDER}`,
                borderRadius: 10, padding: '13px 16px',
              }}>
                <div style={{
                  fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em',
                  textTransform: 'uppercase', color: TEXT_SOFT, marginBottom: 8,
                  fontFamily: "'DM Sans', sans-serif",
                }}>
                  How these figures are calculated
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 5 }}>
                  {report.notes.map((n, i) => (
                    <li key={i} style={{
                      fontSize: 12.5, color: TEXT_SOFT, lineHeight: 1.5,
                      fontFamily: "'DM Sans', sans-serif",
                    }}>
                      {n}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </AppShell>
  )
}

const selectStyle: React.CSSProperties = {
  padding: '7px 11px',
  border: `1px solid ${BORDER}`,
  borderRadius: 7,
  background: '#fff',
  color: TEXT,
  fontFamily: "'DM Sans', sans-serif",
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
}
