import React, { useState, useCallback, useEffect } from 'react'
import { DashboardData, WeekMetrics, MonthlyTotals } from '../../types'
import { dashboardApi } from '../../api/dashboard.api'
import { useAuthStore } from '../../store/auth.store'
import FetchProgress from '../common/FetchProgress'

// ── Format helpers ────────────────────────────────────────────
const DASH = '—'
const fmtCurrency = (v: number) =>
  `$${v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtCurrencyCell = (v: number | null | undefined) =>
  v == null || v === 0 ? DASH : fmtCurrency(v)
const fmtIntCell = (v: number | null | undefined) =>
  v == null || v === 0 ? DASH : v.toLocaleString('en-AU')
const fmtPctCell = (v: number | null | undefined) =>
  v == null ? DASH : `${v.toFixed(1)}%`

// ── Colours ───────────────────────────────────────────────────
const TEAL       = '#0f6e56'
const TEAL_SOFT  = '#f0faf7'
const NAVY       = '#1a1a2e'
const HEADER_BG  = '#1e2547'
const TEXT       = '#111827'
const TEXT_SOFT  = '#4b5563'
const TEXT_MUTED = '#9ca3af'
const BORDER     = '#eef0f3'
const ROW_ALT    = '#fafbfc'

// ── Month names ───────────────────────────────────────────────
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

// ── Clinics ───────────────────────────────────────────────────
const CLINIC_LIST = [
  { id: 'newport',   name: 'Newport'   },
  { id: 'narrabeen', name: 'Narrabeen' },
  { id: 'brookvale', name: 'Brookvale' },
]

// ── Sub-components ────────────────────────────────────────────

function SectionHeader({ label }: { label: string }) {
  return (
    <tr>
      <td colSpan={10} style={{
        background: NAVY, color: '#fff', fontWeight: 600, fontSize: 11,
        letterSpacing: '0.08em', padding: '9px 16px', textTransform: 'uppercase',
      }}>
        {label}
      </td>
    </tr>
  )
}

type CellVal = string

function DataRow({
  label, definition, wk1, wk2, wk3, wk4, rem,
  metricType, monthly, monthlyGoal, highlight, alt,
}: {
  label: string; definition: string
  wk1: CellVal; wk2: CellVal; wk3: CellVal; wk4: CellVal; rem: CellVal
  metricType: string; monthly: CellVal; monthlyGoal?: CellVal
  highlight?: boolean; alt?: boolean
}) {
  const rowBg = highlight ? TEAL_SOFT : alt ? ROW_ALT : '#fff'

  const numericCell = (v: CellVal, bold = false): React.CSSProperties => ({
    padding: '9px 12px',
    fontSize: 12.5,
    textAlign: 'right',
    fontFamily: "'DM Mono', monospace",
    fontVariantNumeric: 'tabular-nums',
    borderBottom: `1px solid ${BORDER}`,
    color: v === DASH ? TEXT_MUTED : highlight ? TEAL : TEXT,
    background: rowBg,
    whiteSpace: 'nowrap',
    fontWeight: bold ? 600 : 400,
  })

  return (
    <tr className="metric-row">
      <td style={{
        padding: '9px 16px', fontSize: 12.5, fontWeight: 500, color: TEXT,
        borderBottom: `1px solid ${BORDER}`, background: rowBg,
        minWidth: 240,
      }}>{label}</td>
      <td style={{
        padding: '9px 14px', fontSize: 12, color: TEXT_SOFT,
        borderBottom: `1px solid ${BORDER}`, background: rowBg,
        minWidth: 260, lineHeight: 1.4,
      }}>{definition}</td>
      <td style={numericCell(wk1)}>{wk1}</td>
      <td style={numericCell(wk2)}>{wk2}</td>
      <td style={numericCell(wk3)}>{wk3}</td>
      <td style={numericCell(wk4)}>{wk4}</td>
      <td style={numericCell(rem)}>{rem}</td>
      <td style={{
        padding: '9px 10px', fontSize: 10, fontWeight: 500,
        textAlign: 'center', color: TEXT_MUTED,
        textTransform: 'uppercase', letterSpacing: '0.06em',
        borderBottom: `1px solid ${BORDER}`, background: rowBg,
        whiteSpace: 'nowrap',
      }}>{metricType || ''}</td>
      <td style={numericCell(monthly, true)}>{monthly}</td>
      <td style={{ ...numericCell(monthlyGoal ?? DASH), color: TEXT_MUTED }}>
        {monthlyGoal ?? DASH}
      </td>
    </tr>
  )
}

// ── Dashboard Table ───────────────────────────────────────────
function DashboardTable({ data }: { data: DashboardData }) {
  const w = data.weeks
  const m = data.monthly

  const wv = <K extends keyof WeekMetrics>(i: number, key: K): WeekMetrics[K] | null => {
    const week = w[i]
    if (!week) return null
    return week[key]
  }

  // Alternating-row counter (reset per section for clean banding)
  let rowIdx = 0
  const nextAlt = () => (rowIdx++ % 2 === 1)
  const resetAlt = () => { rowIdx = 0 }

  const crow = (
    label: string, def: string, key: keyof WeekMetrics,
    mKey: keyof MonthlyTotals, highlight = false
  ) => (
    <DataRow
      label={label} definition={def}
      wk1={fmtCurrencyCell(wv(0, key) as number | null)}
      wk2={fmtCurrencyCell(wv(1, key) as number | null)}
      wk3={fmtCurrencyCell(wv(2, key) as number | null)}
      wk4={fmtCurrencyCell(wv(3, key) as number | null)}
      rem={fmtCurrencyCell(wv(4, key) as number | null)}
      metricType="Total"
      monthly={fmtCurrencyCell(m[mKey] as number)}
      highlight={highlight}
      alt={!highlight && nextAlt()}
    />
  )

  const nrow = (
    label: string, def: string, key: keyof WeekMetrics,
    mKey: keyof MonthlyTotals, metricType = 'Total', highlight = false
  ) => (
    <DataRow
      label={label} definition={def}
      wk1={fmtIntCell(wv(0, key) as number | null)}
      wk2={fmtIntCell(wv(1, key) as number | null)}
      wk3={fmtIntCell(wv(2, key) as number | null)}
      wk4={fmtIntCell(wv(3, key) as number | null)}
      rem={fmtIntCell(wv(4, key) as number | null)}
      metricType={metricType}
      monthly={fmtIntCell(m[mKey] as number)}
      highlight={highlight}
      alt={!highlight && nextAlt()}
    />
  )

  const prow = (
    label: string, def: string, key: keyof WeekMetrics,
    mKey: keyof MonthlyTotals, highlight = false
  ) => (
    <DataRow
      label={label} definition={def}
      wk1={fmtPctCell(wv(0, key) as number | null)}
      wk2={fmtPctCell(wv(1, key) as number | null)}
      wk3={fmtPctCell(wv(2, key) as number | null)}
      wk4={fmtPctCell(wv(3, key) as number | null)}
      rem={fmtPctCell(wv(4, key) as number | null)}
      metricType="Avg"
      monthly={fmtPctCell(m[mKey] as number | null)}
      highlight={highlight}
      alt={!highlight && nextAlt()}
    />
  )

  const emptyRow = (label: string, def: string, metricType = 'Total', monthly = DASH) => (
    <DataRow
      label={label} definition={def}
      wk1={DASH} wk2={DASH} wk3={DASH} wk4={DASH} rem={DASH}
      metricType={metricType} monthly={monthly}
      alt={nextAlt()}
    />
  )

  const colHeader = (text: string, sub?: string, align: 'left' | 'right' | 'center' = 'right') => (
    <th style={{
      padding: '12px 12px', textAlign: align, fontSize: 11, fontWeight: 600,
      color: '#fff', background: HEADER_BG, whiteSpace: 'nowrap',
      borderRight: '1px solid rgba(255,255,255,0.08)',
      position: 'sticky', top: 0, zIndex: 1,
      letterSpacing: '0.03em',
    }}>
      {text}
      {sub && <div style={{ fontSize: 10, fontWeight: 400, opacity: 0.55, marginTop: 3 }}>{sub}</div>}
    </th>
  )

  return (
    <div className="print-table-wrap" style={{ overflowX: 'auto', maxHeight: '72vh', overflowY: 'auto' }}>
      <style>{`
        .metric-row { transition: background 0.12s }
        .metric-row:hover td { background: #f5f7fa !important }
      `}</style>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1180 }}>
        <thead>
          <tr>
            <th style={{
              padding: '12px 16px', textAlign: 'left', fontSize: 11,
              fontWeight: 700, color: '#fff', background: HEADER_BG,
              letterSpacing: '0.07em', textTransform: 'uppercase',
              position: 'sticky', top: 0, zIndex: 1,
            }}>
              Metrics
            </th>
            <th style={{
              padding: '12px 14px', textAlign: 'left', fontSize: 11,
              fontWeight: 600, color: '#fff', background: HEADER_BG,
              borderRight: '1px solid rgba(255,255,255,0.08)',
              position: 'sticky', top: 0, zIndex: 1,
              letterSpacing: '0.03em',
            }}>
              Definition
            </th>
            {[0, 1, 2, 3, 4].map(i => {
              const label = data.weeks[i]?.label ?? ''
              const parsed = label.match(/^(.+?)\s*(\[[^\]]*\])?$/)
              const title    = parsed?.[1] ?? label
              const subtitle = parsed?.[2] ?? ''
              return <React.Fragment key={i}>{colHeader(title, subtitle)}</React.Fragment>
            })}
            {colHeader('Metric Type', undefined, 'center')}
            {colHeader('Monthly Actual')}
            {colHeader('Monthly Goal')}
          </tr>
        </thead>
        <tbody>

          {/* ── FINANCES ── */}
          <SectionHeader label="Finances $$$" />
          {(resetAlt(), null)}
          {crow('Total Revenue',
            'Total revenue collected in last 7 days',
            'totalRevenue', 'totalRevenue', true)}
          {crow('Total Revenue from Product Sales',
            'Total product sales in the last 7 days',
            'productSalesRevenue', 'productSalesRevenue')}
          {crow('Upfront Revenue',
            'Total upfront revenue from upfront treatment plan',
            'upfrontRevenue', 'upfrontRevenue', true)}
          {crow('Cash Collected from Insurance Patients',
            'Cash collected from insurance patients last 7 days',
            'cashFromInsurance', 'cashFromInsurance')}
          {emptyRow('Projected Revenue from Insurance Patients',
            'Projected revenue from insurance claims etc last 7 days', '')}
          {emptyRow('Debt Collection',
            'Total revenue sent to debt collection (all time)')}

          {/* ── MARKETING ── */}
          <SectionHeader label="Marketing" />
          {(resetAlt(), null)}
          {emptyRow('New Opt Ins To The List',
            'Total number of new opt ins to our email list in last 7 days')}
          {nrow('New Patients',
            'Total number of new patients in the last 7 days',
            'newPatients', 'newPatients', 'Total', true)}
          {nrow('Patient Reactivations (New Episodes)',
            'Total number of patient reactivations in the last 7 days',
            'patientReactivations', 'patientReactivations')}
          {emptyRow('Ad Spend',
            'Total ad spend across all campaigns for last 7 days', '')}
          {emptyRow('Cost Per Patient',
            'Total ad spend / number of new patients')}

          {/* ── SALES ── */}
          <SectionHeader label="Sales (Service & Product Delivery)" />
          {(resetAlt(), null)}
          {nrow('Total Number of Patients For The Week',
            'Total number of patients in the calendar for the last 7 days',
            'totalPatients', 'totalPatients', 'Total', true)}
          {nrow('Appointments Attended',
            'Total number of appointments attended in the last 7 days',
            'appointmentsAttended', 'appointmentsAttended')}
          {prow('Appointment Show Up Rate %',
            'Total appt attended / Total Number of appt Booked',
            'showUpRate', 'showUpRate', true)}
          {nrow('Appointments Cancelled with No Rebooking',
            'Total number of appointments cancelled & no re-booking in the last 7 days',
            'appointmentsCancelled', 'appointmentsCancelled')}
          {nrow('Appointments Cancelled & Rebooked',
            'Total number of appts cancelled & re-booked in the last 7 days',
            'appointmentsRebooked', 'appointmentsRebooked')}
          {prow('Cancellation %',
            'Number of appts cancelled / Total number of appts attended',
            'cancellationRate', 'cancellationRate')}
          {nrow('No Show Appointments',
            'Total number of no show appts in the last 7 days',
            'noShows', 'noShows')}
          {prow('Case Acceptance % For All Team',
            'Average case acceptance across the whole team in the last 7 days',
            'caseAcceptance', 'caseAcceptance', true)}
          {nrow('Number of Clients Who Took The Upfront Treatment Plan Option',
            'Number of clients who accepted upfront offer (payment collected) in the last 7 days',
            'upfrontPlanAccepted', 'upfrontPlanAccepted')}
          {nrow('Clients Who Accepted a Product or Upsell',
            'Number of clients who accepted a product or upsell in the last 7 days',
            'productsUpsold', 'productsUpsold')}
          {emptyRow('Clients Who Transitioned To A Complementary Service',
            'Number of clients who transitioned to a complementary service in last 7 days')}
          {emptyRow('Active Patients',
            'Total number of active patients in treatment in the last 7 days', 'Avg')}
          {emptyRow('Inactive Patients',
            'Total number of inactive patients not in treatment (all time)', '')}

        </tbody>
      </table>
    </div>
  )
}

// ── Main Dashboard Page ───────────────────────────────────────
export default function DashboardPage() {
  const { logout, user }    = useAuthStore()
  const now                 = new Date()
  const [clinic, setClinic] = useState('newport')
  const [month, setMonth]   = useState(now.getMonth() + 1)
  const [year, setYear]     = useState(now.getFullYear())
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [data, setData]       = useState<DashboardData | null>(null)

  const fetchData = useCallback(async (forceRefresh = false) => {
    setLoading(true); setError(null)
    try {
      const result = await dashboardApi.getMonthly(clinic, month, year, { forceRefresh })
      setData(result)
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed to fetch data')
    } finally {
      setLoading(false)
    }
  }, [clinic, month, year])

  useEffect(() => { fetchData() }, [fetchData])

  const currentClinic = CLINIC_LIST.find(c => c.id === clinic)
  const years = [2025, 2026, 2027]

  const applyMonthOffset = (offset: number) => {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1)
    setMonth(d.getMonth() + 1)
    setYear(d.getFullYear())
  }
  const presets = [
    { label: 'This Month',   offset:  0 },
    { label: 'Last Month',   offset: -1 },
    { label: '2 Months Ago', offset: -2 },
    { label: '3 Months Ago', offset: -3 },
  ]
  const activePresetOffset = (() => {
    for (const p of presets) {
      const d = new Date(now.getFullYear(), now.getMonth() + p.offset, 1)
      if (d.getMonth() + 1 === month && d.getFullYear() === year) return p.offset
    }
    return null
  })()

  return (
    <div className="print-root" style={{ minHeight: '100vh', background: '#f0f2f5', fontFamily: "'DM Sans', sans-serif" }}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg) } }
        @keyframes fadeIn { from { opacity:0; transform:translateY(6px) } to { opacity:1; transform:none } }
        .clinic-btn:hover { background: #e8f5f0 !important; border-color: #0f6e56 !important; color: #0f6e56 !important }
        .clinic-btn.active { background: #0f6e56 !important; color: #fff !important; border-color: #0f6e56 !important }
        .fetch-btn:hover:not(:disabled) { background: #0a5040 !important }
        select:focus { outline: none; border-color: #0f6e56; box-shadow: 0 0 0 2px rgba(15,110,86,0.15) }

        /* ── Print styles ─────────────────────────────────────── */
        @media print {
          @page { size: 297mm 210mm; margin: 8mm }   /* A4 landscape, explicit */
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important }
          html, body { background: #fff !important; margin: 0 !important; padding: 0 !important }
          .no-print { display: none !important }

          .print-root {
            background: #fff !important;
            padding: 0 !important;
            margin: 0 !important;
            min-height: 0 !important;
          }
          .print-area { padding: 0 !important; margin: 0 !important }

          .print-card {
            border: 1px solid #d1d5db !important;
            border-radius: 0 !important;
            box-shadow: none !important;
            overflow: visible !important;
          }

          /* Table wrapper: disable scroll, let it flow on paper */
          .print-table-wrap {
            max-height: none !important;
            overflow: visible !important;
          }
          .print-table-wrap table {
            min-width: 0 !important;
            width: 100% !important;
            table-layout: fixed !important;
          }

          /* Repeat header on every page */
          .print-table-wrap thead { display: table-header-group }
          .print-table-wrap tfoot { display: table-footer-group }

          /* Don't split rows across pages */
          .print-table-wrap tr { page-break-inside: avoid; break-inside: avoid }

          /* Allow first two columns (Metric + Definition) to wrap — numerics stay nowrap */
          .print-table-wrap th:nth-child(1),
          .print-table-wrap th:nth-child(2),
          .print-table-wrap td:nth-child(1),
          .print-table-wrap td:nth-child(2) {
            white-space: normal !important;
            word-break: break-word;
            overflow-wrap: anywhere;
            min-width: 0 !important;
          }

          /* Proportional column widths for landscape A4 */
          .print-table-wrap th:nth-child(1)  { width: 17% !important }
          .print-table-wrap th:nth-child(2)  { width: 21% !important }
          .print-table-wrap th:nth-child(3),
          .print-table-wrap th:nth-child(4),
          .print-table-wrap th:nth-child(5),
          .print-table-wrap th:nth-child(6),
          .print-table-wrap th:nth-child(7)  { width: 7.2% !important }
          .print-table-wrap th:nth-child(8)  { width: 5% !important }
          .print-table-wrap th:nth-child(9)  { width: 8% !important }
          .print-table-wrap th:nth-child(10) { width: 7% !important }

          /* Tighter, readable */
          .print-table-wrap th,
          .print-table-wrap td {
            padding: 4px 6px !important;
            font-size: 8.5pt !important;
            line-height: 1.3 !important;
          }
          .print-table-wrap th { position: static !important; font-size: 8pt !important }
          .metric-row:hover td { background: inherit !important }
        }
      `}</style>

      {/* ── Header ── */}
      <div className="no-print" style={{
        background: NAVY, color: '#fff',
        padding: '0 28px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        height: 56, boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{
            width: 34, height: 34, background: TEAL, borderRadius: 8,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <span style={{ color: '#fff', fontWeight: 700, fontSize: 13 }}>PW</span>
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: '0.01em' }}>PhysioWard Sports & Rehab</div>
            <div style={{ fontSize: 10, opacity: 0.5, letterSpacing: '0.08em', textTransform: 'uppercase' }}>CEO Dashboard</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ fontSize: 12, opacity: 0.5 }}>{user?.email}</span>
          <button
            onClick={logout}
            style={{
              background: 'transparent', border: '1px solid rgba(255,255,255,0.2)',
              color: '#fff', borderRadius: 6, padding: '5px 12px',
              fontSize: 12, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
            }}
          >
            Sign out
          </button>
        </div>
      </div>

      {/* ── Controls Bar ── */}
      <div className="no-print" style={{
        background: '#fff', borderBottom: '1px solid #e5e7eb',
        padding: '14px 28px',
        display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {CLINIC_LIST.map(c => (
            <button
              key={c.id}
              className={`clinic-btn${clinic === c.id ? ' active' : ''}`}
              onClick={() => setClinic(c.id)}
              style={{
                padding: '7px 16px', border: '1px solid #e5e7eb',
                borderRadius: 7, background: '#fff',
                cursor: 'pointer', fontSize: 13, fontWeight: 500,
                fontFamily: "'DM Sans', sans-serif",
                color: '#374151', transition: 'all 0.15s',
              }}
            >
              {c.name}
            </button>
          ))}
        </div>

        <div style={{ width: 1, height: 28, background: '#e5e7eb' }} />

        <div style={{ display: 'flex', gap: 6 }}>
          {presets.map(p => {
            const isActive = activePresetOffset === p.offset
            return (
              <button
                key={p.offset}
                onClick={() => applyMonthOffset(p.offset)}
                className={`clinic-btn${isActive ? ' active' : ''}`}
                style={{
                  padding: '7px 14px', border: '1px solid #e5e7eb',
                  borderRadius: 7, background: '#fff',
                  cursor: 'pointer', fontSize: 12, fontWeight: 500,
                  fontFamily: "'DM Sans', sans-serif",
                  color: '#374151', transition: 'all 0.15s',
                }}
              >
                {p.label}
              </button>
            )
          })}
        </div>

        <div style={{ width: 1, height: 28, background: '#e5e7eb' }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 500 }}>Month</span>
          <select
            value={month}
            onChange={e => setMonth(Number(e.target.value))}
            style={{
              border: '1px solid #e5e7eb', borderRadius: 6, padding: '6px 10px',
              fontSize: 13, fontFamily: "'DM Sans', sans-serif",
              color: '#111827', background: '#fff', cursor: 'pointer',
              transition: 'border-color 0.15s',
            }}
          >
            {MONTHS.map((name, i) => (
              <option key={i + 1} value={i + 1}>{name}</option>
            ))}
          </select>

          <select
            value={year}
            onChange={e => setYear(Number(e.target.value))}
            style={{
              border: '1px solid #e5e7eb', borderRadius: 6, padding: '6px 10px',
              fontSize: 13, fontFamily: "'DM Sans', sans-serif",
              color: '#111827', background: '#fff', cursor: 'pointer',
            }}
          >
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>

        <button
          className="fetch-btn"
          onClick={() => fetchData(true)}
          disabled={loading}
          style={{
            background: loading ? '#9ca3af' : TEAL,
            color: '#fff', border: 'none', borderRadius: 7,
            padding: '8px 22px', fontSize: 13, fontWeight: 600,
            cursor: loading ? 'not-allowed' : 'pointer',
            fontFamily: "'DM Sans', sans-serif",
            transition: 'background 0.15s',
            display: 'flex', alignItems: 'center', gap: 8,
          }}
        >
          {loading ? (
            <>
              <span style={{
                width: 13, height: 13,
                border: '2px solid rgba(255,255,255,0.3)',
                borderTop: '2px solid #fff',
                borderRadius: '50%', display: 'inline-block',
                animation: 'spin 0.7s linear infinite',
              }} />
              Fetching Nookal...
            </>
          ) : '↻ Refresh'}
        </button>

        <button
          onClick={() => window.print()}
          disabled={!data || loading}
          style={{
            background: '#fff', color: TEXT,
            border: '1px solid #e5e7eb', borderRadius: 7,
            padding: '8px 16px', fontSize: 13, fontWeight: 500,
            cursor: !data || loading ? 'not-allowed' : 'pointer',
            opacity: !data || loading ? 0.5 : 1,
            fontFamily: "'DM Sans', sans-serif",
            transition: 'all 0.15s',
            display: 'flex', alignItems: 'center', gap: 6,
          }}
          title="Print dashboard (Ctrl+P)"
        >
          🖨 Print
        </button>

        {data && (
          <span style={{ fontSize: 12, color: '#9ca3af' }}>
            {currentClinic?.name} · {MONTHS[data.month - 1]} {data.year} · fetched in {data.duration}ms
          </span>
        )}
      </div>

      {error && (
        <div className="no-print" style={{
          margin: '20px 28px 0',
          background: '#fef2f2', border: '1px solid #fecaca',
          borderRadius: 8, padding: '12px 16px',
          fontSize: 13, color: '#991b1b',
          fontFamily: "'DM Sans', sans-serif",
        }}>
          ⚠️ {error}
        </div>
      )}

      {/* ── Table area ── */}
      <div className="print-area" style={{ padding: '20px 28px', animation: data ? 'fadeIn 0.3s ease' : 'none' }}>
        {loading ? (
          <FetchProgress active={loading} clinicName={currentClinic?.name} />
        ) : !data ? (
          <div style={{
            background: '#fff', borderRadius: 12,
            border: '1px solid #e5e7eb',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            padding: '80px 0',
            color: '#9ca3af',
          }}>
            <div style={{ fontSize: 42, marginBottom: 16 }}>📊</div>
            <div style={{ fontSize: 16, fontWeight: 500, color: '#374151', marginBottom: 8 }}>
              Select a clinic and month, then click Fetch Data
            </div>
            <div style={{ fontSize: 13 }}>
              All 5 weeks will auto-populate from Nookal
            </div>
          </div>
        ) : (
          <div className="print-card" style={{
            background: '#fff', borderRadius: 12,
            border: '1px solid #e5e7eb', overflow: 'hidden',
            boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
          }}>
            <div style={{
              background: HEADER_BG, color: '#fff',
              padding: '14px 22px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <div style={{ fontWeight: 700, fontSize: 16, letterSpacing: '0.02em' }}>
                CEO Dashboard — {currentClinic?.name}
              </div>
              <div style={{ fontSize: 12, opacity: 0.6, fontFamily: "'DM Mono', monospace" }}>
                {MONTHS[data.month - 1]} {data.year}
              </div>
            </div>
            <DashboardTable data={data} />

            {/* Footer */}
            <div style={{
              padding: '10px 18px', background: '#f9fafb',
              borderTop: '1px solid #e5e7eb',
              fontSize: 11, color: TEXT_MUTED,
              fontFamily: "'DM Mono', monospace",
              display: 'flex', gap: 24, flexWrap: 'wrap',
            }}>
              {data.weeks.map(w => (
                <span key={w.weekNum}>
                  {w.label}: {w.appointmentsAttended} appts · ${w.totalRevenue.toFixed(0)} rev
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
