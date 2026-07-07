import React, { useCallback, useEffect, useState } from 'react'
import { editRequestsApi, EditRequestDTO } from '../../api/editRequests.api'
import { usersApi } from '../../api/users.api'
import { toast } from '../../store/toast.store'
import { confirmDialog } from '../../store/confirm.store'
import { promptDialog } from '../../store/prompt.store'
import { CLINIC_LABEL, ClinicId, User } from '../../types'
import AppShell from '../shared/AppShell'

const TEAL      = '#0f6e56'
const TEXT      = '#111827'
const TEXT_SOFT = '#4b5563'
const BORDER    = '#e5e7eb'
const DANGER    = '#b91c1c'

// Human-readable labels for patch field names.
const FIELD_LABEL: Record<string, string> = {
  front_staff_name:            'Front of staff',
  clinician_id:                'Clinician',
  patient_name:                'Patient name',
  date_logged:                 'Date',
  treatment_plan_provided:     'Treatment plan provided',
  case_recommendations:        'Case recommendations',
  appointments_booked:         'Appointments booked',
  prepay_offered:              'Prepay offered',
  prepay_accepted:             'Prepay accepted',
  transition_notes:            'Transition notes',
  notes:                       'Notes',
  // dropout fields
  status:                      'Status',
  reason:                      'Reason',
  appointment_cancelled_dates: 'Cancelled dates',
}

function formatValue(key: string, val: unknown, clinicians: User[]): string {
  if (val === null || val === undefined) return '—'
  if (typeof val === 'boolean') return val ? 'Yes' : 'No'
  if (Array.isArray(val)) return val.length === 0 ? '(none)' : val.join(', ')
  if (key === 'clinician_id') {
    const found = clinicians.find(c => c.id === String(val))
    return found ? (found.full_name || found.email) : `ID: ${val}`
  }
  return String(val)
}

function ago(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)  return `${hrs} hr ago`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function EditRequestsPage() {
  const [rows,       setRows]       = useState<EditRequestDTO[]>([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState('')
  const [busyId,     setBusyId]     = useState<string | null>(null)
  const [clinicians, setClinicians] = useState<User[]>([])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [data, staff] = await Promise.all([
        editRequestsApi.listPending(),
        usersApi.staff('CLINICIAN'),
      ])
      setRows(data)
      setClinicians(staff)
    } catch (e: any) {
      setError(e.response?.data?.error?.message || 'Failed to load edit requests')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const approve = async (r: EditRequestDTO) => {
    const ok = await confirmDialog.ask({
      title:        'Approve edit?',
      message:      `Patient: ${r.patient_name || 'entry'}\nRequested by: ${r.requested_by_name || '—'}\nReason: ${r.reason}\n\nThis will apply the proposed changes to the entry.`,
      confirmLabel: 'Approve & apply',
    })
    if (!ok) return
    setBusyId(r.id)
    try {
      await editRequestsApi.approve(r.id)
      toast.success('Edit approved and applied')
      await load()
    } catch (e: any) {
      toast.error(e.response?.data?.error?.message || 'Failed to approve')
      // Reload anyway — the usual failure is "already approved/rejected" by
      // another admin, and the stale row would keep erroring on every click.
      await load()
    } finally { setBusyId(null) }
  }

  const reject = async (r: EditRequestDTO) => {
    const reason = await promptDialog.ask({
      title:        'Reject edit request',
      message:      `Patient: ${r.patient_name || 'entry'}\nRequested by: ${r.requested_by_name || '—'}\nReason: ${r.reason}\n\nThe entry will stay unchanged. Provide a reason so the staff member knows why.`,
      placeholder:  'e.g. Duplicate entry, wrong entry — please re-submit…',
      confirmLabel: 'Reject request',
      validate:     v => v.trim().length < 2 ? 'Rejection reason is required' : null,
    })
    if (reason === null) return
    setBusyId(r.id)
    try {
      await editRequestsApi.reject(r.id, reason.trim())
      toast.success('Request rejected — staff will be notified')
      await load()
    } catch (e: any) {
      toast.error(e.response?.data?.error?.message || 'Failed to reject')
      // Reload anyway — the usual failure is "already approved/rejected" by
      // another admin, and the stale row would keep erroring on every click.
      await load()
    } finally { setBusyId(null) }
  }

  return (
    <AppShell title="Edit Requests">
      <div className="pw-page" style={{ padding: '20px 28px' }}>
        <div style={{
          background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, overflow: 'hidden',
        }}>
          <div style={{
            padding: '12px 16px', background: '#f9fafb', borderBottom: `1px solid ${BORDER}`,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>
              Pending edit requests
              <span style={{ color: TEXT_SOFT, fontWeight: 400, marginLeft: 8 }}>
                ({rows.length}) — approve to apply the changes, reject to keep the entry as-is
              </span>
            </div>
            <button onClick={load} disabled={loading} style={smallBtnStyle}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>

          {error && (
            <div style={{
              background: '#fef2f2', borderBottom: '1px solid #fecaca', color: DANGER,
              padding: '10px 16px', fontSize: 13,
            }}>{error}</div>
          )}

          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
              No pending edit requests.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    <Th>Patient</Th>
                    <Th>Clinic</Th>
                    <Th>Entry date</Th>
                    <Th>Requested by</Th>
                    <Th>Reason</Th>
                    <Th>Proposed changes</Th>
                    <Th>Requested</Th>
                    <Th align="right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} style={{ borderTop: `1px solid ${BORDER}` }}>
                      <Td><strong>{r.patient_name || <Dim>—</Dim>}</strong></Td>
                      <Td>{r.clinic_id ? (CLINIC_LABEL[r.clinic_id as ClinicId] ?? r.clinic_id) : <Dim>—</Dim>}</Td>
                      <Td>{r.entry_date || <Dim>—</Dim>}</Td>
                      <Td>{r.requested_by_name || <Dim>—</Dim>}</Td>
                      <Td>
                        <span style={{
                          color: TEXT_SOFT, fontStyle: 'italic',
                          display: 'block', maxWidth: 220,
                        }}>
                          {r.reason}
                        </span>
                      </Td>
                      <Td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                          {Object.entries(r.patch).map(([key, val]) => (
                            <div key={key} style={{ fontSize: 12 }}>
                              <span style={{ color: TEXT_SOFT, fontWeight: 600 }}>
                                {FIELD_LABEL[key] ?? key}:
                              </span>{' '}
                              <span style={{ color: TEXT }}>
                                {formatValue(key, val, clinicians)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </Td>
                      <Td><span style={{ color: TEXT_SOFT }}>{ago(r.created_at)}</span></Td>
                      <Td align="right">
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                          <button
                            onClick={() => approve(r)}
                            disabled={busyId === r.id}
                            style={{ ...smallBtnStyle, background: TEAL, color: '#fff', borderColor: TEAL }}
                          >
                            {busyId === r.id ? '…' : 'Approve'}
                          </button>
                          <button
                            onClick={() => reject(r)}
                            disabled={busyId === r.id}
                            style={{ ...smallBtnStyle, color: DANGER, borderColor: '#fecaca' }}
                          >
                            Reject
                          </button>
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  )
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th style={{
      padding: '10px 14px', textAlign: align, fontSize: 11, fontWeight: 600,
      color: TEXT_SOFT, letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap',
    }}>{children}</th>
  )
}
function Td({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <td style={{ padding: '10px 14px', textAlign: align, color: TEXT, verticalAlign: 'top' }}>{children}</td>
}
function Dim({ children }: { children: React.ReactNode }) {
  return <span style={{ color: '#9ca3af' }}>{children}</span>
}

const smallBtnStyle: React.CSSProperties = {
  background: '#fff', color: TEXT, border: `1px solid ${BORDER}`,
  borderRadius: 6, padding: '5px 12px', fontSize: 12, fontWeight: 600,
  cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
}
