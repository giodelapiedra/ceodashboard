import { Router, Response, NextFunction } from 'express';
import ExcelJS from 'exceljs';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';
import { caseAcceptanceService } from './case-acceptance.service';
import { audit } from '../../shared/audit';
import {
  createCaseAcceptanceSchema,
  updateCaseAcceptanceSchema,
  listCaseAcceptanceQuerySchema,
} from './case-acceptance.validators';
import { CLINICS } from '../../types';

const CLINIC_LABEL: Record<string, string> = Object.fromEntries(
  CLINICS.map((c) => [c.id, c.name])
);

const router = Router();
router.use(authMiddleware);

// GET /api/case-acceptance
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const filters = listCaseAcceptanceQuerySchema.parse(req.query);
    const result  = await caseAcceptanceService.list(req.scope!, filters);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/case-acceptance/summary — aggregate over the FULL filtered set,
// independent of pagination. Used by the admin dashboard.
router.get('/summary', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const filters = listCaseAcceptanceQuerySchema.parse(req.query);
    const summary = await caseAcceptanceService.summary(req.scope!, filters);
    res.json(summary);
  } catch (err) { next(err); }
});

// GET /api/case-acceptance/export — XLSX dump styled to match the source
// Google Sheet: cyan title bar, light-blue header, Y/N + ✔/X pills with
// background fills, dropdown-style grey cells for categorical columns, live
// =G/F formula for the Case Acceptance column. Excel data-validation
// dropdowns applied so users can edit the file just like the sheet.
router.get('/export', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const filters     = listCaseAcceptanceQuerySchema.parse(req.query);
    const rows        = await caseAcceptanceService.listAll(req.scope!, filters);
    const showClinic  = !filters.clinic_id; // Overall view → include Clinic column

    // ── Palette (matches the source sheet) ────────────────────────────────
    const C = {
      titleBg:    'FF46BDC6', // cyan title bar
      titleFg:    'FFFFFFFF',
      headerBg:   'FFC9DAF8', // light blue
      headerFg:   'FF1F2937',
      dropdownBg: 'FFEFEFEF', // category cells (light grey)
      yFill:      'FFD9EAD3', // Y pill (light green)
      yFg:        'FF274E13',
      nFill:      'FFF4CCCC', // N pill (light red)
      nFg:        'FF990000',
      tickFill:   'FF38761D', // ✔ pill (dark green)
      tickFg:     'FFFFFFFF',
      xFill:      'FFF4CCCC', // X pill (light pink)
      xFg:        'FF990000',
      border:     'FFB7B7B7',
    };

    interface ColumnSpec {
      header:    string;
      width:     number;
      align:     'left' | 'center' | 'right';
      dropdown?: boolean; // grey "category cell" look
    }
    const cols: ColumnSpec[] = [
      { header: 'Date',                          width: 11,  align: 'center' },
      ...(showClinic
        ? [{ header: 'Clinic',                   width: 12,  align: 'center' as const, dropdown: true }]
        : []),
      { header: 'Front of staff name',           width: 18,  align: 'center', dropdown: true },
      { header: 'Clinician name',                width: 16,  align: 'center', dropdown: true },
      { header: 'Patient name',                  width: 24,  align: 'left' },
      { header: 'Treatment plan provided Y/N',   width: 14,  align: 'center' },
      { header: 'Case Recommendations',          width: 13,  align: 'center' },
      { header: 'Appointments Booked',           width: 13,  align: 'center' },
      { header: 'Case Acceptance',               width: 12,  align: 'center' },
      { header: 'Prepay Offered',                width: 12,  align: 'center' },
      { header: 'Prepay Accepted',               width: 12,  align: 'center' },
      { header: 'Transition (TP Provided/Explained/Objections)', width: 18, align: 'center' },
      { header: "Notes (If they didn't book all appointments why?)", width: 48, align: 'left' },
    ];
    const colCount = cols.length;
    const idx = (header: string) => cols.findIndex((c) => c.header === header) + 1;

    const wb = new ExcelJS.Workbook();
    wb.creator        = 'PhysioWard';
    wb.created        = new Date();
    wb.lastModifiedBy = 'PhysioWard';

    const ws = wb.addWorksheet('Case Acceptance', {
      views: [{ state: 'frozen', ySplit: 2 }],
    });
    ws.columns = cols.map((c) => ({ width: c.width }));

    // ── Row 1: title bar ──────────────────────────────────────────────────
    const titleRow = ws.addRow(['Daily Case Recommendation & Acceptance Tracker']);
    ws.mergeCells(1, 1, 1, colCount);
    titleRow.height = 30;
    const titleCell = titleRow.getCell(1);
    titleCell.font      = { name: 'Calibri', size: 14, bold: true, color: { argb: C.titleFg } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
    titleCell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.titleBg } };
    applyBorders(titleCell, C.border);

    // ── Row 2: column headers ─────────────────────────────────────────────
    const headerRow = ws.addRow(cols.map((c) => c.header));
    headerRow.height = 42;
    headerRow.eachCell((cell) => {
      cell.font      = { name: 'Calibri', bold: true, size: 11, color: { argb: C.headerFg } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } };
      applyBorders(cell, C.border);
    });

    const ynText = (v: boolean | null): string =>
      v === true ? 'Y' : v === false ? 'N' : '';
    const tickText = (v: boolean | null): string =>
      v === true ? '✔' : v === false ? 'X' : '';

    // Column indexes (1-based) — used for per-cell styling + data validation.
    const C_DATE   = idx('Date');
    const C_CLINIC = showClinic ? idx('Clinic') : -1;
    const C_FS     = idx('Front of staff name');
    const C_CL     = idx('Clinician name');
    const C_PAT    = idx('Patient name');
    const C_TP     = idx('Treatment plan provided Y/N');
    const C_RECS   = idx('Case Recommendations');
    const C_BOOKED = idx('Appointments Booked');
    const C_PCT    = idx('Case Acceptance');
    const C_PPO    = idx('Prepay Offered');
    const C_PPA    = idx('Prepay Accepted');
    const C_TR     = idx('Transition (TP Provided/Explained/Objections)');
    const C_NOTES  = idx("Notes (If they didn't book all appointments why?)");

    // ── Data rows ─────────────────────────────────────────────────────────
    rows.forEach((r, i) => {
      const sheetRow = 3 + i; // title=1, header=2, data starts at 3
      const recsColLetter   = colLetter(C_RECS);
      const bookedColLetter = colLetter(C_BOOKED);

      const values: (string | number | Date | ExcelJS.CellFormulaValue | null)[] = [];
      values[C_DATE   - 1] = r.date_logged ? new Date(r.date_logged) : null;
      if (showClinic) values[C_CLINIC - 1] = CLINIC_LABEL[r.clinic_id] ?? r.clinic_id;
      values[C_FS     - 1] = r.front_staff_name ?? '';
      values[C_CL     - 1] = r.clinician_name   ?? '';
      values[C_PAT    - 1] = r.patient_name;
      values[C_TP     - 1] = ynText(r.treatment_plan_provided);
      values[C_RECS   - 1] = r.case_recommendations;
      values[C_BOOKED - 1] = r.appointments_booked;
      values[C_PCT    - 1] = {
        formula: `IFERROR(${bookedColLetter}${sheetRow}/${recsColLetter}${sheetRow},"")`,
        result:  r.case_acceptance_pct === null ? '' : r.case_acceptance_pct / 100,
      };
      values[C_PPO    - 1] = tickText(r.prepay_offered);
      values[C_PPA    - 1] = tickText(r.prepay_accepted);
      values[C_TR     - 1] = r.transition_notes ?? '';
      values[C_NOTES  - 1] = r.notes ?? '';

      const row = ws.addRow(values);
      row.height = 22;

      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const spec = cols[colNumber - 1];
        cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF111827' } };
        cell.alignment = {
          vertical:   'middle',
          horizontal: spec.align,
          wrapText:   spec.header.startsWith('Notes'),
        };
        applyBorders(cell, C.border);

        // Default fill for "category" columns.
        if (spec.dropdown) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.dropdownBg } };
        }
      });

      // Per-value pill fills (override the category default).
      paintYN(row.getCell(C_TP),  r.treatment_plan_provided, C);
      paintTick(row.getCell(C_PPO), r.prepay_offered,  C);
      paintTick(row.getCell(C_PPA), r.prepay_accepted, C);

      // Acceptance % cell — neutral background but with the percentage format.
      const pctCell = row.getCell(C_PCT);
      pctCell.numFmt    = '0%';
      pctCell.alignment = { vertical: 'middle', horizontal: 'center' };
    });

    // ── Per-column overrides ──────────────────────────────────────────────
    ws.getColumn(C_DATE).numFmt = 'd/m/yyyy';

    // ── Excel data validation (real dropdowns) ────────────────────────────
    const lastDataRow  = 2 + rows.length;
    const editableLast = Math.max(lastDataRow + 200, 1000);
    const yn   = `"Y,N"`;
    const tick = `"✔,X"`;
    for (let r = 3; r <= editableLast; r++) {
      ws.getCell(r, C_TP).dataValidation = {
        type: 'list', allowBlank: true, formulae: [yn],
        showErrorMessage: true, errorStyle: 'warning',
        errorTitle: 'Invalid value', error: 'Pick Y or N.',
      };
      for (const col of [C_PPO, C_PPA]) {
        ws.getCell(r, col).dataValidation = {
          type: 'list', allowBlank: true, formulae: [tick],
          showErrorMessage: true, errorStyle: 'warning',
          errorTitle: 'Invalid value', error: 'Pick ✔ or X.',
        };
      }
    }

    // Filterable header so the recipient can sort/filter immediately.
    ws.autoFilter = {
      from: { row: 2, column: 1 },
      to:   { row: 2, column: colCount },
    };

    const today = new Date().toISOString().slice(0, 10);
    const datePart = filters.date_from && filters.date_to
      ? `_${filters.date_from}_to_${filters.date_to}`
      : `_${today}`;
    const clinicPart = filters.clinic_id ? `_${filters.clinic_id}` : '';
    const filename = `case-acceptance${clinicPart}${datePart}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

function applyBorders(cell: ExcelJS.Cell, argb: string): void {
  const side = { style: 'thin' as const, color: { argb } };
  cell.border = { top: side, bottom: side, left: side, right: side };
}

function paintYN(
  cell: ExcelJS.Cell,
  v: boolean | null,
  C: { yFill: string; yFg: string; nFill: string; nFg: string }
): void {
  if (v === true) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.yFill } };
    cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: C.yFg } };
  } else if (v === false) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.nFill } };
    cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: C.nFg } };
  }
  // else: leave default white cell + default font
}

function paintTick(
  cell: ExcelJS.Cell,
  v: boolean | null,
  C: { tickFill: string; tickFg: string; xFill: string; xFg: string; dropdownBg: string }
): void {
  if (v === true) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.tickFill } };
    cell.font = { name: 'Calibri', size: 12, bold: true, color: { argb: C.tickFg } };
  } else if (v === false) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.xFill } };
    cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: C.xFg } };
  } else {
    // blank → grey dropdown look
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.dropdownBg } };
  }
}

function colLetter(col: number): string {
  // 1 → A, 27 → AA, etc. ExcelJS exposes Column.letter but only after a row
  // exists; this avoids the chicken-and-egg ordering issue inside row builders.
  let s = '';
  let n = col;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// GET /api/case-acceptance/:id
router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const row = await caseAcceptanceService.get(req.scope!, req.params.id);
    res.json(row);
  } catch (err) { next(err); }
});

// POST /api/case-acceptance
router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = createCaseAcceptanceSchema.parse(req.body);
    const row  = await caseAcceptanceService.create(req.scope!, body);
    await audit(req.scope!.userId, 'case_acceptance.create', { id: row.id, clinic_id: row.clinic_id });
    res.status(201).json(row);
  } catch (err) { next(err); }
});

// PATCH /api/case-acceptance/:id
router.patch('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const patch = updateCaseAcceptanceSchema.parse(req.body);
    const row   = await caseAcceptanceService.update(req.scope!, req.params.id, patch);
    await audit(req.scope!.userId, 'case_acceptance.update', { id: row.id });
    res.json(row);
  } catch (err) { next(err); }
});

// DELETE /api/case-acceptance/:id
router.delete('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await caseAcceptanceService.delete(req.scope!, req.params.id);
    await audit(req.scope!.userId, 'case_acceptance.delete', { id: req.params.id });
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
