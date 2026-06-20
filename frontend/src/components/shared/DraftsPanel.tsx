import React from 'react'
import { DraftDTO } from '../../api/drafts.api'
import { CLINIC_LABEL, ClinicId } from '../../types'

const TEAL      = '#0f6e56'
const TEXT      = '#111827'
const TEXT_SOFT = '#4b5563'
const BORDER    = '#e5e7eb'
const DANGER    = '#b91c1c'

/** "just now" / "5 min ago" / "3 hr ago" / "12 Jun" — compact saved-at label. */
function savedAgo(iso: string): string {
  const then = new Date(iso).getTime()
  const diffMs = Date.now() - then
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)  return `${hrs} hr ago`
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/**
 * Per-user list of saved drafts for an entry form. Purely presentational —
 * the parent owns the data and the resume/delete actions. Renders nothing when
 * there are no drafts so it stays out of the way until the user saves one.
 */
export default function DraftsPanel<T>({
  drafts, onResume, onDelete, busy,
}: {
  drafts:   DraftDTO<T>[]
  onResume: (d: DraftDTO<T>) => void
  onDelete: (d: DraftDTO<T>) => void
  busy?:    boolean
}) {
  if (drafts.length === 0) return null

  return (
    <div style={{
      background: '#fffdf5', border: '1px solid #fde68a', borderRadius: 10,
      padding: 16, marginBottom: 20,
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: TEXT, marginBottom: 10 }}>
        Saved drafts
        <span style={{ color: TEXT_SOFT, fontWeight: 400, marginLeft: 6 }}>
          ({drafts.length}) — click Resume to finish later
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {drafts.map(d => (
          <div key={d.id} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 12, background: '#fff', border: `1px solid ${BORDER}`,
            borderRadius: 8, padding: '8px 12px',
          }}>
            <div style={{ minWidth: 0 }}>
              <span style={{ fontWeight: 600, color: TEXT }}>
                {d.patient_name || <span style={{ color: '#9ca3af', fontWeight: 400 }}>Untitled draft</span>}
              </span>
              <span style={{ color: TEXT_SOFT, fontSize: 12, marginLeft: 8 }}>
                {d.clinic_id ? CLINIC_LABEL[d.clinic_id as ClinicId] ?? d.clinic_id : ''}
                {d.clinic_id ? ' · ' : ''}saved {savedAgo(d.updated_at)}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              <button
                type="button"
                onClick={() => onResume(d)}
                disabled={busy}
                style={{
                  background: '#fff', color: TEAL, border: `1px solid ${TEAL}`,
                  borderRadius: 6, padding: '5px 12px', fontSize: 12, fontWeight: 600,
                  cursor: busy ? 'not-allowed' : 'pointer', fontFamily: "'DM Sans', sans-serif",
                }}
              >Resume</button>
              <button
                type="button"
                onClick={() => onDelete(d)}
                disabled={busy}
                style={{
                  background: '#fff', color: DANGER, border: '1px solid #fecaca',
                  borderRadius: 6, padding: '5px 10px', fontSize: 12, fontWeight: 500,
                  cursor: busy ? 'not-allowed' : 'pointer', fontFamily: "'DM Sans', sans-serif",
                }}
              >Delete</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
