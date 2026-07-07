import React, { useMemo } from 'react'
import {
  ResponsiveContainer,
  AreaChart, Area,
  PieChart, Pie, Cell,
  XAxis, YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts'
import { DropoutSummary } from '../../api/dropouts.api'
import { CLINIC_LABEL, ClinicId, DROPOUT_STATUSES, DropoutStatus } from '../../types'

// ── Theme ───────────────────────────────────────────────────────────────
const TEAL       = '#0f6e56'
const TEAL_LIGHT = '#22a37e'
const TEAL_TINT  = '#f0faf7'
const TEAL_TINT2 = '#e6f5ef'
const TEXT       = '#111827'
const TEXT_SOFT  = '#4b5563'
const TEXT_MUTED = '#9ca3af'
const BORDER     = '#eef0f3'
const TRACK      = '#eef1f5'

const STATUS_COLOR: Record<DropoutStatus, string> = {
  'Re-scheduled':                '#10b981',
  'Cancelled - not rescheduled': '#f59e0b',
  'No Future Bookings':          '#ef4444',
  'Completed Treatment Plan':    '#0ea5e9',
}

const CLINIC_DOT: Record<string, string> = {
  newport:   '#0ea5e9',
  narrabeen: '#8b5cf6',
  brookvale: '#f59e0b',
}

interface Props {
  summary:  DropoutSummary
  dateFrom: string
  dateTo:   string
  /** When 'overall', show the per-clinic split panel. Otherwise hide it. */
  tab:      ClinicId | 'overall'
}

export default function DropoutAnalytics({ summary, dateFrom, dateTo, tab }: Props) {
  const series = useMemo(
    () => fillDailySeries(summary.byDay, dateFrom, dateTo),
    [summary.byDay, dateFrom, dateTo]
  )

  const reasonRows = useMemo(
    () => Object.entries(summary.byReason)
      .filter(([k]) => k && k !== 'null')
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6),
    [summary.byReason]
  )

  const statusRows = useMemo(
    () => DROPOUT_STATUSES
      .map((s) => ({ label: s, count: summary.byStatus[s] ?? 0, color: STATUS_COLOR[s] }))
      .filter((r) => r.count > 0),
    [summary.byStatus]
  )

  const clinicRows = useMemo(
    () => Object.entries(summary.byClinic)
      .map(([id, count]) => ({
        id,
        label: CLINIC_LABEL[id as ClinicId] ?? id,
        count,
        color: CLINIC_DOT[id] ?? TEAL,
      }))
      .sort((a, b) => b.count - a.count),
    [summary.byClinic]
  )

  const peakDay = useMemo(() => {
    if (!series.length) return null
    return series.reduce((m, d) => (d.count > m.count ? d : m), series[0])
  }, [series])

  const avgPerDay = useMemo(() => {
    if (!series.length) return 0
    return series.reduce((s, d) => s + d.count, 0) / series.length
  }, [series])

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        marginBottom: 12,
      }}>
        <div style={{
          fontSize: 12, fontWeight: 700, color: TEXT_SOFT,
          letterSpacing: '0.1em', textTransform: 'uppercase',
        }}>Analytics</div>
        <div style={{ fontSize: 11, color: TEXT_MUTED, fontFamily: "'DM Mono', monospace" }}>
          {dateFrom} → {dateTo} · {series.length} day{series.length === 1 ? '' : 's'}
        </div>
      </div>

      <div className="pw-grid" style={{
        display: 'grid',
        gridTemplateColumns: '1.6fr 1fr',
        gap: 14,
      }}>
        {/* ── Trend area chart ── */}
        <Panel>
          <PanelHeader
            title="Dropouts over time"
            subtitle="Daily entries within the selected range"
            kpis={[
              { label: 'Total',     value: summary.total.toLocaleString() },
              { label: 'Avg / day', value: avgPerDay.toFixed(1) },
              { label: 'Peak',      value: peakDay
                  ? `${peakDay.count} · ${formatShortDate(peakDay.date)}`
                  : '—' },
            ]}
          />
          {series.length === 0 ? (
            <EmptyChart message="No entries in this range" />
          ) : (
            <TrendChart data={series} />
          )}
        </Panel>

        {/* ── Status donut ── */}
        <Panel>
          <PanelHeader title="Status mix" subtitle="Outcome distribution" />
          {statusRows.length === 0
            ? <EmptyChart message="No status data" />
            : <StatusDonut rows={statusRows} total={summary.total} />}
        </Panel>

        {/* ── Top reasons ── */}
        <Panel style={{ gridColumn: tab === 'overall' ? 'span 1' : 'span 2' }}>
          <PanelHeader title="Top reasons" subtitle="Why patients dropped out" />
          {reasonRows.length === 0
            ? <EmptyChart message="No reason data" small />
            : <RankedRows rows={reasonRows.map((r) => ({
                ...r, color: TEAL, accent: 'gradient' as const,
              }))} />}
        </Panel>

        {/* ── Clinic split (overall view only) ── */}
        {tab === 'overall' && (
          <Panel>
            <PanelHeader title="By clinic" subtitle="Where the entries came from" />
            {clinicRows.length === 0
              ? <EmptyChart message="No clinic data" small />
              : <RankedRows
                  rows={clinicRows.map((c) => ({
                    label: c.label, count: c.count, color: c.color, accent: 'solid' as const,
                  }))}
                  hideRank
                  showShare
                />}
          </Panel>
        )}
      </div>
    </div>
  )
}

// ── Trend area chart with gradient ─────────────────────────────────────

function TrendChart({ data }: { data: { date: string; count: number }[] }) {
  return (
    <div style={{ width: '100%', height: 250 }}>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 12, right: 12, bottom: 4, left: -8 }}>
          <defs>
            <linearGradient id="dropoutAreaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor={TEAL_LIGHT} stopOpacity={0.55} />
              <stop offset="55%"  stopColor={TEAL}       stopOpacity={0.22} />
              <stop offset="100%" stopColor={TEAL}       stopOpacity={0} />
            </linearGradient>
            <linearGradient id="dropoutLineGrad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%"   stopColor={TEAL} />
              <stop offset="100%" stopColor={TEAL_LIGHT} />
            </linearGradient>
          </defs>

          <CartesianGrid stroke="#f1f3f6" strokeDasharray="2 4" vertical={false} />

          <XAxis
            dataKey="date"
            tickFormatter={formatShortDate}
            tick={{ fill: TEXT_MUTED, fontSize: 10, fontFamily: "'DM Sans', sans-serif" }}
            tickLine={false}
            axisLine={{ stroke: BORDER }}
            minTickGap={28}
            interval="preserveStartEnd"
          />
          <YAxis
            allowDecimals={false}
            tick={{ fill: TEXT_MUTED, fontSize: 10, fontFamily: "'DM Mono', monospace" }}
            tickLine={false}
            axisLine={false}
            width={36}
          />

          <Tooltip
            content={<TrendTooltip />}
            cursor={{ stroke: TEAL, strokeWidth: 1, strokeDasharray: '3 3' }}
          />

          <Area
            type="monotone"
            dataKey="count"
            stroke="url(#dropoutLineGrad)"
            strokeWidth={2.6}
            fill="url(#dropoutAreaGrad)"
            activeDot={{ r: 5, stroke: '#fff', strokeWidth: 2.5, fill: TEAL }}
            animationDuration={500}
            isAnimationActive
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

function TrendTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const v = payload[0].value as number
  return (
    <div style={{
      background: 'linear-gradient(180deg, #1e2547 0%, #14193a 100%)',
      color: '#fff', padding: '9px 13px',
      borderRadius: 10, fontSize: 12, fontFamily: "'DM Sans', sans-serif",
      border: '1px solid rgba(255,255,255,0.08)',
      boxShadow: '0 8px 24px rgba(15, 23, 42, 0.25), 0 2px 4px rgba(15, 23, 42, 0.1)',
      backdropFilter: 'blur(8px)',
    }}>
      <div style={{ opacity: 0.65, fontSize: 10, marginBottom: 3, fontWeight: 500 }}>
        {formatLongDate(label)}
      </div>
      <div style={{ fontFamily: "'DM Mono', monospace", display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontWeight: 700, fontSize: 16, color: TEAL_LIGHT }}>{v}</span>
        <span style={{ opacity: 0.7, fontSize: 11 }}>{v === 1 ? 'entry' : 'entries'}</span>
      </div>
    </div>
  )
}

// ── Status donut ───────────────────────────────────────────────────────

function StatusDonut({
  rows, total,
}: {
  rows: { label: string; count: number; color: string }[]
  total: number
}) {
  return (
    <div className="pw-grid" style={{
      display: 'grid',
      gridTemplateColumns: '170px 1fr',
      gap: 16,
      alignItems: 'center',
    }}>
      <div style={{
        position: 'relative', width: 170, height: 170,
        // Soft radial backdrop behind the donut for subtle depth.
        background: `radial-gradient(circle at center, ${TEAL_TINT} 0%, rgba(255,255,255,0) 65%)`,
        borderRadius: '50%',
      }}>
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={rows}
              dataKey="count"
              innerRadius={52}
              outerRadius={78}
              paddingAngle={2.5}
              stroke="#fff"
              strokeWidth={2.5}
              isAnimationActive
              animationDuration={550}
              startAngle={90}
              endAngle={-270}
            >
              {rows.map((r) => (
                <Cell key={r.label} fill={r.color} />
              ))}
            </Pie>
            <Tooltip content={<DonutTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        {/* Centre label */}
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
        }}>
          <div style={{
            fontSize: 26, fontWeight: 700, color: TEXT,
            fontFamily: "'DM Mono', monospace", lineHeight: 1,
            letterSpacing: '-0.02em',
          }}>{total.toLocaleString()}</div>
          <div style={{
            fontSize: 10, color: TEXT_MUTED, marginTop: 5,
            letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600,
          }}>Entries</div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {rows.map((r) => {
          const pct = total > 0 ? (r.count / total) * 100 : 0
          return (
            <div key={r.label} style={{
              display: 'flex', alignItems: 'center', gap: 9,
              padding: '4px 0',
            }}>
              <span style={{
                width: 10, height: 10, borderRadius: 3, background: r.color,
                display: 'inline-block', flex: '0 0 auto',
                boxShadow: `0 0 0 3px ${r.color}1a`, // 1a = 10% alpha glow
              }} />
              <span style={{
                fontSize: 12, color: TEXT, flex: 1, minWidth: 0, fontWeight: 500,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{r.label}</span>
              <span style={{
                fontSize: 11, color: TEXT_MUTED, minWidth: 32, textAlign: 'right',
                fontFamily: "'DM Mono', monospace",
              }}>{pct.toFixed(0)}%</span>
              <span style={{
                fontSize: 13, fontWeight: 700, color: TEXT, minWidth: 28, textAlign: 'right',
                fontFamily: "'DM Mono', monospace",
              }}>{r.count}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function DonutTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const item = payload[0]
  return (
    <div style={{
      background: 'linear-gradient(180deg, #1e2547 0%, #14193a 100%)',
      color: '#fff', padding: '7px 11px',
      borderRadius: 10, fontSize: 12, fontFamily: "'DM Sans', sans-serif",
      border: '1px solid rgba(255,255,255,0.08)',
      boxShadow: '0 8px 24px rgba(15, 23, 42, 0.25)',
    }}>
      <div style={{ opacity: 0.7, fontSize: 10, marginBottom: 1 }}>{item.name}</div>
      <div style={{ fontWeight: 700, fontFamily: "'DM Mono', monospace", fontSize: 14 }}>
        {item.value}
      </div>
    </div>
  )
}

// ── Ranked rows (used for Top reasons + By clinic) ─────────────────────

interface RankedRow {
  label:  string
  count:  number
  color:  string
  /** 'gradient' = teal→light gradient bar; 'solid' = single colour bar (clinics). */
  accent: 'gradient' | 'solid'
}

function RankedRows({
  rows, hideRank, showShare,
}: {
  rows:      RankedRow[]
  hideRank?: boolean
  showShare?: boolean
}) {
  const max   = Math.max(1, ...rows.map((r) => r.count))
  const total = rows.reduce((s, r) => s + r.count, 0) || 1

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {rows.map((r, i) => {
        const widthPct = (r.count / max) * 100
        const sharePct = (r.count / total) * 100
        const isTop = i === 0
        const fill = r.accent === 'gradient'
          ? `linear-gradient(90deg, ${TEAL} 0%, ${TEAL_LIGHT} 100%)`
          : r.color
        return (
          <div key={r.label} style={{
            display: 'grid',
            gridTemplateColumns: hideRank ? '1fr auto' : '32px 1fr auto',
            alignItems: 'center',
            gap: 14,
          }}>
            {/* Rank chip */}
            {!hideRank && (
              <div style={{
                width: 30, height: 30, borderRadius: 9,
                background: isTop
                  ? `linear-gradient(135deg, ${TEAL} 0%, ${TEAL_LIGHT} 100%)`
                  : TEAL_TINT,
                color:  isTop ? '#fff' : TEAL,
                fontSize: 12, fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: "'DM Mono', monospace",
                boxShadow: isTop
                  ? `0 4px 10px ${TEAL}40, inset 0 1px 0 rgba(255,255,255,0.15)`
                  : 'inset 0 0 0 1px ' + TEAL_TINT2,
                flex: '0 0 auto',
              }}>{i + 1}</div>
            )}

            {/* Label + bar */}
            <div style={{ minWidth: 0 }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                marginBottom: 6,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  {hideRank && (
                    <span style={{
                      width: 8, height: 8, borderRadius: 2, background: r.color,
                      display: 'inline-block', flex: '0 0 auto',
                      boxShadow: `0 0 0 3px ${r.color}1a`,
                    }} />
                  )}
                  <span style={{
                    fontSize: 13, fontWeight: 600, color: TEXT,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>{r.label}</span>
                </div>
                {(showShare || sharePct < 100) && (
                  <span style={{
                    fontSize: 11, color: TEXT_MUTED, fontFamily: "'DM Mono', monospace",
                    fontWeight: 500,
                  }}>{sharePct.toFixed(1)}%</span>
                )}
              </div>
              <div style={{
                height: 9, borderRadius: 999,
                background: TRACK,
                position: 'relative', overflow: 'hidden',
                boxShadow: 'inset 0 1px 1px rgba(15, 23, 42, 0.04)',
              }}>
                <div style={{
                  position: 'absolute', insetBlock: 0, left: 0,
                  width: `${widthPct}%`,
                  background: fill,
                  borderRadius: 999,
                  boxShadow: r.accent === 'gradient'
                    ? `0 1px 2px ${TEAL}33, inset 0 1px 0 rgba(255,255,255,0.18)`
                    : `0 1px 2px ${r.color}33, inset 0 1px 0 rgba(255,255,255,0.2)`,
                  transition: 'width 0.55s cubic-bezier(0.4, 0, 0.2, 1)',
                }} />
              </div>
            </div>

            {/* Count */}
            <div style={{
              display: 'flex', alignItems: 'baseline', gap: 4,
              justifyContent: 'flex-end', minWidth: 56,
            }}>
              <span style={{
                fontSize: 20, fontWeight: 700, color: TEXT,
                fontFamily: "'DM Mono', monospace", lineHeight: 1,
                letterSpacing: '-0.02em',
              }}>{r.count.toLocaleString()}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Layout primitives ──────────────────────────────────────────────────

function Panel({
  children, style,
}: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      // Subtle vertical gradient + soft shadow gives just enough lift.
      background:   'linear-gradient(180deg, #ffffff 0%, #fbfcfd 100%)',
      border:       `1px solid ${BORDER}`,
      borderRadius: 14,
      padding:      '18px 20px',
      boxShadow:    '0 1px 2px rgba(15, 23, 42, 0.04), 0 4px 14px rgba(15, 23, 42, 0.035)',
      ...style,
    }}>
      {children}
    </div>
  )
}

function PanelHeader({
  title, subtitle, kpis,
}: {
  title:    string
  subtitle: string
  kpis?:    { label: string; value: string }[]
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
        gap: 12, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          {/* Accent bar — gives each panel a subtle brand stripe */}
          <span style={{
            width: 4, height: 22, borderRadius: 999,
            background: `linear-gradient(180deg, ${TEAL} 0%, ${TEAL_LIGHT} 100%)`,
            marginTop: 2, flex: '0 0 auto',
            boxShadow: `0 0 8px ${TEAL}40`,
          }} />
          <div>
            <div style={{
              fontSize: 14, fontWeight: 700, color: TEXT,
              letterSpacing: '-0.01em', lineHeight: 1.2,
            }}>{title}</div>
            <div style={{
              fontSize: 11, color: TEXT_MUTED, marginTop: 4, fontWeight: 500,
            }}>{subtitle}</div>
          </div>
        </div>
        {kpis && kpis.length > 0 && (
          <div style={{ display: 'flex', gap: 8 }}>
            {kpis.map((k) => (
              <div key={k.label} style={{
                background: TEAL_TINT,
                border: `1px solid ${TEAL_TINT2}`,
                borderRadius: 9, padding: '6px 11px',
                textAlign: 'right', minWidth: 60,
              }}>
                <div style={{
                  fontSize: 9, color: TEXT_SOFT, fontWeight: 700,
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                }}>{k.label}</div>
                <div style={{
                  fontSize: 14, fontWeight: 700, color: TEAL, marginTop: 2,
                  fontFamily: "'DM Mono', monospace", lineHeight: 1,
                }}>{k.value}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function EmptyChart({ message, small }: { message: string; small?: boolean }) {
  return (
    <div style={{
      height: small ? 100 : 220,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: TEXT_MUTED, fontSize: 13, fontWeight: 500,
      border: `1px dashed ${BORDER}`, borderRadius: 10,
      background: '#fafbfc',
    }}>
      {message}
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Fill missing days with 0 between dateFrom..dateTo (inclusive). The DB only
 * returns days that actually had entries, so for a 30-day filter we need to
 * pad zeros to keep the trend chart honest.
 */
function fillDailySeries(
  byDay:    { date: string; count: number }[],
  dateFrom: string,
  dateTo:   string
): { date: string; count: number }[] {
  if (!dateFrom || !dateTo) {
    return byDay.slice().sort((a, b) => a.date.localeCompare(b.date))
  }
  const map = new Map(byDay.map((d) => [d.date, d.count]))
  const out: { date: string; count: number }[] = []

  const start = new Date(`${dateFrom}T00:00:00Z`)
  const end   = new Date(`${dateTo}T00:00:00Z`)
  // Cap at 366 days so a misclick on the date filter can't murder render perf.
  const MAX_DAYS = 366
  let safety = 0

  for (
    let d = new Date(start);
    d.getTime() <= end.getTime() && safety < MAX_DAYS;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    const iso = d.toISOString().slice(0, 10)
    out.push({ date: iso, count: map.get(iso) ?? 0 })
    safety++
  }
  return out
}

const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

/** "2026-04-13" → "Apr 13" */
function formatShortDate(iso: string): string {
  if (!iso || iso.length < 10) return iso ?? ''
  const m = Number(iso.slice(5, 7))
  const d = Number(iso.slice(8, 10))
  return `${SHORT_MONTHS[m - 1]} ${d}`
}

/** "2026-04-13" → "Mon, Apr 13, 2026" */
function formatLongDate(iso: string): string {
  if (!iso || iso.length < 10) return iso ?? ''
  const date = new Date(`${iso}T00:00:00Z`)
  const dows = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
  return `${dows[date.getUTCDay()]}, ${SHORT_MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`
}
