import path from 'path';
import ExcelJS from 'exceljs';
import { pool, query, withTransaction } from './pool';
import { env } from '../config/env';
import { authService } from '../services/auth.service';
import { userRepository, UserRow } from '../repositories/user.repository';
import {
  DROPOUT_STATUSES, DROPOUT_REASONS, FRONT_STAFF_NAMES,
  DropoutStatus, DropoutReason, FrontStaffName,
} from '../shared/roles';

/**
 * One-shot import of the 2026 dropout-tracking spreadsheet into the
 * `patient_dropouts` table.
 *
 * Source layout (Sheet1):
 *   R1            Title row (ignored)
 *   R2            Header row (ignored)
 *   R3..end       Data rows. Columns:
 *     A Date | B Front-of-staff | C Clinician | D Patient name |
 *     E Appointment cancelled (DD.MM) | F Status | G Appts attended (ignored) |
 *     H Reason | I Notes | J Cross-checked (ignored)
 *
 * Defaults (confirmed with Sam 2026-04-30):
 *   - clinic_id  = 'newport' for every row
 *   - entered_by = the seeded ADMIN user (CEO_EMAIL from env)
 *   - empty Status / Reason → preserved as NULL (per migration 006).
 *     The manual entry form still requires both via zod; nullability is
 *     for legacy imported data only.
 *   - Cross-checked column dropped (no DB column)
 *   - Row 595 has an obvious typo "15/0/42026" — corrected to 2026-04-15
 *     (the rows around it are all dated 2026-04-15).
 *
 * Clinicians referenced in the sheet (Tim, Caitlin, Isabella, Noah, Gabby,
 * Kyle) are auto-provisioned as CLINICIAN-role users in the `newport`
 * clinic on first run, with email pattern `<firstname>@physioward.com.au`
 * and a temporary password from IMPORT_CLINICIAN_TEMP_PASSWORD (they should change it on first login).
 *
 * Usage:
 *   npm run db:import:dropouts                    # dry-run
 *   npm run db:import:dropouts -- --commit       # insert (needs IMPORT_* env below)
 *   npm run db:import:dropouts -- --xlsx <path>  # override spreadsheet path
 *
 * Secrets / paths (never hardcode — use env or CLI):
 *   IMPORT_DROPOUTS_XLSX           — default spreadsheet path if --xlsx omitted
 *   IMPORT_CLINICIAN_TEMP_PASSWORD — required with --commit when new clinicians are created;
 *                                    min 8 chars; users must change after first login.
 */

const TARGET_CLINIC = 'newport';
const SOURCE_YEAR   = 2026;

function resolveSpreadsheetPath(cliPath: string | undefined): string {
  const fromEnv = process.env.IMPORT_DROPOUTS_XLSX?.trim();
  const p       = cliPath ?? fromEnv;
  if (!p) {
    throw new Error(
      'Set IMPORT_DROPOUTS_XLSX in .env or pass --xlsx <path> to the import script.'
    );
  }
  return p;
}

/** Required when --commit may create clinician accounts; validated before DB writes. */
function resolveCommitClinicianTempPassword(): string {
  const pwd = process.env.IMPORT_CLINICIAN_TEMP_PASSWORD?.trim() ?? '';
  if (pwd.length < 8) {
    throw new Error(
      'IMPORT_CLINICIAN_TEMP_PASSWORD must be set (min 8 characters) when using --commit.'
    );
  }
  return pwd;
}

/**
 * Manual date_logged overrides for rows where the source spreadsheet has a
 * clear typo. Keyed by 1-indexed sheet row number. Verified by inspecting
 * the rows immediately above/below in the sheet.
 */
const DATE_LOGGED_OVERRIDES: Record<number, string> = {
  595: '2026-04-15', // sheet has "15/0/42026" — neighbours all dated 2026-04-15
};

// Cells the spreadsheet exposes — fixed positions.
const COL = {
  date_logged:    1,
  front_staff:    2,
  clinician:      3,
  patient:        4,
  appt_cancelled: 5,
  status:         6,
  reason:         8,
  notes:          9,
} as const;

type ParsedRow = {
  rowIdx:         number;          // 1-indexed row number in the sheet
  date_logged:    string | null;   // YYYY-MM-DD
  front_staff:    string | null;
  clinician:      string | null;
  patient:        string | null;
  appt_cancelled: string | null;   // YYYY-MM-DD
  status:         string | null;
  reason:         string | null;
  notes:          string | null;
};

type ValidRow = {
  clinic_id:                  string;
  entered_by:                 string;
  front_staff_name:           FrontStaffName | null;
  clinician_id:               string;
  patient_name:                string;
  date_logged:                 string;
  appointment_cancelled_dates: string[];
  status:                      DropoutStatus | null;
  reason:                      DropoutReason | null;
  notes:                       string | null;
};

type SkippedRow = { rowIdx: number; reason: string };

function readCell(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? null : t;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    if (Array.isArray(obj.richText)) {
      const text = (obj.richText as Array<{ text?: string }>)
        .map((p) => p.text ?? '')
        .join('')
        .trim();
      return text === '' ? null : text;
    }
    if (typeof obj.text === 'string') {
      const t = obj.text.trim();
      return t === '' ? null : t;
    }
    if ('result' in obj) return readCell(obj.result);
  }
  return null;
}

/**
 * Date_logged accepts: a JS Date (Excel-formatted cell), an ISO string, or
 * "DD/M/YYYY" / "DD/MM/YYYY" (which is how the later rows of the sheet
 * appear once the column was overridden manually).
 */
function parseDateLogged(rawCell: unknown): string | null {
  if (rawCell instanceof Date) return rawCell.toISOString().slice(0, 10);
  const s = readCell(rawCell);
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return s.slice(0, 10);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

/**
 * Appointment cancelled date is a "calendar shorthand" the staff write as
 * DD.MM (e.g. "19.01"). Year is implied (sheet is for {SOURCE_YEAR}).
 */
function parseApptCancelled(rawCell: unknown): string | null {
  if (rawCell instanceof Date) return rawCell.toISOString().slice(0, 10);
  const s = readCell(rawCell);
  if (!s) return null;
  let m = s.match(/^(\d{1,2})[./-](\d{1,2})$/);
  if (m) return `${SOURCE_YEAR}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (m) {
    const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yyyy}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return s.slice(0, 10);
  return null;
}

async function parseSheet(filePath: string): Promise<ParsedRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error(`No worksheet in ${filePath}`);

  const out: ParsedRow[] = [];
  for (let r = 3; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const dateRaw  = row.getCell(COL.date_logged).value;
    const fos      = readCell(row.getCell(COL.front_staff).value);
    const cl       = readCell(row.getCell(COL.clinician).value);
    const patient  = readCell(row.getCell(COL.patient).value);
    const apptRaw  = row.getCell(COL.appt_cancelled).value;
    const status   = readCell(row.getCell(COL.status).value);
    const reason   = readCell(row.getCell(COL.reason).value);
    const notes    = readCell(row.getCell(COL.notes).value);

    // Skip fully blank rows.
    if (!dateRaw && !fos && !cl && !patient && !status) continue;

    out.push({
      rowIdx:         r,
      date_logged:    DATE_LOGGED_OVERRIDES[r] ?? parseDateLogged(dateRaw),
      front_staff:    fos,
      clinician:      cl,
      patient:        patient,
      appt_cancelled: parseApptCancelled(apptRaw),
      status:         status,
      reason:         reason,
      notes:          notes,
    });
  }
  return out;
}

/**
 * Try to find an existing user whose full_name matches the first-name token
 * from the sheet. Match is case-insensitive and accepts either the bare
 * first name ("Tim") or "Tim <lastname>".
 */
async function findClinicianByFirstName(firstName: string): Promise<UserRow | null> {
  const { rows } = await query<UserRow>(
    `SELECT *
       FROM users
      WHERE role = 'CLINICIAN'
        AND clinic_id = $1
        AND (
          LOWER(full_name) = LOWER($2)
          OR LOWER(full_name) LIKE LOWER($3)
        )
      ORDER BY id ASC
      LIMIT 1`,
    [TARGET_CLINIC, firstName, `${firstName} %`]
  );
  return rows[0] ?? null;
}

function firstNameToEmail(firstName: string): string {
  return `${firstName.toLowerCase()}@physioward.com.au`;
}

async function ensureClinician(
  firstName: string,
  commit: boolean,
  tempPasswordPlain: string
): Promise<{ id: string | null; created: boolean; email: string }> {
  const existing = await findClinicianByFirstName(firstName);
  if (existing) {
    return { id: existing.id, created: false, email: existing.email };
  }
  const email = firstNameToEmail(firstName);

  // Avoid an email collision (e.g. someone seeded `tim@physioward.com.au` as
  // a different role/clinic). If it exists at all we reuse it.
  const byEmail = await userRepository.findByEmail(email);
  if (byEmail) {
    return { id: byEmail.id, created: false, email: byEmail.email };
  }

  if (!commit) return { id: null, created: true, email };

  const passwordHash = await authService.hashPassword(tempPasswordPlain);
  const created = await userRepository.create({
    email,
    passwordHash,
    role:      'CLINICIAN',
    full_name: firstName,
    clinic_id: TARGET_CLINIC,
  });
  return { id: created.id, created: true, email: created.email };
}

function normalizeFrontStaff(raw: string | null): FrontStaffName | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const match = (FRONT_STAFF_NAMES as readonly string[]).find(
    (n) => n.toLowerCase() === trimmed.toLowerCase()
  );
  return (match ?? null) as FrontStaffName | null;
}

function validateRow(
  r: ParsedRow,
  enteredBy: string,
  clinicianMap: Map<string, string>
): { ok: true; value: ValidRow } | { ok: false; reason: string } {
  if (!r.date_logged) return { ok: false, reason: 'unparseable date_logged' };
  if (!r.patient)    return { ok: false, reason: 'missing patient_name' };
  if (!r.clinician)  return { ok: false, reason: 'missing clinician name' };

  const clinicianId = clinicianMap.get(r.clinician);
  if (!clinicianId) {
    return { ok: false, reason: `clinician "${r.clinician}" not provisioned` };
  }

  // Status / Reason are NULLable in the DB (migration 006). If a non-null
  // value is present it must be in the whitelist; blank → NULL passthrough.
  let status: DropoutStatus | null = null;
  if (r.status) {
    if (!(DROPOUT_STATUSES as readonly string[]).includes(r.status)) {
      return { ok: false, reason: `unknown status "${r.status}"` };
    }
    status = r.status as DropoutStatus;
  }

  let reason: DropoutReason | null = null;
  if (r.reason) {
    if (!(DROPOUT_REASONS as readonly string[]).includes(r.reason)) {
      return { ok: false, reason: `unknown reason "${r.reason}"` };
    }
    reason = r.reason as DropoutReason;
  }

  const front = normalizeFrontStaff(r.front_staff);

  return {
    ok: true,
    value: {
      clinic_id:                   TARGET_CLINIC,
      entered_by:                  enteredBy,
      front_staff_name:            front,
      clinician_id:                clinicianId,
      patient_name:                r.patient.slice(0, 200),
      date_logged:                 r.date_logged,
      // Source sheet has at most one cancellation date per row — promote
      // it to a single-element array, or [] when blank.
      appointment_cancelled_dates: r.appt_cancelled ? [r.appt_cancelled] : [],
      status,
      reason,
      notes:                       r.notes ? r.notes.slice(0, 2000) : null,
    },
  };
}

function getArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}

export async function run(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const xlsx   = resolveSpreadsheetPath(getArg('--xlsx'));
  const clinicianTempPwd = commit ? resolveCommitClinicianTempPassword() : '';

  console.log(`[import] mode:   ${commit ? 'COMMIT' : 'DRY-RUN'}`);
  console.log(`[import] source: ${path.resolve(xlsx)}`);
  console.log(`[import] clinic: ${TARGET_CLINIC}`);

  const admin = await userRepository.findByEmail(env.CEO_EMAIL);
  if (!admin) throw new Error(`Admin user ${env.CEO_EMAIL} not found — run db:seed first.`);
  console.log(`[import] entered_by: ${admin.email} (id=${admin.id})`);

  const rows = await parseSheet(xlsx);
  console.log(`[import] parsed ${rows.length} non-empty data rows`);

  // Collect every distinct clinician name referenced in the sheet, then
  // ensure each one has a CLINICIAN account in the target clinic.
  const namesInSheet = [...new Set(rows.map((r) => r.clinician).filter((s): s is string => !!s))];
  console.log(`[import] clinicians referenced: ${namesInSheet.join(', ')}`);

  const clinicianMap = new Map<string, string>(); // sheet name → user.id
  console.log(`\n[import] provisioning clinicians:`);
  for (const name of namesInSheet) {
    const r = await ensureClinician(name, commit, clinicianTempPwd);
    if (r.id === null) {
      console.log(`  + would create  ${name.padEnd(10)}  ${r.email}  (CLINICIAN, ${TARGET_CLINIC})`);
    } else if (r.created) {
      console.log(`  + created       ${name.padEnd(10)}  ${r.email}  (id=${r.id})`);
    } else {
      console.log(`  ✓ exists        ${name.padEnd(10)}  ${r.email}  (id=${r.id})`);
    }
    if (r.id !== null) clinicianMap.set(name, r.id);
  }
  if (commit && namesInSheet.some((n) => !clinicianMap.has(n))) {
    throw new Error('Some clinicians failed to provision — aborting');
  }

  // For dry-run we still want the validation pass to "succeed" past the
  // clinician check, so seed missing entries with a placeholder id.
  if (!commit) {
    for (const name of namesInSheet) {
      if (!clinicianMap.has(name)) clinicianMap.set(name, '<dry-run>');
    }
  }

  // Validate every row.
  const valid:   ValidRow[]   = [];
  const skipped: SkippedRow[] = [];
  const nullStatusRows: number[] = [];
  const nullReasonRows: number[] = [];
  const frontStaffUnknown: { rowIdx: number; raw: string }[] = [];

  for (const r of rows) {
    if (r.front_staff && !normalizeFrontStaff(r.front_staff)) {
      frontStaffUnknown.push({ rowIdx: r.rowIdx, raw: r.front_staff });
    }
    if (!r.status) nullStatusRows.push(r.rowIdx);
    if (!r.reason) nullReasonRows.push(r.rowIdx);

    const result = validateRow(r, admin.id, clinicianMap);
    if (result.ok) valid.push(result.value);
    else skipped.push({ rowIdx: r.rowIdx, reason: result.reason });
  }

  console.log(`\n[import] validation:`);
  console.log(`  valid           ${valid.length}`);
  console.log(`  skipped         ${skipped.length}`);
  console.log(`  status NULL     ${nullStatusRows.length}  (preserved from blank source)`);
  console.log(`  reason NULL     ${nullReasonRows.length}  (preserved from blank source)`);
  if (frontStaffUnknown.length) {
    console.log(`  front-staff unknown (left NULL): ${frontStaffUnknown.length}`);
    for (const f of frontStaffUnknown.slice(0, 10)) {
      console.log(`    row ${f.rowIdx}: "${f.raw}"`);
    }
    if (frontStaffUnknown.length > 10) {
      console.log(`    … and ${frontStaffUnknown.length - 10} more`);
    }
  }
  if (skipped.length) {
    console.log(`\n[import] skipped rows:`);
    for (const s of skipped) console.log(`  row ${s.rowIdx}: ${s.reason}`);
  }

  if (!commit) {
    console.log(`\n[import] DRY-RUN complete. Re-run with --commit to insert ${valid.length} rows.`);
    return;
  }

  console.log(`\n[import] committing ${valid.length} rows in a transaction…`);
  await withTransaction(async (client) => {
    for (const v of valid) {
      await client.query(
        `INSERT INTO patient_dropouts (
           clinic_id, entered_by, front_staff_name, clinician_id,
           patient_name, date_logged, appointment_cancelled_dates,
           status, reason, notes
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::date[],$8,$9,$10)`,
        [
          v.clinic_id, v.entered_by, v.front_staff_name, v.clinician_id,
          v.patient_name, v.date_logged, v.appointment_cancelled_dates,
          v.status, v.reason, v.notes,
        ]
      );
    }
  });
  console.log(`[import] inserted ${valid.length} rows into patient_dropouts.`);
  console.log(
    '[import] If new clinician accounts were created, they share the temporary password from IMPORT_CLINICIAN_TEMP_PASSWORD — share out-of-band and have each user change it on first login.'
  );
}

if (require.main === module) {
  run()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[import] failed:', err);
      pool.end().finally(() => process.exit(1));
    });
}
