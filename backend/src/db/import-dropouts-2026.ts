import path from 'path';
import ExcelJS from 'exceljs';
import { pool, query, withTransaction } from './pool';
import { env } from '../config/env';
import { authService } from '../services/auth.service';
import { userRepository, UserRow } from '../repositories/user.repository';
import {
  DROPOUT_STATUSES, DROPOUT_REASONS,
  DropoutStatus, DropoutReason,
  CLINIC_IDS, ClinicId, isClinicId,
} from '../shared/roles';

/**
 * Multi-clinic import of the 2026 Daily Patient Dropout Tracking spreadsheets
 * into `patient_dropouts`. Mirrors `import-case-acceptance.ts` — per-clinic
 * quirks (column layout, name aliases, reason aliases) live in CLINIC_CONFIG.
 *
 * Source layout (Sheet1, header on row 1):
 *   Brookvale / Newport  (8 cols):
 *     A Date | B Front-of-staff | C Clinician | D Patient name |
 *     E Appt cancelled | F Status | G Reason | H Notes
 *   Narrabeen (9 cols — extra "Appts Attended on DC" col at G, ignored):
 *     A Date | B Front-of-staff | C Clinician | D Patient name |
 *     E Appt cancelled | F Status | G (ignored) | H Reason | I Notes
 *
 * Quirks handled per clinic (confirmed with Sam 2026-05-11):
 *   - Brookvale lists clinicians ("Angus", "Jervis", "Sam", "Emma physio") in
 *     the front-of-staff column when the physio took the call themselves —
 *     aliased to "Other - Physio".
 *   - Narrabeen: "Work" reason → "Work Commitments"; "Zac" clinician → "Zach";
 *     "Reformer Bed" / "Sam" / "Other - Physio" in the clinician column are
 *     skipped (not real clinicians).
 *   - "Physio Discharged" reason → "Discharged" (DB whitelist) for every clinic.
 *   - Appointment-cancelled column is a free-form scratch field:
 *       • real Date  → ISO date
 *       • "DD/MM/YYYY" / "DD.MM.YY" / "DD.MM" / numeric DD.MM (year inferred)
 *       • anything else ("discharged", "all", blank) → no cancellation recorded
 *
 * Usage:
 *   npm run db:import:dropouts -- --clinic newport                    # dry-run
 *   npm run db:import:dropouts -- --clinic newport --commit           # insert
 *   npm run db:import:dropouts -- --clinic narrabeen --xlsx <path>    # custom path
 *
 * Secrets / paths (never hardcode):
 *   IMPORT_DROPOUTS_XLSX             — default spreadsheet path if --xlsx omitted
 *   IMPORT_DROPOUTS_BROOKVALE_XLSX   — per-clinic path overrides (optional)
 *   IMPORT_DROPOUTS_NARRABEEN_XLSX
 *   IMPORT_DROPOUTS_NEWPORT_XLSX
 *   IMPORT_CLINICIAN_TEMP_PASSWORD   — required with --commit when new clinicians
 *                                      need provisioning; min 8 chars.
 */

const SOURCE_YEAR = 2026;

interface ColumnMap {
  date_logged:    number;
  front_staff:    number;
  clinician:      number;
  patient:        number;
  appt_cancelled: number;
  status:         number;
  reason:         number;
  notes:          number;
}

interface ClinicConfig {
  /** First data row (1-indexed). Headers occupy the rows above. */
  firstDataRow:        number;
  /** 1-indexed column positions for each field. */
  cols:                ColumnMap;
  /** Map sheet-text → canonical front-of-staff name; `null` value → store NULL. */
  frontStaffAliases:   Record<string, string | null>;
  /** Map sheet-text → canonical clinician name. */
  clinicianAliases:    Record<string, string>;
  /** Sheet-text values that mean "not a real clinician" — row is skipped. */
  clinicianSkips:      readonly string[];
  /** Map sheet-text → canonical DROPOUT_REASONS value. */
  reasonAliases:       Record<string, DropoutReason>;
  /** Hard date_logged overrides keyed by 1-indexed sheet row (typos). */
  dateLoggedOverrides: Record<number, string>;
}

const BASE_COLS_8: ColumnMap = {
  date_logged:    1,
  front_staff:    2,
  clinician:      3,
  patient:        4,
  appt_cancelled: 5,
  status:         6,
  reason:         7,
  notes:          8,
};

const NARRABEEN_COLS_9: ColumnMap = {
  date_logged:    1,
  front_staff:    2,
  clinician:      3,
  patient:        4,
  appt_cancelled: 5,
  status:         6,
  // col 7 = "Appts Attended on DC" (ignored — not a DB field)
  reason:         8,
  notes:          9,
};

const CLINIC_CONFIG: Record<ClinicId, ClinicConfig> = {
  brookvale: {
    firstDataRow: 2,
    cols:         BASE_COLS_8,
    // Physios who took the call themselves get rolled up to "Other - Physio".
    // Plain "Sam" (CEO) likewise — he's not a front-desk role.
    frontStaffAliases: {
      jesse:          'Other - Physio',
      'Emma physio':  'Other - Physio',
      'Jesse physio': 'Other - Physio',
      physio:         'Other - Physio',
      Angus:          'Other - Physio',
      Jervis:         'Other - Physio',
      Sam:            'Other - Physio',
    },
    clinicianAliases: {},
    clinicianSkips:   ['Other - Physio'],
    reasonAliases:    { 'Physio Discharged': 'Discharged' },
    dateLoggedOverrides: {},
  },
  narrabeen: {
    firstDataRow: 2,
    cols:         NARRABEEN_COLS_9,
    frontStaffAliases: {
      'No reception':        null,
      'Front of staff name': null, // accidental header-row paste in data area
    },
    clinicianAliases:    { Zac: 'Zach' },
    clinicianSkips:      ['Reformer Bed', 'Sam', 'Other - Physio'],
    reasonAliases:       {
      Work:                'Work Commitments',
      'Physio Discharged': 'Discharged',
    },
    dateLoggedOverrides: {},
  },
  newport: {
    firstDataRow:        2,
    cols:                BASE_COLS_8,
    frontStaffAliases:   {},
    clinicianAliases:    {},
    clinicianSkips:      ['Other - Physio'],
    reasonAliases:       { 'Physio Discharged': 'Discharged' },
    // Row 594: sheet has "15/0/42026" — clear typo (neighbours dated 2026-04-15).
    // Rows 763–771: Date column left blank by staff but otherwise real entries
    // (patients filled, statuses present). Sam confirmed 2026-05-11: stamp them
    // with today's date so they don't get dropped.
    dateLoggedOverrides: {
      594: '2026-04-15',
      763: '2026-05-11',
      764: '2026-05-11',
      765: '2026-05-11',
      766: '2026-05-11',
      767: '2026-05-11',
      768: '2026-05-11',
      769: '2026-05-11',
      770: '2026-05-11',
      771: '2026-05-11',
    },
  },
};

type ParsedRow = {
  rowIdx:         number;
  date_logged:    string | null;
  front_staff:    string | null;
  clinician:      string | null;
  patient:        string | null;
  /** Zero or more ISO dates parsed from the cancellation column. */
  appt_cancelled: string[];
  status:         string | null;
  reason:         string | null;
  notes:          string | null;
};

type ValidRow = {
  clinic_id:                   string;
  entered_by:                  string;
  front_staff_name:            string | null;
  clinician_id:                string;
  patient_name:                string;
  date_logged:                 string;
  appointment_cancelled_dates: string[];
  status:                      DropoutStatus | null;
  reason:                      DropoutReason | null;
  notes:                       string | null;
};

type SkippedRow = { rowIdx: number; reason: string };

function resolveSpreadsheetPath(clinic: ClinicId, cliPath: string | undefined): string {
  const perClinicEnvKey =
    `IMPORT_DROPOUTS_${clinic.toUpperCase()}_XLSX` as const;
  const fromPerClinicEnv = process.env[perClinicEnvKey]?.trim();
  const fromGenericEnv   = process.env.IMPORT_DROPOUTS_XLSX?.trim();
  const p = cliPath ?? fromPerClinicEnv ?? fromGenericEnv;
  if (!p) {
    throw new Error(
      `No spreadsheet path. Pass --xlsx <path>, or set ${perClinicEnvKey} / IMPORT_DROPOUTS_XLSX in .env.`
    );
  }
  return p;
}

function resolveClinic(cliClinic: string | undefined): ClinicId {
  if (!cliClinic) {
    throw new Error(`Pass --clinic <id> (one of: ${CLINIC_IDS.join(', ')}).`);
  }
  if (!isClinicId(cliClinic)) {
    throw new Error(`Unknown clinic "${cliClinic}". Valid: ${CLINIC_IDS.join(', ')}.`);
  }
  return cliClinic;
}

function resolveCommitClinicianTempPassword(): string {
  const pwd = process.env.IMPORT_CLINICIAN_TEMP_PASSWORD?.trim() ?? '';
  if (pwd.length < 8) {
    throw new Error(
      'IMPORT_CLINICIAN_TEMP_PASSWORD must be set (min 8 characters) when using --commit and new clinicians need provisioning.'
    );
  }
  return pwd;
}

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
 * date_logged accepts: Date object (Excel-formatted), ISO ("2026-01-05" or
 * "2026-01-05T..."), Australian DD/MM/YYYY, or DD.MM.YYYY/YY.
 */
function parseDateLogged(rawCell: unknown): string | null {
  if (rawCell instanceof Date) return rawCell.toISOString().slice(0, 10);
  const s = readCell(rawCell);
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return s.slice(0, 10);
  m = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})$/);
  if (m) {
    const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yyyy}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

function pad2(n: string | number): string {
  return String(n).padStart(2, '0');
}

/**
 * Parse a single space-separated token into an ISO date, given an optional
 * sharedMonth (used when a bare day like "20" appears next to "27.03" — the
 * "20" inherits month 03).
 *   • "20.03"      → ${YEAR}-03-20
 *   • "20/03"      → ${YEAR}-03-20
 *   • "20.03.26"   → 2026-03-20
 *   • "20/03/2026" → 2026-03-20
 *   • "20"         → ${YEAR}-${sharedMonth}-20  (when sharedMonth provided)
 *   • anything else → null
 */
function parseDateToken(tok: string, sharedMonth: number | null): string | null {
  let m = tok.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})$/);
  if (m) {
    const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yyyy}-${pad2(m[2])}-${pad2(m[1])}`;
  }
  m = tok.match(/^(\d{1,2})[\/.](\d{1,2})$/);
  if (m) return `${SOURCE_YEAR}-${pad2(m[2])}-${pad2(m[1])}`;
  m = tok.match(/^(\d{1,2})$/);
  if (m && sharedMonth !== null) {
    return `${SOURCE_YEAR}-${pad2(sharedMonth)}-${pad2(m[1])}`;
  }
  return null;
}

/**
 * Appointment-cancelled column is a free-form scratch field. The cell can hold:
 *   • a real Excel Date          → single ISO date
 *   • single shorthand "19.01"   → year inferred from SOURCE_YEAR
 *   • Excel-coerced number 22.01 → "DD.MM" (read via cell.text + numeric fallback)
 *   • full "DD/MM/YYYY"          → as-is
 *   • multi-date list:
 *       "18.02, 23.02, 02.03"           → 3 dates, each with own month
 *       "20.03,27.03,02.04,08.04,10.04" → 5 dates, each with own month
 *       "12,14.05"                      → 2 dates sharing month 05
 *       "14,21,28.05  4,11,18.06"       → 6 dates across 2 groups
 *       "6.01 & 20.01" / "13,16,23,30.01 and 06,13.02" → "&"/"and" treated as separators
 *   • non-date text ("discharged", "all", "DNA", "self discharge") → []
 *
 * Returns an array of unique ISO dates (deduped to protect against accidental
 * repeats). Capped at 50 to match the validator schema.
 */
function parseApptCancelledMulti(cell: ExcelJS.Cell): string[] {
  const v = cell.value;
  if (v === null || v === undefined) return [];

  if (v instanceof Date) return [v.toISOString().slice(0, 10)];

  let text: string;
  if (typeof v === 'number') {
    text = (cell.text ?? '').trim();
    if (!text) {
      const day   = Math.floor(v);
      const month = Math.round((v - day) * 100);
      if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
        return [`${SOURCE_YEAR}-${pad2(month)}-${pad2(day)}`];
      }
      return [];
    }
  } else {
    const s = readCell(v);
    if (!s) return [];
    text = s;
  }

  // Single ISO date short-circuit.
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return [text.slice(0, 10)];

  // Strip non-date annotations. Commas, "&", "and", and runs of whitespace all
  // act as token separators — the look-ahead loop below figures out which
  // bare-day tokens share which month, so group boundaries don't need to be
  // tracked separately.
  const normalized = text
    .replace(/\(/g, ' ').replace(/\)/g, ' ')
    .replace(/\b(?:and|AND|And|DNA|dna)\b/g, ' ');

  const tokens = normalized
    .split(/[,\s&]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  // Matches "DD.MM" or "DD.MM.YY[YY]" (and "/" variants). Used both to detect
  // and to extract the month from a token.
  const monthRegex = /^(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?$/;
  const out: string[] = [];

  let i = 0;
  while (i < tokens.length) {
    // Look ahead for the NEXT token carrying an explicit month — bare days
    // before that token (e.g. "14,16,21,29.04") inherit ITS month, not the
    // right-most month later in the cell. Critical for entries like
    // "14,16,21,29.04,05,12,26.05,09,23.06" where 14/16/21 belong to April,
    // 05/12 belong to May, and 09 belongs to June.
    let j = i;
    while (j < tokens.length && !monthRegex.test(tokens[j])) j++;
    if (j >= tokens.length) break;

    const m           = tokens[j].match(monthRegex)!;
    const sharedMonth = parseInt(m[2], 10);

    for (let k = i; k < j; k++) {
      const bare = tokens[k].match(/^(\d{1,2})$/);
      if (bare) {
        out.push(`${SOURCE_YEAR}-${pad2(sharedMonth)}-${pad2(bare[1])}`);
      }
    }

    const explicit = parseDateToken(tokens[j], sharedMonth);
    if (explicit) out.push(explicit);

    i = j + 1;
  }

  return [...new Set(out)].slice(0, 50);
}

async function parseSheet(filePath: string, cfg: ClinicConfig): Promise<ParsedRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error(`No worksheet in ${filePath}`);

  const c   = cfg.cols;
  const out: ParsedRow[] = [];
  for (let r = cfg.firstDataRow; r <= ws.rowCount; r++) {
    const row     = ws.getRow(r);
    const dateRaw = row.getCell(c.date_logged).value;
    const fos     = readCell(row.getCell(c.front_staff).value);
    const cl      = readCell(row.getCell(c.clinician).value);
    const patient = readCell(row.getCell(c.patient).value);
    const apptDates = parseApptCancelledMulti(row.getCell(c.appt_cancelled));
    const status  = readCell(row.getCell(c.status).value);
    const reason  = readCell(row.getCell(c.reason).value);
    const notes   = readCell(row.getCell(c.notes).value);

    // Skip fully blank rows.
    if (!dateRaw && !fos && !cl && !patient && !status) continue;

    out.push({
      rowIdx:         r,
      date_logged:    cfg.dateLoggedOverrides[r] ?? parseDateLogged(dateRaw),
      front_staff:    fos,
      clinician:      cl,
      patient,
      appt_cancelled: apptDates,
      status,
      reason,
      notes,
    });
  }
  return out;
}

function firstWord(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

async function findClinicianByFirstName(firstName: string, clinic: ClinicId): Promise<UserRow | null> {
  const fw = firstWord(firstName);
  const { rows } = await query<UserRow>(
    `SELECT *
       FROM users
      WHERE role = 'CLINICIAN'
        AND clinic_id = $1
        AND (
          LOWER(full_name) = LOWER($2)
          OR LOWER(full_name) = LOWER($3)
          OR LOWER(full_name) LIKE LOWER($4)
        )
      ORDER BY id ASC
      LIMIT 1`,
    [clinic, firstName, fw, `${fw} %`]
  );
  return rows[0] ?? null;
}

/**
 * Cross-clinic reuse — per Sam (2026-05-11), some physios rotate between
 * clinics, so an existing CLINICIAN account is reused regardless of its
 * primary clinic_id. The dropout scope filter goes by clinician_id (not
 * clinic_id), so the same user sees entries from every clinic they cover.
 */
async function findClinicianAnywhere(firstName: string): Promise<UserRow | null> {
  const fw = firstWord(firstName);
  const { rows } = await query<UserRow>(
    `SELECT *
       FROM users
      WHERE role = 'CLINICIAN'
        AND is_active = true
        AND (
          LOWER(full_name) = LOWER($1)
          OR LOWER(full_name) = LOWER($2)
          OR LOWER(full_name) LIKE LOWER($3)
        )
      ORDER BY id ASC
      LIMIT 1`,
    [firstName, fw, `${fw} %`]
  );
  return rows[0] ?? null;
}

function firstNameToEmail(firstName: string): string {
  const local = firstName.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9.+_-]/g, '');
  return `${local}@physioward.com.au`;
}

async function ensureClinician(
  firstName: string,
  clinic: ClinicId,
  commit: boolean,
  tempPasswordPlain: string
): Promise<{ id: string | null; created: boolean; reused: boolean; email: string }> {
  const inTarget = await findClinicianByFirstName(firstName, clinic);
  if (inTarget) {
    return { id: inTarget.id, created: false, reused: false, email: inTarget.email };
  }

  const elsewhere = await findClinicianAnywhere(firstName);
  if (elsewhere) {
    return { id: elsewhere.id, created: false, reused: true, email: elsewhere.email };
  }

  const baseEmail = firstNameToEmail(firstName);
  let   email     = baseEmail;
  const baseTaken = await userRepository.findByEmail(baseEmail);
  if (baseTaken) {
    email = `${firstName.toLowerCase().replace(/[^a-z0-9]/g, '')}-${clinic}@physioward.com.au`;
  }
  if (!commit) return { id: null, created: true, reused: false, email };

  const passwordHash = await authService.hashPassword(tempPasswordPlain);
  const created = await userRepository.create({
    email,
    passwordHash,
    role:      'CLINICIAN',
    full_name: firstName,
    clinic_id: clinic,
  });
  return { id: created.id, created: true, reused: false, email: created.email };
}

function validateRow(
  r: ParsedRow,
  cfg: ClinicConfig,
  clinic: ClinicId,
  enteredBy: string,
  clinicianMap: Map<string, string>
): { ok: true; value: ValidRow } | { ok: false; reason: string } {
  if (!r.date_logged) return { ok: false, reason: 'unparseable date_logged' };
  if (!r.patient)     return { ok: false, reason: 'missing patient_name' };
  if (!r.clinician)   return { ok: false, reason: 'missing clinician name' };

  if (cfg.clinicianSkips.includes(r.clinician)) {
    return { ok: false, reason: `clinician "${r.clinician}" not a real clinician (skipped)` };
  }

  const clinicianKey = cfg.clinicianAliases[r.clinician] ?? r.clinician;
  const clinicianId  = clinicianMap.get(clinicianKey);
  if (!clinicianId) {
    return { ok: false, reason: `clinician "${r.clinician}" not provisioned in ${clinic}` };
  }

  // Status / Reason: blank → NULL passthrough (migration 006); non-null must
  // be in the whitelist after alias resolution.
  let status: DropoutStatus | null = null;
  if (r.status) {
    if (!(DROPOUT_STATUSES as readonly string[]).includes(r.status)) {
      return { ok: false, reason: `unknown status "${r.status}"` };
    }
    status = r.status as DropoutStatus;
  }

  let reason: DropoutReason | null = null;
  if (r.reason) {
    const aliased = cfg.reasonAliases[r.reason] ?? r.reason;
    if (!(DROPOUT_REASONS as readonly string[]).includes(aliased)) {
      return { ok: false, reason: `unknown reason "${r.reason}"` };
    }
    reason = aliased as DropoutReason;
  }

  // front_staff_name is free-form text in the DB (no enum check). Apply
  // per-clinic alias if present; otherwise store trimmed verbatim.
  let frontStaff: string | null = null;
  if (r.front_staff) {
    if (Object.prototype.hasOwnProperty.call(cfg.frontStaffAliases, r.front_staff)) {
      frontStaff = cfg.frontStaffAliases[r.front_staff];
    } else {
      frontStaff = r.front_staff.trim().slice(0, 120);
    }
  }

  return {
    ok: true,
    value: {
      clinic_id:                   clinic,
      entered_by:                  enteredBy,
      front_staff_name:            frontStaff,
      clinician_id:                clinicianId,
      patient_name:                r.patient.slice(0, 200),
      date_logged:                 r.date_logged,
      appointment_cancelled_dates: r.appt_cancelled,
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
  const clinic = resolveClinic(getArg('--clinic'));
  const xlsx   = resolveSpreadsheetPath(clinic, getArg('--xlsx'));
  const cfg    = CLINIC_CONFIG[clinic];

  console.log(`[import] mode:   ${commit ? 'COMMIT' : 'DRY-RUN'}`);
  console.log(`[import] source: ${path.resolve(xlsx)}`);
  console.log(`[import] clinic: ${clinic}`);

  const admin = await userRepository.findByEmail(env.CEO_EMAIL);
  if (!admin) throw new Error(`Admin user ${env.CEO_EMAIL} not found — run db:seed first.`);
  console.log(`[import] entered_by: ${admin.email} (id=${admin.id})`);

  const rows = await parseSheet(xlsx, cfg);
  console.log(`[import] parsed ${rows.length} non-empty data rows`);

  // Distinct clinician names (after alias / skip resolution).
  const namesInSheet = [...new Set(
    rows
      .map((r) => r.clinician)
      .filter((s): s is string => !!s)
      .filter((s) => !cfg.clinicianSkips.includes(s))
      .map((s) => cfg.clinicianAliases[s] ?? s)
  )];
  console.log(`[import] clinicians referenced (after aliases): ${namesInSheet.join(', ')}`);

  const needsCreate = commit && await needsProvisioning(namesInSheet, clinic);
  const tempPwd     = needsCreate ? resolveCommitClinicianTempPassword() : '';

  const clinicianMap = new Map<string, string>();
  console.log(`\n[import] resolving clinicians for ${clinic}:`);
  for (const name of namesInSheet) {
    const r = await ensureClinician(name, clinic, commit, tempPwd);
    if (r.id === null) {
      console.log(`  + would create  ${name.padEnd(12)}  ${r.email}  (CLINICIAN, ${clinic})`);
    } else if (r.created) {
      console.log(`  + created       ${name.padEnd(12)}  ${r.email}  (id=${r.id})`);
    } else if (r.reused) {
      console.log(`  ↻ reused        ${name.padEnd(12)}  ${r.email}  (id=${r.id}, cross-clinic)`);
    } else {
      console.log(`  ✓ exists        ${name.padEnd(12)}  ${r.email}  (id=${r.id})`);
    }
    if (r.id !== null) clinicianMap.set(name, r.id);
  }
  if (!commit) {
    for (const name of namesInSheet) {
      if (!clinicianMap.has(name)) clinicianMap.set(name, '<dry-run>');
    }
  }

  const valid:   ValidRow[]   = [];
  const skipped: SkippedRow[] = [];
  const nullStatusRows: number[] = [];
  const nullReasonRows: number[] = [];

  for (const r of rows) {
    if (!r.status) nullStatusRows.push(r.rowIdx);
    if (!r.reason) nullReasonRows.push(r.rowIdx);

    const result = validateRow(r, cfg, clinic, admin.id, clinicianMap);
    if (result.ok) valid.push(result.value);
    else skipped.push({ rowIdx: r.rowIdx, reason: result.reason });
  }

  console.log(`\n[import] validation:`);
  console.log(`  valid           ${valid.length}`);
  console.log(`  skipped         ${skipped.length}`);
  console.log(`  status NULL     ${nullStatusRows.length}  (preserved from blank source)`);
  console.log(`  reason NULL     ${nullReasonRows.length}  (preserved from blank source)`);

  if (skipped.length) {
    console.log(`\n[import] skipped rows:`);
    for (const s of skipped) console.log(`  row ${s.rowIdx}: ${s.reason}`);
  }

  // Sanity rail: warn if this clinic already has data overlapping the source range.
  if (valid.length > 0) {
    const minDate = valid.reduce((m, v) => v.date_logged < m ? v.date_logged : m, valid[0].date_logged);
    const maxDate = valid.reduce((m, v) => v.date_logged > m ? v.date_logged : m, valid[0].date_logged);
    const { rows: existing } = await query<{ n: string }>(
      `SELECT COUNT(*)::bigint AS n
         FROM patient_dropouts
        WHERE clinic_id = $1
          AND date_logged BETWEEN $2 AND $3`,
      [clinic, minDate, maxDate]
    );
    const n = Number(existing[0]?.n ?? 0);
    if (n > 0) {
      console.log(
        `\n[import] WARNING: ${n} existing patient_dropouts rows already in ${clinic} ` +
        `between ${minDate} and ${maxDate}. Re-running with --commit will duplicate them.`
      );
    }
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

/** True if any clinician name is missing from the DB entirely (any clinic). */
async function needsProvisioning(names: string[], clinic: ClinicId): Promise<boolean> {
  for (const name of names) {
    const inTarget = await findClinicianByFirstName(name, clinic);
    if (inTarget) continue;
    const elsewhere = await findClinicianAnywhere(name);
    if (!elsewhere) return true;
  }
  return false;
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
