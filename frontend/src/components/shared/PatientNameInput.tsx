import React, { useEffect, useRef, useState } from 'react'
import { patientsApi } from '../../api/patients.api'

const TEAL = '#0f6e56'

interface Props {
  value:        string
  onChange:     (v: string) => void
  placeholder?: string
  style?:       React.CSSProperties
}

/**
 * Patient-name text input with a suggestions dropdown sourced from names we've
 * ALREADY encoded (patient_dropouts + case_acceptances). Helps staff reuse the
 * existing spelling for a returning patient instead of retyping it. Purely a
 * convenience over our own data — not connected to Nookal.
 */
export default function PatientNameInput({ value, onChange, placeholder, style }: Props) {
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [open, setOpen]         = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const [focused, setFocused]   = useState(false)

  // Suppress the very next fetch after a selection so picking a name doesn't
  // immediately re-open the list.
  const justPicked = useRef(false)
  const wrapRef    = useRef<HTMLDivElement>(null)
  const blurTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Debounced fetch — only while the field is focused and the user has typed
  // at least 2 characters. Programmatic sets (e.g. loading a row to edit) don't
  // focus the field, so they never trigger a lookup.
  useEffect(() => {
    if (!focused) return
    if (justPicked.current) { justPicked.current = false; return }
    const q = value.trim()
    if (q.length < 2) { setSuggestions([]); setOpen(false); return }

    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const names = await patientsApi.suggest(q)
        if (cancelled) return
        // Drop an exact (case-insensitive) match — no point suggesting what's
        // already fully typed.
        const filtered = names.filter(n => n.toLowerCase() !== q.toLowerCase())
        setSuggestions(filtered)
        setHighlight(-1)
        setOpen(filtered.length > 0)
      } catch { /* suggestions are best-effort — never block typing */ }
    }, 250)

    return () => { cancelled = true; clearTimeout(t) }
  }, [value, focused])

  const pick = (name: string) => {
    justPicked.current = true
    onChange(name)
    setOpen(false)
    setSuggestions([])
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || suggestions.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight(h => Math.min(h + 1, suggestions.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight(h => Math.max(h - 1, 0))
    } else if (e.key === 'Enter' && highlight >= 0) {
      e.preventDefault()
      pick(suggestions[highlight])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={() => { setFocused(true); if (suggestions.length) setOpen(true) }}
        onBlur={() => {
          // Delay so a click on a suggestion registers before we close.
          blurTimer.current = setTimeout(() => { setOpen(false); setFocused(false) }, 150)
        }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        style={style}
      />
      {open && suggestions.length > 0 && (
        <div
          role="listbox"
          style={{
            position: 'absolute', top: 'calc(100% + 2px)', left: 0, right: 0,
            background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
            boxShadow: '0 8px 24px rgba(15,23,42,0.14)', zIndex: 50,
            maxHeight: 240, overflowY: 'auto', padding: 4,
          }}
          onMouseDown={e => { e.preventDefault() }}  // keep input focus on click
        >
          {suggestions.map((name, i) => (
            <button
              key={name}
              type="button"
              role="option"
              aria-selected={i === highlight}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => {
                if (blurTimer.current) clearTimeout(blurTimer.current)
                pick(name)
              }}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                background: i === highlight ? '#f0faf7' : 'transparent',
                color: i === highlight ? TEAL : '#111827',
                border: 'none', borderRadius: 6, padding: '8px 10px',
                fontSize: 14, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
              }}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
