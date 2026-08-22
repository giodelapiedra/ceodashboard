import React, { useState, useCallback, useEffect, useRef } from 'react'
import { DashboardData, WeekMetrics, MonthlyTotals } from '../../types'
import { dashboardApi, AgeingDebtsMonth } from '../../api/dashboard.api'
import FetchProgress from '../common/FetchProgress'
import AppShell from '../shared/AppShell'
import { useAuthStore } from '../../store/auth.store'
import { toast } from '../../store/toast.store'

// ── Format helpers ────────────────────────────────────────────
// Two render states for empty cells:
//   - NO_DATA ("—")  → metric not connected to a data source yet (e.g. Ad
//                       Spend, Ageing Debts). Distinct from a real zero
//                       so the CEO doesn't read "0" as a tracked-but-empty
//                       value.
//   - ZERO_*         → metric is connected and the real value is zero.
const ZERO_CURRENCY = '$0.00'
const ZERO_INT      = '0'
const ZERO_PCT      = '0%'
const NO_DATA       = '—'
const fmtCurrency = (v: number) =>
  `$${v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtCurrencyCell = (v: number | null | undefined) =>
  v == null ? NO_DATA : v === 0 ? ZERO_CURRENCY : fmtCurrency(v)
const fmtIntCell = (v: number | null | undefined) =>
  v == null ? NO_DATA : v === 0 ? ZERO_INT : v.toLocaleString('en-AU')
const fmtPctCell = (v: number | null | undefined) =>
  v == null ? NO_DATA : `${v.toFixed(1)}%`

/** Cells that ended up as one of the muted forms — greyed out so a real
 *  value (e.g. "$5,128.00") still pops visually. */
function isZeroCell(v: string): boolean {
  return v === ZERO_INT || v === ZERO_PCT || v === ZERO_CURRENCY || v === NO_DATA
}

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
  { id: 'overall',   name: 'Overall'   },
]

// ── Sub-components ────────────────────────────────────────────

// Metrics + Definition + one per week column + Metric Type + Monthly Actual +
// Monthly Goal. Week count comes from the payload (5 or 6, depending on how many
// Mon-Sun blocks the month touches), so the span can't be a constant.
function SectionHeader({ label, weekCols }: { label: string; weekCols: number }) {
  return (
    <tr>
      <td colSpan={5 + weekCols} style={{
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
  label, definition, cells, cellNodes,
  metricType, monthly, monthlyNode, monthlyGoal, highlight, alt,
}: {
  label: string; definition: string
  /** One value per week column, in API order (Week 1 → last week of month). */
  cells: CellVal[]
  /** Renders instead of `cells` in the week columns — for the hand-typed
   *  Ageing Debts row, whose week cells are input boxes. `cells` is still
   *  required: it decides whether each cell reads as muted or as a real value. */
  cellNodes?: React.ReactNode[]
  metricType: string; monthly: CellVal; monthlyGoal?: CellVal
  /** Renders instead of `monthly` inside the Monthly Actual cell — for the one
   *  row that is hand-typed (Ageing Debts). `monthly` is still required: it is
   *  what decides whether the cell reads as muted or as a real value. */
  monthlyNode?: React.ReactNode
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
    color: isZeroCell(v) ? TEXT_MUTED : highlight ? TEAL : TEXT,
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
      {cells.map((c, i) => <td key={i} style={numericCell(c)}>{cellNodes?.[i] ?? c}</td>)}
      <td style={{
        padding: '9px 10px', fontSize: 10, fontWeight: 500,
        textAlign: 'center', color: TEXT_MUTED,
        textTransform: 'uppercase', letterSpacing: '0.06em',
        borderBottom: `1px solid ${BORDER}`, background: rowBg,
        whiteSpace: 'nowrap',
      }}>{metricType || ''}</td>
      <td style={numericCell(monthly, true)}>{monthlyNode ?? monthly}</td>
      <td style={{ ...numericCell(monthlyGoal ?? ZERO_INT), color: TEXT_MUTED }}>
        {monthlyGoal ?? ZERO_INT}
      </td>
    </tr>
  )
}

// ── Ageing Debts cell (the hand-typed figures) ─────────────────
// Was a slow on-demand Nookal fetch behind its own button; Sam asked
// (2026-08-11) to type the number in instead, then (2026-08-12) to type it per
// WEEK COLUMN and have Monthly Actual add them up. One of these renders in each
// week cell; the Monthly Actual cell is now a computed total, not an input.
//
// The box is ALWAYS visible for admins. It started out as click-to-edit, but
// the only click target was a single "—" with a dotted underline — Sam couldn't
// find it (2026-08-12). A permanent bordered input with a "$" in front is the
// whole affordance now; the print stylesheet strips the border back off.
//
// Non-admins get plain read-only text, no box.
function AgeingDebtsCell({
  value, canEdit, onSave, onClear, width = 104, title,
}: {
  value: number | null
  canEdit: boolean
  onSave: (amount: number) => Promise<void>
  onClear: () => Promise<void>
  /** Week columns are narrower than the Monthly Actual column. */
  width?: number
  title?: string
}) {
  const asDraft = (v: number | null) => (v == null ? '' : v.toFixed(2))

  const [draft,   setDraft]   = useState(() => asDraft(value))
  const [saving,  setSaving]  = useState(false)
  const [focused, setFocused] = useState(false)
  // Enter blurs to commit; a slow save must not let a second blur fire the same
  // PUT again while the first is still in flight.
  const inFlight = useRef(false)

  // Re-sync when the clinic/month switches or a save returns the stored figure.
  // Never while focused, or it would yank the number out from under the typing.
  useEffect(() => {
    if (!focused) setDraft(asDraft(value))
  }, [value, focused])

  if (!canEdit) {
    return <>{value == null ? NO_DATA : fmtCurrency(value)}</>
  }

  const commit = async () => {
    if (inFlight.current) return

    // Accept what a CEO actually pastes out of Nookal: "$12,345.00".
    const raw = draft.replace(/[$,\s]/g, '')

    // An emptied box means "clear this month" — deliberately not the same as
    // typing 0, which is the real figure when every debt has been paid.
    if (raw === '') {
      if (value == null) return
      inFlight.current = true
      setSaving(true)
      try { await onClear() } finally { setSaving(false); inFlight.current = false }
      return
    }

    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) {
      toast.error('Enter a number of 0 or more')
      setDraft(asDraft(value))
      return
    }

    if (n === value) return       // unchanged — skip the round trip
    inFlight.current = true
    setSaving(true)
    try { await onSave(n) } finally { setSaving(false); inFlight.current = false }
  }

  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      justifyContent: 'flex-end', width: '100%',
    }}>
      <span style={{ color: TEXT_MUTED, fontSize: 11, fontWeight: 400 }}>$</span>
      <input
        className="ageing-input"
        value={draft}
        disabled={saving}
        onChange={e => setDraft(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); commit() }}
        onKeyDown={e => {
          // Blur is the single commit path — Enter just triggers it, so a save
          // can never be submitted twice for one edit.
          if (e.key === 'Enter')  { e.preventDefault(); e.currentTarget.blur() }
          if (e.key === 'Escape') { e.preventDefault(); setDraft(asDraft(value)); e.currentTarget.blur() }
        }}
        placeholder={saving ? 'Saving…' : '0.00'}
        inputMode="decimal"
        title={title ?? 'Type the Ageing Debts figure. Enter saves. Leave it blank to clear.'}
        style={{
          width, boxSizing: 'border-box',
          textAlign: 'right', fontSize: 12.5, fontWeight: 600,
          fontFamily: "'DM Mono', monospace", fontVariantNumeric: 'tabular-nums',
          color: TEXT, background: '#fff',
          borderRadius: 4, padding: '3px 6px',
        }}
      />
    </span>
  )
}

// ── Dashboard Table ───────────────────────────────────────────
function DashboardTable({ data, ageing, canEditAgeing, onSaveAgeingWeek, onClearAgeingWeek }: {
  data: DashboardData
  /** The hand-typed Ageing Debts week columns + derived total for this month. */
  ageing: AgeingDebtsMonth | null
  canEditAgeing: boolean
  /** `week` is the 1-based column position, matching the API's week_num. */
  onSaveAgeingWeek:  (week: number, amount: number) => Promise<void>
  onClearAgeingWeek: (week: number) => Promise<void>
}) {
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

  // One cell per week column the API returned. The month has 5 or 6 weeks, so
  // the count is driven by the payload and never hardcoded.
  const weekCells = (
    key: keyof WeekMetrics,
    fmt: (v: number | null) => CellVal
  ): CellVal[] => w.map((_, i) => fmt(wv(i, key) as number | null))

  const crow = (
    label: string, def: string, key: keyof WeekMetrics,
    mKey: keyof MonthlyTotals, highlight = false
  ) => (
    <DataRow
      label={label} definition={def}
      cells={weekCells(key, fmtCurrencyCell)}
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
      cells={weekCells(key, fmtIntCell)}
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
      cells={weekCells(key, fmtPctCell)}
      metricType="Avg"
      monthly={fmtPctCell(m[mKey] as number | null)}
      highlight={highlight}
      alt={!highlight && nextAlt()}
    />
  )

  const emptyRow = (label: string, def: string, metricType = 'Total', monthly = NO_DATA) => (
    <DataRow
      label={label} definition={def}
      cells={w.map(() => NO_DATA)}
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
        /* Ageing Debts is the only typed-in figure — the box IS the affordance,
           so it stays visible at rest instead of appearing on click. */
        .ageing-input { border: 1px solid #d1d5db; outline: none; transition: border-color 0.12s, box-shadow 0.12s }
        .ageing-input:hover { border-color: #9ca3af }
        .ageing-input:focus { border-color: ${TEAL}; box-shadow: 0 0 0 2px rgba(15,110,86,0.12) }
        .ageing-input:disabled { background: #f9fafb; color: ${TEXT_MUTED} }
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
            {w.map((week, i) => {
              const label = week.label ?? ''
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
          <SectionHeader label="Finances $$$" weekCols={w.length} />
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
          {/* Ageing Debts — hand-typed, not pulled from Nookal (migrations 027
              + 028). Typed per WEEK COLUMN since 2026-08-12; Monthly Actual is
              their SUM and is no longer editable. 'Overall' is typed
              separately, NOT summed from the three clinics — Sam reads a
              practice-wide total off Nookal that need not equal the sum of the
              per-location figures.

              Months typed before 2026-08-12 have no week rows; the API serves
              their old monthly figure instead (source: 'monthly') so nothing
              already entered disappears. Typing any week replaces it. */}
          {(() => {
            const byWeek = new Map((ageing?.weeks ?? []).map(x => [x.week_num, x]))
            const lastEdit = (ageing?.weeks ?? [])
              .reduce<string | null>((max, x) => (!max || x.updated_at > max ? x.updated_at : max), null)
              ?? ageing?.entry?.updated_at ?? null
            const editor = (ageing?.weeks ?? [])
              .find(x => x.updated_at === lastEdit)?.updated_by_name
              ?? ageing?.entry?.updated_by_name ?? null

            return (
              <DataRow
                label="Ageing Debts"
                definition={
                  `Total outstanding invoice balances. Entered manually per week; Monthly Actual is the sum.${
                    lastEdit
                      ? ` Last updated ${new Date(lastEdit).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}${editor ? ` by ${editor}` : ''}.`
                      : canEditAgeing ? ' Type each week into its own box, then press Enter.' : ''
                  }${
                    ageing?.source === 'monthly'
                      ? ' This month was entered as a single monthly figure — type the weeks to replace it.'
                      : ''
                  }`
                }
                // Drives the muted-vs-real colour of each cell; the nodes below
                // are what actually render inside them.
                cells={w.map((_, i) => {
                  const v = byWeek.get(i + 1)
                  return v ? fmtCurrency(v.amount) : NO_DATA
                })}
                cellNodes={w.map((_, i) => (
                  <AgeingDebtsCell
                    key={i}
                    value={byWeek.get(i + 1)?.amount ?? null}
                    canEdit={canEditAgeing}
                    width={86}
                    title={`Ageing Debts for Week ${i + 1}. Enter saves. Leave it blank to clear this week.`}
                    onSave={(amount) => onSaveAgeingWeek(i + 1, amount)}
                    onClear={() => onClearAgeingWeek(i + 1)}
                  />
                ))}
                metricType="Total"
                monthly={ageing?.total == null ? NO_DATA : fmtCurrency(ageing.total)}
                alt={nextAlt()}
              />
            )
          })()}

          {/* ── MARKETING ── */}
          <SectionHeader label="Marketing" weekCols={w.length} />
          {(resetAlt(), null)}
          {emptyRow('New Opt Ins To The List',
            'Total number of new opt ins to our email list in last 7 days')}
          {nrow('New Patients',
            'Total number of new patients in the last 7 days',
            'newPatients', 'newPatients', 'Total', true)}
          {nrow('Patient Reactivations (New Episodes)',
            'Total number of patient reactivations in the last 7 days',
            'patientReactivations', 'patientReactivations')}
          {crow('Ad Spend',
            'Total ad spend across all campaigns (global, all clinics)',
            'adSpend', 'adSpend')}
          {crow('Cost Per Patient',
            'Total ad spend / number of new patients',
            'costPerPatient', 'costPerPatient')}

          {/* ── SALES ── */}
          <SectionHeader label="Sales (Service & Product Delivery)" weekCols={w.length} />
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
          {/* TEMPORARILY HIDDEN — not in use yet (per Sam, 2026-06-18).
              Re-enable by uncommenting this block when ready to use these metrics.
          {nrow('Clients Who Accepted a Product or Upsell',
            'Number of clients who accepted a product or upsell in the last 7 days',
            'productsUpsold', 'productsUpsold')}
          {emptyRow('Clients Who Transitioned To A Complementary Service',
            'Number of clients who transitioned to a complementary service in last 7 days')}
          {emptyRow('Active Patients',
            'Total number of active patients in treatment in the last 7 days', 'Avg')}
          {emptyRow('Inactive Patients',
            'Total number of inactive patients not in treatment (all time)', '')}
          */}

        </tbody>
      </table>
    </div>
  )
}

// ── Main Dashboard Page ───────────────────────────────────────
export default function DashboardPage() {
  const now                 = new Date()
  const { user }            = useAuthStore()
  const [clinic, setClinic] = useState('newport')
  const [month, setMonth]   = useState(now.getMonth() + 1)
  const [year, setYear]     = useState(now.getFullYear())
  const [loading, setLoading]           = useState(false)
  const [error, setError]               = useState<string | null>(null)
  const [data, setData]                 = useState<DashboardData | null>(null)
  const [ageing, setAgeing]             = useState<AgeingDebtsMonth | null>(null)

  // Only ADMIN may type the Ageing Debts figure; the API enforces it too.
  const canEditAgeing = user?.role === 'ADMIN'

  const fetchData = useCallback(async (forceRefresh = false) => {
    setLoading(true); setError(null)
    try {
      const result = await dashboardApi.getMonthly(clinic, month, year, { forceRefresh })
      setData(result)
    } catch (e: any) {
      setError(e.response?.data?.error?.message || 'Failed to fetch data')
    } finally {
      setLoading(false)
    }
  }, [clinic, month, year])

  // The typed Ageing Debts figures are a handful of small rows keyed by clinic
  // + month, so unlike the old Nookal fetch they can just load with the
  // dashboard.
  const fetchAgeing = useCallback(async () => {
    try {
      setAgeing(await dashboardApi.getAgeingDebtsManual(clinic, year, month))
    } catch {
      // Non-fatal — the rest of the dashboard still works without it.
      setAgeing(null)
    }
  }, [clinic, year, month])

  // Both write calls return the recomputed month, so the Monthly Actual total
  // never has to be re-added on the client and can't drift from the server's.
  const saveAgeingWeek = useCallback(async (week: number, amount: number) => {
    try {
      setAgeing(await dashboardApi.saveAgeingDebtsWeek(clinic, year, month, week, amount))
      toast.success(`Ageing Debts saved for Week ${week}`)
    } catch (e: any) {
      toast.error(e.response?.data?.error?.message || e.response?.data?.error || 'Failed to save Ageing Debts')
      // Put the cell back to what the server actually holds.
      await fetchAgeing()
    }
  }, [clinic, year, month, fetchAgeing])

  const clearAgeingWeek = useCallback(async (week: number) => {
    try {
      setAgeing(await dashboardApi.clearAgeingDebtsWeek(clinic, year, month, week))
      toast.success(`Ageing Debts cleared for Week ${week}`)
    } catch (e: any) {
      toast.error(e.response?.data?.error?.message || e.response?.data?.error || 'Failed to clear Ageing Debts')
      await fetchAgeing()
    }
  }, [clinic, year, month, fetchAgeing])

  useEffect(() => { fetchData() }, [fetchData])
  useEffect(() => { fetchAgeing() }, [fetchAgeing])

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
    <AppShell>
    <div className="print-root">
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
          /* On paper the Ageing Debts figure is just a number, not a form field. */
          .ageing-input {
            border: none !important; box-shadow: none !important;
            background: transparent !important; padding: 0 !important;
            width: auto !important;
          }
        }
      `}</style>

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

        {/* The "💰 Ageing Debts" button lived here. Removed 2026-08-11 — the
            figure is now typed straight into the Monthly Actual cell of the
            Ageing Debts row instead of pulled from Nookal. */}

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
      <div className="print-area pw-page" style={{ padding: '20px 28px', animation: data ? 'fadeIn 0.3s ease' : 'none' }}>
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
            <DashboardTable
              data={data}
              ageing={ageing}
              canEditAgeing={canEditAgeing}
              onSaveAgeingWeek={saveAgeingWeek}
              onClearAgeingWeek={clearAgeingWeek}
            />

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
    </AppShell>
  )
}
