import React, { useEffect } from 'react'
import { DraftDTO } from '../../api/drafts.api'
import { CLINIC_LABEL, ClinicId } from '../../types'

const TEAL      = '#0f6e56'
const TEXT      = '#111827'
const TEXT_SOFT = '#4b5563'
const BORDER    = '#e5e7eb'

function savedAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)  return `${hrs} hr ago`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * Blocks the user from submitting a new entry when they have unfinished drafts.
 * Lists each draft with a Resume button. No "proceed anyway" — drafts must be
 * finished or deleted first via the DraftsPanel or My Drafts page.
 */
export default function DraftBlockerModal<T>({
  drafts,
  onResume,
  onClose,
}: {
  drafts:   DraftDTO<T>[]
  onResume: (d: DraftDTO<T>) => void
  onClose:  () => void
}) {
  const count = drafts.length

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          background: '#fff', borderRadius: 14, padding: '28px 28px 24px',
          width: '100%', maxWidth: 460,
          boxShadow: '0 20px 50px rgba(15,23,42,0.18)',
          fontFamily: "'DM Sans', sans-serif",
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 9,
              background: '#fffbeb', border: '1px solid #fde68a',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 18, flexShrink: 0,
            }}>✏️</div>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: TEXT }}>
              Finish your draft first
            </h2>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: '#9ca3af', fontSize: 22, lineHeight: 1, padding: '0 0 0 8px',
              fontFamily: "'DM Sans', sans-serif",
            }}
          >×</button>
        </div>

        <p style={{ margin: '0 0 20px', fontSize: 13, color: TEXT_SOFT, lineHeight: 1.6 }}>
          You have{' '}
          <strong style={{ color: TEXT }}>
            {count === 1 ? 'an unfinished draft' : `${count} unfinished drafts`}
          </strong>
          . Resume and complete {count === 1 ? 'it' : 'one'}, or delete{' '}
          {count === 1 ? 'it' : 'them all'} via <em>My Drafts</em>, before adding a new entry.
        </p>

        {/* Draft list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {drafts.map(d => (
            <div key={d.id} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 12, background: '#f9fafb', border: `1px solid ${BORDER}`,
              borderRadius: 8, padding: '10px 14px',
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: TEXT, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {d.patient_name
                    ? d.patient_name
                    : <span style={{ color: '#9ca3af', fontWeight: 400 }}>Untitled draft</span>}
                </div>
                <div style={{ fontSize: 12, color: TEXT_SOFT, marginTop: 2 }}>
                  {d.clinic_id ? `${CLINIC_LABEL[d.clinic_id as ClinicId] ?? d.clinic_id} · ` : ''}
                  Saved {savedAgo(d.updated_at)}
                </div>
              </div>
              <button
                onClick={() => onResume(d)}
                style={{
                  background: '#fff', color: TEAL, border: `1px solid ${TEAL}`,
                  borderRadius: 6, padding: '6px 16px', fontSize: 12, fontWeight: 600,
                  cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", flexShrink: 0,
                  transition: 'background 0.12s',
                }}
              >Resume</button>
            </div>
          ))}
        </div>

        {/* Footer note */}
        <div style={{
          marginTop: 18, padding: '10px 14px', background: '#f0faf7',
          border: '1px solid #cdebde', borderRadius: 8,
          fontSize: 12, color: '#065f46', lineHeight: 1.5,
        }}>
          To discard {count === 1 ? 'this draft' : 'drafts'}, use the <strong>Delete</strong> button in the
          {' '}<em>Saved drafts</em> panel above, or go to <strong>My Drafts</strong>.
        </div>
      </div>
    </div>
  )
}
