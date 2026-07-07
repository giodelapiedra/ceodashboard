import React, { useEffect, useMemo, useState } from 'react'
import {
  ResponsiveContainer,
  AreaChart, Area,
  BarChart, Bar,
  LineChart, Line,
  PieChart, Pie, Cell,
  XAxis, YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'
import { dashboardApi } from '../../api/dashboard.api'
import { adSpendApi, WeeklyReportRow } from '../../api/adSpend.api'
import { DashboardData, WeekMetrics, MonthlyTotals } from '../../types'
import AppShell from '../shared/AppShell'

// ── Theme ───────────────────────────────────────────────────────────────
const TEAL       = '#0f6e56'
const TEAL_LIGHT = '#22a37e'
const TEAL_TINT  = '#f0faf7'
const TEAL_TINT2 = '#e6f5ef'
const NAVY       = '#1e2547'
const NAVY_DARK  = '#14193a'
const TEXT       = '#111827'
const TEXT_SOFT  = '#4b5563'
const TEXT_MUTED = '#9ca3af'
const BORDER     = '#eef0f3'
const TRACK      = '#eef1f5'

// Per-metric accent palette — keeps each KPI visually distinct.
const ACCENTS = {
  revenue:  { from: '#0f6e56', to: '#22a37e', tint: '#f0faf7', glow: 'rgba(15,110,86,0.3)'  },
  patients: { from: '#0ea5e9', to: '#38bdf8', tint: '#f0f9ff', glow: 'rgba(14,165,233,0.3)' },
  showup:   { from: '#8b5cf6', to: '#a78bfa', tint: '#f5f3ff', glow: 'rgba(139,92,246,0.3)' },
  case:     { from: '#f59e0b', to: '#fbbf24', tint: '#fffbeb', glow: 'rgba(245,158,11,0.3)' },
} as const
type AccentKey = keyof typeof ACCENTS

// Colours for the revenue mix donut + composition labels.
const REVENUE_COLORS = {
  services:   '#0f6e56',
  products:   '#0ea5e9',
  upfront:    '#8b5cf6',
  insurance:  '#f59e0b',
}

const CLINIC_LIST = [
  { id: 'newport',   name: 'Newport'   },
  { id: 'narrabeen', name: 'Narrabeen' },
  { id: 'brookvale', name: 'Brookvale' },
  { id: 'overall',   name: 'Overall'   },
]
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

// ── Page ────────────────────────────────────────────────────────────────

export default function CEOAnalyticsPage() {
  const now = new Date()
  const [clinic, setClinic] = useState('newport')
  const [month,  setMonth]  = useState(now.getMonth() + 1)
  const [year,   setYear]   = useState(now.getFullYear())
  const [data,      setData]      = useState<DashboardData | null>(null)
  const [adSpend,   setAdSpend]   = useState<WeeklyReportRow[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)

    // Date range for the selected month
    const dateFrom = `${year}-${String(month).padStart(2, '0')}-01`
    const lastDay  = new Date(year, month, 0).getDate()
    const dateTo   = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

    Promise.all([
      dashboardApi.getMonthly(clinic, month, year),
      adSpendApi.weeklyReport(dateFrom, dateTo).catch(() => [] as WeeklyReportRow[]),
    ])
      .then(([dash, spend]) => {
        if (!cancelled) { setData(dash); setAdSpend(spend) }
      })
      .catch((e: any) => { if (!cancelled) setError(e?.response?.data?.error?.message || e?.response?.data?.error || 'Failed to load') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [clinic, month, year])

  const presets = [
    { label: 'This Month',   offset:  0 },
    { label: 'Last Month',   offset: -1 },
    { label: '2 Months Ago', offset: -2 },
    { label: '3 Months Ago', offset: -3 },
  ]
  const applyMonthOffset = (offset: number) => {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1)
    setMonth(d.getMonth() + 1); setYear(d.getFullYear())
  }
  const activePresetOffset = (() => {
    for (const p of presets) {
      const d = new Date(now.getFullYear(), now.getMonth() + p.offset, 1)
      if (d.getMonth() + 1 === month && d.getFullYear() === year) return p.offset
    }
    return null
  })()

  return (
    <AppShell title="CEO Analytics">
      <div className="pw-page" style={{ padding: '20px 28px' }}>
        {/* ── Controls ── */}
        <div style={{
          background: 'linear-gradient(180deg, #ffffff 0%, #fbfcfd 100%)',
          border: `1px solid ${BORDER}`,
          borderRadius: 12, padding: 12,
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          marginBottom: 16,
          boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04)',
        }}>
          {/* Clinic tabs */}
          <div style={{
            display: 'flex', gap: 4,
            background: '#f6f7f9', padding: 4, borderRadius: 9,
          }}>
            {CLINIC_LIST.map((c) => {
              const active = clinic === c.id
              return (
                <button key={c.id} onClick={() => setClinic(c.id)} style={{
                  background:  active ? `linear-gradient(180deg, ${TEAL} 0%, ${TEAL_LIGHT} 100%)` : 'transparent',
                  color:       active ? '#fff' : TEXT_SOFT,
                  border:      'none', borderRadius: 6,
                  padding:     '6px 16px', fontSize: 13, fontWeight: 600,
                  cursor:      'pointer',
                  fontFamily:  "'DM Sans', sans-serif",
                  boxShadow:   active ? `0 2px 6px ${TEAL}33` : 'none',
                }}>{c.name}</button>
              )
            })}
          </div>

          <div style={{ width: 1, height: 28, background: BORDER }} />

          {/* Month presets */}
          <div style={{ display: 'flex', gap: 4 }}>
            {presets.map((p) => {
              const active = activePresetOffset === p.offset
              return (
                <button key={p.offset} onClick={() => applyMonthOffset(p.offset)} style={{
                  background:  active ? TEAL : '#fff',
                  color:       active ? '#fff' : TEXT_SOFT,
                  border:      `1px solid ${active ? TEAL : BORDER}`,
                  borderRadius: 7, padding: '6px 12px',
                  fontSize: 12, fontWeight: 500,
                  cursor: 'pointer',
                  fontFamily: "'DM Sans', sans-serif",
                }}>{p.label}</button>
              )
            })}
          </div>

          <div style={{ width: 1, height: 28, background: BORDER }} />

          <select value={month} onChange={(e) => setMonth(Number(e.target.value))} style={selectStyle}>
            {MONTHS.map((n, i) => <option key={i + 1} value={i + 1}>{n}</option>)}
          </select>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} style={selectStyle}>
            {[2025, 2026, 2027].map((y) => <option key={y} value={y}>{y}</option>)}
          </select>

          <div style={{ flex: 1 }} />
          {data && (
            <div style={{ fontSize: 11, color: TEXT_MUTED, fontFamily: "'DM Mono', monospace" }}>
              {data.fromCache ? '✓ cached' : '↻ fresh'} · {data.duration}ms
            </div>
          )}
        </div>

        {error && (
          <div style={{
            background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c',
            borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 12,
          }}>⚠ {error}</div>
        )}

        {loading || !data
          ? <SkeletonState />
          : <Analytics data={data} adSpend={adSpend} />}
      </div>
    </AppShell>
  )
}

// ── Body ────────────────────────────────────────────────────────────────

function Analytics({ data, adSpend }: { data: DashboardData; adSpend: WeeklyReportRow[] }) {
  const weeks = data.weeks
  const m     = data.monthly

  // Sparklines for each KPI — small array of {x, y} per week.
  const revSeries     = useMemo(() => weeks.map((w) => ({ x: w.label, y: w.totalRevenue })),     [weeks])
  const newPatSeries  = useMemo(() => weeks.map((w) => ({ x: w.label, y: w.newPatients })),      [weeks])
  const showupSeries  = useMemo(() => weeks.map((w) => ({ x: w.label, y: w.showUpRate ?? 0 })),  [weeks])
  const caseSeries    = useMemo(() => weeks.map((w) => ({ x: w.label, y: w.caseAcceptance ?? 0 })), [weeks])

  // Revenue trend for the main area chart — multi-source.
  const revenueTrend = useMemo(() => weeks.map((w) => ({
    week:      shortenWeekLabel(w.label),
    Total:     w.totalRevenue,
    Services:  Math.max(0, w.totalRevenue - w.productSalesRevenue),
    Products:  w.productSalesRevenue,
    Upfront:   w.upfrontRevenue,
    Insurance: w.cashFromInsurance,
  })), [weeks])

  // Revenue mix donut — monthly aggregate by source.
  const revenueMix = useMemo(() => {
    const services = Math.max(0, m.totalRevenue - m.productSalesRevenue)
    return [
      { name: 'Services',  value: services,             color: REVENUE_COLORS.services  },
      { name: 'Products',  value: m.productSalesRevenue, color: REVENUE_COLORS.products  },
      { name: 'Upfront',   value: m.upfrontRevenue,      color: REVENUE_COLORS.upfront   },
      { name: 'Insurance', value: m.cashFromInsurance,   color: REVENUE_COLORS.insurance },
    ].filter((s) => s.value > 0)
  }, [m])

  // Performance rates per week.
  const ratesData = useMemo(() => weeks.map((w) => ({
    week:        shortenWeekLabel(w.label),
    'Show-Up':   w.showUpRate       ?? null,
    'Cancel':    w.cancellationRate ?? null,
    'Case Acc':  w.caseAcceptance   ?? null,
  })), [weeks])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* ── Hero KPI strip ── */}
      <div className="pw-grid-2" style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 14,
      }}>
        <KpiCard
          accent="revenue"
          label="Total Revenue"
          value={fmtCurrency(m.totalRevenue)}
          caption={`Monthly · ${data.clinic}`}
          spark={revSeries}
          highlight={fmtCurrencyShort(m.totalRevenue)}
        />
        <KpiCard
          accent="patients"
          label="New Patients"
          value={m.newPatients.toLocaleString()}
          caption={`+${m.patientReactivations} reactivations`}
          spark={newPatSeries}
        />
        <KpiCard
          accent="showup"
          label="Show-Up Rate"
          value={fmtPct(m.showUpRate)}
          caption={`${m.appointmentsAttended.toLocaleString()} attended`}
          spark={showupSeries}
        />
        <KpiCard
          accent="case"
          label="Case Acceptance"
          value={fmtPct(m.caseAcceptance)}
          caption="Plan acceptance rate"
          spark={caseSeries}
        />
      </div>

      {/* ── Revenue trend + mix ── */}
      <div className="pw-grid" style={{
        display: 'grid', gridTemplateColumns: '1.7fr 1fr', gap: 14,
      }}>
        <Panel>
          <PanelHeader
            title="Revenue trend"
            subtitle="Weekly revenue across the month"
            kpis={[
              { label: 'Best week',  value: bestWeekLabel(weeks, (w) => w.totalRevenue, fmtCurrencyShort) },
              { label: 'Avg / week', value: fmtCurrencyShort(avgBy(weeks, (w) => w.totalRevenue)) },
            ]}
          />
          <RevenueTrendChart data={revenueTrend} />
        </Panel>

        <Panel>
          <PanelHeader title="Revenue mix" subtitle="Monthly breakdown by source" />
          {revenueMix.length === 0
            ? <EmptyChart message="No revenue data" />
            : <RevenueMixDonut rows={revenueMix} total={m.totalRevenue} />}
        </Panel>
      </div>

      {/* ── Patient flow ── */}
      <Panel>
        <PanelHeader
          title="Patient flow"
          subtitle="From new arrivals through to attended appointments"
        />
        <PatientFlow monthly={m} />
      </Panel>

      {/* ── Performance rates ── */}
      <Panel>
        <PanelHeader
          title="Performance rates"
          subtitle="Show-up vs cancellation vs case acceptance, week by week"
          kpis={[
            { label: 'Show-Up',  value: fmtPct(m.showUpRate) },
            { label: 'Cancel',   value: fmtPct(m.cancellationRate) },
            { label: 'Case Acc', value: fmtPct(m.caseAcceptance) },
          ]}
        />
        <PerformanceRatesChart data={ratesData} />
      </Panel>

      {/* ── Operational metrics grid ── */}
      <Panel>
        <PanelHeader
          title="Operational metrics"
          subtitle="Secondary KPIs for the month"
        />
        <div className="pw-grid-2" style={{
          display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10,
        }}>
          <MiniStat label="No-shows"              value={m.noShows} />
          <MiniStat label="Cancelled"             value={m.appointmentsCancelled} />
          <MiniStat label="Rebooked"              value={m.appointmentsRebooked} />
          <MiniStat label="Upfront accepted"      value={m.upfrontPlanAccepted} accent />
          <MiniStat label="Products upsold"       value={m.productsUpsold} accent />
          <MiniStat label="Active patients"       value={m.activePatients} />
        </div>
      </Panel>

      {/* ── Ad Spend ── */}
      {adSpend.length > 0 && (
        <Panel>
          <PanelHeader
            title="Ad spend"
            subtitle="Weekly Facebook + Google spend (AUD)"
            kpis={[
              { label: 'Facebook', value: fmtCurrencyShort(adSpend.reduce((s, w) => s + (w.byChannel['Facebook'] ?? 0), 0)) },
              { label: 'Google',   value: fmtCurrencyShort(adSpend.reduce((s, w) => s + (w.byChannel['Google']   ?? 0), 0)) },
              { label: 'Total',    value: fmtCurrencyShort(adSpend.reduce((s, w) => s + w.total, 0)) },
            ]}
          />
          <AdSpendChart data={adSpend} />
        </Panel>
      )}
    </div>
  )
}

// ── KPI hero card ───────────────────────────────────────────────────────

function KpiCard({
  accent, label, value, caption, spark, highlight,
}: {
  accent:    AccentKey
  label:     string
  value:     string
  caption:   string
  spark:     { x: string; y: number }[]
  highlight?: string
}) {
  const a = ACCENTS[accent]
  const gradId = `kpi-grad-${accent}`
  const lineId = `kpi-line-${accent}`

  return (
    <div style={{
      position: 'relative',
      background: `linear-gradient(140deg, #ffffff 0%, #ffffff 55%, ${a.tint} 100%)`,
      border: `1px solid ${BORDER}`,
      borderRadius: 14,
      padding: '16px 18px',
      overflow: 'hidden',
      boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04), 0 6px 18px rgba(15, 23, 42, 0.04)',
    }}>
      {/* Top-right glow accent */}
      <div style={{
        position: 'absolute', top: -30, right: -30, width: 120, height: 120,
        background: `radial-gradient(circle, ${a.glow} 0%, transparent 70%)`,
        pointerEvents: 'none',
      }} />

      <div style={{
        position: 'relative',
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
        marginBottom: 4,
      }}>
        <div>
          <div style={{
            fontSize: 10, fontWeight: 700, color: TEXT_SOFT,
            letterSpacing: '0.1em', textTransform: 'uppercase',
          }}>{label}</div>
          <div style={{
            fontSize: 28, fontWeight: 700, color: TEXT, marginTop: 6,
            fontFamily: "'DM Mono', monospace", lineHeight: 1,
            letterSpacing: '-0.02em',
          }}>{value}</div>
          {(highlight || caption) && (
            <div style={{
              fontSize: 11, color: TEXT_MUTED, marginTop: 6, fontWeight: 500,
            }}>{caption}</div>
          )}
        </div>
        {/* Accent dot */}
        <span style={{
          width: 10, height: 10, borderRadius: 3,
          background: `linear-gradient(135deg, ${a.from} 0%, ${a.to} 100%)`,
          boxShadow: `0 0 0 3px ${a.glow}`,
        }} />
      </div>

      {/* Sparkline */}
      <div style={{ position: 'relative', height: 48, marginTop: 8, marginInline: -6 }}>
        <ResponsiveContainer>
          <AreaChart data={spark} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stopColor={a.from} stopOpacity={0.4} />
                <stop offset="100%" stopColor={a.from} stopOpacity={0} />
              </linearGradient>
              <linearGradient id={lineId} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%"   stopColor={a.from} />
                <stop offset="100%" stopColor={a.to} />
              </linearGradient>
            </defs>
            <Area
              type="monotone" dataKey="y"
              stroke={`url(#${lineId})`} strokeWidth={2}
              fill={`url(#${gradId})`}
              isAnimationActive animationDuration={550}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ── Revenue trend (main chart) ─────────────────────────────────────────

function RevenueTrendChart({ data }: {
  data: { week: string; Total: number; Services: number; Products: number; Upfront: number; Insurance: number }[]
}) {
  return (
    <div style={{ width: '100%', height: 280 }}>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 12, right: 12, bottom: 4, left: 4 }}>
          <defs>
            <linearGradient id="totalRevGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor={TEAL_LIGHT} stopOpacity={0.55} />
              <stop offset="60%"  stopColor={TEAL}       stopOpacity={0.2} />
              <stop offset="100%" stopColor={TEAL}       stopOpacity={0} />
            </linearGradient>
            <linearGradient id="totalRevLine" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%"   stopColor={TEAL} />
              <stop offset="100%" stopColor={TEAL_LIGHT} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#f1f3f6" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="week"
            tick={{ fill: TEXT_MUTED, fontSize: 11, fontFamily: "'DM Sans', sans-serif" }}
            tickLine={false}
            axisLine={{ stroke: BORDER }}
          />
          <YAxis
            tickFormatter={(v) => fmtCurrencyShort(v)}
            tick={{ fill: TEXT_MUTED, fontSize: 10, fontFamily: "'DM Mono', monospace" }}
            tickLine={false}
            axisLine={false}
            width={56}
          />
          <Tooltip content={<RevenueTooltip />} cursor={{ stroke: TEAL, strokeWidth: 1, strokeDasharray: '3 3' }} />
          <Area
            type="monotone" dataKey="Total"
            stroke="url(#totalRevLine)" strokeWidth={2.6}
            fill="url(#totalRevGrad)"
            activeDot={{ r: 5, stroke: '#fff', strokeWidth: 2.5, fill: TEAL }}
            isAnimationActive animationDuration={550}
          />
          <Line type="monotone" dataKey="Services"  stroke={REVENUE_COLORS.services}  strokeWidth={1.6} strokeDasharray="4 3" dot={false} isAnimationActive animationDuration={600} />
          <Line type="monotone" dataKey="Products"  stroke={REVENUE_COLORS.products}  strokeWidth={1.6} strokeDasharray="4 3" dot={false} isAnimationActive animationDuration={600} />
          <Line type="monotone" dataKey="Upfront"   stroke={REVENUE_COLORS.upfront}   strokeWidth={1.6} strokeDasharray="4 3" dot={false} isAnimationActive animationDuration={600} />
          <Line type="monotone" dataKey="Insurance" stroke={REVENUE_COLORS.insurance} strokeWidth={1.6} strokeDasharray="4 3" dot={false} isAnimationActive animationDuration={600} />
          <Legend
            verticalAlign="bottom" height={28}
            iconType="circle" iconSize={8}
            wrapperStyle={{ fontSize: 11, fontFamily: "'DM Sans', sans-serif", color: TEXT_SOFT, paddingTop: 4 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

function RevenueTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const items = payload.filter((p: any) => p.value !== null && p.value !== undefined)
  return (
    <div style={tooltipStyle}>
      <div style={{ opacity: 0.7, fontSize: 10, marginBottom: 6, fontWeight: 500 }}>{label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {items.map((p: any) => (
          <div key={p.dataKey} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
            <span style={{
              width: 8, height: 8, borderRadius: 2, background: p.color,
              flex: '0 0 auto',
            }} />
            <span style={{ opacity: 0.85, minWidth: 64 }}>{p.dataKey}</span>
            <span style={{
              fontFamily: "'DM Mono', monospace", fontWeight: 700,
              color: p.dataKey === 'Total' ? TEAL_LIGHT : '#fff',
              marginLeft: 'auto',
            }}>{fmtCurrencyShort(p.value)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Revenue mix donut ──────────────────────────────────────────────────

function RevenueMixDonut({
  rows, total,
}: { rows: { name: string; value: number; color: string }[]; total: number }) {
  return (
    <div className="pw-grid" style={{
      display: 'grid', gridTemplateColumns: '170px 1fr', gap: 16, alignItems: 'center',
    }}>
      <div style={{
        position: 'relative', width: 170, height: 170,
        background: `radial-gradient(circle at center, ${TEAL_TINT} 0%, rgba(255,255,255,0) 65%)`,
        borderRadius: '50%',
      }}>
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={rows} dataKey="value"
              innerRadius={52} outerRadius={78}
              paddingAngle={2.5} stroke="#fff" strokeWidth={2.5}
              isAnimationActive animationDuration={550}
              startAngle={90} endAngle={-270}
            >
              {rows.map((r) => <Cell key={r.name} fill={r.color} />)}
            </Pie>
            <Tooltip content={<MixTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
        }}>
          <div style={{
            fontSize: 18, fontWeight: 700, color: TEXT,
            fontFamily: "'DM Mono', monospace", lineHeight: 1,
            letterSpacing: '-0.02em',
          }}>{fmtCurrencyShort(total)}</div>
          <div style={{
            fontSize: 9, color: TEXT_MUTED, marginTop: 5,
            letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 700,
          }}>Total</div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {rows.map((r) => {
          const pct = total > 0 ? (r.value / total) * 100 : 0
          return (
            <div key={r.name} style={{
              display: 'flex', alignItems: 'center', gap: 9, padding: '4px 0',
            }}>
              <span style={{
                width: 10, height: 10, borderRadius: 3, background: r.color,
                flex: '0 0 auto', boxShadow: `0 0 0 3px ${r.color}1a`,
              }} />
              <span style={{
                fontSize: 12, color: TEXT, flex: 1, fontWeight: 500,
              }}>{r.name}</span>
              <span style={{
                fontSize: 11, color: TEXT_MUTED, minWidth: 32, textAlign: 'right',
                fontFamily: "'DM Mono', monospace",
              }}>{pct.toFixed(0)}%</span>
              <span style={{
                fontSize: 13, fontWeight: 700, color: TEXT, minWidth: 60, textAlign: 'right',
                fontFamily: "'DM Mono', monospace",
              }}>{fmtCurrencyShort(r.value)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function MixTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const item = payload[0]
  return (
    <div style={tooltipStyle}>
      <div style={{ opacity: 0.7, fontSize: 10, marginBottom: 1 }}>{item.name}</div>
      <div style={{ fontWeight: 700, fontFamily: "'DM Mono', monospace", fontSize: 14 }}>
        {fmtCurrency(item.value)}
      </div>
    </div>
  )
}

// ── Patient flow funnel ────────────────────────────────────────────────

function PatientFlow({ monthly: m }: { monthly: MonthlyTotals }) {
  // Conversion rates between stages — null when prev stage is 0.
  const reactRate     = pctOrNull(m.patientReactivations, m.newPatients + m.patientReactivations)
  const attendRate    = pctOrNull(m.appointmentsAttended, m.totalPatients)
  const noShowRate    = pctOrNull(m.noShows, m.totalPatients)

  const stages = [
    { label: 'New patients',  value: m.newPatients,             color: '#0ea5e9', sub: 'First-time arrivals' },
    { label: 'Reactivations', value: m.patientReactivations,    color: '#8b5cf6', sub: reactRate != null ? `${reactRate.toFixed(0)}% returning` : 'Returning patients' },
    { label: 'Total',         value: m.totalPatients,           color: TEAL,      sub: 'All patients seen' },
    { label: 'Attended',      value: m.appointmentsAttended,    color: '#10b981', sub: attendRate != null ? `${attendRate.toFixed(0)}% attendance` : 'Completed visits' },
    { label: 'No-shows',      value: m.noShows,                 color: '#ef4444', sub: noShowRate != null ? `${noShowRate.toFixed(0)}% no-show` : 'Missed visits' },
  ]

  return (
    <div className="pw-grid-2" style={{
      display: 'grid', gridTemplateColumns: 'repeat(5, 1fr) ',
      gap: 0, alignItems: 'stretch',
    }}>
      {stages.map((s, i) => (
        <React.Fragment key={s.label}>
          <div style={{
            position: 'relative',
            background: `linear-gradient(180deg, ${s.color}10 0%, ${s.color}03 100%)`,
            border: `1px solid ${s.color}25`,
            borderRadius: 12, padding: '14px 16px',
            zIndex: stages.length - i,
          }}>
            <div style={{
              fontSize: 10, fontWeight: 700, color: TEXT_SOFT,
              letterSpacing: '0.08em', textTransform: 'uppercase',
            }}>{s.label}</div>
            <div style={{
              fontSize: 26, fontWeight: 700, color: s.color, marginTop: 6,
              fontFamily: "'DM Mono', monospace", lineHeight: 1,
              letterSpacing: '-0.02em',
            }}>{s.value.toLocaleString()}</div>
            <div style={{
              fontSize: 11, color: TEXT_MUTED, marginTop: 6, fontWeight: 500,
            }}>{s.sub}</div>
            {/* Right-arrow connector — except last item */}
            {i < stages.length - 1 && (
              <div style={{
                position: 'absolute', right: -10, top: '50%',
                transform: 'translateY(-50%)',
                width: 20, height: 20, borderRadius: '50%',
                background: '#fff', border: `1px solid ${BORDER}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: TEXT_MUTED, fontSize: 12, fontWeight: 700,
                zIndex: 10,
                boxShadow: '0 1px 3px rgba(15, 23, 42, 0.06)',
              }}>›</div>
            )}
          </div>
          {/* Spacer so arrows don't collide */}
          {i < stages.length - 1 && <div style={{ width: 6 }} />}
        </React.Fragment>
      ))}
    </div>
  )
}

// ── Performance rates (multi-line) ─────────────────────────────────────

function PerformanceRatesChart({ data }: {
  data: { week: string; 'Show-Up': number | null; 'Cancel': number | null; 'Case Acc': number | null }[]
}) {
  return (
    <div style={{ width: '100%', height: 240 }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 12, right: 16, bottom: 4, left: -12 }}>
          <CartesianGrid stroke="#f1f3f6" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="week"
            tick={{ fill: TEXT_MUTED, fontSize: 11, fontFamily: "'DM Sans', sans-serif" }}
            tickLine={false}
            axisLine={{ stroke: BORDER }}
          />
          <YAxis
            tickFormatter={(v) => `${v}%`}
            tick={{ fill: TEXT_MUTED, fontSize: 10, fontFamily: "'DM Mono', monospace" }}
            tickLine={false}
            axisLine={false}
            width={42}
            domain={[0, 100]}
          />
          <Tooltip content={<RatesTooltip />} cursor={{ stroke: TEAL_LIGHT, strokeWidth: 1, strokeDasharray: '3 3' }} />
          <Line type="monotone" dataKey="Show-Up"  stroke="#10b981" strokeWidth={2.5} dot={{ r: 4, fill: '#fff', stroke: '#10b981', strokeWidth: 2 }} activeDot={{ r: 5 }} isAnimationActive animationDuration={550} connectNulls />
          <Line type="monotone" dataKey="Cancel"   stroke="#f59e0b" strokeWidth={2.5} dot={{ r: 4, fill: '#fff', stroke: '#f59e0b', strokeWidth: 2 }} activeDot={{ r: 5 }} isAnimationActive animationDuration={550} connectNulls />
          <Line type="monotone" dataKey="Case Acc" stroke="#8b5cf6" strokeWidth={2.5} dot={{ r: 4, fill: '#fff', stroke: '#8b5cf6', strokeWidth: 2 }} activeDot={{ r: 5 }} isAnimationActive animationDuration={550} connectNulls />
          <Legend
            verticalAlign="bottom" height={28}
            iconType="circle" iconSize={8}
            wrapperStyle={{ fontSize: 11, fontFamily: "'DM Sans', sans-serif", color: TEXT_SOFT, paddingTop: 4 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function RatesTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={tooltipStyle}>
      <div style={{ opacity: 0.7, fontSize: 10, marginBottom: 6, fontWeight: 500 }}>{label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {payload.map((p: any) => (
          <div key={p.dataKey} style={{
            display: 'flex', alignItems: 'center', gap: 8, fontSize: 11,
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: 2, background: p.color,
              flex: '0 0 auto',
            }} />
            <span style={{ opacity: 0.85, minWidth: 60 }}>{p.dataKey}</span>
            <span style={{
              fontFamily: "'DM Mono', monospace", fontWeight: 700,
              marginLeft: 'auto',
            }}>{p.value == null ? '—' : `${p.value.toFixed(1)}%`}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Ad Spend chart ─────────────────────────────────────────────────────

function AdSpendChart({ data }: { data: WeeklyReportRow[] }) {
  const chartData = data.map((w) => ({
    week:      `${w.week_start.slice(5)}→${w.week_end.slice(5)}`,
    Facebook:  +(w.byChannel['Facebook'] ?? 0).toFixed(2),
    Google:    +(w.byChannel['Google']   ?? 0).toFixed(2),
    Total:     +w.total.toFixed(2),
  }))

  return (
    <div style={{ width: '100%', height: 260 }}>
      <ResponsiveContainer>
        <BarChart data={chartData} margin={{ top: 12, right: 12, bottom: 4, left: 4 }} barGap={4}>
          <CartesianGrid stroke="#f1f3f6" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="week"
            tick={{ fill: TEXT_MUTED, fontSize: 11, fontFamily: "'DM Sans', sans-serif" }}
            tickLine={false}
            axisLine={{ stroke: BORDER }}
          />
          <YAxis
            tickFormatter={(v) => fmtCurrencyShort(v)}
            tick={{ fill: TEXT_MUTED, fontSize: 10, fontFamily: "'DM Mono', monospace" }}
            tickLine={false}
            axisLine={false}
            width={56}
          />
          <Tooltip content={<AdSpendTooltip />} cursor={{ fill: 'rgba(15,110,86,0.04)' }} />
          <Bar dataKey="Facebook" fill="#1877f2" radius={[4, 4, 0, 0]} isAnimationActive animationDuration={500} />
          <Bar dataKey="Google"   fill="#ea4335" radius={[4, 4, 0, 0]} isAnimationActive animationDuration={500} />
          <Legend
            verticalAlign="bottom" height={28}
            iconType="circle" iconSize={8}
            wrapperStyle={{ fontSize: 11, fontFamily: "'DM Sans', sans-serif", color: TEXT_SOFT, paddingTop: 4 }}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function AdSpendTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const total = payload.reduce((s: number, p: any) => s + (p.value ?? 0), 0)
  return (
    <div style={tooltipStyle}>
      <div style={{ opacity: 0.7, fontSize: 10, marginBottom: 6, fontWeight: 500 }}>{label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {payload.map((p: any) => (
          <div key={p.dataKey} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color, flex: '0 0 auto' }} />
            <span style={{ opacity: 0.85, minWidth: 64 }}>{p.dataKey}</span>
            <span style={{ fontFamily: "'DM Mono', monospace", fontWeight: 700, marginLeft: 'auto' }}>
              {fmtCurrencyShort(p.value)}
            </span>
          </div>
        ))}
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.15)', marginTop: 4, paddingTop: 4, display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
          <span style={{ opacity: 0.7 }}>Total</span>
          <span style={{ fontFamily: "'DM Mono', monospace", fontWeight: 700, color: TEAL_LIGHT }}>{fmtCurrencyShort(total)}</span>
        </div>
      </div>
    </div>
  )
}

// ── Mini stat ──────────────────────────────────────────────────────────

function MiniStat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div style={{
      background: accent
        ? `linear-gradient(180deg, ${TEAL_TINT} 0%, #ffffff 100%)`
        : '#fff',
      border: `1px solid ${accent ? TEAL_TINT2 : BORDER}`,
      borderRadius: 10, padding: '12px 14px',
    }}>
      <div style={{
        fontSize: 10, fontWeight: 700, color: TEXT_SOFT,
        letterSpacing: '0.08em', textTransform: 'uppercase',
      }}>{label}</div>
      <div style={{
        fontSize: 20, fontWeight: 700, color: accent ? TEAL : TEXT, marginTop: 4,
        fontFamily: "'DM Mono', monospace", lineHeight: 1,
      }}>{value.toLocaleString()}</div>
    </div>
  )
}

// ── Layout primitives ──────────────────────────────────────────────────

function Panel({
  children, style,
}: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
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

function EmptyChart({ message }: { message: string }) {
  return (
    <div style={{
      height: 220,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: TEXT_MUTED, fontSize: 13, fontWeight: 500,
      border: `1px dashed ${BORDER}`, borderRadius: 10,
      background: '#fafbfc',
    }}>{message}</div>
  )
}

function SkeletonState() {
  return (
    <div style={{
      background: 'linear-gradient(180deg, #ffffff 0%, #fbfcfd 100%)',
      border: `1px solid ${BORDER}`, borderRadius: 14,
      padding: 80, textAlign: 'center', color: TEXT_MUTED, fontSize: 13,
      boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04)',
    }}>
      <div style={{
        width: 36, height: 36, margin: '0 auto 16px',
        border: `3px solid ${TEAL_TINT2}`, borderTop: `3px solid ${TEAL}`,
        borderRadius: '50%',
        animation: 'spin 0.8s linear infinite',
      }} />
      <div style={{ fontWeight: 500 }}>Loading analytics from Nookal…</div>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────

const tooltipStyle: React.CSSProperties = {
  background: `linear-gradient(180deg, ${NAVY} 0%, ${NAVY_DARK} 100%)`,
  color: '#fff', padding: '10px 13px',
  borderRadius: 10, fontSize: 12, fontFamily: "'DM Sans', sans-serif",
  border: '1px solid rgba(255,255,255,0.08)',
  boxShadow: '0 8px 24px rgba(15, 23, 42, 0.25), 0 2px 4px rgba(15, 23, 42, 0.1)',
  minWidth: 150,
}

const selectStyle: React.CSSProperties = {
  border: `1px solid ${BORDER}`, borderRadius: 7, padding: '6px 10px',
  fontSize: 13, fontFamily: "'DM Sans', sans-serif",
  color: TEXT, background: '#fff', cursor: 'pointer',
}

function fmtCurrency(v: number): string {
  return `$${v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
/** "$12,345" → "$12.3K", "$1,234,567" → "$1.2M" — for tight chart axes/cards. */
function fmtCurrencyShort(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}
function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${v.toFixed(1)}%`
}
function pctOrNull(num: number, denom: number): number | null {
  if (denom <= 0) return null
  return (num / denom) * 100
}
function avgBy(rows: WeekMetrics[], pick: (r: WeekMetrics) => number): number {
  if (!rows.length) return 0
  return rows.reduce((s, r) => s + pick(r), 0) / rows.length
}
function bestWeekLabel(
  rows:   WeekMetrics[],
  pick:   (r: WeekMetrics) => number,
  format: (v: number) => string
): string {
  if (!rows.length) return '—'
  const top = rows.reduce((m, r) => (pick(r) > pick(m) ? r : m), rows[0])
  return `${shortenWeekLabel(top.label)} · ${format(pick(top))}`
}

/** "Week 1 [6-10]" → "Week 1" — drop the bracketed date range for compact display. */
function shortenWeekLabel(label: string): string {
  const idx = label.indexOf('[')
  return (idx >= 0 ? label.slice(0, idx) : label).trim()
}
