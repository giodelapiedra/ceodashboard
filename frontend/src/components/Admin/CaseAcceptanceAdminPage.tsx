import React, { useEffect, useState, useCallback } from 'react'
import { caseAcceptanceApi, CaseAcceptanceSummary } from '../../api/caseAcceptance.api'
import { CaseAcceptanceDTO, ClinicId, CLINIC_LABEL, User } from '../../types'
import { usersApi } from '../../api/users.api'
import AppShell from '../shared/AppShell'
import Pagination from '../shared/Pagination'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { usePaginationParams } from '../../hooks/usePaginationParams'
import DateRangePicker from '../shared/DateRangePicker'
import { toast } from '../../store/toast.store'

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

type TpFilter = '' | 'Y' | 'N'

export default function CaseAcceptanceAdminPage() {
  const [tab,    setTab]    = useState<ClinicTab>('overall')
  const [rows,   setRows]   = useState<CaseAcceptanceDTO[]>([])
  const [total,   setTotal]   = useState(0)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  const [dateFrom, setDateFrom] = useState(daysAgoISO(30))
  const [dateTo,   setDateTo]   = useState(todayISO())
  const [tpFilter, setTpFilter] = useState<TpFilter>('')
  const [searchInput, setSearchInput] = useState('')
  const search = useDebouncedValue(searchInput.trim(), 300)

  const { limit, offset, setOffset, setLimit, resetPage } = usePaginationParams()
  const [exporting, setExporting] = useState(false)
  const [clinicians, setClinicians] = useState<User[]>([])
  const [clinicianFilter, setClinicianFilter] = useState('')

  useEffect(() => {
    usersApi.staff('CLINICIAN').then(setClinicians).catch(() => {})
  }, [])

  useEffect(() => { resetPage() }, [tab, dateFrom, dateTo, tpFilter, search, clinicianFilter, resetPage])

  const filterParams = {
    clinic_id:    tab === 'overall' ? undefined : tab,
    date_from:    dateFrom || undefined,
    date_to:      dateTo   || undefined,
    tp_provided:  tpFilter === '' ? undefined : tpFilter === 'Y',
    search:       search   || undefined,
    clinician_id: clinicianFilter || undefined,
  }

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await caseAcceptanceApi.list({ ...filterParams, limit, offset })
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (e: any) {
      setError(e.response?.data?.error?.message || 'Failed to load entries')
    } finally { setLoading(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, dateFrom, dateTo, tpFilter, search, limit, offset, clinicianFilter])

  useEffect(() => { load() }, [load])

  const onExport = async () => {
    if (exporting) return
    setExporting(true)
    try {
      await caseAcceptanceApi.exportXlsx(filterParams)
      toast.success('Export downloaded')
    } catch (e: any) {
      toast.error(e.response?.data?.error?.message || 'Export failed')
    } finally { setExporting(false) }
  }

  const [summary, setSummary] = useState<CaseAcceptanceSummary>({
    total: 0, totalRecommendations: 0, totalBooked: 0, caseAcceptancePct: null,
    tpProvided: 0, tpNotProvided: 0,
    prepayOffered: 0, prepayAccepted: 0, transitions: 0, byClinic: {},
  })
  useEffect(() => {
    let cancelled = false
    caseAcceptanceApi.summary(filterParams)
      .then(s => { if (!cancelled) setSummary(s) })
      .catch(() => {})
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, dateFrom, dateTo, tpFilter, search, clinicianFilter])

  return (
    <AppShell title="Case Recommendation & Acceptance">
      <div className="pw-page" style={{ padding: '20px 28px' }}>
        {/* Tabs */}
        <div style={{
          display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap',
          background: '#fff', padding: 4, borderRadius: 8,
          border: `1px solid ${BORDER}`, width: 'fit-content', maxWidth: '100%',
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
          <Field label="Clinician">
            <select value={clinicianFilter} onChange={e => setClinicianFilter(e.target.value)} style={inputStyle}>
              <option value="">All Clinicians</option>
              {clinicians.map(c => (
                <option key={c.id} value={c.id}>{c.full_name}</option>
              ))}
            </select>
          </Field>
          <Field label="TP Provided">
            <select value={tpFilter} onChange={e => setTpFilter(e.target.value as TpFilter)} style={inputStyle}>
              <option value="">All</option>
              <option value="Y">Yes</option>
              <option value="N">No</option>
            </select>
          </Field>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'flex-end', gap: 8 }}>
            <button
              onClick={onExport}
              disabled={exporting || loading || total === 0}
              title={total === 0 ? 'No entries to export' : 'Download XLSX with current filters'}
              style={{
                background:   exporting || loading || total === 0 ? '#f3f4f6' : TEAL,
                color:        exporting || loading || total === 0 ? TEXT_SOFT : '#fff',
                border:       `1px solid ${exporting || loading || total === 0 ? BORDER : TEAL}`,
                borderRadius: 7,
                padding:      '8px 16px',
                fontSize:     13,
                fontWeight:   600,
                fontFamily:   "'DM Sans', sans-serif",
                cursor:       exporting || loading || total === 0 ? 'not-allowed' : 'pointer',
              }}
            >{exporting ? 'Exporting…' : '↓ Export XLSX'}</button>
          </div>
        </div>

        {error && (
          <div style={{
            background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c',
            borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 12,
          }}>{error}</div>
        )}

        {/* Summary strip */}
        <div className="pw-grid-2" style={{
          display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10,
          marginBottom: 16,
        }}>
          <SummaryCard label="Entries" value={summary.total} highlight />
          <SummaryCard
            label="Recs"
            value={summary.totalRecommendations}
            sub={summary.totalRecommendations > 0 ? `${pct(summary.totalBooked, summary.totalRecommendations)}% booked` : ''}
          />
          <SummaryCard
            label="Booked"
            value={summary.totalBooked}
            sub={summary.caseAcceptancePct !== null ? `${summary.caseAcceptancePct.toFixed(1)}% acceptance` : ''}
          />
          <SummaryCard
            label="Acceptance"
            value={summary.caseAcceptancePct === null ? '—' : `${summary.caseAcceptancePct.toFixed(1)}%`}
            sub={`${summary.totalBooked} / ${summary.totalRecommendations}`}
          />
          <SummaryCard
            label="Prepay offered"
            value={summary.prepayOffered}
            /* pct() returns '0' on a zero denominator → show a real 0% that
               counts toward averages, not a blank/dash. */
            sub={`${pct(summary.prepayOffered, summary.total)}% of entries`}
          />
          <SummaryCard
            label="Prepay accepted"
            value={summary.prepayAccepted}
            sub={`${pct(summary.prepayAccepted, summary.prepayOffered)}% of offers`}
          />
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
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 1400 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    <Th>Date</Th>
                    {tab === 'overall' && <Th>Clinic</Th>}
                    <Th>Front of staff</Th>
                    <Th>Clinician</Th>
                    <Th>Patient</Th>
                    <Th align="center">TP</Th>
                    <Th align="right">Recs</Th>
                    <Th align="right">Booked</Th>
                    <Th align="right">Acceptance</Th>
                    <Th align="center">Prepay offered</Th>
                    <Th align="center">Prepay accepted</Th>
                    <Th>Transition notes</Th>
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
                      <Td align="center"><YnPill v={r.treatment_plan_provided} /></Td>
                      <Td align="right">{r.case_recommendations}</Td>
                      <Td align="right">{r.appointments_booked}</Td>
                      <Td align="right">{r.case_acceptance_pct === null ? <Dim>—</Dim> : `${r.case_acceptance_pct.toFixed(2)}%`}</Td>
                      <Td align="center"><PrepayPill v={r.prepay_offered} /></Td>
                      <Td align="center"><PrepayPill v={r.prepay_accepted} /></Td>
                      <Td><span style={{ color: TEXT_SOFT }}>{r.transition_notes || <Dim>—</Dim>}</span></Td>
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

function pct(n: number, d: number): string {
  if (d <= 0) return '0'
  return ((n / d) * 100).toFixed(1)
}

function SummaryCard({ label, value, sub, highlight }: {
  label: string; value: number | string; sub?: string; highlight?: boolean
}) {
  return (
    <div style={{
      background: highlight ? '#f0faf7' : '#fff',
      border: `1px solid ${highlight ? '#cdebde' : BORDER}`,
      borderRadius: 10, padding: '14px 16px',
    }}>
      <div style={{ fontSize: 11, color: TEXT_SOFT, fontWeight: 500, letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: highlight ? TEAL : TEXT, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: TEXT_SOFT, marginTop: 2 }}>{sub}</div>}
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
function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' | 'center' }) {
  return (
    <th style={{
      padding: '10px 14px', textAlign: align, fontSize: 11, fontWeight: 600,
      color: TEXT_SOFT, letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap',
    }}>{children}</th>
  )
}
function Td({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' | 'center' }) {
  return <td style={{ padding: '10px 14px', textAlign: align, color: TEXT, verticalAlign: 'top' }}>{children}</td>
}
function Dim({ children }: { children: React.ReactNode }) {
  return <span style={{ color: '#9ca3af' }}>{children}</span>
}

function YnPill({ v }: { v: boolean | null }) {
  if (v === null || v === undefined) return <Dim>—</Dim>
  const yes = v === true
  return (
    <span style={{
      background:   yes ? '#ecfdf5' : '#fef2f2',
      color:        yes ? '#065f46' : '#991b1b',
      border: `1px solid ${yes ? '#a7f3d0' : '#fecaca'}`,
      padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
    }}>{yes ? 'YES' : 'NO'}</span>
  )
}

// Prepay columns only: keep YES/NO for a real true/false, but show a muted
// "0" (instead of a blank dash) when the value is empty/not recorded.
function PrepayPill({ v }: { v: boolean | null }) {
  if (v === null || v === undefined) return <Dim>0</Dim>
  const yes = v === true
  return (
    <span style={{
      background:   yes ? '#ecfdf5' : '#fef2f2',
      color:        yes ? '#065f46' : '#991b1b',
      border: `1px solid ${yes ? '#a7f3d0' : '#fecaca'}`,
      padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
    }}>{yes ? 'YES' : 'NO'}</span>
  )
}

const inputStyle: React.CSSProperties = {
  padding: '7px 10px', border: `1px solid ${BORDER}`,
  borderRadius: 7, fontSize: 13, fontFamily: "'DM Sans', sans-serif",
  color: TEXT, background: '#fff',
}
