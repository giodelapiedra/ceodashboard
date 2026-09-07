import { ClinicId, CLINIC_LABEL, MOJO_ALERT_AT_OR_BELOW } from '../types'

/**
 * The non-visual half of Team Performance KPI Reporting: colour tokens, the
 * score bands, and the local-date helpers.
 *
 * Split out of weeklyKpi.ui (2026-08-31) when the Excel export needed the same
 * band thresholds and the same week/stamp wording as the tracker page. The
 * alternative was a second copy of both in lib/, which is exactly how a "6" ends
 * up amber on screen and green in the file.
 *
 * Nothing here imports React, so a non-component module (the exporter) can use
 * it without a components -> lib dependency pointing the wrong way. weeklyKpi.ui
 * re-exports every name below, so the pages and the form still import them from
 * the one place they always have.
 */

// ── Tokens ──────────────────────────────────────────────────────────────────
// Neutrals are the Apple system greys; the accent stays PhysioWard teal so the
// feature is still recognisably this product.

export const ACCENT      = '#0f6e56'   // the one accent — selection + action
export const ACCENT_SOFT = '#f1f7f5'   // faintest wash, for a selected row only
export const ACCENT_LINE = '#dceae5'
export const SURFACE     = '#ffffff'
export const SURFACE_ALT = '#f5f5f7'   // grey fill: tracks, table heads, segments
export const BORDER      = '#e6e6ea'   // hairline
export const BORDER_MID  = '#d2d2d7'   // hairline that has to be seen
export const TEXT        = '#1d1d1f'
export const TEXT_SOFT   = '#515154'
export const TEXT_MUTED  = '#86868b'
export const TEXT_FAINT  = '#b0b0b6'
export const DANGER      = '#c0342b'
export const AMBER       = '#9a6700'
export const TRACK       = '#e8e8ed'

/** Per-band accent — one flat colour each, no gradients and no glows. The ramp
 *  runs teal → amber → red so a score's colour reads as a direction, not as
 *  five unrelated hues. `tint` is only ever used behind small text. */
export const BAND_COLORS = {
  high: { fg: '#0f6e56', tint: '#f1f7f5' },
  good: { fg: '#2f8f74', tint: '#f2f8f6' },
  mid:  { fg: '#9a6700', tint: '#fbf6ec' },
  low:  { fg: '#b4530f', tint: '#fcf4ee' },
  bad:  { fg: '#c0342b', tint: '#fdf2f1' },
} as const
export type BandKey = keyof typeof BAND_COLORS

/** Which accent a 1–10 score gets. Mojo at or below the rubric's "talk to me
 *  now" threshold is forced red regardless of where the numeric bands fall —
 *  that band is a welfare signal, not a performance score. */
export function bandKeyFor(score: number, isMojo?: boolean): BandKey {
  if (isMojo && score <= MOJO_ALERT_AT_OR_BELOW) return 'bad'
  if (score >= 9) return 'high'
  if (score >= 7) return 'good'
  if (score >= 5) return 'mid'
  if (score >= 3) return 'low'
  return 'bad'
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

// ── Date helpers ────────────────────────────────────────────────────────────
// Local-date only. Never toISOString() — that is UTC, and in Sydney it reports
// yesterday for anything before ~10am.

export function localISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
export function todayISO(): string { return localISO(new Date()) }

/** Midday parse so no DST shift can move the day. */
function parse(iso: string): Date { return new Date(`${iso}T12:00:00`) }

export function addDays(iso: string, n: number): string {
  const d = parse(iso); d.setDate(d.getDate() + n); return localISO(d)
}

/** Monday of the ISO week containing `iso`. Sunday belongs to the week that is
 *  ending, so it maps back six days — same rule as the server. */
export function mondayOf(iso: string): string {
  const d = parse(iso)
  const dow = d.getDay()
  d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow))
  return localISO(d)
}

/** "Aug 18–24, 2026" — the week as a person reads it. */
export function weekLabel(monday: string): string {
  const s = parse(monday), e = parse(addDays(monday, 6))
  const sm = MONTHS[s.getMonth()], sd = s.getDate(), sy = s.getFullYear()
  const em = MONTHS[e.getMonth()], ed = e.getDate(), ey = e.getFullYear()
  if (sy !== ey) return `${sm} ${sd}, ${sy} – ${em} ${ed}, ${ey}`
  if (sm === em) return `${sm} ${sd}–${ed}, ${sy}`
  return `${sm} ${sd} – ${em} ${ed}, ${sy}`
}

export function stamp(isoTimestamp: string): string {
  const d = new Date(isoTimestamp)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} · ${
    d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })}`
}

/** The order the three clinics are always listed in — the pilot order, and the
 *  order the tracker groups by. One copy: the page and the Excel export must
 *  not be able to disagree about it. */
export const CLINIC_ORDER: ClinicId[] = ['newport', 'narrabeen', 'brookvale']

export function clinicLabel(id: ClinicId | string | null): string {
  return id && id in CLINIC_LABEL ? CLINIC_LABEL[id as ClinicId] : '—'
}
