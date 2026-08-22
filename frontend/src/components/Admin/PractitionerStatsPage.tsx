import React, { useEffect, useState, useCallback } from 'react'
import {
  practitionerStatsApi,
  PractitionerStatsReport,
  PractitionerWeekStats,
  Metric,
  Zone,
  OccupancySyncResponse,
} from '../../api/practitionerStats.api'
import { toast } from '../../store/toast.store'
import { ClinicId, CLINIC_LABEL } from '../../types'
import AppShell from '../shared/AppShell'

const TEAL      = '#0f6e56'
const TEXT      = '#111827'
const TEXT_SOFT = '#4b5563'
const TEXT_MUTE = '#9ca3af'
const BORDER    = '#e5e7eb'

// Zone palette. Checked for colour-vision separation against a white surface
// before use, and each zone also carries a glyph below so the state never
// depends on colour alone (print, CVD, forced-colors).
const ZONE: Record<Zone, { fg: string; bg: string; glyph: string; label: string }> = {
  thriving: { fg: '#0a8a72', bg: '#e6f4f0', glyph: '▲', label: 'Thriving'   },
  refining: { fg: '#a8880c', bg: '#f7f2df', glyph: '●', label: 'Refining'   },
  reset:    { fg: '#bd2f45', bg: '#fbeaec', glyph: '▼', label: 'Reset Zone' },
}
const BLOCKED_FG = '#7c3aed'
const BLOCKED_BG = '#f2ecfd'

type ClinicTab = ClinicId | 'overall'
const TABS: { id: ClinicTab; label: string }[] = [
  { id: 'newport',   label: 'Newport'   },
  { id: 'narrabeen', label: 'Narrabeen' },
  { id: 'brookvale', label: 'Brookvale' },
  { id: 'overall',   label: 'Overall'   },
]

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/**
 * Column spec — header and body both render from this one list, so the two can
 * never drift out of order.
 *
 * The first nine entries are the nine figures SOP step 6 lists, in that order,
 * under the labels the SOP and the Practitioner Stats 2026 tab actually use
 * (Therapist is the row label, not a figure):
 *
 *   Total Appts | Occupancy | NC | Recommendations | Conversion |
 *   Case Accept | Cancellation % | Prepay % | Prepay Acceptance %
 *
 * Renaming or reordering them would break the weekly cross-check against the
 * spreadsheet this report is meant to replace.
 *
 * Where the sheet disagrees with itself, operational usage wins over the KPI
 * dictionary — Cath reads the SOP and the tab, not the dictionary:
 *   "Case Accept"  — SOP step 6, its section heading, its final check, the
 *                    physio tabs, and 6 of 10 week blocks. Only the KPI
 *                    dictionary says "Case Acceptance".
 *   "Prepay %"     — 8 of 10 week blocks, over "Prepay Offered%" (2).
 *
 * Columns this report ADDS come last, after a divider, so nothing the CEO
 * already reads shifts position.
 */
/** The three figures a person can type in. All three are filled by Sync too;
 *  editing exists to correct one, and to supply an Occupancy for a week Nookal
 *  could not measure. */
type ManualField = 'total_appts' | 'occupancy_pct' | 'new_cases'

/**
 * Column bands. The SOP lists nine figures in a fixed order and the table keeps
 * it, so the bands are drawn around that order rather than reordering to suit
 * them — they name what the eye is already grouping.
 */
type Band = 'volume' | 'clinical' | 'retention' | 'prepay' | 'added'

const BANDS: Record<Band, { label: string; tint: string; ink: string }> = {
  // Tints stay very pale: the zone chips inside these cells carry the meaning,
  // and a saturated band would compete with them.
  volume:    { label: 'Volume',      tint: '#eff4f8', ink: '#5b6b7a' },
  clinical:  { label: 'Clinical',    tint: '#f0faf7', ink: '#0f6e56' },
  retention: { label: '',            tint: '#fdf3f4', ink: '#9c3f4c' },
  prepay:    { label: 'Prepay',      tint: '#f8f5ee', ink: '#8a7333' },
  added:     { label: 'Added here',  tint: '#f5f5f7', ink: '#6b7280' },
}

type Col = { band: Band } & (
  | { kind: 'metric'; label: string; title: string; get: (r: PractitionerWeekStats) => Metric; suffix?: string }
  | { kind: 'count';  label: string; title: string; get: (r: PractitionerWeekStats) => number }
  | { kind: 'manual'; label: string; title: string; field: ManualField; suffix?: string; get: (r: PractitionerWeekStats) => Metric }
)

const COLUMNS: Col[] = [
  // ── the sheet's columns, in the sheet's order ──
  { band: 'volume',    kind: 'manual', label: 'Total Appts', field: 'total_appts',
    title: 'Hand-read: Nookal → Reports → Providers & Practice → Completed Consults (SOP steps 7-11). All locations. Also the denominator for Cancellation %.',
    get: (r) => r.totalAppts },
  { band: 'volume',    kind: 'manual', label: 'Occupancy', field: 'occupancy_pct', suffix: '%',
    title: 'Target >80%. The exact Nookal figure: Occupied ÷ Scheduled Minutes, off Nookal → Reports → Occupancy (date range = this week, Locations = All Locations, Export), loaded with db:import:occupancy. Sync does NOT fill this — the rostered hours Nookal divides by are absent from its API, and the diary-derived substitute ran up to 23 points high and put 5 of 11 practitioners in the wrong zone, so a blank is shown instead. Hover a cell for the hours behind the number. Typing one by hand beats the import and survives everything.',
    get: (r) => r.occupancy },
  { band: 'volume',    kind: 'manual', label: 'NC', field: 'new_cases',
    title: 'Hand-read: same Providers & Practice report → New Cases (SOP steps 12-14).',
    get: (r) => r.newCases },
  { band: 'clinical',  kind: 'metric', label: 'Recommendations', suffix: '',
    title: 'Average treatment-plan recommendations per initial consult. Target 8–12.',
    get: (r) => r.recommendations },
  { band: 'clinical',  kind: 'metric', label: 'Conversion',
    title: 'Average appointments booked from initial. Target >6.',
    get: (r) => r.conversion },
  { band: 'clinical',  kind: 'metric', label: 'Case Accept', suffix: '%',
    title: 'Pooled: sum booked ÷ sum recommendations, per the KPI dictionary. Target >80%. The sheet averages per-patient percentages instead and can differ by 17 points.',
    get: (r) => r.caseAcceptance },
  { band: 'retention', kind: 'metric', label: 'Cancellation %', suffix: '%',
    title: 'Computed: patients left with no future booking ÷ Total Appts. Target <10%. Counts "No Future Bookings" + "Cancelled - not rescheduled", per patient rather than per cancelled appointment. A completed treatment plan is NOT counted — the patient finished their care. A reschedule is not counted either — the booking still exists. Replaces SOP steps 30-39: the ten Nookal Cancellation reports and the manual NFB cross-check.',
    get: (r) => r.cancellationPct },
  { band: 'prepay',    kind: 'metric', label: 'Prepay %', suffix: '%',
    title: 'Prepay offered ÷ initial consults. Target 100%. The sheet divides by NC, which is how it produced 125%. No zone band — the KPI dictionary defines none.',
    get: (r) => r.prepayOfferedPct },
  { band: 'prepay',    kind: 'metric', label: 'Prepay Acceptance %', suffix: '%',
    title: 'Prepay accepted ÷ prepay offered. Target 80%. Blank when nothing was offered. No zone band — the KPI dictionary defines none.',
    get: (r) => r.prepayAcceptedPct },

  // ── added by this report, not in the sheet ──
  { band: 'added',     kind: 'count', label: 'Initials',
    title: 'ADDED: initial consultations logged. The honest denominator for the prepay rates — the sheet has no such column.',
    get: (r) => r.initials },
  { band: 'added',     kind: 'metric', label: 'TP Documented', suffix: '%',
    title: 'ADDED: treatment plans documented. A KPI with a 100% target in the dictionary that the sheet tracks nowhere.',
    get: (r) => r.tpDocumented },
  { band: 'added',     kind: 'count', label: 'Cxl events',
    title: 'ADDED: cancellation events, per cancelled appointment date. One entry with three cancelled dates is three events.',
    get: (r) => r.cancellations },
  { band: 'added',     kind: 'count', label: 'Churns',
    title: 'ADDED: churns per patient, on their last cancelled date. A reschedule keeps a future booking, so it is not a churn. Runs slightly HIGHER than the Cancellation % numerator: this also counts completed treatment plans, which Cancellation % deliberately leaves out.',
    get: (r) => r.churns },
]

/** Index of the first added column — where the divider goes. */
/**
 * Contiguous runs of the same band, for the grouped header row. Derived rather
 * than hand-listed so a column can never end up under the wrong band label.
 */
const BAND_RUNS: { band: Band; span: number }[] = COLUMNS.reduce<{ band: Band; span: number }[]>(
  (runs, c) => {
    const last = runs[runs.length - 1]
    if (last && last.band === c.band) last.span += 1
    else runs.push({ band: c.band, span: 1 })
    return runs
  },
  []
)

/** A band boundary gets a divider, so the eye finds the groups without counting. */
const isBandStart = (i: number) => i > 0 && COLUMNS[i - 1].band !== COLUMNS[i].band

function fmt(m: Metric, suffix = ''): string {
  if (m.value === null) return '—'
  return `${m.value}${suffix}`
}

function ZoneCell({ m, suffix = '', extra }: { m: Metric; suffix?: string; extra?: React.CSSProperties }) {
  // No figure at all — nothing was logged.
  if (m.value === null) {
    return (
      <td style={{ ...cellBase, ...extra, color: TEXT_MUTE, fontWeight: 400 }} title="No data logged for this week">
        —
      </td>
    )
  }
  // A value carrying a note is a warning, not a performance reading — occupancy
  // over 100% is a roster error. Flag it in the impossible-value colour so it is
  // never mistaken for a good score.
  if (m.note) {
    return (
      <td style={{ ...cellBase, ...extra, color: BLOCKED_FG, background: BLOCKED_BG }} title={m.note}>
        ⚠ {fmt(m, suffix)}
      </td>
    )
  }
  // A real figure the KPI dictionary sets no target band for (the prepay rates).
  // Render the number plainly — never swallow it just because there is no zone.
  if (!m.zone) {
    return <td style={{ ...cellBase, ...extra }} title={m.detail}>{fmt(m, suffix)}</td>
  }
  const z = ZONE[m.zone]
  // The zone label alone ("Thriving") says nothing about where the number came
  // from. Where a metric carries its working — synced occupancy does — put that
  // in front of the label, so the hours are one hover away from the percentage.
  return (
    <td style={{ ...cellBase, ...extra }}>
      <span
        title={m.detail ? `${m.detail} — ${z.label}` : z.label}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          background: z.bg, color: z.fg,
          padding: '3px 8px', borderRadius: 5, fontWeight: 600,
        }}
      >
        <span style={{ fontSize: 9, lineHeight: 1 }}>{z.glyph}</span>
        {fmt(m, suffix)}
      </span>
    </td>
  )
}

const cellBase: React.CSSProperties = {
  padding: '7px 10px',
  textAlign: 'right',
  fontFamily: "'DM Mono', ui-monospace, monospace",
  fontSize: 12.5,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
  borderBottom: `1px solid #f1f3f6`,
  color: TEXT_SOFT,
}

const thBase: React.CSSProperties = {
  padding: '9px 10px',
  textAlign: 'right',
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: TEXT_SOFT,
  background: '#f9fafb',
  borderBottom: `1px solid ${BORDER}`,
  whiteSpace: 'nowrap',
}

/**
 * Blocking overlay for the duration of a sync.
 *
 * A sync pulls a whole month of Nookal appointments — measured at 3,572 records
 * and 30+ seconds. Without a modal the page looks frozen and the natural reaction
 * is to click Sync again, which starts a second month-long fetch. So this states
 * what is happening, that it is slow on purpose, and that leaving is safe.
 *
 * Matches the ConfirmDialog overlay (same scrim, radius and animation) so it does
 * not read as a different app.
 */
function SyncOverlay({ period }: { period: string }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="sync-title"
      aria-busy="true"
      style={{
        position: 'fixed', inset: 0, zIndex: 9000,
        background: 'rgba(15, 23, 42, 0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
        animation: 'psFadeIn 0.12s ease',
      }}
    >
      <style>{`
        @keyframes psFadeIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes psPopIn  { from { opacity: 0; transform: translateY(6px) scale(0.97) } to { opacity: 1; transform: none } }
        @keyframes psSpin   { to { transform: rotate(360deg) } }
        @keyframes psPulse  { 0%,100% { opacity: 1 } 50% { opacity: 0.45 } }
        /* A spinner is decoration; never animate it for someone who asked us not to. */
        @media (prefers-reduced-motion: reduce) {
          .ps-spin  { animation: none !important; border-top-color: ${TEAL} !important }
          .ps-pulse { animation: none !important }
        }
      `}</style>

      <div style={{
        background: '#fff', borderRadius: 12,
        width: '100%', maxWidth: 420,
        boxShadow: '0 20px 50px rgba(0,0,0,0.20)',
        animation: 'psPopIn 0.16s ease',
        overflow: 'hidden',
        fontFamily: "'DM Sans', sans-serif",
        padding: '26px 26px 22px',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14,
        textAlign: 'center',
      }}>
        <div
          className="ps-spin"
          aria-hidden="true"
          style={{
            width: 38, height: 38, borderRadius: '50%',
            border: `3px solid ${BORDER}`, borderTopColor: TEAL,
            animation: 'psSpin 0.8s linear infinite',
          }}
        />
        <div>
          <div id="sync-title" style={{ fontSize: 16, fontWeight: 700, color: TEXT, letterSpacing: '-0.01em' }}>
            Syncing Nookal — please wait
          </div>
          <div className="ps-pulse" style={{
            marginTop: 5, fontSize: 13, color: TEXT_SOFT,
            animation: 'psPulse 1.6s ease-in-out infinite',
          }}>
            Reading {period} appointments…
          </div>
        </div>
        <div style={{
          fontSize: 12, color: TEXT_MUTE, lineHeight: 1.55,
          borderTop: `1px solid ${BORDER}`, paddingTop: 12, width: '100%',
        }}>
          A whole month is a few thousand appointments, so this takes around
          <strong style={{ color: TEXT_SOFT }}> 30 seconds</strong>. Please do not
          press Sync again. Your figures are saved as they are written, so closing
          this page will not lose what has already come through.
        </div>
      </div>
    </div>
  )
}

/**
 * Overlay for occupancy sync — matches SyncOverlay style.
 */
function SyncOccupancyOverlay({ period }: { period: string }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="sync-occupancy-title"
      aria-busy="true"
      style={{
        position: 'fixed', inset: 0, zIndex: 9000,
        background: 'rgba(15, 23, 42, 0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
        animation: 'psFadeIn 0.12s ease',
      }}
    >
      <style>{`
        @keyframes psFadeIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes psPopIn  { from { opacity: 0; transform: translateY(6px) scale(0.97) } to { opacity: 1; transform: none } }
        @keyframes psSpin   { to { transform: rotate(360deg) } }
        @keyframes psPulse  { 0%,100% { opacity: 1 } 50% { opacity: 0.45 } }
        @media (prefers-reduced-motion: reduce) {
          .ps-spin  { animation: none !important; border-top-color: #a855f7 !important }
          .ps-pulse { animation: none !important }
        }
      `}</style>

      <div style={{
        background: '#fff', borderRadius: 12,
        width: '100%', maxWidth: 420,
        boxShadow: '0 20px 50px rgba(0,0,0,0.20)',
        animation: 'psPopIn 0.16s ease',
        overflow: 'hidden',
        fontFamily: "'DM Sans', sans-serif",
        padding: '26px 26px 22px',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14,
        textAlign: 'center',
      }}>
        <div
          className="ps-spin"
          aria-hidden="true"
          style={{
            width: 38, height: 38, borderRadius: '50%',
            border: `3px solid ${BORDER}`, borderTopColor: '#a855f7',
            animation: 'psSpin 0.8s linear infinite',
          }}
        />
        <div>
          <div id="sync-occupancy-title" style={{ fontSize: 16, fontWeight: 700, color: TEXT, letterSpacing: '-0.01em' }}>
            Syncing Occupancy
          </div>
          <div className="ps-pulse" style={{
            marginTop: 5, fontSize: 13, color: TEXT_SOFT,
            animation: 'psPulse 1.6s ease-in-out infinite',
          }}>
            {period} — scraping from Nookal
          </div>
        </div>
        <div style={{
          fontSize: 12, color: TEXT_MUTE, lineHeight: 1.55,
          borderTop: `1px solid ${BORDER}`, paddingTop: 12, width: '100%',
        }}>
          Browser automation takes around
          <strong style={{ color: TEXT_SOFT }}> 1–2 minutes</strong>. 
          Please do not close this page.
        </div>
      </div>
    </div>
  )
}

type DraftRow = Partial<Record<ManualField, string>>

interface StatsRowProps {
  r:        PractitionerWeekStats
  isTeam?:  boolean
  /** Edit mode is off for the Team row — its figures are sums of the rows above. */
  editing?: boolean
  draft?:   DraftRow
  onEdit?:  (field: ManualField, raw: string) => void
  onCommit?: () => void
}

function StatsRow({ r, isTeam, editing, draft, onEdit, onCommit }: StatsRowProps) {
  const rowBg = isTeam ? '#f9fafb' : '#fff'
  const canEdit = !!editing && !isTeam
  return (
    <tr style={{ background: rowBg }}>
      <td
        style={{
          padding: '7px 14px', textAlign: 'left',
          fontFamily: "'DM Sans', sans-serif", fontSize: 13,
          fontWeight: isTeam ? 700 : 600, color: TEXT,
          borderBottom: `1px solid #f1f3f6`,
          borderRight: `1px solid ${BORDER}`,
          background: rowBg,
          position: 'sticky', left: 0, zIndex: 1,
        }}
      >
        {r.clinicianName}
      </td>
      {COLUMNS.map((c, i) => {
        // Band tint + a divider at each band boundary. The tint is on the cell,
        // not the row, so a band reads as a vertical column of related figures.
        const extra: React.CSSProperties = {
          background: isTeam ? undefined : BANDS[c.band].tint,
          ...(isBandStart(i) ? { borderLeft: `2px solid ${BORDER}` } : {}),
        }

        if (c.kind === 'manual') {
          if (canEdit) {
            return (
              <td key={c.label} style={{ ...cellBase, ...extra, padding: '3px 4px' }}>
                <input
                  type="number"
                  step={c.field === 'occupancy_pct' ? '0.01' : '1'}
                  min="0"
                  value={draft?.[c.field] ?? ''}
                  onChange={(e) => onEdit?.(c.field, e.target.value)}
                  onBlur={onCommit}
                  aria-label={`${c.label} for ${r.clinicianName}`}
                  style={{
                    width: 64, padding: '4px 6px', textAlign: 'right',
                    border: `1px solid ${BORDER}`, borderRadius: 4,
                    fontFamily: "'DM Mono', ui-monospace, monospace",
                    fontSize: 12.5, fontVariantNumeric: 'tabular-nums',
                  }}
                />
              </td>
            )
          }
          // Read mode: an unentered manual figure gets the ⚠ treatment with the
          // Nookal path in the tooltip, so it reads as "go and enter this".
          const m = c.get(r)
          if (m.value === null) {
            return (
              <td
                key={c.label}
                style={{ ...cellBase, ...extra, color: BLOCKED_FG, background: BLOCKED_BG, opacity: 0.85 }}
                title={m.note}
              >
                ⚠
              </td>
            )
          }
          return <ZoneCell key={c.label} m={m} suffix={c.suffix} extra={extra} />
        }
        if (c.kind === 'count') {
          // A genuine zero prints as 0, never as an em dash — conflating "none"
          // with "not recorded" is the exact defect this board exists to remove.
          return <td key={c.label} style={{ ...cellBase, ...extra }}>{c.get(r)}</td>
        }
        return <ZoneCell key={c.label} m={c.get(r)} suffix={c.suffix} extra={extra} />
      })}
    </tr>
  )
}

export default function PractitionerStatsPage() {
  const now = new Date()
  const [tab,   setTab]   = useState<ClinicTab>('overall')
  const [year,  setYear]  = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [weekIdx, setWeekIdx] = useState(0)

  const [report,  setReport]  = useState<PractitionerStatsReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  const [syncing, setSyncing] = useState(false)
  const [syncingOccupancy, setSyncingOccupancy] = useState(false)
  const [occupancyConfigured, setOccupancyConfigured] = useState<boolean | null>(null)
  const [editing, setEditing] = useState(false)
  // Drafts are keyed by clinician and held as strings so a half-typed value and a
  // deliberately cleared field both survive until commit.
  const [drafts,  setDrafts]  = useState<Record<string, DraftRow>>({})
  const [saving,  setSaving]  = useState(false)

  // Check if occupancy scraping is configured on mount
  useEffect(() => {
    practitionerStatsApi.getOccupancyStatus()
      .then(status => setOccupancyConfigured(status.configured))
      .catch(() => setOccupancyConfigured(false))
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const data = await practitionerStatsApi.get(
        year, month, tab === 'overall' ? undefined : tab
      )
      // The axios generic is a promise, not a check — a misrouted request can
      // resolve 200 with an HTML body and no `weeks` at all. Verify the shape
      // before trusting it rather than throwing deep inside the render.
      if (!data || !Array.isArray(data.weeks)) {
        throw new Error('Unexpected response from /api/practitioner-stats')
      }
      setReport(data)
      // A month has 4 weeks plus a remainder that is often empty — the
      // calculator marks an empty one with a 9999-12-31 range. Clamp against the
      // SELECTABLE count, not weeks.length (always 5): coming from a month that
      // had a real remainder would otherwise leave the tab parked on the empty
      // sentinel, showing an all-zero week with no button highlighted.
      const selectable = data.weeks.filter((w) => w.dateFrom !== '9999-12-31').length
      setWeekIdx((i) => Math.min(i, Math.max(selectable - 1, 0)))
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load practitioner stats'
      setError(msg)
      setReport(null)
    } finally {
      setLoading(false)
    }
  }, [year, month, tab])

  useEffect(() => { load() }, [load])

  const week = report?.weeks[weekIdx] ?? null
  // The calculator emits an empty remainder as 9999-12-31 when a month ends on
  // Week 4's Sunday — don't offer a tab for a range that does not exist.
  const selectableWeeks = (report?.weeks ?? []).filter((w) => w.dateFrom !== '9999-12-31')

  const runSync = async () => {
    setSyncing(true)
    try {
      const r = await practitionerStatsApi.sync(year, month)
      await load()
      const bits = [`${r.appointments} appointments · ${r.rowsWritten} rows`]
      // A practitioner whose Nookal record could not be matched contributes
      // nothing, and silence about that would read as a genuine zero.
      if (r.mapping.unresolved.length) {
        bits.push(`unmatched: ${r.mapping.unresolved.map((u) => u.fullName || u.userId).join(', ')}`)
      }
      if (r.unmappedProviderIds.length) {
        bits.push(`${r.unmappedProviderIds.length} Nookal provider(s) skipped — no PhysioWard account`)
      }
      // Occupancy is called out separately because Sync cannot produce it, and a
      // blank column would otherwise read as nobody having looked.
      if (r.occupancyNeedsImport) {
        bits.push(`${r.occupancyNeedsImport} week-row(s) still need Occupancy — click "Sync Occupancy" to scrape from Nookal`)
      }
      toast.success(`Synced ${MONTHS[month - 1]} ${year} — ${bits.join(' · ')}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Sync failed'
      toast.error(`${msg} — nothing was changed`)
    } finally {
      setSyncing(false)
    }
  }

  const runSyncOccupancy = async () => {
    setSyncingOccupancy(true)
    try {
      const r = await practitionerStatsApi.syncOccupancy(year, month)
      await load()
      
      const totalWritten = r.results.reduce((sum, res) => sum + res.written, 0)
      const totalScraped = r.results.reduce((sum, res) => sum + res.scraped, 0)
      const allUnmatched = [...new Set(r.results.flatMap(res => res.unmatched))]
      
      const bits = [`${totalScraped} providers scraped · ${totalWritten} rows written`]
      if (allUnmatched.length > 0) {
        bits.push(`unmatched: ${allUnmatched.join(', ')}`)
      }
      
      toast.success(`Occupancy synced for ${MONTHS[month - 1]} ${year} — ${bits.join(' · ')}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Occupancy sync failed'
      toast.error(`${msg} — check Nookal web credentials`)
    } finally {
      setSyncingOccupancy(false)
    }
  }

  /** Seed drafts from what is already stored, so editing starts from the truth. */
  const beginEdit = () => {
    if (!week) return
    const seed: Record<string, DraftRow> = {}
    for (const r of week.rows) {
      seed[r.clinicianId] = {
        total_appts:   r.totalAppts.value === null ? '' : String(r.totalAppts.value),
        occupancy_pct: r.occupancy.value  === null ? '' : String(r.occupancy.value),
        new_cases:     r.newCases.value   === null ? '' : String(r.newCases.value),
      }
    }
    setDrafts(seed)
    setEditing(true)
  }

  const editField = (clinicianId: string, field: ManualField, raw: string) => {
    setDrafts((d) => ({ ...d, [clinicianId]: { ...d[clinicianId], [field]: raw } }))
  }

  /** An empty box means "no figure", which is not the same as 0 — send null. */
  const numOrNull = (raw: string | undefined): number | null => {
    if (raw === undefined || raw.trim() === '') return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }

  const commitRow = async (clinicianId: string) => {
    if (!week) return
    const d = drafts[clinicianId]
    if (!d) return
    try {
      await practitionerStatsApi.saveWeekInput({
        clinician_id:  clinicianId,
        year, month,
        // The Remainder column is stored as week 5.
        week_num:      week.weekNum === 'remainder' ? 5 : week.weekNum,
        total_appts:   numOrNull(d.total_appts),
        occupancy_pct: numOrNull(d.occupancy_pct),
        new_cases:     numOrNull(d.new_cases),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not save'
      toast.error(`${msg} — this practitioner's figures were not saved`)
    }
  }

  /** Reload on exit so Cancellation % and the Team row recompute from what was
   *  saved, rather than leaving stale derived values on screen. */
  const finishEdit = async () => {
    setSaving(true)
    try {
      await load()
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  // hideNav: reached only from the /admin-home card since 2026-08-16, so the
  // page stands on its own — the "← Home" button is the way back.
  return (
    <AppShell hideNav>
      {syncing && <SyncOverlay period={`${MONTHS[month - 1]} ${year}`} />}
      {syncingOccupancy && <SyncOccupancyOverlay period={`${MONTHS[month - 1]} ${year}`} />}
      <div className="pw-page" style={{ padding: '20px 28px' }}>

        <div style={{ marginBottom: 16 }}>
          <h1 style={{
            margin: 0, fontFamily: "'DM Sans', sans-serif",
            fontSize: 22, fontWeight: 700, color: TEXT, letterSpacing: '-0.02em',
          }}>
            Practitioner Stats
          </h1>
          <p style={{
            margin: '4px 0 0', fontSize: 13, color: TEXT_SOFT,
            fontFamily: "'DM Sans', sans-serif",
          }}>
            Weekly clinical impact per practitioner, Monday–Sunday. Zones follow the
            Clinical Impact KPI targets.
          </p>
        </div>

        {/* Clinic tabs */}
        <div className="pw-wrap" style={{
          display: 'flex', gap: 4, background: '#fff', padding: 4, borderRadius: 8,
          border: `1px solid ${BORDER}`, width: 'fit-content', maxWidth: '100%',
          marginBottom: 12,
        }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                padding: '7px 15px', border: 'none', borderRadius: 6,
                background: tab === t.id ? TEAL : 'transparent',
                color:      tab === t.id ? '#fff' : TEXT_SOFT,
                fontFamily: "'DM Sans', sans-serif",
                fontSize: 13, fontWeight: 600, cursor: 'pointer',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Period + week selector */}
        <div className="pw-wrap" style={{
          display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap',
        }}>
          <select
            value={month}
            onChange={(e) => setMonth(Number(e.target.value))}
            style={selectStyle}
          >
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            style={selectStyle}
          >
            {[now.getFullYear(), now.getFullYear() - 1, now.getFullYear() - 2].map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>

          {selectableWeeks.length > 0 && (
            <div style={{ display: 'flex', gap: 4, marginLeft: 4, flexWrap: 'wrap' }}>
              {selectableWeeks.map((w, i) => (
                <button
                  key={String(w.weekNum)}
                  onClick={() => setWeekIdx(i)}
                  title={`${w.dateFrom} → ${w.dateTo}`}
                  style={{
                    padding: '6px 12px', borderRadius: 6,
                    border: `1px solid ${weekIdx === i ? TEAL : BORDER}`,
                    background: weekIdx === i ? '#f0faf7' : '#fff',
                    color:      weekIdx === i ? TEAL : TEXT_SOFT,
                    fontFamily: "'DM Sans', sans-serif",
                    fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
                  }}
                >
                  {w.weekNum === 'remainder' ? 'Remainder' : `Week ${w.weekNum}`}
                </button>
              ))}
            </div>
          )}

          <button
            onClick={runSync}
            disabled={syncing || syncingOccupancy || editing}
            title="Pull this month's appointments from Nookal and fill Total Appts, NC and cancellations for every practitioner."
            style={{
              marginLeft: 'auto', padding: '7px 15px', borderRadius: 7,
              border: 'none', background: syncing ? '#9ca3af' : TEAL, color: '#fff',
              fontFamily: "'DM Sans', sans-serif", fontSize: 13, fontWeight: 600,
              cursor: syncing || syncingOccupancy || editing ? 'not-allowed' : 'pointer',
            }}
          >
            {syncing ? 'Syncing Nookal…' : 'Sync Nookal'}
          </button>

          {occupancyConfigured && (
            <button
              onClick={runSyncOccupancy}
              disabled={syncing || syncingOccupancy || editing}
              title="Scrape the Occupancy report directly from Nookal's web interface using browser automation. This gets the exact figures Nookal displays — Occupied ÷ Scheduled Minutes including rostered hours. Takes 1-2 minutes for a full month."
              style={{
                padding: '7px 15px', borderRadius: 7,
                border: 'none', 
                background: syncingOccupancy ? '#9ca3af' : '#a855f7', 
                color: '#fff',
                fontFamily: "'DM Sans', sans-serif", fontSize: 13, fontWeight: 600,
                cursor: syncing || syncingOccupancy || editing ? 'not-allowed' : 'pointer',
              }}
            >
              {syncingOccupancy ? 'Syncing Occupancy…' : 'Sync Occupancy'}
            </button>
          )}

          {week && (
            editing ? (
              <button
                onClick={finishEdit}
                disabled={saving}
                style={{
                  padding: '7px 15px', borderRadius: 7,
                  border: 'none', background: TEAL, color: '#fff',
                  fontFamily: "'DM Sans', sans-serif", fontSize: 13, fontWeight: 600,
                  cursor: saving ? 'wait' : 'pointer',
                }}
              >
                {saving ? 'Saving…' : 'Done'}
              </button>
            ) : (
              <button
                onClick={beginEdit}
                title="Type in figures by hand. Total Appts and NC come from Sync; Occupancy comes from the Nookal Occupancy report import. Use this to correct any of them, or to fill an Occupancy without exporting. Anything you type here outranks both and survives every later Sync."
                style={{
                  padding: '7px 15px', borderRadius: 7,
                  border: `1px solid ${TEAL}`, background: '#f0faf7', color: TEAL,
                  fontFamily: "'DM Sans', sans-serif", fontSize: 13, fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Enter Nookal figures
              </button>
            )
          )}
        </div>

        {/* Zone legend */}
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 12 }}>
          {(Object.keys(ZONE) as Zone[]).map((z) => (
            <span key={z} style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontSize: 11.5, fontWeight: 600, color: ZONE[z].fg,
              fontFamily: "'DM Sans', sans-serif",
            }}>
              <span style={{ fontSize: 9 }}>{ZONE[z].glyph}</span>{ZONE[z].label}
            </span>
          ))}
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            fontSize: 11.5, fontWeight: 600, color: BLOCKED_FG,
            fontFamily: "'DM Sans', sans-serif",
          }}>
            <span style={{ fontSize: 10 }}>⚠</span>Not entered yet, or an impossible value — hover for why
          </span>
        </div>

        {error && (
          <div style={{
            background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c',
            borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 12,
            fontFamily: "'DM Sans', sans-serif",
          }}>
            {error}
          </div>
        )}

        {loading ? (
          <div style={{ padding: 30, color: TEXT_SOFT, fontSize: 13, fontFamily: "'DM Sans', sans-serif" }}>
            Loading…
          </div>
        ) : !week ? (
          <div style={{ padding: 30, color: TEXT_SOFT, fontSize: 13, fontFamily: "'DM Sans', sans-serif" }}>
            No data for this period.
          </div>
        ) : (
          <>
            <div style={{
              fontSize: 12.5, color: TEXT_SOFT, marginBottom: 8,
              fontFamily: "'DM Mono', ui-monospace, monospace",
              display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline',
            }}>
              <span>
                {week.label} · {week.dateFrom} → {week.dateTo}
                {tab !== 'overall' && ` · ${CLINIC_LABEL[tab]}`}
              </span>
              {/* The figures are read from Postgres, so Sync is only worth
                  pressing when Nookal has moved on. Saying when it last ran is
                  what makes that judgeable instead of guesswork. */}
              <span style={{ color: week.syncedAt ? TEXT_MUTE : BLOCKED_FG }}>
                {week.syncedAt
                  ? `· synced ${new Date(week.syncedAt).toLocaleString()}`
                  : '· never synced — press Sync Nookal'}
              </span>
            </div>

            {/* Team headline before the detail. The Team row is the last line of a
                13-column scroller, which is the worst place for the figure most
                often wanted first. */}
            <div className="pw-grid-2" style={{
              display: 'grid', gap: 10, marginBottom: 12,
              gridTemplateColumns: 'repeat(auto-fit, minmax(168px, 1fr))',
            }}>
              {([
                { label: 'Total appts', m: week.team.totalAppts,     suffix: ''  },
                { label: 'Occupancy',   m: week.team.occupancy,      suffix: '%' },
                { label: 'Case accept', m: week.team.caseAcceptance, suffix: '%' },
                { label: 'Cancellation', m: week.team.cancellationPct, suffix: '%' },
              ] as const).map((t) => {
                const z = t.m.zone ? ZONE[t.m.zone] : null
                return (
                  <div key={t.label} style={{
                    background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10,
                    padding: '12px 14px', position: 'relative', overflow: 'hidden',
                    display: 'flex', flexDirection: 'column', gap: 6,
                  }}>
                    <span style={{
                      position: 'absolute', inset: '0 auto 0 0', width: 3,
                      background: z ? z.fg : BORDER,
                    }} />
                    <div style={{
                      fontSize: 10, fontWeight: 700, letterSpacing: '0.07em',
                      textTransform: 'uppercase', color: TEXT_SOFT,
                      fontFamily: "'DM Sans', sans-serif",
                    }}>
                      {t.label} · team
                    </div>
                    <div style={{
                      fontFamily: "'DM Mono', ui-monospace, monospace",
                      fontSize: 23, fontWeight: 600, lineHeight: 1,
                      fontVariantNumeric: 'tabular-nums',
                      color: t.m.value === null ? TEXT_MUTE : TEXT,
                    }}>
                      {t.m.value === null ? '—' : `${t.m.value}${t.suffix}`}
                    </div>
                    {z ? (
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 5,
                        fontSize: 11, fontWeight: 650, color: z.fg, background: z.bg,
                        padding: '2px 7px', borderRadius: 4, width: 'fit-content',
                        fontFamily: "'DM Sans', sans-serif",
                      }}>
                        <span style={{ fontSize: 9 }}>{z.glyph}</span>{z.label}
                      </span>
                    ) : (
                      <span style={{
                        fontSize: 11, color: TEXT_MUTE,
                        fontFamily: "'DM Sans', sans-serif",
                      }}>
                        {t.m.value === null ? 'no data' : 'no target band'}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>

            <div style={{
              background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10,
              overflowX: 'auto',
            }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 1040 }}>
                <thead>
                  {/* Band row: names the groups the SOP order already implies,
                      so 13 columns scan as 5 things instead of 13. */}
                  <tr>
                    <th
                      aria-hidden="true"
                      style={{
                        ...thBase, background: '#fff', borderBottom: 'none',
                        position: 'sticky', left: 0, zIndex: 3,
                        borderRight: `1px solid ${BORDER}`,
                      }}
                    />
                    {BAND_RUNS.map(({ band, span }) => (
                      <th
                        key={band}
                        colSpan={span}
                        style={{
                          ...thBase,
                          textAlign: 'center',
                          background: BANDS[band].tint,
                          color: BANDS[band].ink,
                          borderLeft: `2px solid ${BORDER}`,
                          borderBottom: `1px solid ${BORDER}`,
                          fontSize: 10,
                        }}
                      >
                        {BANDS[band].label}
                      </th>
                    ))}
                  </tr>
                  <tr>
                    {/* Same label as the sheet's first column, not "Practitioner". */}
                    <th style={{
                      ...thBase, textAlign: 'left', position: 'sticky', left: 0, zIndex: 2,
                      borderRight: `1px solid ${BORDER}`,
                    }}>
                      Therapist
                    </th>
                    {COLUMNS.map((c, i) => (
                      <th
                        key={c.label}
                        title={c.title}
                        style={{
                          ...thBase,
                          background: BANDS[c.band].tint,
                          ...(isBandStart(i) ? { borderLeft: `2px solid ${BORDER}` } : {}),
                          // Italic marks the four columns this report adds, so they
                          // are never mistaken for the spreadsheet's own.
                          ...(c.band === 'added' ? { fontStyle: 'italic' } : {}),
                        }}
                      >
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {week.rows.map((r) => (
                    <StatsRow
                      key={r.clinicianId}
                      r={r}
                      editing={editing}
                      draft={drafts[r.clinicianId]}
                      onEdit={(field, raw) => editField(r.clinicianId, field, raw)}
                      onCommit={() => commitRow(r.clinicianId)}
                    />
                  ))}
                  <StatsRow r={week.team} isTeam />
                </tbody>
              </table>
            </div>

          </>
        )}
      </div>
    </AppShell>
  )
}

const selectStyle: React.CSSProperties = {
  padding: '7px 11px',
  border: `1px solid ${BORDER}`,
  borderRadius: 7,
  background: '#fff',
  color: TEXT,
  fontFamily: "'DM Sans', sans-serif",
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
}
