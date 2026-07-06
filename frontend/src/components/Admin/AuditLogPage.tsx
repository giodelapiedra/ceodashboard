import React, { useEffect, useState, useCallback } from 'react'
import { auditLogApi, AuditLogDTO } from '../../api/auditLog.api'
import { ROLE_LABEL } from '../../types'
import AppShell from '../shared/AppShell'
import Pagination from '../shared/Pagination'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { usePaginationParams } from '../../hooks/usePaginationParams'
import DateRangePicker from '../shared/DateRangePicker'

const TEAL      = '#0f6e56'
const TEXT      = '#111827'
const TEXT_SOFT = '#4b5563'
const BORDER    = '#e5e7eb'

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
function daysAgoISO(days: number): string {
  const d = new Date(); d.setDate(d.getDate() - days)
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

/** Map an action string to a human label + a colour for the pill. */
const ACTION_STYLE: { match: (a: string) => boolean; label: (a: string) => string; bg: string; fg: string; bd: string }[] = [
  { match: a => a.endsWith('.delete'),         label: a => a, bg: '#fee2e2', fg: '#991b1b', bd: '#fecaca' },
  { match: a => a.endsWith('.deactivate'),     label: a => a, bg: '#fff7ed', fg: '#9a3412', bd: '#fed7aa' },
  { match: a => a.endsWith('.create'),         label: a => a, bg: '#ecfdf5', fg: '#065f46', bd: '#a7f3d0' },
  { match: a => a.endsWith('.reactivate'),     label: a => a, bg: '#ecfdf5', fg: '#065f46', bd: '#a7f3d0' },
  { match: a => a.endsWith('.update'),         label: a => a, bg: '#fef9c3', fg: '#854d0e', bd: '#fde68a' },
  { match: a => a.endsWith('.password_reset'), label: a => a, bg: '#fef9c3', fg: '#854d0e', bd: '#fde68a' },
]
function actionStyle(action: string) {
  return ACTION_STYLE.find(s => s.match(action))
    ?? { label: (a: string) => a, bg: '#f3f4f6', fg: '#374151', bd: '#e5e7eb' }
}

const ACTION_PREFIX_OPTIONS = [
  { value: '',                  label: 'All actions'  },
  { value: 'dropout.',          label: 'Dropouts'     },
  { value: 'case_acceptance.',  label: 'Case Acceptance' },
  { value: 'user.',             label: 'User Management' },
]

export default function AuditLogPage() {
  const [rows,    setRows]    = useState<AuditLogDTO[]>([])
  const [total,   setTotal]   = useState(0)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  const [dateFrom, setDateFrom]       = useState(daysAgoISO(7))
  const [dateTo,   setDateTo]         = useState(todayISO())
  const [actionPrefix, setActionPrefix] = useState('')
  const [actionExact,  setActionExact]  = useState('')
  const [userIdInput,  setUserIdInput]  = useState('')
  const userId = useDebouncedValue(userIdInput.trim(), 300)

  const [actionsList, setActionsList] = useState<string[]>([])

  const { limit, offset, setOffset, setLimit, resetPage } = usePaginationParams()

  useEffect(() => { resetPage() }, [dateFrom, dateTo, actionPrefix, actionExact, userId, resetPage])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await auditLogApi.list({
        date_from:     dateFrom || undefined,
        date_to:       dateTo   || undefined,
        action_prefix: actionExact ? undefined : (actionPrefix || undefined),
        action:        actionExact || undefined,
        user_id:       userId || undefined,
        limit, offset,
      })
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (e: any) {
      setError(e.response?.data?.error?.message || 'Failed to load activity log')
    } finally { setLoading(false) }
  }, [dateFrom, dateTo, actionPrefix, actionExact, userId, limit, offset])

  useEffect(() => { load() }, [load])

  // Distinct actions — populates the exact-action dropdown.
  useEffect(() => {
    let cancelled = false
    auditLogApi.actions()
      .then((a) => { if (!cancelled) setActionsList(a) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  return (
    <AppShell title="Activity Log">
      <div style={{ padding: '20px 28px' }}>
        {/* Filters */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
          flexWrap: 'wrap',
        }}>
          <Field label="Date range">
            <DateRangePicker
              value={{ from: dateFrom, to: dateTo }}
              onChange={(r) => { setDateFrom(r.from); setDateTo(r.to) }}
              maxRangeDays={366}
            />
          </Field>
          <Field label="Category">
            <select value={actionPrefix} onChange={e => { setActionPrefix(e.target.value); setActionExact('') }} style={inputStyle}>
              {ACTION_PREFIX_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Specific action">
            <select value={actionExact} onChange={e => setActionExact(e.target.value)} style={inputStyle}>
              <option value="">All</option>
              {actionsList
                .filter(a => !actionPrefix || a.startsWith(actionPrefix))
                .map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </Field>
          <Field label="User ID">
            <input value={userIdInput} onChange={e => setUserIdInput(e.target.value)}
              placeholder="e.g. 3" style={{ ...inputStyle, width: 100 }} />
          </Field>
        </div>

        {error && (
          <div style={{
            background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c',
            borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 12,
          }}>{error}</div>
        )}

        {/* Table */}
        <div style={{
          background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10,
          overflow: 'hidden',
        }}>
          <div style={{
            padding: '12px 16px', background: '#f9fafb', borderBottom: `1px solid ${BORDER}`,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>
              {total.toLocaleString()} {total === 1 ? 'event' : 'events'}
            </div>
          </div>

          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No activity matches these filters.</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 1100 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    <Th>When</Th>
                    <Th>Who</Th>
                    <Th>Action</Th>
                    <Th>Details</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} style={{ borderTop: `1px solid ${BORDER}` }}>
                      <Td>
                        <div style={{ fontWeight: 500 }}>{formatWhen(r.created_at)}</div>
                        <div style={{ fontSize: 11, color: TEXT_SOFT }}>{r.created_at.slice(0, 19).replace('T', ' ')}</div>
                      </Td>
                      <Td>
                        {r.user_name || r.user_email
                          ? <>
                              <div style={{ fontWeight: 500 }}>{r.user_name || r.user_email}</div>
                              {r.user_email && r.user_name && (
                                <div style={{ fontSize: 11, color: TEXT_SOFT }}>{r.user_email}</div>
                              )}
                              {r.user_role && (
                                <div style={{ fontSize: 11, color: TEXT_SOFT, marginTop: 2 }}>
                                  {ROLE_LABEL[r.user_role]}
                                </div>
                              )}
                            </>
                          : <Dim>(deleted user{r.user_id ? ` #${r.user_id}` : ''})</Dim>
                        }
                      </Td>
                      <Td><ActionPill action={r.action} /></Td>
                      <Td><MetadataCell metadata={r.metadata} /></Td>
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

function formatWhen(iso: string): string {
  const d = new Date(iso)
  const diffMs = Date.now() - d.getTime()
  const sec = Math.floor(diffMs / 1000)
  if (sec < 60)         return 'just now'
  if (sec < 3600)       return `${Math.floor(sec / 60)}m ago`
  if (sec < 24 * 3600)  return `${Math.floor(sec / 3600)}h ago`
  if (sec < 7 * 86400)  return `${Math.floor(sec / 86400)}d ago`
  return d.toLocaleDateString()
}

function ActionPill({ action }: { action: string }) {
  const s = actionStyle(action)
  return (
    <span style={{
      background: s.bg, color: s.fg, border: `1px solid ${s.bd}`,
      padding: '2px 10px', borderRadius: 999, fontSize: 11, fontWeight: 600,
      whiteSpace: 'nowrap', fontFamily: 'monospace',
    }}>{action}</span>
  )
}

function MetadataCell({ metadata }: { metadata: Record<string, unknown> | null }) {
  if (!metadata) return <Dim>—</Dim>
  const entries = Object.entries(metadata)
  if (entries.length === 0) return <Dim>—</Dim>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontFamily: 'monospace', fontSize: 12 }}>
      {entries.map(([k, v]) => (
        <div key={k}>
          <span style={{ color: TEXT_SOFT }}>{k}:</span>{' '}
          <span style={{ color: TEXT }}>{stringify(v)}</span>
        </div>
      ))}
    </div>
  )
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'object')          return JSON.stringify(v)
  return String(v)
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

const inputStyle: React.CSSProperties = {
  padding: '7px 10px', border: `1px solid ${BORDER}`,
  borderRadius: 7, fontSize: 13, fontFamily: "'DM Sans', sans-serif",
  color: TEXT, background: '#fff',
}

void TEAL
