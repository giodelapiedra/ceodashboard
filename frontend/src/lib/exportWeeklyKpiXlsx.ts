import ExcelJS from 'exceljs'
import {
  WeeklyKpiDTO, ClinicId,
  MOJO_ALERT_AT_OR_BELOW, EFFECTIVENESS_RUBRIC, MOJO_RUBRIC, RubricBand,
} from '../types'
import type { TrackerView } from '../api/weeklyKpi.api'
import {
  ACCENT, SURFACE_ALT, BORDER, TEXT, TEXT_SOFT, AMBER, DANGER,
  BAND_COLORS, bandKeyFor, CLINIC_ORDER, clinicLabel, weekLabel, stamp,
} from './weeklyKpi.format'
import { argb, newWorkbook, applyAllBorders, downloadWorkbook } from './xlsx'

/**
 * "Download Excel" for the super admin's Team Performance KPI tracker.
 *
 * Built on the CLIENT, like exportDropoutsXlsx: the whole week is already in
 * the browser, so a server route would only re-run the tracker query, re-parse
 * the same filters, and need an authenticated file download to hand back what
 * the page is already holding. (Case acceptance exports server-side because
 * that one streams a filtered set the page never fully loads — different
 * problem, different answer.)
 *
 * What the file is for: the tracker page deliberately keeps only the scannable
 * columns on screen and hides the KPI detail, wins and reflections behind the
 * row drawer. The export is the opposite — the FULL week, every field, one row
 * per physio, so it can be read in a meeting or kept as that week's record.
 * The two are not meant to carry the same columns.
 *
 * It mirrors the page in every other way:
 *   * it exports exactly what is on screen, filters included, and says so in
 *     the subtitle — a file that quietly holds more than the page did is how a
 *     "why doesn't this match" conversation starts;
 *   * the physios who did NOT submit are in the file too, in their own block
 *     under the table. Same reason the page shows them: a table of submissions
 *     can never show the person who skipped the week, and that is the person
 *     Sam needs first.
 *
 * Every colour, band threshold and date format comes from weeklyKpi.format —
 * the same module the page renders from — so a score cannot be amber on screen
 * and green in the file.
 */

/* The feature's tokens, converted once to the AARRGGBB ExcelJS wants. */
const FILL = {
  title:   argb(ACCENT),
  head:    argb(SURFACE_ALT),
  missing: argb(BAND_COLORS.mid.tint),   // amber wash — check-ins, not-submitted
  open:    argb(BAND_COLORS.bad.tint),   // red wash — Friday still open
}
const INK = {
  onTitle: 'FFFFFFFF',
  text:    argb(TEXT),
  soft:    argb(TEXT_SOFT),
  amber:   argb(AMBER),
  danger:  argb(DANGER),
  border:  argb(BORDER),
}

const FONT = 'Calibri'

/** The band a score sits in, as a pair of ARGB fills — same thresholds and the
 *  same ramp the tracker paints with, because it is the same function. */
function scoreColors(score: number, isMojo: boolean) {
  const band = BAND_COLORS[bandKeyFor(score, isMojo)]
  return { fg: argb(band.fg), bg: argb(band.tint) }
}

interface ColumnSpec {
  header: string
  width:  number
  align:  'left' | 'center'
  wrap?:  boolean
  /** One report's value for this column. Everything resolves to a string or a
   *  number here, so the sheet can never show a stray null. */
  value:  (r: WeeklyKpiDTO) => string | number
}

/** A submission stamp, or '' while that half is still open. */
const stampOrBlank = (ts: string | null) => (ts ? stamp(ts) : '')

const COLUMNS: ColumnSpec[] = [
  { header: 'Clinic', width: 13, align: 'center', value: r => clinicLabel(r.clinic_id) },
  { header: 'Physio', width: 22, align: 'left',   value: r => r.clinician_name ?? '' },
  { header: 'Status', width: 14, align: 'center',
    value: r => r.friday_submitted_at ? 'Complete' : 'Monday only' },

  { header: 'KPI 1',    width: 22, align: 'left', wrap: true, value: r => r.kpis[0]?.name   ?? '' },
  { header: 'Target 1', width: 12, align: 'center',           value: r => r.kpis[0]?.target ?? '' },
  { header: 'Result 1', width: 12, align: 'center',           value: r => r.kpis[0]?.result ?? '' },
  { header: 'KPI 2',    width: 22, align: 'left', wrap: true, value: r => r.kpis[1]?.name   ?? '' },
  { header: 'Target 2', width: 12, align: 'center',           value: r => r.kpis[1]?.target ?? '' },
  { header: 'Result 2', width: 12, align: 'center',           value: r => r.kpis[1]?.result ?? '' },
  { header: 'KPI 3',    width: 22, align: 'left', wrap: true, value: r => r.kpis[2]?.name   ?? '' },
  { header: 'Target 3', width: 12, align: 'center',           value: r => r.kpis[2]?.target ?? '' },
  { header: 'Result 3', width: 12, align: 'center',           value: r => r.kpis[2]?.result ?? '' },

  // Null until Friday closes the loop (Effectiveness + Mojo moved there 2026-09-04).
  { header: 'Effectiveness', width: 13, align: 'center', value: r => r.effectiveness_rating ?? '' },
  { header: 'Mojo',          width: 10, align: 'center', value: r => r.mojo_rating ?? '' },

  { header: 'Intention for the week', width: 46, align: 'left', wrap: true, value: r => r.intention },
  { header: 'If the goal is missed',  width: 38, align: 'left', wrap: true, value: r => r.missed_goal_actions ?? '' },
  { header: 'Case to discuss',        width: 34, align: 'left', wrap: true, value: r => r.case_to_discuss ?? '' },
  { header: 'Help needed',            width: 34, align: 'left', wrap: true, value: r => r.help_needed ?? '' },
  { header: 'Check-in', width: 11, align: 'center', value: r => r.checkin_needed ? 'Yes' : 'No' },
  { header: 'Check-in focus',         width: 34, align: 'left', wrap: true, value: r => r.checkin_focus ?? '' },

  { header: 'Wins', width: 38, align: 'left', wrap: true, value: r => r.wins ?? '' },
  // Three states, not two: null is "Friday half not in yet", which must never
  // read as "did not hit the goal".
  { header: 'Goal hit', width: 11, align: 'center',
    value: r => r.goal_achieved === null ? '' : r.goal_achieved ? 'Yes' : 'No' },
  { header: 'Reflection',       width: 38, align: 'left', wrap: true, value: r => r.goal_reflection ?? '' },
  { header: 'Flagged for super admin', width: 38, align: 'left', wrap: true, value: r => r.flag_for_sam ?? '' },

  { header: 'Monday submitted', width: 21, align: 'center', value: r => stamp(r.monday_submitted_at) },
  { header: 'Friday submitted', width: 21, align: 'center', value: r => stampOrBlank(r.friday_submitted_at) },
]

const colIndex = (header: string) => COLUMNS.findIndex(c => c.header === header) + 1
const EFFECTIVENESS_COL = colIndex('Effectiveness')
const MOJO_COL          = colIndex('Mojo')
const CHECKIN_COL       = colIndex('Check-in')
const STATUS_COL        = colIndex('Status')

const TITLE_ROW  = 1
const SUB_ROW    = 2
const HEADER_ROW = 3

/** Which filters were on screen when the button was pressed — named in the
 *  subtitle so the file says what it is a view of. */
export interface ExportKpiOptions {
  clinic?:      ClinicId | ''
  checkinOnly?: boolean
  openOnly?:    boolean
}

export async function exportWeeklyKpiXlsx(
  view: TrackerView,
  opts: ExportKpiOptions = {},
): Promise<void> {
  const wb = newWorkbook()

  const ws = wb.addWorksheet('Team KPI', {
    // Clinic + Physio stay put while scrolling right through 26 columns; the
    // title, subtitle and header stay put while scrolling down.
    views: [{ state: 'frozen', xSplit: 2, ySplit: HEADER_ROW }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  })
  ws.columns = COLUMNS.map(c => ({ width: c.width }))
  const colCount = COLUMNS.length

  // ── Row 1: title ────────────────────────────────────────────────────────
  bannerRow(ws, [`Team Performance KPI  ·  ${weekLabel(view.week_start)}`], colCount, {
    height: 34, size: 15, bold: true, ink: INK.onTitle, fill: FILL.title,
  })

  // ── Row 2: the page's own summary figures, plus the filter state ────────
  const s         = view.summary
  const rosterAll = view.rows.length + view.missing.length
  const filters   = [
    opts.clinic      ? `${clinicLabel(opts.clinic)} only` : null,
    opts.checkinOnly ? 'check-in requested only'          : null,
    opts.openOnly    ? 'Friday still open only'           : null,
  ].filter(Boolean)

  bannerRow(ws, [[
    `${s.submitted} of ${rosterAll} submitted`,
    `${s.friday_closed} Friday closed`,
    `Avg effectiveness ${s.avg_effectiveness?.toFixed(1) ?? '—'}`,
    `Avg mojo ${s.avg_mojo?.toFixed(1) ?? '—'}`,
    `${s.checkin_needed} check-in${s.checkin_needed === 1 ? '' : 's'} requested`,
    `Exported ${stamp(new Date().toISOString())}`,
    ...(filters.length ? [`Filtered: ${filters.join(', ')}`] : []),
  ].join('   ·   ')], colCount, {
    height: 22, size: 10.5, ink: INK.soft, fill: FILL.head,
  })

  // ── Row 3: header ───────────────────────────────────────────────────────
  const headerRow = ws.addRow(COLUMNS.map(c => c.header))
  headerRow.height = 30
  headerRow.eachCell(c => {
    c.font      = { name: FONT, size: 10.5, bold: true, color: { argb: INK.text } }
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    c.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL.head } }
    applyAllBorders(c, INK.border)
  })

  // ── Data — clinic first, then name, so the file reads like the page ─────
  const rank = (c: string) => {
    const i = CLINIC_ORDER.indexOf(c as ClinicId)
    return i === -1 ? CLINIC_ORDER.length : i
  }
  const rows = [...view.rows].sort((a, b) =>
    rank(a.clinic_id) - rank(b.clinic_id) ||
    (a.clinician_name ?? '').localeCompare(b.clinician_name ?? ''))

  for (const r of rows) {
    const row = ws.addRow(COLUMNS.map(c => c.value(r)))
    row.height = 30
    row.eachCell({ includeEmpty: true }, (cell, n) => {
      const spec = COLUMNS[n - 1]
      cell.font      = { name: FONT, size: 10.5, color: { argb: INK.text } }
      cell.alignment = { vertical: 'top', horizontal: spec.align, wrapText: !!spec.wrap }
      applyAllBorders(cell, INK.border)
    })

    if (r.effectiveness_rating !== null) paintScore(row.getCell(EFFECTIVENESS_COL), r.effectiveness_rating, false)
    if (r.mojo_rating          !== null) paintScore(row.getCell(MOJO_COL),          r.mojo_rating,          true)

    if (r.checkin_needed) {
      const c = row.getCell(CHECKIN_COL)
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL.missing } }
      c.font = { name: FONT, size: 10.5, bold: true, color: { argb: INK.amber } }
    }
    if (!r.friday_submitted_at) {
      const c = row.getCell(STATUS_COL)
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL.open } }
      c.font = { name: FONT, size: 10.5, color: { argb: INK.danger } }
    }
  }

  // The filter covers the header + submissions only, so the not-submitted
  // block below is never swept away by a filter applied to the table.
  ws.autoFilter = {
    from: { row: HEADER_ROW, column: 1 },
    to:   { row: HEADER_ROW + rows.length, column: colCount },
  }

  // ── Who did not submit ──────────────────────────────────────────────────
  if (view.missing.length > 0) {
    ws.addRow([])
    bannerRow(ws, [`Not submitted  ·  ${view.missing.length}`], colCount, {
      height: 24, size: 11.5, bold: true, ink: INK.amber, fill: FILL.missing,
    })

    for (const m of view.missing) {
      const row = ws.addRow([clinicLabel(m.clinic_id), m.full_name ?? '', 'Not submitted'])
      row.height = 22
      for (let n = 1; n <= 3; n++) {
        const cell = row.getCell(n)
        cell.font      = { name: FONT, size: 10.5, color: { argb: INK.text } }
        cell.alignment = { vertical: 'middle', horizontal: n === 2 ? 'left' : 'center' }
        cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL.missing } }
        applyAllBorders(cell, INK.border)
      }
    }
  }

  addRubricSheet(wb)

  await downloadWorkbook(wb, `PhysioWard Team KPI ${view.week_start}`)
}

/**
 * A second sheet with the two 1–10 rubrics.
 *
 * The scores only mean something against the wording behind them, and this file
 * gets read by people who are not looking at the app while they read it — in a
 * meeting, or forwarded on. Without this, a "6" in the Mojo column is a number
 * with no scale attached.
 */
function addRubricSheet(wb: ExcelJS.Workbook): void {
  const ws = wb.addWorksheet('Rubric', { views: [{ state: 'frozen', ySplit: 1 }] })
  ws.columns = [{ width: 16 }, { width: 10 }, { width: 22 }, { width: 108 }]

  const head = ws.addRow(['Rating', 'Score', 'Band', 'What it means'])
  head.height = 26
  head.eachCell(c => {
    c.font      = { name: FONT, size: 10.5, bold: true, color: { argb: INK.text } }
    c.alignment = { vertical: 'middle', horizontal: 'left' }
    c.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL.head } }
    applyAllBorders(c, INK.border)
  })

  const block = (label: string, bands: readonly RubricBand[], isMojo: boolean) => {
    for (const b of bands) {
      const row = ws.addRow([label, b.score, b.short, b.meaning])
      row.height = 30
      row.eachCell({ includeEmpty: true }, cell => {
        cell.font      = { name: FONT, size: 10.5, color: { argb: INK.text } }
        cell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true }
        applyAllBorders(cell, INK.border)
      })
      // The score cell carries the colour that band has in the table, so a
      // reader can match a coloured cell to its wording by eye.
      paintScore(row.getCell(2), b.min, isMojo)
      row.getCell(2).alignment = { vertical: 'top', horizontal: 'left' }
    }
  }

  block('Effectiveness', EFFECTIVENESS_RUBRIC, false)
  block('Mojo',          MOJO_RUBRIC,          true)

  bannerRow(ws, [
    `Mojo of ${MOJO_ALERT_AT_OR_BELOW} or below is a "talk to me now" band, not a note-it-and-move-on score.`,
  ], 4, { height: 24, size: 10.5, italic: true, ink: INK.amber, fill: FILL.missing })
}

/** A merged full-width bar: the title, the summary, the not-submitted banner
 *  and the rubric note are all the same shape with different ink. */
function bannerRow(
  ws: ExcelJS.Worksheet,
  values: string[],
  colCount: number,
  style: { height: number; size: number; ink: string; fill: string; bold?: boolean; italic?: boolean },
): void {
  const row = ws.addRow(values)
  ws.mergeCells(row.number, 1, row.number, colCount)
  row.height = style.height
  const cell = row.getCell(1)
  cell.font = {
    name: FONT, size: style.size, bold: !!style.bold, italic: !!style.italic,
    color: { argb: style.ink },
  }
  cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 }
  cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: style.fill } }
}

function paintScore(cell: ExcelJS.Cell, score: number, isMojo: boolean): void {
  const { fg, bg } = scoreColors(score, isMojo)
  cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }
  cell.font      = { name: FONT, size: 11, bold: true, color: { argb: fg } }
  cell.alignment = { vertical: 'top', horizontal: 'center' }
}
