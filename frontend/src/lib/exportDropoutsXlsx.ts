import { newWorkbook, applyAllBorders, downloadWorkbook } from './xlsx'
import {
  DropoutDTO, DropoutStatus, ClinicId, CLINIC_LABEL,
  DROPOUT_STATUSES, DROPOUT_REASONS, FRONT_STAFF_NAMES,
} from '../types'

/* Palette tuned to match the source Google Sheet. */
const COLOR = {
  titleBg:   'FFF6B26B', // orange title bar
  titleFg:   'FF1A1A1A',
  headerBg:  'FFC9DAF8', // light blue header
  headerFg:  'FF1F2937',
  dropdownBg:'FFF3F3F3', // subtle grey for "dropdown-style" columns
  border:    'FFCCCCCC',
}

const STATUS_FILL: Record<DropoutStatus, string> = {
  'Re-scheduled':                'FFEFEFEF', // light grey
  'Cancelled - not rescheduled': 'FFFFF2CC', // cream/yellow
  'No Future Bookings':          'FFF4CCCC', // pink
  'Completed Treatment Plan':    'FFD9EAD3', // light green
}

interface ExportOptions {
  /** Filename WITHOUT extension. */
  filename:  string
  /** If true, includes a "Clinic" column (used by Overall view). */
  includeClinic?: boolean
}

interface ColumnSpec {
  header:   string
  width:    number
  align:    'left' | 'center'
  /** Render with the subtle grey "dropdown" look. */
  dropdown?: boolean
}

export async function exportDropoutsXlsx(
  rows: DropoutDTO[],
  opts: ExportOptions
): Promise<void> {
  const includeClinic = !!opts.includeClinic

  // Column definitions — order, widths, alignment, dropdown styling.
  const cols: ColumnSpec[] = [
    { header: 'Date',                       width: 11,  align: 'center' },
    ...(includeClinic
      ? [{ header: 'Clinic',                width: 12,  align: 'center' as const }]
      : []),
    { header: 'Front of staff name',        width: 18,  align: 'center', dropdown: true },
    { header: 'Clinician name',             width: 14,  align: 'center', dropdown: true },
    { header: 'Patient name',               width: 24,  align: 'left' },
    { header: 'Appointments Cancelled',     width: 28,  align: 'left' },
    { header: 'STATUS',                     width: 28,  align: 'center', dropdown: true },
    { header: 'Reason for Cancelling',      width: 22,  align: 'center', dropdown: true },
    { header: 'Notes',                      width: 60,  align: 'left' },
  ]
  const colCount = cols.length

  const wb = newWorkbook()

  const ws = wb.addWorksheet('Daily Patient Dropout Tracking', {
    views: [{ state: 'frozen', ySplit: 2 }],
  })
  ws.columns = cols.map((c) => ({ width: c.width }))

  // ── Row 1: title bar ────────────────────────────────────────
  const titleRow = ws.addRow(['Daily Patient Dropout Tracking'])
  ws.mergeCells(1, 1, 1, colCount)
  titleRow.height = 32
  const titleCell = titleRow.getCell(1)
  titleCell.font = {
    name: 'Calibri', size: 16, bold: true, color: { argb: COLOR.titleFg },
  }
  titleCell.alignment = { vertical: 'middle', horizontal: 'center' }
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.titleBg } }
  applyAllBorders(titleCell, COLOR.border)

  // ── Row 2: header row ───────────────────────────────────────
  const headerRow = ws.addRow(cols.map((c) => c.header))
  headerRow.height = 38
  headerRow.eachCell((c) => {
    c.font      = { name: 'Calibri', bold: true, color: { argb: COLOR.headerFg }, size: 11 }
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    c.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.headerBg } }
    applyAllBorders(c, COLOR.border)
  })

  // Column index helpers (1-based for ExcelJS).
  const idx = (header: string) => cols.findIndex((c) => c.header === header) + 1
  const STATUS_COL      = idx('STATUS')
  const REASON_COL      = idx('Reason for Cancelling')
  const FRONT_STAFF_COL = idx('Front of staff name')

  // ── Data rows ───────────────────────────────────────────────
  for (const r of rows) {
    const values = [
      r.date_logged,
      ...(includeClinic ? [CLINIC_LABEL[r.clinic_id as ClinicId]] : []),
      r.front_staff_name ?? '',
      r.clinician_name ?? '',
      r.patient_name,
      r.appointment_cancelled_dates.join('; '),
      r.status ?? '',
      r.reason ?? '',
      r.notes ?? '',
    ]
    const row = ws.addRow(values)
    row.height = 22

    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const spec = cols[colNumber - 1]
      cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF111827' } }
      cell.alignment = {
        vertical:   'middle',
        horizontal: spec.align,
        wrapText:   spec.header === 'Notes' || spec.header === 'Appointments Cancelled',
      }
      applyAllBorders(cell, COLOR.border)

      if (spec.dropdown && colNumber !== STATUS_COL) {
        cell.fill = {
          type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.dropdownBg },
        }
      }
    })

    // STATUS gets its own colour by value (overrides the dropdown fill).
    // Null status (legacy import rows with blank status) keeps the dropdown grey.
    const statusCell = row.getCell(STATUS_COL)
    statusCell.fill = {
      type: 'pattern', pattern: 'solid',
      fgColor: { argb: r.status ? STATUS_FILL[r.status] : COLOR.dropdownBg },
    }
  }

  // ── Real Excel dropdowns (data validation) ──────────────────
  // Apply to all data rows + a buffer of empty rows so users can append.
  const lastDataRow  = 2 + rows.length
  const editableLast = Math.max(lastDataRow + 200, 1000)

  const statusList     = `"${[...DROPOUT_STATUSES].join(',')}"`
  const reasonList     = `"${[...DROPOUT_REASONS].join(',')}"`
  const frontStaffList = `"${[...FRONT_STAFF_NAMES].join(',')}"`

  for (let r = 3; r <= editableLast; r++) {
    ws.getCell(r, STATUS_COL).dataValidation = {
      type: 'list', allowBlank: true, formulae: [statusList],
      showErrorMessage: true, errorStyle: 'warning',
      errorTitle: 'Invalid status', error: 'Pick a value from the dropdown.',
    }
    ws.getCell(r, REASON_COL).dataValidation = {
      type: 'list', allowBlank: true, formulae: [reasonList],
      showErrorMessage: true, errorStyle: 'warning',
      errorTitle: 'Invalid reason', error: 'Pick a value from the dropdown.',
    }
    ws.getCell(r, FRONT_STAFF_COL).dataValidation = {
      type: 'list', allowBlank: true, formulae: [frontStaffList],
      showErrorMessage: true, errorStyle: 'warning',
      errorTitle: 'Invalid front-of-staff name', error: 'Pick a value from the dropdown.',
    }
  }

  // Filterable header so recipient can sort/filter immediately.
  ws.autoFilter = {
    from: { row: 2, column: 1 },
    to:   { row: 2, column: colCount },
  }

  await downloadWorkbook(wb, opts.filename)
}
