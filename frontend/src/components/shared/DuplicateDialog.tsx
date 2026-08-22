import React, { useEffect, useRef } from 'react'
import { useDuplicateStore } from '../../store/duplicate.store'

const TEAL      = '#0f6e56'
const AMBER     = '#b45309'
const AMBER_BG  = '#fffbeb'
const TEXT      = '#111827'
const TEXT_SOFT = '#4b5563'
const TEXT_DIM  = '#9ca3af'
const BORDER    = '#e5e7eb'

/**
 * Shown when the entry being saved collides with one already in the database.
 *
 * A warning, never a block: the only outcomes are "save it anyway as a second
 * entry" and "back out". Nothing here edits the stored row or files anything
 * for approval.
 *
 * The diff table is the whole point: "duplicate!" on its own teaches staff to
 * dismiss the warning. Seeing exactly which fields differ from the stored row
 * is what lets them tell a real double-entry from a legitimately separate one.
 *
 * Cancel is the default (Esc, backdrop click) — nothing is saved by accident.
 */
export default function DuplicateDialog() {
  const { current, resolve } = useDuplicateStore()
  const cancelBtnRef = useRef<HTMLButtonElement>(null)

  // Focus lands on Cancel, NOT the primary. The point of the dialog is to make
  // staff read the diff — a reflex Enter must not save straight through it.
  useEffect(() => {
    if (current) {
      const t = setTimeout(() => cancelBtnRef.current?.focus(), 30)
      return () => clearTimeout(t)
    }
  }, [current?.id])

  // Esc cancels. Enter is deliberately NOT bound to any action.
  useEffect(() => {
    if (!current) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); resolve('cancel') }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [current, resolve])

  if (!current) return null

  const { title, subtitle, existingMeta, fields, saveLabel, saveNote } = current

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="dup-title"
      onClick={(e) => { if (e.target === e.currentTarget) resolve('cancel') }}
      style={{
        position: 'fixed', inset: 0, zIndex: 9100,
        background: 'rgba(15, 23, 42, 0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
        animation: 'dupFadeIn 0.12s ease',
      }}
    >
      <style>{`
        @keyframes dupFadeIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes dupPopIn  { from { opacity: 0; transform: translateY(6px) scale(0.97) } to { opacity: 1; transform: none } }
      `}</style>

      <div style={{
        background: '#fff', borderRadius: 12,
        width: '100%', maxWidth: 620,
        maxHeight: '90vh', display: 'flex', flexDirection: 'column',
        boxShadow: '0 20px 50px rgba(0,0,0,0.20)',
        animation: 'dupPopIn 0.16s ease',
        overflow: 'hidden',
        fontFamily: "'DM Sans', sans-serif",
      }}>
        <div style={{ padding: '22px 24px 14px', display: 'flex', gap: 14 }}>
          <span style={{
            flexShrink: 0,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 36, height: 36, borderRadius: '50%',
            background: AMBER_BG, color: AMBER,
            fontSize: 18, fontWeight: 700,
          }}>!</span>

          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 id="dup-title" style={{
              margin: 0, fontSize: 16, fontWeight: 700, color: TEXT, lineHeight: 1.3,
            }}>{title}</h3>
            <p style={{ margin: '6px 0 0', fontSize: 13, color: TEXT_SOFT, lineHeight: 1.5 }}>
              {subtitle}
            </p>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: TEXT_DIM, lineHeight: 1.5 }}>
              {existingMeta}
            </p>
          </div>
        </div>

        <div style={{ padding: '0 24px 18px', overflowY: 'auto' }}>
          <table style={{
            width: '100%', borderCollapse: 'collapse',
            fontSize: 12.5, tableLayout: 'fixed',
          }}>
            <thead>
              <tr>
                <th style={thStyle('30%')}>Field</th>
                <th style={thStyle('35%')}>Already saved</th>
                <th style={thStyle('35%')}>What you typed</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((f) => {
                // Compare rendered text: that is what the user is looking at,
                // and it already accounts for the null → '—' normalisation.
                const changed = f.existing !== f.incoming
                return (
                  <tr key={f.label} style={{ background: changed ? AMBER_BG : undefined }}>
                    <td style={tdStyle(changed ? TEXT : TEXT_DIM, changed ? 600 : 400)}>
                      {f.label}
                    </td>
                    <td style={tdStyle(changed ? TEXT_SOFT : TEXT_DIM, 400)}>{f.existing}</td>
                    <td style={tdStyle(changed ? TEXT : TEXT_DIM, changed ? 600 : 400)}>
                      {f.incoming}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {fields.every((f) => f.existing === f.incoming) && (
            <p style={{
              margin: '12px 0 0', fontSize: 12.5, color: TEXT_SOFT, lineHeight: 1.5,
            }}>
              Every field matches the saved entry — this looks like the same thing
              keyed twice. Cancelling changes nothing.
            </p>
          )}

          <p style={{ margin: '12px 0 0', fontSize: 12.5, color: TEXT_SOFT, lineHeight: 1.5 }}>
            Saving adds a second entry — the saved one is left exactly as it is.
            To correct that one instead, cancel and edit it from the list.
          </p>
        </div>

        <div style={{
          padding: '12px 18px', borderTop: `1px solid ${BORDER}`, background: '#fafbfc',
          display: 'flex', flexWrap: 'wrap', alignItems: 'center',
          justifyContent: 'flex-end', gap: 8,
        }}>
          {saveNote && (
            <span style={{
              flex: '1 1 200px', minWidth: 0,
              fontSize: 11.5, color: TEXT_DIM, lineHeight: 1.4,
            }}>{saveNote}</span>
          )}

          <button
            ref={cancelBtnRef}
            onClick={() => resolve('cancel')}
            style={btnStyle({ background: '#fff', color: TEXT, border: `1px solid ${BORDER}` })}
          >Cancel</button>

          <button
            onClick={() => resolve('save')}
            style={btnStyle({
              background: TEAL, color: '#fff', border: 'none', weight: 600,
              shadow: '0 1px 3px rgba(15,110,86,0.25)',
            })}
          >{saveLabel ?? 'Save anyway'}</button>
        </div>
      </div>
    </div>
  )
}

const thStyle = (width: string): React.CSSProperties => ({
  width,
  textAlign: 'left',
  padding: '6px 8px',
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  color: TEXT_DIM,
  borderBottom: `1px solid ${BORDER}`,
})

const tdStyle = (color: string, fontWeight: number): React.CSSProperties => ({
  padding: '7px 8px',
  color,
  fontWeight,
  borderBottom: `1px solid ${BORDER}`,
  wordBreak: 'break-word',
})

function btnStyle(o: {
  background: string
  color:      string
  border:     string
  weight?:    number
  shadow?:    string
}): React.CSSProperties {
  return {
    background: o.background,
    color:      o.color,
    border:     o.border,
    borderRadius: 7,
    padding: '8px 16px',
    fontSize: 13,
    fontWeight: o.weight ?? 500,
    cursor: 'pointer',
    fontFamily: "'DM Sans', sans-serif",
    boxShadow: o.shadow,
  }
}
