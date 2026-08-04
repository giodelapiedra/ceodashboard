import React, { useEffect, useRef } from 'react'
import { usePendingApprovalsStore } from '../../store/pendingApprovals.store'
import { useNavStore } from '../../store/nav.store'

const DANGER      = '#b91c1c'
const DANGER_SOFT = '#fef2f2'
const TEXT        = '#111827'
const TEXT_SOFT   = '#4b5563'
const BORDER      = '#e5e7eb'

/**
 * Login pop-up for the super admin: "N requests need your approval".
 *
 * Deliberately a modal (not a toast) — staff edits/deletions sit frozen until
 * the admin decides, so this must be impossible to walk past. Dismissing it
 * leaves the red bar + menu badges behind (see AppShell).
 */
export default function PendingApprovalsModal() {
  const { popupOpen, editCount, deleteCount, closePopup } = usePendingApprovalsStore()
  const { navigate } = useNavStore()
  const firstBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!popupOpen) return
    const t = setTimeout(() => firstBtnRef.current?.focus(), 30)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closePopup() }
    document.addEventListener('keydown', onKey)
    return () => { clearTimeout(t); document.removeEventListener('keydown', onKey) }
  }, [popupOpen, closePopup])

  if (!popupOpen) return null

  const total = editCount + deleteCount
  const go = (page: 'admin-edit-requests' | 'admin-delete-requests') => {
    closePopup()
    navigate(page)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="pending-approvals-title"
      // No click-outside close on purpose — the admin has to press a button.
      style={{
        position: 'fixed', inset: 0, zIndex: 9500,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
        animation: 'paFadeIn 0.14s ease',
        fontFamily: "'DM Sans', sans-serif",
      }}
    >
      <style>{`
        @keyframes paFadeIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes paPopIn  { from { opacity: 0; transform: translateY(10px) scale(0.96) } to { opacity: 1; transform: none } }
        @keyframes paRing   {
          0%, 100% { transform: rotate(0deg) }
          15% { transform: rotate(14deg) }  30% { transform: rotate(-12deg) }
          45% { transform: rotate(9deg) }   60% { transform: rotate(-6deg) }
          75% { transform: rotate(3deg) }
        }
        .pa-row:hover { background: #fff5f5 !important; border-color: ${DANGER} !important }
      `}</style>

      <div style={{
        background: '#fff', borderRadius: 16,
        width: '100%', maxWidth: 460,
        boxShadow: '0 24px 60px rgba(0,0,0,0.28)',
        animation: 'paPopIn 0.2s ease',
        overflow: 'hidden',
      }}>
        {/* Red header strip — reads as "action required" at a glance. */}
        <div style={{
          background: DANGER, color: '#fff',
          padding: '20px 24px',
          display: 'flex', alignItems: 'center', gap: 14,
        }}>
          <span style={{
            flexShrink: 0,
            width: 42, height: 42, borderRadius: '50%',
            background: 'rgba(255,255,255,0.18)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            animation: 'paRing 1.6s ease-in-out 3',
            transformOrigin: '50% 20%',
          }}>
            <BellIcon />
          </span>
          <div style={{ minWidth: 0 }}>
            <h2 id="pending-approvals-title" style={{
              margin: 0, fontSize: 18, fontWeight: 800, letterSpacing: '-0.01em',
            }}>
              {total} request{total === 1 ? '' : 's'} need{total === 1 ? 's' : ''} your approval
            </h2>
            <p style={{ margin: '3px 0 0', fontSize: 13, opacity: 0.9 }}>
              Staff are waiting — nothing changes until you decide.
            </p>
          </div>
        </div>

        <div style={{ padding: '18px 24px 8px' }}>
          {editCount > 0 && (
            <QueueRow
              buttonRef={editCount > 0 ? firstBtnRef : undefined}
              icon={<PencilIcon />}
              count={editCount}
              label={`edit request${editCount === 1 ? '' : 's'}`}
              hint="Changes to existing entries, waiting to be applied."
              onClick={() => go('admin-edit-requests')}
            />
          )}
          {deleteCount > 0 && (
            <QueueRow
              buttonRef={editCount === 0 ? firstBtnRef : undefined}
              icon={<TrashIcon />}
              count={deleteCount}
              label={`delete request${deleteCount === 1 ? '' : 's'}`}
              hint="Entries staff want removed, waiting to be deleted."
              onClick={() => go('admin-delete-requests')}
            />
          )}
        </div>

        <div style={{
          padding: '12px 20px', borderTop: `1px solid ${BORDER}`, background: '#fafbfc',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
        }}>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>
            Stays flagged in the Admin menu until cleared.
          </span>
          <button
            onClick={closePopup}
            style={{
              background: '#fff', color: TEXT_SOFT,
              border: `1px solid ${BORDER}`, borderRadius: 7,
              padding: '8px 16px', fontSize: 13, fontWeight: 500,
              cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
            }}
          >Later</button>
        </div>
      </div>
    </div>
  )
}

function QueueRow({
  icon, count, label, hint, onClick, buttonRef,
}: {
  icon:      React.ReactNode
  count:     number
  label:     string
  hint:      string
  onClick:   () => void
  buttonRef?: React.RefObject<HTMLButtonElement>
}) {
  return (
    <button
      ref={buttonRef}
      onClick={onClick}
      className="pa-row"
      style={{
        display: 'flex', alignItems: 'center', gap: 14,
        width: '100%', textAlign: 'left',
        background: DANGER_SOFT,
        border: '1px solid #fecaca', borderRadius: 11,
        padding: '14px 16px', marginBottom: 10,
        cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
        transition: 'background 0.15s, border-color 0.15s',
      }}
    >
      <span style={{
        flexShrink: 0,
        width: 38, height: 38, borderRadius: 10,
        background: DANGER, color: '#fff',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 15, fontWeight: 700, color: TEXT }}>
          {count} {label}
        </span>
        <span style={{ display: 'block', fontSize: 12.5, color: TEXT_SOFT, marginTop: 2 }}>
          {hint}
        </span>
      </span>
      <span style={{ flexShrink: 0, fontSize: 13, fontWeight: 700, color: DANGER }}>
        Review →
      </span>
    </button>
  )
}

// ── Icons ───────────────────────────────────────────────────────────────

function BellIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  )
}
