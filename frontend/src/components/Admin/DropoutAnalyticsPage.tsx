import React, { useEffect, useState } from 'react'
import { dropoutsApi, DropoutSummary } from '../../api/dropouts.api'
import {
  ClinicId,
  DROPOUT_STATUSES, DROPOUT_REASONS, DropoutStatus, DropoutReason,
} from '../../types'
import AppShell from '../shared/AppShell'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import DropoutAnalytics from './DropoutAnalytics'
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

const EMPTY_SUMMARY: DropoutSummary = {
  total: 0, byStatus: {}, byReason: {}, byClinic: {}, byDay: [],
}

export default function DropoutAnalyticsPage() {
  const [tab, setTab] = useState<ClinicTab>('overall')

  const [dateFrom, setDateFrom] = useState(daysAgoISO(30))
  const [dateTo,   setDateTo]   = useState(todayISO())
  const [statusFilter, setStatusFilter] = useState<DropoutStatus | ''>('')
  const [reasonFilter, setReasonFilter] = useState<DropoutReason | ''>('')
  const [searchInput,  setSearchInput]  = useState('')
  const search = useDebouncedValue(searchInput.trim(), 300)

  const [summary, setSummary] = useState<DropoutSummary>(EMPTY_SUMMARY)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  // Refetch whenever any filter changes. Each request is independently
  // cancellable via the `cancelled` flag so a fast filter change doesn't
  // race with a slow earlier response.
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError('')
    dropoutsApi.summary({
      clinic_id: tab === 'overall' ? undefined : tab,
      date_from: dateFrom || undefined,
      date_to:   dateTo   || undefined,
      status:    statusFilter || undefined,
      reason:    reasonFilter || undefined,
      search:    search || undefined,
    })
      .then((s) => { if (!cancelled) setSummary(s) })
      .catch((e: any) => {
        if (!cancelled) setError(e?.response?.data?.error?.message || 'Failed to load analytics')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [tab, dateFrom, dateTo, statusFilter, reasonFilter, search])

  return (
    <AppShell title="Dropout Analytics">
      <div className="pw-page" style={{ padding: '20px 28px' }}>
        {/* Tabs */}
        <div style={{
          display: 'flex', gap: 4, marginBottom: 14,
          background: '#fff', padding: 4, borderRadius: 8,
          border: `1px solid ${BORDER}`, width: 'fit-content', maxWidth: '100%', flexWrap: 'wrap',
        }}>
          {TABS.map((t) => {
            const active = t.id === tab
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                style={{
                  background:  active ? TEAL : 'transparent',
                  color:       active ? '#fff' : TEXT_SOFT,
                  border:      'none', borderRadius: 6,
                  padding:     '7px 18px', fontSize: 13, fontWeight: 600,
                  cursor:      'pointer',
                  fontFamily:  "'DM Sans', sans-serif",
                }}
              >{t.label}</button>
            )
          })}
        </div>

        {/* Filters */}
        <div style={{
          background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10,
          padding: '12px 14px', marginBottom: 16,
          display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap',
        }}>
          <Field label="Date range">
            <DateRangePicker
              value={{ from: dateFrom, to: dateTo }}
              onChange={(r) => { setDateFrom(r.from); setDateTo(r.to) }}
              maxRangeDays={366}
            />
          </Field>

          <Field label="Status">
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as DropoutStatus | '')} style={inputStyle}>
              <option value="">All</option>
              {DROPOUT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Reason">
            <select value={reasonFilter} onChange={(e) => setReasonFilter(e.target.value as DropoutReason | '')} style={inputStyle}>
              <option value="">All</option>
              {DROPOUT_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
          <Field label="Search">
            <div style={{ position: 'relative' }}>
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Patient or notes…"
                style={{ ...inputStyle, paddingRight: searchInput ? 26 : 12, minWidth: 200 }}
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
        </div>

        {error && (
          <div style={{
            background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c',
            borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 12,
          }}>{error}</div>
        )}

        {loading ? (
          <div style={{
            background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12,
            padding: 80, textAlign: 'center', color: '#9ca3af', fontSize: 13,
          }}>Loading analytics…</div>
        ) : (
          <DropoutAnalytics
            summary={summary}
            dateFrom={dateFrom}
            dateTo={dateTo}
            tab={tab}
          />
        )}
      </div>
    </AppShell>
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

const inputStyle: React.CSSProperties = {
  padding: '7px 10px', border: `1px solid ${BORDER}`,
  borderRadius: 7, fontSize: 13, fontFamily: "'DM Sans', sans-serif",
  color: TEXT, background: '#fff',
}
