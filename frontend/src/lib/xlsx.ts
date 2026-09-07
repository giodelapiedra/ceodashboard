import ExcelJS from 'exceljs'

/**
 * The bits every client-side .xlsx export in this app was writing for itself:
 * the workbook metadata, the hairline border, the colour conversion, and the
 * download tail.
 *
 * Pulled out when the weekly KPI export became the second one (2026-08-31) —
 * the dropouts export had all four inline, and a third copy of "make a blob,
 * make an anchor, click it, revoke the URL" is not a house style, it is three
 * places to fix the day a browser changes its mind about object URLs.
 *
 * Deliberately NOT a generic "render any table" helper. The two exports are
 * shaped very differently — one mirrors a Google Sheet with dropdowns, the
 * other is a wide week with score bands — and a shared table renderer would
 * have to grow an option for every difference. Shared plumbing, separate
 * layouts.
 */

/** CSS hex ('#0f6e56') to the AARRGGBB ExcelJS wants ('FF0F6E56').
 *  Lets a sheet reuse the app's own colour tokens instead of a second, drifting
 *  set of hard-coded ARGB strings. */
export function argb(hex: string, alpha = 'FF'): string {
  return alpha + hex.replace('#', '').toUpperCase()
}

/** A workbook stamped as ours, so the file's properties don't say "unknown". */
export function newWorkbook(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook()
  wb.creator        = 'PhysioWard'
  wb.created        = new Date()
  wb.lastModifiedBy = 'PhysioWard'
  return wb
}

/** The thin grey box every data cell in both exports gets. */
export function applyAllBorders(cell: ExcelJS.Cell, colorArgb: string): void {
  const side = { style: 'thin' as const, color: { argb: colorArgb } }
  cell.border = { top: side, bottom: side, left: side, right: side }
}

/** Write the workbook and hand it to the browser as a download.
 *  `filename` is WITHOUT the extension. */
export async function downloadWorkbook(wb: ExcelJS.Workbook, filename: string): Promise<void> {
  const buffer = await wb.xlsx.writeBuffer()
  const blob   = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const a   = document.createElement('a')
  a.href     = url
  a.download = `${filename}.xlsx`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
