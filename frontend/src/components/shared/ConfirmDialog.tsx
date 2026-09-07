import React, { useEffect, useRef } from 'react'
import { useConfirmStore } from '../../store/confirm.store'

const TEAL   = '#0f6e56'
const DANGER = '#b91c1c'
const TEXT   = '#111827'
const TEXT_SOFT = '#4b5563'
const BORDER = '#e5e7eb'

export default function ConfirmDialog() {
  const { current, resolve } = useConfirmStore()
  const confirmBtnRef = useRef<HTMLButtonElement>(null)

  // Focus the confirm button when the dialog opens — Enter then accepts.
  // For destructive dialogs we still focus confirm (faster keyboard flow);
  // the accidental-click guard is the visual red colour + the explicit label.
  useEffect(() => {
    if (current) {
      const t = setTimeout(() => confirmBtnRef.current?.focus(), 30)
      return () => clearTimeout(t)
    }
  }, [current?.id])

  // Esc cancels; Enter confirms (only when our button doesn't already have focus).
  useEffect(() => {
    if (!current) return
    const onKey = (e: KeyboardEvent) => {
      // Esc is 'dismiss', not 'cancel': a dialog whose cancel button is a real
      // second action (see ConfirmOutcome) must not fire it on a key press
      // whose whole meaning is "get me out of here".
      if (e.key === 'Escape') { e.preventDefault(); resolve('dismiss') }
      else if (e.key === 'Enter' && document.activeElement !== confirmBtnRef.current) {
        e.preventDefault(); resolve('confirm')
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [current, resolve])

  if (!current) return null

  const {
    title, message, destructive,
    confirmLabel = destructive ? 'Delete' : 'Confirm',
    cancelLabel  = 'Cancel',
  } = current

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      onClick={(e) => { if (e.target === e.currentTarget) resolve('dismiss') }}
      style={{
        position: 'fixed', inset: 0, zIndex: 9000,
        background: 'rgba(15, 23, 42, 0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
        animation: 'cdFadeIn 0.12s ease',
      }}
    >
      <style>{`
        @keyframes cdFadeIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes cdPopIn  { from { opacity: 0; transform: translateY(6px) scale(0.97) } to { opacity: 1; transform: none } }
      `}</style>

      <div style={{
        background: '#fff', borderRadius: 12,
        width: '100%', maxWidth: 420,
        boxShadow: '0 20px 50px rgba(0,0,0,0.20)',
        animation: 'cdPopIn 0.16s ease',
        overflow: 'hidden',
        fontFamily: "'DM Sans', sans-serif",
      }}>
        <div style={{ padding: '22px 24px 14px', display: 'flex', gap: 14 }}>
          <span style={{
            flexShrink: 0,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 36, height: 36, borderRadius: '50%',
            background: destructive ? '#fef2f2' : '#f0faf7',
            color:      destructive ? DANGER  : TEAL,
            fontSize: 18, fontWeight: 700,
          }}>{destructive ? '!' : '?'}</span>

          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 id="confirm-title" style={{
              margin: 0, fontSize: 16, fontWeight: 700, color: TEXT, lineHeight: 1.3,
            }}>{title}</h3>
            <p style={{
              margin: '6px 0 0', fontSize: 13, color: TEXT_SOFT, lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
            }}>{message}</p>
          </div>
        </div>

        <div style={{
          padding: '12px 18px', borderTop: `1px solid ${BORDER}`, background: '#fafbfc',
          display: 'flex', justifyContent: 'flex-end', gap: 8,
        }}>
          <button
            onClick={() => resolve('cancel')}
            style={{
              background: '#fff', color: TEXT,
              border: `1px solid ${BORDER}`, borderRadius: 7,
              padding: '8px 16px', fontSize: 13, fontWeight: 500,
              cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
            }}
          >{cancelLabel}</button>
          <button
            ref={confirmBtnRef}
            onClick={() => resolve('confirm')}
            style={{
              background: destructive ? DANGER : TEAL,
              color: '#fff', border: 'none', borderRadius: 7,
              padding: '8px 18px', fontSize: 13, fontWeight: 600,
              cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
              boxShadow: destructive ? '0 1px 3px rgba(185,28,28,0.25)' : '0 1px 3px rgba(15,110,86,0.25)',
            }}
          >{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
