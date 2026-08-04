import React, { useEffect, useState, useCallback } from 'react'
import {
  practitionerStatsApi,
  PractitionerStatsReport,
  PractitionerWeekStats,
  Metric,
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

/** Columns the backend cannot fill yet. Rendered, not hidden — a missing KPI
 *  the CEO expects to see must read as "blocked", never as an empty cell. */
const BLOCKED_COLS: { key: keyof PractitionerWeekStats; label: string }[] = [
  { key: 'totalAppts',      label: 'Total appts' },
  { key: 'occupancy',       label: 'Occupancy'   },
  { key: 'newCases',        label: 'NC'          },
  { key: 'cancellationPct', label: 'Cxl %'       },
]

function fmt(m: Metric, suffix = ''): string {
  if (m.value === null) return '—'
  return `${m.value}${suffix}`
}

function ZoneCell({ m, suffix = '' }: { m: Metric; suffix?: string }) {
  if (m.value === null || !m.zone) {
    return (
      <td style={{ ...cellBase, color: TEXT_MUTE, fontWeight: 400 }} title="No data logged for this week">
        —
      </td>
    )
  }
  const z = ZONE[m.zone]
  return (
    <td style={cellBase}>
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
      <td style={cellBase}>{r.initials || '—'}</td>
      <ZoneCell m={r.recommendations} />
      <ZoneCell m={r.conversion} />
      <ZoneCell m={r.caseAcceptance}   suffix="%" />
      <ZoneCell m={r.tpDocumented}     suffix="%" />
      <ZoneCell m={r.prepayOfferedPct}  suffix="%" />
      <ZoneCell m={r.prepayAcceptedPct} suffix="%" />
      <td style={cellBase}>{r.cancellations || '—'}</td>
      <td style={cellBase}>{r.churns || '—'}</td>
      {BLOCKED_COLS.map((c) => {
        const cell = r[c.key] as { reason: string }
        return (
          <td
            key={c.key}
            style={{ ...cellBase, color: BLOCKED_FG, background: BLOCKED_BG, opacity: 0.85 }}
            title={cell.reason}
          >
            ⚠
          </td>
        )
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
      setReport(data)
      // A month has 4 weeks plus an optional remainder; clamp so switching
      // months never leaves the tab pointing past the end.
      setWeekIdx((i) => Math.min(i, Math.max(data.weeks.length - 1, 0)))
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
            <span style={{ fontSize: 10 }}>⚠</span>Needs Nookal data — hover for why
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
                    <th style={{
                      ...thBase, textAlign: 'left', position: 'sticky', left: 0, zIndex: 2,
                      borderRight: `1px solid ${BORDER}`,
                    }}>
                      Practitioner
                    </th>
                    <th style={thBase} title="Initial consultations logged — the prepay denominator">Initials</th>
                    <th style={thBase} title="Average treatment-plan recommendations. Target 8–12.">Recs</th>
                    <th style={thBase} title="Average appointments booked from initial. Target >6.">Conv</th>
                    <th style={thBase} title="Pooled: sum booked ÷ sum recommendations. Target >80%.">Case acc</th>
                    <th style={thBase} title="Treatment plans documented. Target 100%.">TP doc</th>
                    <th style={thBase} title="Prepay offered ÷ initial consults">Prepay off</th>
                    <th style={thBase} title="Prepay accepted ÷ prepay offered. Blank when nothing was offered.">Prepay acc</th>
                    <th style={thBase} title="Dropout entries logged — cancellation events">Cxl</th>
                    <th style={thBase} title="Cancellations that left no future booking">Churns</th>
                    {BLOCKED_COLS.map((c) => (
                      <th key={c.key} style={{ ...thBase, color: BLOCKED_FG, background: BLOCKED_BG }}>
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
