import React from 'react'
import {
  RubricBand, WeeklyKpiDTO,
  MOJO_ALERT_AT_OR_BELOW, EFFECTIVENESS_RUBRIC, MOJO_RUBRIC, rubricBandFor,
  KpiModel, KpiSignal, SignalRating, KpiDrainType,
} from '../../types'
import { LocalScore, bandKeyForScore } from '../../lib/weeklyKpi.score'

/**
 * Shared pieces for Team Performance KPI Reporting — used by the physio's form,
 * the history list, and the super admin's tracker.
 *
 * ── On the visual design (revised 2026-08-24) ──
 * Sam's brief: "minimalist lang, white, flat, tulad sa Apple". The previous cut
 * leaned on dark gradient hero bands, gradient-filled buttons, coloured glows
 * and layered shadows; all of that is gone. What replaces it is one flat system:
 *
 *   * white surfaces on a white page — depth comes from hairlines and spacing,
 *     never from a shadow or a gradient;
 *   * one accent (PhysioWard teal) used only where something is selected or
 *     needs acting on, so colour still means something when it appears;
 *   * type carries the hierarchy — size and weight, not boxes and fills.
 *
 * Every colour in this file is a FLAT value. If a future change needs emphasis,
 * reach for weight, size or whitespace before reaching for a fill.
 *
 * Layout, field order and every piece of wording still follow Sam's build spec
 * exactly — this revision is presentation only.
 */

// ── Tokens, bands and date helpers ───────────────────────────────────
//
// These live in lib/weeklyKpi.format — the exporter needs the same bands and
// the same date wording as this file, and it has no business importing a React
// module to get them. Re-exported here so every page and form keeps importing
// them from weeklyKpi.ui, which is still the one door into this feature's look.

import {
  ACCENT, ACCENT_SOFT, ACCENT_LINE, SURFACE, SURFACE_ALT, BORDER, BORDER_MID,
  TEXT, TEXT_SOFT, TEXT_MUTED, TEXT_FAINT, DANGER, AMBER, TRACK,
  BAND_COLORS, BandKey, bandKeyFor, CLINIC_ORDER,
  localISO, todayISO, addDays, mondayOf, weekLabel, stamp, clinicLabel,
} from '../../lib/weeklyKpi.format'

export {
  ACCENT, ACCENT_SOFT, ACCENT_LINE, SURFACE, SURFACE_ALT, BORDER, BORDER_MID,
  TEXT, TEXT_SOFT, TEXT_MUTED, TEXT_FAINT, DANGER, AMBER, TRACK,
  BAND_COLORS, bandKeyFor, CLINIC_ORDER,
  localISO, todayISO, addDays, mondayOf, weekLabel, stamp, clinicLabel,
}
export type { BandKey }

// ── Shared styles ───────────────────────────────────────────────────────────

export const FONT = "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
export const MONO = "'DM Mono', ui-monospace, SFMono-Regular, monospace"

/** Full-bleed white page surface. Both KPI pages sit on this rather than on the
 *  shell's grey — the whole point of the brief is a white page. */
export const pageSurface: React.CSSProperties = {
  background: SURFACE, minHeight: 'calc(100vh - 62px)', fontFamily: FONT,
}

export const inputStyle: React.CSSProperties = {
  width:'100%', padding:'10px 12px', border:`1px solid ${BORDER_MID}`,
  borderRadius:9, fontSize:13.5, fontFamily:FONT,
  color:TEXT, boxSizing:'border-box', background:SURFACE, outline:'none',
}
export const textareaStyle: React.CSSProperties = {
  ...inputStyle, minHeight:80, resize:'vertical', lineHeight:1.55,
}
export const primaryBtnStyle: React.CSSProperties = {
  background:ACCENT, color:'#fff', border:'1px solid ' + ACCENT, borderRadius:10,
  padding:'12px 22px', fontSize:14, fontWeight:600, cursor:'pointer',
  fontFamily:FONT, letterSpacing:'-0.01em',
}
export const smallBtnStyle: React.CSSProperties = {
  background:SURFACE, color:TEXT, border:`1px solid ${BORDER_MID}`,
  borderRadius:8, padding:'7px 13px', fontSize:12.5, fontWeight:500,
  cursor:'pointer', fontFamily:FONT,
}

/** The small uppercase caption used above every value in this feature. */
export const captionStyle: React.CSSProperties = {
  fontSize:10, fontWeight:600, color:TEXT_MUTED,
  letterSpacing:'0.08em', textTransform:'uppercase',
}

// ── Shells ──────────────────────────────────────────────────────────────────

/** The card shell: white, one hairline, no shadow. */
export function Panel({
  children, style, pad = '20px 22px',
}: {
  children: React.ReactNode
  style?:   React.CSSProperties
  pad?:     string
}) {
  return (
    <div className="pw-panel" style={{
      background:SURFACE, border:`1px solid ${BORDER}`, borderRadius:14,
      padding:pad, ...style,
    }}>{children}</div>
  )
}

/**
 * Every responsive rule this feature needs, in one place.
 *
 * These pages are styled with inline objects — the house style here — and an
 * inline style cannot hold a media query. Rather than scatter a `<style>` block
 * per component, each layout that has to change on a narrow screen carries a
 * `pw-*` class and every breakpoint for the feature lives in this one block,
 * where they can be read against each other.
 *
 * Render it once per page. It is plain global CSS, so a second copy on the same
 * page is harmless — which is why the physio's form and the read-only report
 * each render their own rather than depending on a parent to have done it.
 *
 * Two breakpoints, both chosen from the content:
 *   760px — a signal's sentence and its five rating buttons stop fitting on one
 *           line, and the nine count boxes stop fitting three across.
 *   640px — phone. Anything still in columns goes to one.
 */
export function WeeklyKpiResponsiveStyles() {
  return (
    <style>{`
      /* Per-field labels for the stacked layouts. Off by default: on a wide
         screen the column header above the grid already names these, and
         printing both would label every cell twice.

         They exist because NOTHING may go unlabelled on a phone. A stacked
         column under a header row is unlabelled — the header is three words
         over one column of boxes — and a placeholder is not a label: it
         vanishes the moment the physio types. So on a narrow screen the header
         row is hidden and these take over. Exactly one of the two is on at any
         width. */
      .pw-kpi-fieldlabel,
      .pw-cell-label { display: none !important; }

      @media (max-width: 760px) {
        /* Sentence above, rating buttons below — the buttons keep their full
           size rather than being squeezed into a column that still fits. */
        .pw-signal-row  { grid-template-columns: 1fr !important; gap: 10px !important; }
        .pw-signal-row > div:last-child { justify-content: flex-start !important; }
        .pw-counts-grid { grid-template-columns: 1fr 1fr !important; }
        /* Drain: label over its description instead of a 150px column that
           leaves four words per line. */
        .pw-drain-row   { grid-template-columns: 1fr !important; gap: 6px !important; }
        .pw-detail-kpi  { grid-template-columns: 1fr 70px 70px !important; }
      }

      @media (max-width: 640px) {
        /* The page's own gutters. 24px each side of a 360px screen spends a
           seventh of the width on nothing. */
        .pw-kpi-page    { padding: 22px 14px 64px !important; }
        .pw-panel       { padding: 18px 15px 22px !important; border-radius: 12px !important; }
        .pw-kpi-title   { font-size: 23px !important; }

        /* The three KPI cells stack, so the column header row above them is
           replaced by a label on each field — swapped, not dropped. */
        .pw-kpi-row        { grid-template-columns: 1fr !important; gap: 12px !important; }
        .pw-kpi-head       { display: none !important; }
        .pw-kpi-fieldlabel { display: block !important; margin-bottom: 5px !important; }

        .pw-counts-grid { grid-template-columns: 1fr !important; }

        /* 10 buttons at 40px do not fit 360px; they wrap to two rows either
           way, so shrink them enough to make it five and five. */
        .pw-rating-scale button { width: 30px !important; height: 36px !important; }

        /* Read-only report: the three-column KPI table and the group bars both
           stop being readable at this width. Same swap as the form — the header
           row goes, a label appears on each cell, and the right-aligned numeric
           columns go back to reading left-to-right under their label. */
        .pw-detail-kpi      { grid-template-columns: 1fr !important; gap: 9px !important; }
        .pw-detail-kpi-head { display: none !important; }
        .pw-detail-kpi > div:not(:first-child) { text-align: left !important; }
        .pw-cell-label      { display: block !important; margin-bottom: 3px !important; }
        .pw-breakdown-row   { grid-template-columns: 1fr !important; gap: 4px !important; }
        .pw-breakdown-row > span:last-child { text-align: left !important; }
        .pw-detail-counts   { grid-template-columns: 1fr !important; }
      }
    `}</style>
  )
}

/**
 * The page header — replaces the dark gradient hero both pages used to carry.
 * A large title on white with a hairline under it is what gives the page a top;
 * a coloured band was doing that job with a lot more ink than it needed.
 */
export function PageHeader({
  eyebrow, title, meta, description, right,
}: {
  eyebrow?:     string
  title:        React.ReactNode
  /** The muted line under the title — identity, week, counts. */
  meta?:        React.ReactNode
  description?: string
  right?:       React.ReactNode
}) {
  return (
    <div style={{
      display:'flex', justifyContent:'space-between', alignItems:'flex-end',
      gap:24, flexWrap:'wrap',
      borderBottom:`1px solid ${BORDER}`, paddingBottom:22, marginBottom:24,
    }}>
      <div style={{ minWidth:0, flex:'1 1 320px' }}>
        {eyebrow && <div style={{ ...captionStyle, marginBottom:9 }}>{eyebrow}</div>}
        <h1 className="pw-kpi-title" style={{
          margin:0, fontSize:28, fontWeight:600, color:TEXT,
          letterSpacing:'-0.026em', lineHeight:1.15,
        }}>{title}</h1>
        {meta && (
          <div style={{
            marginTop:8, fontSize:13.5, color:TEXT_MUTED,
            display:'flex', alignItems:'center', gap:8, flexWrap:'wrap',
          }}>{meta}</div>
        )}
        {description && (
          <p style={{
            margin:'12px 0 0', fontSize:13.5, color:TEXT_SOFT,
            lineHeight:1.6, maxWidth:560,
          }}>{description}</p>
        )}
      </div>
      {right}
    </div>
  )
}

/** Section heading inside a panel. No accent bar — weight does the work. */
export function PanelHeader({
  title, subtitle, right,
}: {
  title:     React.ReactNode
  subtitle?: string
  right?:    React.ReactNode
}) {
  return (
    <div style={{
      display:'flex', justifyContent:'space-between', alignItems:'flex-start',
      gap:12, flexWrap:'wrap', marginBottom:18,
    }}>
      <div style={{ minWidth:0 }}>
        <div style={{
          fontSize:16, fontWeight:600, color:TEXT,
          letterSpacing:'-0.015em', lineHeight:1.25,
        }}>{title}</div>
        {subtitle && (
          <div style={{ fontSize:13, color:TEXT_MUTED, marginTop:5, lineHeight:1.5 }}>
            {subtitle}
          </div>
        )}
      </div>
      {right}
    </div>
  )
}

/** Quiet divider label between sections of a read-only report. */
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:12, margin:'0 0 16px' }}>
      <span style={captionStyle}>{children}</span>
      <span style={{ flex:1, height:1, background:BORDER }} />
    </div>
  )
}

// ── Controls ────────────────────────────────────────────────────────────────

/** A labelled field. `hint` is the spec's hint text — it sits under the label
 *  where the physio reads it before answering, not after. */
export function Field({
  label, hint, required, children,
}: {
  label: string
  hint?: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div style={{ marginBottom: 26 }}>
      <label style={{ display:'block', fontSize:14, fontWeight:600, color:TEXT, marginBottom:8, letterSpacing:'-0.01em' }}>
        {label}
        {/* Named rather than starred: an asterisk needs a legend somewhere, and
            this form has more required fields than optional ones. */}
        {required && (
          <span style={{
            marginLeft:9, fontSize:11, fontWeight:500, color:TEXT_MUTED,
            letterSpacing:'0.02em', verticalAlign:'1px',
          }}>Required</span>
        )}
        {hint && (
          <span style={{ display:'block', fontWeight:400, color:TEXT_MUTED, fontSize:13, marginTop:4, lineHeight:1.55 }}>
            {hint}
          </span>
        )}
      </label>
      {children}
    </div>
  )
}

/** One square on the 1–10 scale. Split out so hover can be flat (a border and
 *  a grey fill) instead of the old lift-and-glow. */
function ScoreButton({
  n, on, band, disabled, onClick,
}: {
  n: number
  on: boolean
  band: BandKey
  disabled?: boolean
  onClick: () => void
}) {
  const [hover, setHover] = React.useState(false)
  const fg = BAND_COLORS[band].fg
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={on}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width:40, height:40, borderRadius:10,
        border:`1px solid ${on ? fg : hover && !disabled ? BORDER_MID : BORDER}`,
        background: on ? fg : hover && !disabled ? SURFACE_ALT : SURFACE,
        color: on ? '#fff' : TEXT_SOFT,
        fontSize:14, fontWeight:on ? 600 : 500, fontFamily:MONO,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        transition:'background .12s, border-color .12s, color .12s',
        padding:0,
      }}
    >{n}</button>
  )
}

/** The spec's "Choose one 1-10". Buttons, not a slider or a number box: the
 *  rubric underneath describes discrete bands, and a slider invites a physio to
 *  fiddle toward a number instead of picking the band that describes their week.
 *
 *  The picked number takes its BAND's colour and the band is named beneath it —
 *  as a line of text now, not as a tinted chip. */
export function RatingScale({
  value, onChange, disabled, isMojo,
}: {
  value: number | null
  onChange: (n: number) => void
  disabled?: boolean
  /** Mojo forces the 1-2 band red — it is a welfare signal, not a score. */
  isMojo?: boolean
}) {
  const band = value === null
    ? null
    : rubricBandFor(value, isMojo ? MOJO_RUBRIC : EFFECTIVENESS_RUBRIC)
  const fg = value === null ? null : BAND_COLORS[bandKeyFor(value, isMojo)].fg

  return (
    <div>
      <div className="pw-rating-scale" style={{ display:'flex', gap:7, flexWrap:'wrap' }}>
        {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
          <ScoreButton
            key={n}
            n={n}
            on={value === n}
            band={bandKeyFor(n, isMojo)}
            disabled={disabled}
            onClick={() => onChange(n)}
          />
        ))}
      </div>
      {band && fg && (
        <div style={{ marginTop:10, fontSize:13, color:TEXT_SOFT }}>
          <span style={{ fontWeight:600, color:fg }}>{band.score}</span>
          <span style={{ color:TEXT_FAINT, margin:'0 7px' }}>·</span>
          {band.short}
        </div>
      )}
    </div>
  )
}

/** The scoring rubric. Rendered inline and always visible — spec section 5:
 *  "keep this visible so the scale stays consistent across the team".
 *
 *  `active` highlights the band the current answer falls in, so the physio can
 *  see the sentence they just agreed to rather than counting rows to find it.
 *  The other four bands stay fully readable — dimming them would defeat the
 *  point of keeping the whole rubric on screen. */
export function Rubric({
  bands, active,
}: {
  bands:   readonly RubricBand[]
  active?: number | null
}) {
  return (
    <div style={{
      marginTop:14, border:`1px solid ${BORDER}`, borderRadius:11, overflow:'hidden',
    }}>
      <div style={{
        display:'grid', gridTemplateColumns:'70px 1fr',
        background:SURFACE_ALT, color:TEXT_MUTED,
        fontSize:10, fontWeight:600, letterSpacing:'0.08em', textTransform:'uppercase',
      }}>
        <div style={{ padding:'9px 12px' }}>Score</div>
        <div style={{ padding:'9px 12px' }}>What this looks like</div>
      </div>
      {bands.map((b, i) => {
        const on = active != null && active >= b.min && active <= b.max
        return (
          <div key={b.score} style={{
            display:'grid', gridTemplateColumns:'70px 1fr',
            borderTop:`1px solid ${BORDER}`,
            background: on ? ACCENT_SOFT : SURFACE,
            fontSize:13, lineHeight:1.5,
            transition:'background .15s',
          }}>
            <div style={{
              padding:'10px 12px', fontWeight:600, whiteSpace:'nowrap',
              color: on ? ACCENT : TEXT_MUTED, fontFamily:MONO,
            }}>{b.score}</div>
            <div style={{ padding:'10px 12px', color: on ? TEXT : TEXT_SOFT, fontWeight: on ? 500 : 400 }}>
              {b.meaning}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Yes / No, the spec's required binary. `null` = not answered yet, which is a
 *  distinct state from No and must stay un-preselected: defaulting to No would
 *  quietly answer "do you need a check-in" for someone who never read it. */
export function YesNo({
  value, onChange, disabled,
}: {
  value: boolean | null
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <div style={{ display:'flex', gap:10 }}>
      {[true, false].map(v => {
        const on = value === v
        return (
          <button
            key={String(v)}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => onChange(v)}
            style={{
              flex:'0 1 150px', padding:'12px 0', borderRadius:10,
              border:`1px solid ${on ? ACCENT : BORDER_MID}`,
              background: on ? ACCENT : SURFACE,
              color: on ? '#fff' : TEXT_SOFT,
              fontSize:14, fontWeight: on ? 600 : 500,
              cursor: disabled ? 'not-allowed' : 'pointer',
              fontFamily:FONT,
              opacity: disabled ? 0.4 : 1,
              transition:'background .12s, border-color .12s, color .12s',
            }}
          >{v ? 'Yes' : 'No'}</button>
        )
      })}
    </div>
  )
}

/** Segmented control, iOS-style: a grey track, the selected segment a plain
 *  white tile. No fill, no shadow — the tile alone reads as selected. */
export function PillGroup({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display:'inline-flex', gap:3, background:SURFACE_ALT,
      padding:3, borderRadius:10, flexWrap:'wrap',
    }}>{children}</div>
  )
}

export function PillBtn({
  label, active, onClick, title, disabled = false,
}: {
  label:  React.ReactNode
  active: boolean
  onClick: () => void
  title?: string
  /** Greys the pill out and stops it responding. Added 2026-09-07 for the
   *  Monday tab, which is locked while an older week is still owed. */
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      aria-pressed={active}
      style={{
        background: active ? SURFACE : 'transparent',
        color: active ? ACCENT : TEXT_SOFT,
        border: `1px solid ${active ? BORDER : 'transparent'}`,
        borderRadius:8, padding:'7px 14px',
        fontSize:13, fontWeight: active ? 600 : 500, whiteSpace:'nowrap',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        fontFamily:FONT, letterSpacing:'-0.005em',
        transition:'background .12s, color .12s',
      }}
    >{label}</button>
  )
}

// ── Readouts ────────────────────────────────────────────────────────────────

export function ErrorBanner({ message }: { message: string }) {
  if (!message) return null
  return (
    <div style={{
      background:'#fdf2f1', border:`1px solid #f3d6d3`, color:DANGER,
      borderRadius:10, padding:'11px 14px', fontSize:13.5, marginBottom:18, lineHeight:1.5,
    }}>{message}</div>
  )
}

/** Inline note — a submitted stamp, or "do the Monday half first". */
export function Note({ tone, children }: { tone: 'good' | 'warn'; children: React.ReactNode }) {
  const fg = tone === 'good' ? ACCENT : AMBER
  return (
    <div style={{
      background:SURFACE_ALT, borderRadius:10, padding:'11px 14px',
      fontSize:13, lineHeight:1.55, marginBottom:20, color:TEXT_SOFT,
      borderLeft:`2px solid ${fg}`,
    }}>{children}</div>
  )
}

/** Small status chip — "Open", "Complete", "Check-in", clinic names. Flat fill,
 *  no border: a chip that also has an outline is two shapes doing one job. */
export function Chip({
  text, tone = 'neutral',
}: {
  text: string
  tone?: 'neutral' | 'good' | 'warn' | 'bad'
}) {
  const palette = {
    neutral: { bg:SURFACE_ALT,            fg:TEXT_MUTED },
    good:    { bg:BAND_COLORS.high.tint,  fg:ACCENT     },
    warn:    { bg:BAND_COLORS.mid.tint,   fg:AMBER      },
    bad:     { bg:BAND_COLORS.bad.tint,   fg:DANGER     },
  }[tone]
  return (
    <span style={{
      background:palette.bg, color:palette.fg,
      padding:'3px 10px', borderRadius:7, fontSize:11.5, fontWeight:600,
      whiteSpace:'nowrap', letterSpacing:'-0.005em',
    }}>{text}</span>
  )
}

/**
 * A 1–10 score: the number, a thin proportional bar, and the rubric band it
 * falls in.
 *
 * A column of bare "8/10" pills was the thing making the tracker unreadable —
 * two-digit numbers all look alike, so every cell had to be read. The bar gives
 * the column a shape to scan down, and naming the band means the number carries
 * the rubric's meaning instead of needing to be remembered. Flat fill on a flat
 * track; the old segmented gradient was decoration doing the same job.
 */
export function RatingMeter({
  value, isMojo, label, compact,
}: {
  /** Null while the Friday half — which is what now sets both Effectiveness
   *  and Mojo — has not been submitted yet. */
  value:   number | null
  isMojo?: boolean
  /** Small-caps caption above the meter — omit inside an already-labelled column. */
  label?:  string
  /** Drops the band name; for the narrowest placements. */
  compact?: boolean
}) {
  if (value === null) {
    return (
      <div style={{ minWidth: 0 }}>
        {label && <div style={{ ...captionStyle, marginBottom:6 }}>{label}</div>}
        <div style={{ fontFamily:MONO, fontSize:17, fontWeight:500, color:TEXT_FAINT, lineHeight:1 }}>—</div>
        {!compact && (
          <div style={{ fontSize:11.5, color:TEXT_FAINT, marginTop:6 }}>Not yet closed</div>
        )}
      </div>
    )
  }

  const c    = BAND_COLORS[bandKeyFor(value, isMojo)]
  const band = rubricBandFor(value, isMojo ? MOJO_RUBRIC : EFFECTIVENESS_RUBRIC)
  const critical = isMojo && value <= MOJO_ALERT_AT_OR_BELOW

  return (
    <div style={{ minWidth: 0 }}>
      {label && <div style={{ ...captionStyle, marginBottom:6 }}>{label}</div>}
      <div style={{ display:'flex', alignItems:'baseline', gap:4 }}>
        <span style={{
          fontFamily:MONO, fontSize:17, fontWeight:500, color:TEXT, lineHeight:1,
        }}>{value}</span>
        <span style={{ fontSize:11.5, color:TEXT_FAINT }}>/10</span>
      </div>
      <div aria-hidden style={{
        marginTop:7, height:3, borderRadius:999, background:TRACK,
        width:'100%', maxWidth:96, overflow:'hidden',
      }}>
        <div style={{
          width:`${value * 10}%`, height:'100%', borderRadius:999,
          background:c.fg, transition:'width .25s ease',
        }} />
      </div>
      {!compact && band && (
        <div style={{
          fontSize:11.5, fontWeight: critical ? 600 : 400,
          color: critical ? c.fg : TEXT_MUTED, marginTop:6,
          whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis',
        }} title={band.meaning}>
          {critical ? '⚠ ' : ''}{band.short}
        </div>
      )}
    </div>
  )
}

/** Initials tile. Flat grey — a person's avatar is an identifier here, not an
 *  accent, so it stays out of the colour system entirely. */
export function Avatar({
  name, size = 36, tone = 'neutral',
}: {
  name: string | null
  size?: number
  tone?: 'neutral' | 'amber'
}) {
  // Initials from the first two WORDS where possible ("Emma Sloot" -> ES).
  // Slicing the first two characters gave "EM", which collides constantly on a
  // roster where several physios share a first initial.
  const parts = (name ?? '?').trim().split(/\s+/).filter(Boolean)
  const initials = (parts.length >= 2
    ? parts[0][0] + parts[1][0]
    : (parts[0] ?? '?').slice(0, 2)).toUpperCase()

  const c = tone === 'amber'
    ? { bg: BAND_COLORS.mid.tint, fg: AMBER }
    : { bg: SURFACE_ALT,          fg: TEXT_SOFT }

  return (
    <div aria-hidden style={{
      width:size, height:size, borderRadius:'50%', flexShrink:0,
      background:c.bg, color:c.fg,
      display:'flex', alignItems:'center', justifyContent:'center',
      fontWeight:600, fontSize: Math.round(size * 0.36), letterSpacing:'0.01em',
    }}>{initials}</div>
  )
}

/** Completion ring — how much of the roster is in. Plain SVG; a chart library
 *  for one arc is not worth the weight. */
export function ProgressRing({
  done, total, size = 54, stroke = 4,
}: {
  done:    number
  total:   number
  size?:   number
  stroke?: number
}) {
  const pct  = total > 0 ? Math.min(1, done / total) : 0
  const r    = (size - stroke) / 2
  const circ = 2 * Math.PI * r

  return (
    <div style={{ position:'relative', width:size, height:size, flexShrink:0 }}>
      <svg width={size} height={size} style={{ transform:'rotate(-90deg)' }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={TRACK} strokeWidth={stroke} />
        <circle cx={size/2} cy={size/2} r={r} fill="none"
          stroke={ACCENT} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - pct)}
          style={{ transition:'stroke-dashoffset .4s ease' }} />
      </svg>
      <div style={{
        position:'absolute', inset:0, display:'flex',
        alignItems:'center', justifyContent:'center', color:TEXT,
      }}>
        <span style={{ fontFamily:MONO, fontSize:13, fontWeight:500, lineHeight:1 }}>
          {total > 0 ? Math.round(pct * 100) : 0}%
        </span>
      </div>
    </div>
  )
}

/** Loading state. One thin ring, centred, no card chrome fighting it. */
export function Loading({ text }: { text: string }) {
  return (
    <div style={{ padding:'56px 24px', textAlign:'center' }}>
      <div style={{
        width:24, height:24, margin:'0 auto 14px',
        border:`2px solid ${TRACK}`, borderTopColor:ACCENT,
        borderRadius:'50%', animation:'pwKpiSpin 0.7s linear infinite',
      }} />
      <div style={{ fontSize:13.5, color:TEXT_MUTED }}>{text}</div>
      <style>{`@keyframes pwKpiSpin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}

/** Empty state. A bare line of grey text reads as a broken page; an icon plus a
 *  reason reads as "nothing here yet, and that is expected". */
export function EmptyState({
  title, body, icon,
}: {
  title: string
  body?: string
  icon?: React.ReactNode
}) {
  return (
    <div style={{
      border:`1px solid ${BORDER}`, borderRadius:14, background:SURFACE,
      textAlign:'center', padding:'48px 24px',
    }}>
      <div style={{
        width:44, height:44, borderRadius:'50%', margin:'0 auto 16px',
        background:SURFACE_ALT, display:'flex', alignItems:'center',
        justifyContent:'center', color:TEXT_MUTED,
      }}>
        {icon ?? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="17" rx="2" />
            <path d="M8 2v4M16 2v4M3 10h18" />
          </svg>
        )}
      </div>
      <div style={{ fontSize:15.5, fontWeight:600, color:TEXT, marginBottom:6, letterSpacing:'-0.01em' }}>
        {title}
      </div>
      {body && (
        <div style={{ fontSize:13.5, color:TEXT_MUTED, lineHeight:1.6, maxWidth:420, margin:'0 auto' }}>
          {body}
        </div>
      )}
    </div>
  )
}

// ── Read-only detail ────────────────────────────────────────────────────────

/** One answer, read back. Label above, answer below, hairline between rows —
 *  the tinted wells the previous cut used made every answer look flagged. */
function ReadBlock({ label, value }: { label: string; value: string | null }) {
  return (
    <div style={{ padding:'14px 0', borderTop:`1px solid ${BORDER}` }}>
      <div style={{ ...captionStyle, marginBottom:6 }}>{label}</div>
      {value ? (
        <div style={{ fontSize:14, color:TEXT, lineHeight:1.6, whiteSpace:'pre-wrap' }}>
          {value}
        </div>
      ) : (
        <div style={{ fontSize:13.5, color:TEXT_FAINT }}>Not answered</div>
      )}
    </div>
  )
}

// ── Weekly Check-In: the 30 behaviour signals ───────────────────────────────

/** The four ratings plus N/A, in the order the Effectiveness sheet prints them.
 *  Wording is the sheet's own — the team is being asked these exact sentences,
 *  so a tooltip paraphrase would quietly change the question. */
const RATING_CHOICES: { value: SignalRating; label: string; meaning: string }[] = [
  { value: 3,    label: '3',   meaning: 'Every time — no exceptions this week' },
  { value: 2,    label: '2',   meaning: 'Most times — one or two misses I can name' },
  { value: 1,    label: '1',   meaning: 'Some of the time. Inconsistent.' },
  { value: 0,    label: '0',   meaning: 'Rarely, or not at all' },
  { value: null, label: 'N/A', meaning: 'Did not arise this week' },
]

/** The 0/1/2/3/N/A legend, printed once above the signals rather than repeated
 *  on thirty rows. */
export function RatingLegend() {
  return (
    <div style={{ border:`1px solid ${BORDER}`, borderRadius:11, overflow:'hidden', marginBottom:22 }}>
      <div style={{
        display:'grid', gridTemplateColumns:'62px 1fr',
        background:SURFACE_ALT, color:TEXT_MUTED,
        fontSize:10, fontWeight:600, letterSpacing:'0.08em', textTransform:'uppercase',
      }}>
        <div style={{ padding:'9px 12px' }}>Rating</div>
        <div style={{ padding:'9px 12px' }}>What it means</div>
      </div>
      {RATING_CHOICES.map(c => (
        <div key={c.label} style={{
          display:'grid', gridTemplateColumns:'62px 1fr',
          borderTop:`1px solid ${BORDER}`, fontSize:13, lineHeight:1.5,
        }}>
          <div style={{ padding:'9px 12px', fontFamily:MONO, fontWeight:600, color:TEXT_MUTED }}>
            {c.label}
          </div>
          <div style={{ padding:'9px 12px', color:TEXT_SOFT }}>{c.meaning}</div>
        </div>
      ))}
    </div>
  )
}

/** One 0/1/2/3/N/A button. Flat: a border and a fill, no lift and no glow. */
function SignalChoice({
  choice, on, onClick,
}: {
  choice: { value: SignalRating; label: string; meaning: string }
  on:     boolean
  onClick: () => void
}) {
  const [hover, setHover] = React.useState(false)
  // N/A is deliberately not on the teal ramp: it is not a good answer or a bad
  // one, and colouring it like a 3 would invite it as the easy click.
  const fg = choice.value === null
    ? TEXT_MUTED
    : BAND_COLORS[choice.value === 3 ? 'high' : choice.value === 2 ? 'good' : choice.value === 1 ? 'low' : 'bad'].fg

  return (
    <button
      type="button"
      aria-pressed={on}
      title={choice.meaning}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        minWidth: choice.value === null ? 46 : 36, height:34, borderRadius:9,
        border:`1px solid ${on ? fg : hover ? BORDER_MID : BORDER}`,
        background: on ? fg : hover ? SURFACE_ALT : SURFACE,
        color: on ? '#fff' : TEXT_SOFT,
        fontSize:13, fontWeight: on ? 600 : 500, fontFamily:MONO,
        cursor:'pointer', padding:'0 8px',
        transition:'background .12s, border-color .12s, color .12s',
      }}
    >{choice.label}</button>
  )
}

/**
 * One signal: the sentence and the five buttons.
 *
 * Unanswered is a real state and stays visibly unanswered — nothing is
 * preselected. Defaulting to 3 would flatter every score; defaulting to N/A
 * would shrink every denominator. Both are worse than an empty row the physio
 * can see they still owe an answer to.
 */
export function SignalRow({
  signal, value, onChange,
}: {
  signal:   KpiSignal
  value:    SignalRating | undefined
  onChange: (v: SignalRating) => void
}) {
  const answered = value !== undefined
  return (
    <div
      className="pw-signal-row"
      style={{
        display:'grid', gridTemplateColumns:'1fr auto', gap:16, alignItems:'center',
        padding:'13px 0', borderTop:`1px solid ${BORDER}`,
      }}
    >
      <div style={{ fontSize:13.5, lineHeight:1.55, color: answered ? TEXT : TEXT_SOFT }}>
        {signal.text}
      </div>
      <div style={{ display:'flex', gap:6, flexWrap:'wrap', justifyContent:'flex-end' }}>
        {RATING_CHOICES.map(c => (
          <SignalChoice
            key={c.label}
            choice={c}
            on={answered && value === c.value}
            onClick={() => onChange(c.value)}
          />
        ))}
      </div>
    </div>
  )
}

/** One of the five groups: its name, what it drives, its weight, and its rows. */
export function SignalGroupPanel({
  group, signals, answers, onChange, pct,
}: {
  group:    { group_id: string; name: string; drives: string; group_weight: number }
  signals:  KpiSignal[]
  answers:  Record<string, SignalRating | undefined>
  onChange: (signalId: string, v: SignalRating) => void
  /** This group's earned share, 0-1, or null when it is fully N/A. */
  pct:      number | null
}) {
  const answered = signals.filter(s => answers[s.signal_id] !== undefined).length
  return (
    <div style={{ marginBottom:30 }}>
      <div style={{
        display:'flex', alignItems:'baseline', justifyContent:'space-between',
        gap:16, flexWrap:'wrap', marginBottom:2,
      }}>
        <h3 style={{ margin:0, fontSize:15.5, fontWeight:600, color:TEXT, letterSpacing:'-0.01em' }}>
          {group.name}
        </h3>
        <span style={{ fontSize:12, color:TEXT_MUTED, fontFamily:MONO }}>
          {Math.round(group.group_weight * 100)}% of the score
          <span style={{ color:TEXT_FAINT, margin:'0 6px' }}>·</span>
          {answered}/{signals.length} answered
          {pct !== null && (
            <>
              <span style={{ color:TEXT_FAINT, margin:'0 6px' }}>·</span>
              {Math.round(pct * 100)}%
            </>
          )}
        </span>
      </div>
      <div style={{ fontSize:12.5, color:TEXT_MUTED, marginBottom:6 }}>
        Drives: {group.drives}
      </div>
      {signals.map(s => (
        <SignalRow
          key={s.signal_id}
          signal={s}
          value={answers[s.signal_id]}
          onChange={v => onChange(s.signal_id, v)}
        />
      ))}
    </div>
  )
}

/**
 * The live score, as the physio fills the form in.
 *
 * Explicitly labelled a preview. The server recomputes from the raw ratings on
 * submit and its number is the one stored, so a client that ever drifts must
 * not be able to look authoritative here.
 */
export function ScoreSummary({ model, score }: { model: KpiModel; score: LocalScore }) {
  const fg = BAND_COLORS[bandKeyForScore(score.band_id)].fg
  const pctDone = Math.round((score.answered / Math.max(score.total, 1)) * 100)

  return (
    <div style={{
      border:`1px solid ${BORDER}`, borderRadius:12, padding:'18px 20px', marginBottom:24,
      background:SURFACE,
    }}>
      <div style={{ display:'flex', alignItems:'baseline', gap:14, flexWrap:'wrap' }}>
        <div style={{ ...captionStyle }}>Effectiveness</div>
        <div style={{ fontSize:30, fontWeight:600, fontFamily:MONO, color:fg, letterSpacing:'-0.02em' }}>
          {score.score === null ? '—' : score.score.toFixed(1)}
          <span style={{ fontSize:15, color:TEXT_FAINT, fontWeight:500 }}> / 10</span>
        </div>
        {score.band_label && (
          <div style={{ fontSize:13.5, color:TEXT_SOFT }}>{score.band_label}</div>
        )}
      </div>

      {/* Progress, not a score bar — it says how much of the form is done. */}
      <div style={{
        height:4, borderRadius:2, background:TRACK, overflow:'hidden', margin:'14px 0 9px',
      }}>
        <div style={{ width:`${pctDone}%`, height:'100%', background:ACCENT, transition:'width .18s' }} />
      </div>
      <div style={{ fontSize:12.5, color:TEXT_MUTED, lineHeight:1.6 }}>
        {score.answered} of {score.total} rated
        <span style={{ color:TEXT_FAINT, margin:'0 7px' }}>·</span>
        {score.na_count} N/A
        {score.na_count >= model.na_count_review_at && (
          <span style={{ color:AMBER, fontWeight:500 }}>
            {' '}— a high N/A count shrinks the denominator, so Sam is asked to review it
          </span>
        )}
      </div>

      {score.standards_missed.length > 0 && (
        <div style={{ marginTop:12, fontSize:13, color:DANGER, lineHeight:1.55 }}>
          <strong style={{ fontWeight:600 }}>
            {score.standards_missed.length} Standard{score.standards_missed.length === 1 ? '' : 's'} rated 0 or 1.
          </strong>{' '}
          These go into your reflection with a plan attached.
        </div>
      )}
      {score.standards_na.length > 0 && (
        <div style={{ marginTop:8, fontSize:12.5, color:AMBER, lineHeight:1.55 }}>
          {score.standards_na.length} Standard{score.standards_na.length === 1 ? '' : 's'} marked N/A.
          A Standard is expected every week — fine if it genuinely did not arise.
        </div>
      )}

      <div style={{ marginTop:12, fontSize:11.5, color:TEXT_FAINT, lineHeight:1.5 }}>
        Live preview from model {model.model_version}. The final score is calculated
        on the server when you submit.
      </div>
    </div>
  )
}

/**
 * Mojo question 2 — the drain type(s). Multi-select since 2026-09-04 (a week
 * is often more than one kind of drain), with "No drain" exclusive: picking it
 * clears any other selection, and picking a real drain while "No drain" is
 * selected replaces it. One column of options, each with its signs and its
 * first action, because the sheet's point is that "the wrong strategy on the
 * right drain does nothing": picking blind from five bare labels would lose
 * exactly the part that makes the answer useful.
 */
export function DrainPicker({
  types, value, onChange,
}: {
  types:    KpiDrainType[]
  value:    string[]
  onChange: (t: string[]) => void
}) {
  const toggle = (type: string) => {
    if (type === 'none') {
      onChange(value.includes('none') ? [] : ['none'])
      return
    }
    const withoutNone = value.filter(v => v !== 'none')
    onChange(
      withoutNone.includes(type)
        ? withoutNone.filter(v => v !== type)
        : [...withoutNone, type]
    )
  }

  return (
    <div style={{ border:`1px solid ${BORDER}`, borderRadius:11, overflow:'hidden' }}>
      {types.map((t, i) => {
        const on = value.includes(t.type)
        return (
          <button
            key={t.type}
            type="button"
            className="pw-drain-row"
            aria-pressed={on}
            onClick={() => toggle(t.type)}
            style={{
              display:'grid', gridTemplateColumns:'150px 1fr', gap:14, width:'100%',
              textAlign:'left', padding:'13px 14px', cursor:'pointer',
              border:'none', borderTop: i === 0 ? 'none' : `1px solid ${BORDER}`,
              background: on ? ACCENT_SOFT : SURFACE,
              fontFamily:'inherit',
            }}
          >
            <span style={{
              fontSize:13.5, fontWeight:600, color: on ? ACCENT : TEXT,
              display:'flex', alignItems:'center', gap:9,
            }}>
              <span style={{
                width:15, height:15, borderRadius:4, flexShrink:0,
                border:`1px solid ${on ? ACCENT : BORDER_MID}`,
                background: on ? ACCENT : SURFACE,
                display:'inline-flex', alignItems:'center', justifyContent:'center',
                color:'#fff', fontSize:9, lineHeight:1,
              }}>{on ? '✓' : ''}</span>
              {t.label}
            </span>
            <span style={{ fontSize:12.5, color:TEXT_SOFT, lineHeight:1.55 }}>
              {t.signs}
              {on && (
                <span style={{ display:'block', marginTop:6, color:ACCENT, fontWeight:500 }}>
                  Where to start: {t.first_action}
                </span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** One numeric count. Blank stays blank: a physio who does not know a number
 *  must be able to leave it empty rather than type a 0 that reads as a real
 *  tally of zero. */
export function CountField({
  label, hint, value, onChange, warn,
}: {
  label:    string
  hint?:    string
  value:    string
  onChange: (v: string) => void
  /** Set when this number contradicts another one. Warns, never blocks. */
  warn?:    boolean
}) {
  return (
    <label style={{ display:'block' }}>
      <span style={{ display:'block', fontSize:13, fontWeight:500, color:TEXT, marginBottom:5 }}>
        {label}
      </span>
      {hint && (
        <span style={{ display:'block', fontSize:11.5, color:TEXT_MUTED, marginBottom:6, lineHeight:1.45 }}>
          {hint}
        </span>
      )}
      <input
        type="number"
        min={0}
        inputMode="numeric"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="—"
        style={{
          ...inputStyle,
          fontFamily:MONO,
          borderColor: warn ? AMBER : BORDER,
        }}
      />
    </label>
  )
}

/** The drain type as a person reads it. Falls back to the raw value rather than
 *  hiding an answer the client does not recognise — a stored 'no_drain' from a
 *  stray import should be visible, not silently blank. */
const DRAIN_LABELS: Record<string, string> = {
  physical:   'Physical — sleep, fuel, movement, breaks',
  emotional:  'Emotional — a hard case, an outcome, something outside work',
  mental:     'Mental — admin backlog, decision fatigue, open loops',
  relational: 'Relational — team friction, a conflict, something unsaid',
  none:       'No drain — a good week',
}

/** Multi-select since 2026-09-04 — joins every picked drain's label. Also
 *  accepts a lone string so a pre-migration row (or a stale caller) still
 *  renders instead of falling through to null. */
export function drainLabel(type: string[] | string | null): string | null {
  if (!type) return null
  const types = Array.isArray(type) ? type : [type]
  if (types.length === 0) return null
  return types.map(t => DRAIN_LABELS[t] ?? t).join('; ')
}

/**
 * The score breakdown on a submitted week: the computed score, its band, the
 * five group percentages, and the two counts Sam acts on.
 *
 * Renders NOTHING for a week that predates the signal model. Those rows carry
 * only the physio's hand-picked 1-10, which the meters above already show; a
 * breakdown of dashes would read as missing data rather than as a week that was
 * never scored this way.
 */
export function EffectivenessBreakdown({
  report, model,
}: {
  report: WeeklyKpiDTO
  /** The model this week was SCORED under — the caller resolves it from
   *  `report.effectiveness.model_version`, not from whatever is current. Null
   *  while it loads, or when this build does not know that version (a rollback
   *  can leave rows from a newer deploy): the stored numbers still render, the
   *  group names and band label simply do not. A missing explanation is better
   *  than one taken from the wrong model. */
  model: KpiModel | null
}) {
  const e = report.effectiveness

  if (e.effectiveness_score === null) return null

  const fg = BAND_COLORS[bandKeyForScore(e.band_id)].fg
  const bandText = model?.bands.find(b => b.band_id === e.band_id)?.label ?? e.band_id

  return (
    <div style={{
      border:`1px solid ${BORDER}`, borderRadius:12, padding:'16px 18px', margin:'4px 0 22px',
    }}>
      <div style={{ display:'flex', alignItems:'baseline', gap:13, flexWrap:'wrap' }}>
        <span style={captionStyle}>Effectiveness · 30 behaviours</span>
        <span style={{ fontSize:24, fontWeight:600, fontFamily:MONO, color:fg, letterSpacing:'-0.02em' }}>
          {e.effectiveness_score.toFixed(1)}
          <span style={{ fontSize:13, color:TEXT_FAINT, fontWeight:500 }}> / 10</span>
        </span>
        {bandText && <span style={{ fontSize:13, color:TEXT_SOFT }}>{bandText}</span>}
      </div>

      {/* Per-group bars. A fully-N/A group prints "N/A" instead of a 0% bar —
          its weight was redistributed, so a zero-length bar would be a lie. */}
      <div style={{ marginTop:14, display:'grid', gap:8 }}>
        {(model?.groups ?? []).map(g => {
          const pct = e.group_pcts?.[g.group_id] ?? null
          return (
            <div key={g.group_id} className="pw-breakdown-row" style={{
              display:'grid', gridTemplateColumns:'minmax(120px, 200px) 1fr 46px',
              gap:12, alignItems:'center',
            }}>
              <span style={{ fontSize:12.5, color:TEXT_SOFT }}>{g.name}</span>
              <span style={{ height:4, borderRadius:2, background:TRACK, overflow:'hidden' }}>
                {pct !== null && (
                  <span style={{
                    display:'block', width:`${Math.round(pct * 100)}%`, height:'100%', background:fg,
                  }} />
                )}
              </span>
              <span style={{ fontSize:12, fontFamily:MONO, color:TEXT_MUTED, textAlign:'right' }}>
                {pct === null ? 'N/A' : `${Math.round(pct * 100)}%`}
              </span>
            </div>
          )
        })}
      </div>

      <div style={{ marginTop:13, fontSize:12.5, color:TEXT_MUTED, lineHeight:1.6 }}>
        {e.na_count ?? 0} of 30 marked N/A
        {(e.standards_missed ?? 0) > 0 && (
          <>
            <span style={{ color:TEXT_FAINT, margin:'0 7px' }}>·</span>
            <span style={{ color:DANGER, fontWeight:600 }}>
              {e.standards_missed} Standard{e.standards_missed === 1 ? '' : 's'} missed
            </span>
          </>
        )}
        {(e.standards_na ?? 0) > 0 && (
          <>
            <span style={{ color:TEXT_FAINT, margin:'0 7px' }}>·</span>
            <span style={{ color:AMBER }}>
              {e.standards_na} Standard{e.standards_na === 1 ? '' : 's'} N/A
            </span>
          </>
        )}
        {e.model_version && (
          <>
            <span style={{ color:TEXT_FAINT, margin:'0 7px' }}>·</span>
            <span style={{ color:TEXT_FAINT }}>model {e.model_version}</span>
          </>
        )}
      </div>
    </div>
  )
}

/** The nine self-reported counts. Hidden entirely when the physio filled none
 *  of them in, rather than printing a grid of dashes. */
export function WeeklyCountsBlock({ counts }: { counts: WeeklyKpiDTO['counts'] }) {
  const rows: { label: string; value: number | null }[] = [
    { label: 'Initials seen',           value: counts.initials_seen },
    { label: 'Full recommendations',    value: counts.recommendations_full },
    { label: 'Plans accepted — full',   value: counts.plans_accepted_full },
    { label: 'Plans accepted — part',   value: counts.plans_accepted_part },
    { label: 'Consults recorded',       value: counts.consults_recorded },
    { label: 'Follow-up calls due',     value: counts.calls_due },
    { label: 'Follow-up calls made',    value: counts.calls_made },
    { label: 'Dropouts contacted',      value: counts.dropouts_contacted },
    { label: 'Cancellations / no-shows', value: counts.cancellations_noshows },
  ]
  const filled = rows.filter(r => r.value !== null)
  if (filled.length === 0) return null

  return (
    <div style={{ marginBottom:22 }}>
      <div style={{ ...captionStyle, marginBottom:9 }}>The week in numbers · self-reported</div>
      <div className="pw-detail-counts" style={{
        display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(168px, 1fr))', gap:'2px 0',
        border:`1px solid ${BORDER}`, borderRadius:11, overflow:'hidden',
      }}>
        {filled.map(r => (
          <div key={r.label} style={{
            display:'flex', alignItems:'baseline', justifyContent:'space-between', gap:10,
            padding:'10px 13px', borderBottom:`1px solid ${BORDER}`,
          }}>
            <span style={{ fontSize:12.5, color:TEXT_SOFT }}>{r.label}</span>
            <span style={{ fontSize:14, fontFamily:MONO, fontWeight:600, color:TEXT }}>{r.value}</span>
          </div>
        ))}
      </div>
      {/* Said once, here, so nobody builds a report on these by mistake: four of
          these nine have an authoritative source elsewhere in this app. */}
      <div style={{ fontSize:11.5, color:TEXT_FAINT, marginTop:8, lineHeight:1.5 }}>
        The physio's own count of their week. Case acceptance and cancellation reporting
        stay sourced from the case-acceptance entries and Nookal — these are the cross-check.
      </div>
    </div>
  )
}

/**
 * One report in full, read-only. This is the spec's "available by clicking into
 * that person's row" — the tracker's main table deliberately carries only the
 * scan columns, and everything else lives here (section 8's column trade-off).
 * Same component for the physio reading back their own past week.
 */
export function WeeklyKpiDetail({
  report, compact, model,
}: {
  report: WeeklyKpiDTO
  /** Drops the scores + check-in block and the week in the section label.
   *  For the drawer, whose header already carries all three — repeating them a
   *  few pixels apart is noise, not emphasis. */
  compact?: boolean
  /** The model THIS report was scored under. The container fetches it (see
   *  useKpiModel) — this file renders what it is handed and never does I/O. */
  model?: KpiModel | null
}) {
  const closed = report.friday_submitted_at !== null
  const kpis   = report.kpis.filter(k => k.name || k.target || k.result)

  return (
    <div style={{ maxWidth: 860 }}>
      {/* Rendered here as well as on the form: this report is also shown inside
          the drawer, which opens from the tracker — a page that never mounts
          the form. Duplicate global CSS is harmless; a report with no
          breakpoints on a phone is not. */}
      <WeeklyKpiResponsiveStyles />

      <SectionLabel>{compact ? 'Monday' : `Monday · ${weekLabel(report.week_start)}`}</SectionLabel>

      {/* KPI table — name / target / result, exactly the spec's three rows.
          Rows the physio left entirely blank are dropped rather than rendered
          as three dashes. */}
      {kpis.length > 0 && (
        <div style={{
          marginBottom:22, border:`1px solid ${BORDER}`, borderRadius:11,
          overflow:'hidden', maxWidth:580,
        }}>
          {/* Column headers for the wide layout only. On a phone the row
              stacks, so each cell carries its own label instead (pw-cell-label
              below) — the labels move, they never disappear. */}
          <div className="pw-detail-kpi pw-detail-kpi-head" style={{
            display:'grid', gridTemplateColumns:'1fr 88px 88px', gap:8,
            padding:'9px 14px', background:SURFACE_ALT, color:TEXT_MUTED,
            fontSize:10, fontWeight:600, letterSpacing:'0.08em', textTransform:'uppercase',
          }}>
            <div>KPI · previous week</div>
            <div style={{ textAlign:'right' }}>Target</div>
            <div style={{ textAlign:'right' }}>Result</div>
          </div>
          {kpis.map((k, i) => (
            <div key={i} className="pw-detail-kpi" style={{
              display:'grid', gridTemplateColumns:'1fr 88px 88px', gap:8,
              padding:'11px 14px', fontSize:13.5, color:TEXT,
              borderTop:`1px solid ${BORDER}`,
            }}>
              <div style={{ fontWeight:500 }}>
                <span className="pw-cell-label" style={captionStyle}>KPI · previous week</span>
                {k.name || <span style={{ color:TEXT_FAINT, fontWeight:400 }}>—</span>}
              </div>
              <div style={{ fontFamily:MONO, textAlign:'right', color:TEXT_MUTED }}>
                <span className="pw-cell-label" style={captionStyle}>Target</span>
                {k.target || <span style={{ color:TEXT_FAINT }}>—</span>}
              </div>
              <div style={{ fontFamily:MONO, textAlign:'right' }}>
                <span className="pw-cell-label" style={captionStyle}>Result</span>
                {k.result || <span style={{ color:TEXT_FAINT }}>—</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {!compact && (
        <div style={{ display:'flex', gap:36, flexWrap:'wrap', marginBottom:8 }}>
          <RatingMeter value={report.effectiveness_rating} label="Effectiveness" />
          <RatingMeter value={report.mojo_rating} isMojo label="Mojo (energy)" />
          <div>
            <div style={{ ...captionStyle, marginBottom:7 }}>15-min check-in</div>
            <Chip
              text={report.checkin_needed ? '⚑ Requested' : 'Not needed'}
              tone={report.checkin_needed ? 'warn' : 'neutral'}
            />
          </div>
        </div>
      )}

      {/* The Weekly Check-In score breakdown. Rendered only when this week was
          actually scored against the signal model — a week submitted before it
          existed shows the hand-picked rating above and nothing here, rather
          than a row of dashes pretending to be a breakdown. */}
      <EffectivenessBreakdown report={report} model={model ?? null} />

      <div style={{ marginTop: compact ? 0 : 14 }}>
        <ReadBlock label="Intention for the week" value={report.intention} />
        <ReadBlock label="If the goal was not hit — actions" value={report.missed_goal_actions} />
        <ReadBlock label="Case to discuss at the meeting"    value={report.case_to_discuss} />
        <ReadBlock label="What help is needed" value={report.help_needed} />
        {report.checkin_needed && (
          <ReadBlock label="Check-in focus" value={report.checkin_focus} />
        )}
      </div>

      <WeeklyCountsBlock counts={report.counts} />

      <div style={{ fontSize:12, color:TEXT_FAINT, margin:'14px 0 28px' }}>
        Monday submitted {stamp(report.monday_submitted_at)}
      </div>

      <SectionLabel>Friday · close the loop</SectionLabel>
      {!closed ? (
        <div style={{ fontSize:13.5, color:AMBER, lineHeight:1.55 }}>
          Still open — the Friday half has not been submitted for this week.
        </div>
      ) : (
        <>
          <div style={{ marginBottom:4 }}>
            <div style={{ ...captionStyle, marginBottom:7 }}>
              Achieved the Monday intention
            </div>
            <Chip
              text={report.goal_achieved ? 'Yes' : 'No'}
              tone={report.goal_achieved ? 'good' : 'warn'}
            />
          </div>
          <div style={{ marginTop:14 }}>
{/* Mojo questions 2 and 3 — on this half since 2026-09-07, next to
                the rating they explain. Never presented as part of the score:
                the sheet is explicit that a Mojo number is a thermometer, not
                a rating. */}
            <ReadBlock label="Kind of drain this week" value={drainLabel(report.mojo_drain)} />
            <ReadBlock label="One thing to do next week — and when" value={report.mojo_action} />
            <ReadBlock label="What went well this week" value={report.wins} />
            {report.goal_achieved === false && (
              <ReadBlock label="Why the goal was missed — reflection" value={report.goal_reflection} />
            )}
            {/* The reflection block. `flag` is the flag_for_sam below — one
                field, not two under different names. */}
            <ReadBlock label="Behaviour that made the biggest difference" value={report.best_behaviour} />
            <ReadBlock label="What slipped" value={report.slipped} />
            <ReadBlock label="Commitment for next week" value={report.commitment} />
            {/* Addressed to the ROLE, not to a person. The column is still
                called flag_for_sam — renaming it would be a migration for a
                label — but everything the team reads says "super admin", so the
                form does not have to be re-worded if the account behind that
                role ever changes hands. */}
            <ReadBlock label="Flagged" value={report.flag_for_sam} />
          </div>
          <div style={{ fontSize:12, color:TEXT_FAINT, marginTop:14 }}>
            Friday submitted {stamp(report.friday_submitted_at!)}
          </div>
        </>
      )}
    </div>
  )
}
