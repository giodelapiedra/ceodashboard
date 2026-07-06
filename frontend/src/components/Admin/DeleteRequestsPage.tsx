import React, { useCallback, useEffect, useState } from 'react'
import { deleteRequestsApi, DeleteRequestDTO, DeleteEntityType } from '../../api/deleteRequests.api'
import { toast } from '../../store/toast.store'
import { confirmDialog } from '../../store/confirm.store'
import { CLINIC_LABEL, ClinicId } from '../../types'
import AppShell from '../shared/AppShell'

const TEAL      = '#0f6e56'
const TEXT      = '#111827'
const TEXT_SOFT = '#4b5563'
const BORDER    = '#e5e7eb'
const DANGER    = '#b91c1c'

const KIND_LABEL: Record<DeleteEntityType, string> = {
  dropout:         'Patient Dropout',
  case_acceptance: 'Case Acceptance',
}

function ago(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)  return `${hrs} hr ago`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function DeleteRequestsPage() {
  const [rows, setRows]       = useState<DeleteRequestDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  const [busyId, setBusyId]   = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      setRows(await deleteRequestsApi.listPending())
    } catch (e: any) {
      setError(e.response?.data?.error?.message || 'Failed to load delete requests')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const approve = async (r: DeleteRequestDTO) => {
    const ok = await confirmDialog.destructive({
      title:        'Approve deletion?',
      message:      `${KIND_LABEL[r.entity_type]} — ${r.patient_name || 'entry'}\nRequested by: ${r.requested_by_name || '—'}\n\nThis will permanently delete the entry. This cannot be undone.`,
      confirmLabel: 'Approve & delete',
    })
    if (!ok) return
    setBusyId(r.id)
    try {
      await deleteRequestsApi.approve(r.id)
      toast.success('Entry deleted')
      await load()
    } catch (e: any) {
      toast.error(e.response?.data?.error?.message || 'Failed to approve')
    } finally { setBusyId(null) }
  }

  const reject = async (r: DeleteRequestDTO) => {
    const ok = await confirmDialog.ask({
      title:        'Reject request?',
      message:      `${KIND_LABEL[r.entity_type]} — ${r.patient_name || 'entry'}\nRequested by: ${r.requested_by_name || '—'}\n\nThe entry will be kept and the request closed.`,
      confirmLabel: 'Reject request',
    })
    if (!ok) return
    setBusyId(r.id)
    try {
      await deleteRequestsApi.reject(r.id)
      toast.success('Request rejected — entry kept')
      await load()
    } catch (e: any) {
      toast.error(e.response?.data?.error?.message || 'Failed to reject')
    } finally { setBusyId(null) }
  }

  return (
    <AppShell title="Delete Requests">
      <div style={{ padding: '20px 28px' }}>
        <div style={{
          background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, overflow: 'hidden',
        }}>
          <div style={{
            padding: '12px 16px', background: '#f9fafb', borderBottom: `1px solid ${BORDER}`,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>
              Pending delete requests
              <span style={{ color: TEXT_SOFT, fontWeight: 400, marginLeft: 8 }}>
                ({rows.length}) — approve to delete the entry, reject to keep it
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
              No pending delete requests.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 980 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    <Th>Type</Th>
                    <Th>Patient</Th>
                    <Th>Clinic</Th>
                    <Th>Entry date</Th>
                    <Th>Requested by</Th>
                    <Th>Reason</Th>
                    <Th>Requested</Th>
                    <Th align="right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} style={{ borderTop: `1px solid ${BORDER}` }}>
                      <Td><KindPill kind={r.entity_type} /></Td>
                      <Td><strong>{r.patient_name || <Dim>—</Dim>}</strong></Td>
                      <Td>{r.clinic_id ? (CLINIC_LABEL[r.clinic_id as ClinicId] ?? r.clinic_id) : <Dim>—</Dim>}</Td>
                      <Td>{r.entry_date || <Dim>—</Dim>}</Td>
                      <Td>{r.requested_by_name || <Dim>—</Dim>}</Td>
                      <Td><span style={{ color: TEXT_SOFT }}>{r.reason || <Dim>—</Dim>}</span></Td>
                      <Td><span style={{ color: TEXT_SOFT }}>{ago(r.created_at)}</span></Td>
                      <Td align="right">
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                          <button onClick={() => approve(r)} disabled={busyId === r.id}
                            style={{ ...smallBtnStyle, background: TEAL, color: '#fff', borderColor: TEAL }}>
                            {busyId === r.id ? '…' : 'Approve'}
                          </button>
                          <button onClick={() => reject(r)} disabled={busyId === r.id}
                            style={{ ...smallBtnStyle, color: DANGER, borderColor: '#fecaca' }}>
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

function KindPill({ kind }: { kind: DeleteEntityType }) {
  const isDropout = kind === 'dropout'
  return (
    <span style={{
      background:   isDropout ? '#eef2ff' : '#f0faf7',
      color:        isDropout ? '#3730a3' : TEAL,
      border: `1px solid ${isDropout ? '#c7d2fe' : '#cdebde'}`,
      padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
    }}>{KIND_LABEL[kind]}</span>
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
