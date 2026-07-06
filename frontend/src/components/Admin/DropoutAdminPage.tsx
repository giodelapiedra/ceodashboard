import React, { useEffect, useState, useCallback } from 'react'
import { dropoutsApi, DropoutSummary } from '../../api/dropouts.api'
import {
  DropoutDTO, ClinicId, CLINIC_LABEL,
  DROPOUT_STATUSES, DROPOUT_REASONS, DropoutStatus, DropoutReason,
} from '../../types'
import AppShell from '../shared/AppShell'
import Pagination from '../shared/Pagination'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { usePaginationParams } from '../../hooks/usePaginationParams'
import { exportDropoutsXlsx } from '../../lib/exportDropoutsXlsx'
import { toast } from '../../store/toast.store'
import DateRangePicker from '../shared/DateRangePicker'

const TEAL      = '#0f6e56'
const TEXT      = '#111827'
const TEXT_SOFT = '#4b5563'
const BORDER    = '#e5e7eb'

type ClinicTab = ClinicId | 'overall'
const TABS: { id: ClinicTab; label: string }[] = [
  { id: 'newport',   label: 'Newport'   },
  { id: 'narrabeen', label: 'Narrabeen' },
  { id: 'brookvale', label: 'Brookvale' },
  { id: 'overall',   label: 'Overall'   },
]

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
function daysAgoISO(days: number): string {
  const d = new Date(); d.setDate(d.getDate() - days)
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

export default function DropoutAdminPage() {
  const [tab,    setTab]    = useState<ClinicTab>('overall')
  const [rows,   setRows]   = useState<DropoutDTO[]>([])
  const [total,   setTotal]   = useState(0)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  const [dateFrom, setDateFrom] = useState(daysAgoISO(30))
  const [dateTo,   setDateTo]   = useState(todayISO())
  const [statusFilter, setStatusFilter] = useState<DropoutStatus | ''>('')
  const [reasonFilter, setReasonFilter] = useState<DropoutReason | ''>('')
  const [searchInput,  setSearchInput]  = useState('')
  const search = useDebouncedValue(searchInput.trim(), 300)

  const { limit, offset, setOffset, setLimit, resetPage } = usePaginationParams()
  const [exporting, setExporting] = useState(false)

  useEffect(() => { resetPage() }, [tab, dateFrom, dateTo, statusFilter, reasonFilter, search, resetPage])

  const filterParams = {
    clinic_id: tab === 'overall' ? undefined : tab,
    date_from: dateFrom || undefined,
    date_to:   dateTo   || undefined,
    status:    statusFilter || undefined,
    reason:    reasonFilter || undefined,
    search:    search || undefined,
  }

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await dropoutsApi.list({ ...filterParams, limit, offset })
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (e: any) {
      setError(e.response?.data?.error?.message || 'Failed to load dropouts')
    } finally { setLoading(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, dateFrom, dateTo, statusFilter, reasonFilter, search, limit, offset])

  useEffect(() => { load() }, [load])

  // Summary reflects the FULL filtered set (server-side aggregate), not just
  // the currently-paginated page. Refetched whenever the filter changes.
  const [summary, setSummary] = useState<DropoutSummary>({ total: 0, byStatus: {}, byReason: {}, byClinic: {}, byDay: [] })
  useEffect(() => {
    let cancelled = false
    dropoutsApi.summary(filterParams)
      .then(s => { if (!cancelled) setSummary(s) })
      .catch(() => {})
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, dateFrom, dateTo, statusFilter, reasonFilter, search])

  const exportXlsx = async () => {
    setExporting(true)
    try {
      // Export must contain the FULL filtered set, not just the current page.
      // Page through the server in chunks so we never blow memory or
      // hit the per-request limit cap.
      const PAGE = 500
      const all: DropoutDTO[] = []
      let cursor = 0
      while (true) {
        const res = await dropoutsApi.list({ ...filterParams, limit: PAGE, offset: cursor })
        all.push(...res.data)
        if (!res.pagination.hasMore || res.data.length === 0) break
        cursor += res.data.length
        if (cursor > 50_000) break // safety cap
      }

      await exportDropoutsXlsx(all, {
        filename:      `dropouts_${tab}_${dateFrom}_to_${dateTo}`,
        includeClinic: tab === 'overall',
      })
      toast.success(`Exported ${all.length.toLocaleString()} ${all.length === 1 ? 'entry' : 'entries'}`)
    } catch (e: any) {
      toast.error(e?.message || 'Failed to export')
    } finally {
      setExporting(false)
    }
  }

  return (
    <AppShell title="Patient Dropout Tracking">
      <div style={{ padding: '20px 28px' }}>
        {/* Tabs */}
        <div style={{
          display: 'flex', gap: 4, marginBottom: 16,
          background: '#fff', padding: 4, borderRadius: 8,
          border: `1px solid ${BORDER}`, width: 'fit-content',
        }}>
          {TABS.map(t => {
            const active = t.id === tab
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                style={{
                  background:   active ? TEAL : 'transparent',
                  color:        active ? '#fff' : TEXT_SOFT,
                  border:       'none', borderRadius: 6,
                  padding:      '7px 18px', fontSize: 13, fontWeight: 600,
                  cursor:       'pointer',
                  fontFamily:   "'DM Sans', sans-serif",
                }}>{t.label}</button>
            )
          })}
        </div>

        {/* Filters */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
          flexWrap: 'wrap',
        }}>
          <Field label="Search">
            <div style={{ position: 'relative' }}>
              <input
                type="text"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                placeholder="Patient name or notes…"
                style={{ ...inputStyle, paddingRight: searchInput ? 26 : 12, minWidth: 220 }}
              />
              {searchInput && (
                <button
                  onClick={() => setSearchInput('')}
                  title="Clear search"
                  style={{
                    position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    color: '#9ca3af', fontSize: 14, padding: 2,
                  }}
                >×</button>
              )}
            </div>
          </Field>
          <Field label="Date range">
            <DateRangePicker
              value={{ from: dateFrom, to: dateTo }}
              onChange={(r) => { setDateFrom(r.from); setDateTo(r.to) }}
              maxRangeDays={366}
            />
          </Field>
          <Field label="Status">
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as DropoutStatus | '')} style={inputStyle}>
              <option value="">All</option>
              {DROPOUT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Reason">
            <select value={reasonFilter} onChange={e => setReasonFilter(e.target.value as DropoutReason | '')} style={inputStyle}>
              <option value="">All</option>
              {DROPOUT_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
          <div style={{ flex: 1 }} />
          <button onClick={exportXlsx} disabled={exporting || summary.total === 0} style={smallBtnStyle}>
            {exporting ? 'Exporting…' : 'Download Excel'}
          </button>
        </div>

        {error && (
          <div style={{
            background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c',
            borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 12,
          }}>{error}</div>
        )}

        {/* Summary strip — quick stats over the filtered set. Rich charts
            live on the dedicated Dropout Analytics page. */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10,
          marginBottom: 16,
        }}>
          <SummaryCard label="Total entries"          value={summary.total} highlight />
          <SummaryCard label="Cancelled (no rebook)"  value={summary.byStatus['Cancelled - not rescheduled'] ?? 0} />
          <SummaryCard label="No future bookings"     value={summary.byStatus['No Future Bookings'] ?? 0} />
          <SummaryCard label="Re-scheduled"           value={summary.byStatus['Re-scheduled'] ?? 0} />
        </div>

        {/* Table */}
        <div style={{
          background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10,
          overflow: 'hidden',
        }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No entries match these filters.</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 1200 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    <Th>Date</Th>
                    {tab === 'overall' && <Th>Clinic</Th>}
                    <Th>Front of staff</Th>
                    <Th>Clinician</Th>
                    <Th>Patient</Th>
                    <Th>Appts cancelled</Th>
                    <Th>Status</Th>
                    <Th>Reason</Th>
                    <Th>Notes</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} style={{ borderTop: `1px solid ${BORDER}` }}>
                      <Td>{r.date_logged}</Td>
                      {tab === 'overall' && <Td>{CLINIC_LABEL[r.clinic_id]}</Td>}
                      <Td>{r.front_staff_name || <Dim>—</Dim>}</Td>
                      <Td>{r.clinician_name || <Dim>—</Dim>}</Td>
                      <Td><strong>{r.patient_name}</strong></Td>
                      <Td>
                        {r.appointment_cancelled_dates.length === 0 ? <Dim>—</Dim>
                          : r.appointment_cancelled_dates.length === 1 ? r.appointment_cancelled_dates[0]
                          : (
                            <span title={r.appointment_cancelled_dates.join(', ')}>
                              {r.appointment_cancelled_dates[0]} <span style={{ color: TEXT_SOFT }}>(+{r.appointment_cancelled_dates.length - 1})</span>
                            </span>
                          )}
                      </Td>
                      <Td>{r.status ? <StatusPill status={r.status} /> : <Dim>—</Dim>}</Td>
                      <Td>{r.reason || <Dim>—</Dim>}</Td>
                      <Td><span style={{ color: TEXT_SOFT }}>{r.notes || <Dim>—</Dim>}</span></Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!loading && total > 0 && (
            <Pagination
              total={total}
              limit={limit}
              offset={offset}
              onChange={setOffset}
              onLimitChange={setLimit}
            />
          )}
        </div>
      </div>
    </AppShell>
  )
}

function SummaryCard({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div style={{
      background: highlight ? '#f0faf7' : '#fff',
      border: `1px solid ${highlight ? '#cdebde' : BORDER}`,
      borderRadius: 10, padding: '14px 16px',
    }}>
      <div style={{ fontSize: 11, color: TEXT_SOFT, fontWeight: 500, letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: highlight ? TEAL : TEXT, marginTop: 4 }}>{value}</div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, color: TEXT_SOFT, fontWeight: 500 }}>{label}</span>
      {children}
    </label>
  )
}
function Th({ children }: { children: React.ReactNode }) {
  return (
    <th style={{
      padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 600,
      color: TEXT_SOFT, letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap',
    }}>{children}</th>
  )
}
function Td({ children }: { children: React.ReactNode }) {
  return <td style={{ padding: '10px 14px', color: TEXT, verticalAlign: 'top' }}>{children}</td>
}
function Dim({ children }: { children: React.ReactNode }) {
  return <span style={{ color: '#9ca3af' }}>{children}</span>
}
function StatusPill({ status }: { status: DropoutStatus }) {
  const colors: Record<DropoutStatus, { bg: string; fg: string; bd: string }> = {
    'Re-scheduled':                { bg: '#ecfdf5', fg: '#065f46', bd: '#a7f3d0' },
    'Cancelled - not rescheduled': { bg: '#fef9c3', fg: '#854d0e', bd: '#fde68a' },
    'No Future Bookings':          { bg: '#fee2e2', fg: '#991b1b', bd: '#fecaca' },
    'Completed Treatment Plan':    { bg: '#e0f2fe', fg: '#075985', bd: '#bae6fd' },
  }
  const c = colors[status]
  return (
    <span style={{
      background: c.bg, color: c.fg, border: `1px solid ${c.bd}`,
      padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
    }}>{status}</span>
  )
}

const inputStyle: React.CSSProperties = {
  padding: '7px 10px', border: `1px solid ${BORDER}`,
  borderRadius: 7, fontSize: 13, fontFamily: "'DM Sans', sans-serif",
  color: TEXT, background: '#fff',
}
const smallBtnStyle: React.CSSProperties = {
  background: '#fff', color: TEXT, border: `1px solid ${BORDER}`,
  borderRadius: 7, padding: '7px 14px', fontSize: 13, fontWeight: 500,
  cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
}
