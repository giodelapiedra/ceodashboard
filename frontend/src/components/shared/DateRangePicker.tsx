import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { DayPicker, DateRange } from 'react-day-picker'
import 'react-day-picker/style.css'
import { format, parseISO, startOfDay, subDays, startOfMonth, endOfMonth, subMonths, isValid } from 'date-fns'

const TEAL       = '#0f6e56'
const TEAL_LIGHT = '#22a37e'
const TEAL_TINT  = '#f0faf7'
const TEAL_TINT2 = '#e6f5ef'
const TEXT       = '#111827'
const TEXT_SOFT  = '#4b5563'
const TEXT_MUTED = '#9ca3af'
const BORDER     = '#eef0f3'

export interface DateRangeValue {
  /** ISO YYYY-MM-DD */
  from: string
  /** ISO YYYY-MM-DD */
  to:   string
}

interface Props {
  value: DateRangeValue
  /** Fires only when the user clicks Apply — not on every click inside the picker. */
  onChange: (next: DateRangeValue) => void
  /** Optional cap. If set, ranges longer than this many days will be rejected. */
  maxRangeDays?: number
}

interface Preset {
  label: string
  build: () => DateRangeValue
}

function isoStartOfDay(d: Date): string {
  return format(startOfDay(d), 'yyyy-MM-dd')
}

const PRESETS: Preset[] = [
  { label: 'Today',       build: () => { const t = new Date(); return { from: isoStartOfDay(t), to: isoStartOfDay(t) } } },
  { label: 'Yesterday',   build: () => { const y = subDays(new Date(), 1); return { from: isoStartOfDay(y), to: isoStartOfDay(y) } } },
  { label: 'Last 7 days', build: () => ({ from: isoStartOfDay(subDays(new Date(), 6)), to: isoStartOfDay(new Date()) }) },
  { label: 'Last 30 days', build: () => ({ from: isoStartOfDay(subDays(new Date(), 29)), to: isoStartOfDay(new Date()) }) },
  { label: 'Last 90 days', build: () => ({ from: isoStartOfDay(subDays(new Date(), 89)), to: isoStartOfDay(new Date()) }) },
  { label: 'This month',  build: () => ({ from: isoStartOfDay(startOfMonth(new Date())), to: isoStartOfDay(new Date()) }) },
  { label: 'Last month',  build: () => {
    const lm = subMonths(new Date(), 1)
    return { from: isoStartOfDay(startOfMonth(lm)), to: isoStartOfDay(endOfMonth(lm)) }
  } },
  { label: 'Last 12 months', build: () => ({ from: isoStartOfDay(subDays(new Date(), 364)), to: isoStartOfDay(new Date()) }) },
]

export default function DateRangePicker({ value, onChange, maxRangeDays }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const popRef  = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  // Popover coordinates (position: fixed). Fixed positioning escapes any
  // ancestor overflow:hidden card that would otherwise clip the calendar.
  // null = not measured yet — popover renders invisible for that first frame.
  const [pos, setPos] = useState<{ top: number; left: number; maxH: number } | null>(null)

  // One month on narrow screens so the popover fits; two on desktop.
  const [months, setMonths] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth < 760 ? 1 : 2)
  useEffect(() => {
    const onResize = () => setMonths(window.innerWidth < 760 ? 1 : 2)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const narrow = months === 1

  // Place the popover under the trigger, clamped to the viewport; flip above
  // when there isn't enough room below. Re-runs on scroll/resize/content growth.
  const place = () => {
    const t = wrapRef.current?.getBoundingClientRect()
    const p = popRef.current
    if (!t || !p) return
    const margin = 8
    const left = Math.max(margin, Math.min(t.left, window.innerWidth - p.offsetWidth - margin))
    const below = window.innerHeight - t.bottom - margin
    const above = t.top - margin
    // scrollHeight = natural content height even while clamped by a previous
    // maxH, so growing room back is picked up on the next placement.
    const ph = p.scrollHeight + 2
    if (ph + margin <= below || below >= above) {
      // Below the trigger. maxH caps to the space actually left under `top`,
      // so a tall calendar scrolls internally instead of running off-screen
      // (position:fixed content can never be reached by page scrolling).
      const top = t.bottom + margin
      setPos({ top, left, maxH: window.innerHeight - top - margin })
    } else {
      // Flip above — same cap against the space above the trigger.
      const h = Math.min(ph, above)
      setPos({ top: Math.max(margin, t.top - margin - h), left, maxH: above })
    }
  }

  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    place()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null
    if (ro && popRef.current) ro.observe(popRef.current)
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      ro?.disconnect()
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, months])

  // Internal "draft" range while the popover is open. Only commits to onChange
  // when user clicks Apply.
  const [draft, setDraft] = useState<DateRange | undefined>(undefined)
  const [rangeError, setRangeError] = useState<string | null>(null)

  const currentRange: DateRange = useMemo(() => ({
    from: parseISOSafe(value.from),
    to:   parseISOSafe(value.to),
  }), [value.from, value.to])

  // Reset draft to current value whenever the popover opens.
  useEffect(() => {
    if (open) {
      setDraft(currentRange)
      setRangeError(null)
    }
  }, [open, currentRange])

  // Outside-click + Escape closes the popover.
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const activePresetLabel = useMemo(() => {
    for (const p of PRESETS) {
      const built = p.build()
      if (built.from === value.from && built.to === value.to) return p.label
    }
    return null
  }, [value])

  const apply = (next: DateRangeValue) => {
    // Presets go through here too — enforce the cap for them as well.
    if (maxRangeDays != null) {
      const spanDays = Math.round((startOfDay(parseISO(next.to)).getTime() - startOfDay(parseISO(next.from)).getTime()) / 86400000) + 1
      if (spanDays > maxRangeDays) {
        setRangeError(`Range too large (${spanDays} days). Max ${maxRangeDays}.`)
        return
      }
    }
    onChange(next)
    setOpen(false)
  }

  const onApplyClick = () => {
    if (!draft?.from) return
    const from = isoStartOfDay(draft.from)
    const to   = isoStartOfDay(draft.to ?? draft.from)
    if (maxRangeDays != null) {
      const spanDays = Math.round((startOfDay(parseISO(to)).getTime() - startOfDay(parseISO(from)).getTime()) / 86400000) + 1
      if (spanDays > maxRangeDays) {
        setRangeError(`Range too large (${spanDays} days). Max ${maxRangeDays}.`)
        return
      }
    }
    apply({ from, to })
  }

  const triggerLabel = formatRangeLabel(value)

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 9,
          padding: '8px 12px',
          background: open ? TEAL_TINT : '#fff',
          border: `1px solid ${open ? TEAL : BORDER}`,
          borderRadius: 8,
          fontSize: 13, fontFamily: "'DM Sans', sans-serif",
          color: TEXT, fontWeight: 500,
          cursor: 'pointer',
          transition: 'border-color 0.15s, background 0.15s',
          minWidth: 240,
        }}
      >
        <CalendarIcon />
        <span style={{ flex: 1, textAlign: 'left' }}>
          {activePresetLabel
            ? <><span style={{ color: TEAL, fontWeight: 600 }}>{activePresetLabel}</span> <span style={{ color: TEXT_MUTED }}>· {triggerLabel}</span></>
            : triggerLabel}
        </span>
        <span style={{
          fontSize: 9, color: TEXT_MUTED,
          transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          transition: 'transform 0.18s',
        }}>▾</span>
      </button>

      {open && (
        <div
          ref={popRef}
          role="dialog"
          aria-label="Choose date range"
          style={{
            position: 'fixed',
            top: pos?.top ?? 0,
            left: pos?.left ?? 0,
            visibility: pos ? 'visible' : 'hidden',
            zIndex: 1000,
            background: '#fff',
            border: `1px solid ${BORDER}`,
            borderRadius: 12,
            boxShadow: '0 12px 32px rgba(15, 23, 42, 0.16), 0 4px 8px rgba(15, 23, 42, 0.06)',
            display: 'grid',
            gridTemplateColumns: narrow ? '1fr' : '160px 1fr',
            overflow: 'hidden auto',
            animation: 'rangePickerFade 0.16s ease',
            minWidth: narrow ? 0 : 600,
            maxWidth: 'calc(100vw - 16px)',
            maxHeight: pos ? pos.maxH : 'calc(100vh - 16px)',
          }}
        >
          <style>{rangePickerCss}</style>

          {/* Preset rail — vertical on desktop; wrapping row on narrow screens */}
          <div style={{
            background: '#fafbfc',
            borderRight: narrow ? 'none' : `1px solid ${BORDER}`,
            borderBottom: narrow ? `1px solid ${BORDER}` : 'none',
            padding: 10,
            display: 'flex',
            flexDirection: narrow ? 'row' : 'column',
            flexWrap: narrow ? 'wrap' : 'nowrap',
            gap: 2,
          }}>
            <div style={{
              fontSize: 9, fontWeight: 700, color: TEXT_MUTED,
              letterSpacing: '0.1em', textTransform: 'uppercase',
              padding: '6px 10px 8px',
              ...(narrow ? { width: '100%' } : {}),
            }}>Quick ranges</div>
            {PRESETS.map((p) => {
              const built = p.build()
              const active = activePresetLabel === p.label
              return (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => apply(built)}
                  style={{
                    textAlign: 'left',
                    padding: '7px 10px',
                    background: active ? TEAL_TINT : 'transparent',
                    color: active ? TEAL : TEXT,
                    border: 'none',
                    borderRadius: 6,
                    fontSize: 12, fontWeight: active ? 600 : 500,
                    fontFamily: "'DM Sans', sans-serif",
                    cursor: 'pointer',
                    transition: 'background 0.12s, color 0.12s',
                  }}
                  onMouseEnter={(e) => { if (!active) (e.currentTarget.style.background = '#f1f3f6') }}
                  onMouseLeave={(e) => { if (!active) (e.currentTarget.style.background = 'transparent') }}
                >{p.label}</button>
              )
            })}
          </div>

          {/* Calendar + footer */}
          <div style={{ padding: 12 }}>
            <DayPicker
              mode="range"
              numberOfMonths={months}
              selected={draft}
              onSelect={(r) => { setDraft(r); setRangeError(null) }}
              showOutsideDays
              weekStartsOn={1}
              className="pw-rdp"
            />

            {rangeError && (
              <div style={{
                marginTop: 8,
                background: '#fef2f2',
                border: '1px solid #fecaca',
                color: '#b91c1c',
                borderRadius: 6,
                padding: '6px 10px',
                fontSize: 12,
              }}>{rangeError}</div>
            )}

            <div style={{
              marginTop: 10, paddingTop: 10,
              borderTop: `1px solid ${BORDER}`,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 12,
            }}>
              <div style={{ fontSize: 12, color: TEXT_SOFT, fontFamily: "'DM Mono', monospace" }}>
                {draft?.from
                  ? `${format(draft.from, 'MMM d, yyyy')}${draft.to ? ` → ${format(draft.to, 'MMM d, yyyy')}` : ''}`
                  : <span style={{ color: TEXT_MUTED }}>Select a range</span>}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  style={ghostBtn}
                >Cancel</button>
                <button
                  type="button"
                  onClick={onApplyClick}
                  disabled={!draft?.from}
                  style={primaryBtn(!draft?.from)}
                >Apply</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Bits ────────────────────────────────────────────────────────────────

function CalendarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={TEAL} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  )
}

const ghostBtn: React.CSSProperties = {
  background: '#fff',
  color: TEXT_SOFT,
  border: `1px solid ${BORDER}`,
  borderRadius: 7,
  padding: '6px 14px',
  fontSize: 12, fontWeight: 500,
  cursor: 'pointer',
  fontFamily: "'DM Sans', sans-serif",
}
const primaryBtn = (disabled: boolean): React.CSSProperties => ({
  background: disabled
    ? '#cbd5e1'
    : `linear-gradient(180deg, ${TEAL} 0%, ${TEAL_LIGHT} 100%)`,
  color: '#fff',
  border: 'none',
  borderRadius: 7,
  padding: '6px 14px',
  fontSize: 12, fontWeight: 600,
  cursor: disabled ? 'not-allowed' : 'pointer',
  fontFamily: "'DM Sans', sans-serif",
  boxShadow: disabled ? 'none' : `0 2px 6px ${TEAL}33`,
  transition: 'transform 0.1s',
})

// react-day-picker v9 ships its own CSS via 'react-day-picker/style.css'.
// We override its CSS variables / class shapes to match the PhysioWard theme.
const rangePickerCss = `
@keyframes rangePickerFade {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}
.pw-rdp {
  --rdp-accent-color: ${TEAL};
  --rdp-accent-background-color: ${TEAL_TINT};
  --rdp-day-height: 34px;
  --rdp-day-width: 34px;
  --rdp-day_button-height: 32px;
  --rdp-day_button-width: 32px;
  --rdp-day_button-border-radius: 8px;
  --rdp-selected-border: 2px solid ${TEAL};
  --rdp-range_middle-color: ${TEAL};
  --rdp-range_middle-background-color: ${TEAL_TINT};
  --rdp-today-color: ${TEAL};
  --rdp-weekday-text-transform: uppercase;
  --rdp-weekday-font: 600 10px/1 'DM Sans', sans-serif;
  --rdp-weekday-opacity: 0.65;
  --rdp-months-gap: 16px;
  --rdp-nav_button-width: 28px;
  --rdp-nav_button-height: 28px;
  --rdp-month_caption-font: 600 13px/1.4 'DM Sans', sans-serif;
  font-family: 'DM Sans', sans-serif;
  margin: 0;
}
.pw-rdp .rdp-month_caption { color: ${TEXT}; padding: 4px 0 8px; }
.pw-rdp .rdp-weekday { color: ${TEXT_MUTED}; padding: 4px 0; }
.pw-rdp .rdp-day { font-size: 12px; color: ${TEXT}; font-family: 'DM Mono', monospace; }
.pw-rdp .rdp-day_button { font-weight: 500; transition: background 0.12s, color 0.12s; }
.pw-rdp .rdp-day_button:hover:not(:disabled) {
  background: ${TEAL_TINT2};
  color: ${TEAL};
}
.pw-rdp .rdp-outside .rdp-day_button { color: ${TEXT_MUTED}; opacity: 0.55; }
.pw-rdp .rdp-today:not(.rdp-selected) .rdp-day_button {
  color: ${TEAL};
  font-weight: 700;
  position: relative;
}
.pw-rdp .rdp-today:not(.rdp-selected) .rdp-day_button::after {
  content: '';
  position: absolute;
  bottom: 3px; left: 50%;
  transform: translateX(-50%);
  width: 4px; height: 4px;
  background: ${TEAL}; border-radius: 50%;
}
.pw-rdp .rdp-selected .rdp-day_button {
  background: ${TEAL_TINT};
  color: ${TEAL};
  font-weight: 700;
  border: none;
}
.pw-rdp .rdp-range_start .rdp-day_button,
.pw-rdp .rdp-range_end .rdp-day_button {
  background: linear-gradient(180deg, ${TEAL} 0%, ${TEAL_LIGHT} 100%);
  color: #fff !important;
  font-weight: 700;
  box-shadow: 0 2px 6px ${TEAL}40;
}
.pw-rdp .rdp-range_middle .rdp-day_button {
  background: ${TEAL_TINT};
  color: ${TEAL};
  border-radius: 0;
}
.pw-rdp .rdp-button_previous,
.pw-rdp .rdp-button_next {
  color: ${TEXT_SOFT};
  border-radius: 6px;
  border: 1px solid ${BORDER};
  background: #fff;
  transition: background 0.12s, border-color 0.12s;
}
.pw-rdp .rdp-button_previous:hover:not(:disabled),
.pw-rdp .rdp-button_next:hover:not(:disabled) {
  background: ${TEAL_TINT};
  border-color: ${TEAL};
  color: ${TEAL};
}
`

// ── Helpers ────────────────────────────────────────────────────────────

function parseISOSafe(iso: string): Date | undefined {
  if (!iso) return undefined
  const d = parseISO(iso)
  return isValid(d) ? d : undefined
}

function formatRangeLabel(v: DateRangeValue): string {
  const f = parseISOSafe(v.from)
  const t = parseISOSafe(v.to)
  if (!f || !t) return 'Pick a date range'
  if (v.from === v.to) return format(f, 'MMM d, yyyy')
  // Same year: "Apr 1 → May 5, 2026"
  if (f.getFullYear() === t.getFullYear()) {
    return `${format(f, 'MMM d')} → ${format(t, 'MMM d, yyyy')}`
  }
  // Different years: full both
  return `${format(f, 'MMM d, yyyy')} → ${format(t, 'MMM d, yyyy')}`
}
