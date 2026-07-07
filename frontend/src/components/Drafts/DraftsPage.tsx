import React, { useCallback, useEffect, useState } from 'react'
import { draftsApi, DraftDTO, DraftKind } from '../../api/drafts.api'
import { useNavStore } from '../../store/nav.store'
import { useDraftResumeStore } from '../../store/draftResume.store'
import { toast } from '../../store/toast.store'
import { confirmDialog } from '../../store/confirm.store'
import { CLINIC_LABEL, ClinicId } from '../../types'
import AppShell from '../shared/AppShell'

const TEAL      = '#0f6e56'
const TEXT      = '#111827'
const TEXT_SOFT = '#4b5563'
const BORDER    = '#e5e7eb'
const DANGER    = '#b91c1c'

const KIND_LABEL: Record<DraftKind, string> = {
  dropout:         'Patient Dropout',
  case_acceptance: 'Case Acceptance',
}
// Which entry page each kind resumes into.
const KIND_PAGE = {
  dropout:         'dropout-entry',
  case_acceptance: 'case-acceptance-entry',
} as const

function savedAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)  return `${hrs} hr ago`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function DraftsPage() {
  const { navigate } = useNavStore()
  const { setPending } = useDraftResumeStore()

  const [drafts, setDrafts]   = useState<DraftDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      // Both kinds in parallel, then merged newest-first into one timeline.
      const [dropouts, cases] = await Promise.all([
        draftsApi.list('dropout'),
        draftsApi.list('case_acceptance'),
      ])
      const all = [...dropouts, ...cases].sort(
        (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      )
      setDrafts(all)
    } catch (e: any) {
      setError(e.response?.data?.error?.message || 'Failed to load drafts')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const resume = (d: DraftDTO) => {
    setPending(d)
    navigate(KIND_PAGE[d.kind])
  }

  const remove = async (d: DraftDTO) => {
    const ok = await confirmDialog.destructive({
      title:        'Delete draft?',
      message:      `${KIND_LABEL[d.kind]} — ${d.patient_name || 'Untitled draft'}\n\nThis cannot be undone.`,
      confirmLabel: 'Delete draft',
    })
    if (!ok) return
    try {
      await draftsApi.remove(d.id)
      toast.success('Draft deleted')
      await load()
    } catch (e: any) {
      toast.error(e.response?.data?.error?.message || 'Failed to delete draft')
    }
  }

  return (
    <AppShell title="My Drafts">
      <div className="pw-page" style={{ padding: '20px 28px' }}>
        <div style={{
          background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10,
          overflow: 'hidden',
        }}>
          <div style={{
            padding: '12px 16px', background: '#f9fafb', borderBottom: `1px solid ${BORDER}`,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>
              Saved drafts
              <span style={{ color: TEXT_SOFT, fontWeight: 400, marginLeft: 8 }}>
                ({drafts.length}) — unfinished entries you can pick up anytime
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
          ) : drafts.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
              No saved drafts. Use “Save draft” on a Dropout or Case Acceptance entry to keep one here.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 760 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    <Th>Type</Th>
                    <Th>Patient</Th>
                    <Th>Clinic</Th>
                    <Th>Last saved</Th>
                    <Th align="right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {drafts.map(d => (
                    <tr key={`${d.kind}-${d.id}`} style={{ borderTop: `1px solid ${BORDER}` }}>
                      <Td><KindPill kind={d.kind} /></Td>
                      <Td>
                        {d.patient_name
                          ? <strong>{d.patient_name}</strong>
                          : <span style={{ color: '#9ca3af' }}>Untitled draft</span>}
                      </Td>
                      <Td>{d.clinic_id ? (CLINIC_LABEL[d.clinic_id as ClinicId] ?? d.clinic_id) : <Dim>—</Dim>}</Td>
                      <Td><span style={{ color: TEXT_SOFT }}>{savedAgo(d.updated_at)}</span></Td>
                      <Td align="right">
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                          <button onClick={() => resume(d)} style={resumeBtnStyle}>Resume</button>
                          <button onClick={() => remove(d)} style={{ ...smallBtnStyle, color: DANGER, borderColor: '#fecaca' }}>Delete</button>
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

function KindPill({ kind }: { kind: DraftKind }) {
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
  borderRadius: 6, padding: '5px 10px', fontSize: 12, fontWeight: 500,
  cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
}
const resumeBtnStyle: React.CSSProperties = {
  background: '#fff', color: TEAL, border: `1px solid ${TEAL}`,
  borderRadius: 6, padding: '5px 12px', fontSize: 12, fontWeight: 600,
  cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
}
