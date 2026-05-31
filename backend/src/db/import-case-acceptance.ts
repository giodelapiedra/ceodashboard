import path from 'path';
import ExcelJS from 'exceljs';
import { pool, query, withTransaction } from './pool';
import { env } from '../config/env';
import { authService } from '../services/auth.service';
import { userRepository, UserRow } from '../repositories/user.repository';
import { CLINIC_IDS, ClinicId, isClinicId } from '../shared/roles';

/**
 * One-shot import of the 2026 Daily Case Recommendation & Acceptance
 * spreadsheets into `case_acceptances`. Re-usable across clinics — pass
 * the clinic id with --clinic. Per-clinic quirks (name aliases, date
 * overrides) live in the CLINIC_CONFIG block.
 *
 * Source layout (Sheet1):
 *   R1            Header row (ignored)
 *   R2..end       Data rows. Columns:
 *     A Date | B Front-of-staff | C Clinician | D Patient name |
 *     E TP Y/N | F Case Recs | G Appts Booked |
 *     H Case Acceptance (sheet formula =G/F — recomputed in backend) |
 *     I Prepay Offered | J Prepay Accepted |
 *     K Transition (mostly blank) | L Notes
 *
 * Decisions (confirmed with Sam 2026-05-11):
 *   - entered_by resolved per-row from the Front-of-staff name (matched
 *     to a FRONT_DESK_GLOBAL / FRONT_DESK / CLINICIAN account by full_name),
 *     falling back to the seeded ADMIN user when no match.
 *   - Front-staff name is saved trimmed but verbatim (free-form column in DB).
 *   - Prepay X or blank → false; ✔ → true; unknown markers → NULL.
 *   - TP "Y" → true; "N" → false; blank → NULL.
 *   - Rows with booked > 0 but recs blank → recs = booked (assume 100%).
 *   - Rows with all of {TP, recs, booked} blank → recs = 0, booked = 0.
 *   - Booked > recs typo → recs := booked (trust the booked count).
 *   - Future-dated rows kept as-is (no date coercion).
 *   - Missing clinicians are auto-provisioned on --commit (same pattern
 *     as `import-dropouts-2026.ts`).
 *
 * Usage:
 *   npm run db:import:case-acceptance -- --clinic newport                    # dry-run
 *   npm run db:import:case-acceptance -- --clinic newport --commit           # insert
 *   npm run db:import:case-acceptance -- --clinic narrabeen --xlsx <path>    # different sheet
 *
 * Secrets / paths (never hardcode):
 *   IMPORT_CASE_ACCEPTANCE_XLSX    — default spreadsheet path if --xlsx omitted
 *   IMPORT_CLINICIAN_TEMP_PASSWORD — required with --commit when new clinicians
 *                                   are created; min 8 chars; users must change
 *                                   after first login.
 */

interface ClinicConfig {
  /** Map sheet-text → users.full_name for front-of-staff lookups (Izzy → Isabella). */
  frontStaffAliases:    Record<string, string>;
  /** Map sheet-text → users.full_name for clinician lookups (Zac → Zach). */
  clinicianAliases:     Record<string, string>;
  /** Hard date_logged overrides keyed by 1-indexed sheet row (typos). */
  dateLoggedOverrides:  Record<number, string>;
}

const CLINIC_CONFIG: Record<ClinicId, ClinicConfig> = {
  newport: {
    // "Izzy" is Isabella's nickname (sheet uses "Isabella" in the clinician
    // column too) — only the front-staff column gets aliased.
    frontStaffAliases:   { Izzy: 'Isabella' },
    clinicianAliases:    {},
    // Row 182 (Georgia Mansur): sheet has "05/03/0206" — broken year.
    // Neighbours R181/R183 are 2026-05-03 so the row belongs there.
    dateLoggedOverrides: { 182: '2026-05-03' },
  },
  narrabeen: {
    frontStaffAliases:   {},
    // "Zac" / "Zach" both refer to the same clinician — collapse to Zach.
    clinicianAliases:    { Zac: 'Zach' },
    dateLoggedOverrides: {},
  },
  brookvale: {
    frontStaffAliases:   {},
    clinicianAliases:    {},
    dateLoggedOverrides: {},
  },
};

const COL = {
  date_logged:      1,
  front_staff:      2,
  clinician:        3,
  patient:          4,
  tp_provided:      5,
  case_recs:        6,
  appts_booked:     7,
  // 8 = sheet formula =G/F, recomputed server-side
  prepay_offered:   9,
  prepay_accepted: 10,
  transition:      11,
  notes:           12,
} as const;

type ParsedRow = {
  rowIdx:          number;
  date_logged:     string | null;
  front_staff:     string | null;
  clinician:       string | null;
  patient:         string | null;
  tp_provided:     boolean | null;
  case_recs:       number | null;
  appts_booked:    number | null;
  prepay_offered:  boolean | null;
  prepay_accepted: boolean | null;
  transition:      boolean | null;
  notes:           string | null;
};

type ValidRow = {
  clinic_id:               string;
  entered_by:              string;
  front_staff_name:        string | null;
  clinician_id:            string;
  patient_name:            string;
  date_logged:             string;
  treatment_plan_provided: boolean | null;
  case_recommendations:    number;
  appointments_booked:     number;
  prepay_offered:          boolean | null;
  prepay_accepted:         boolean | null;
  transition_notes:        string | null;
  notes:                   string | null;
};

type SkippedRow = { rowIdx: number; reason: string };
type CoercionFlag = 'recs_set_to_booked' | 'header_only_zeroed' | 'recs_bumped_to_booked';

function resolveSpreadsheetPath(cliPath: string | undefined): string {
  const fromEnv = process.env.IMPORT_CASE_ACCEPTANCE_XLSX?.trim();
  const p       = cliPath ?? fromEnv;
  if (!p) {
    throw new Error(
      'Set IMPORT_CASE_ACCEPTANCE_XLSX in .env or pass --xlsx <path>.'
    );
  }
  return p;
}

function resolveClinic(cliClinic: string | undefined): ClinicId {
  if (!cliClinic) {
    throw new Error(
      `Pass --clinic <id> (one of: ${CLINIC_IDS.join(', ')}).`
    );
  }
  if (!isClinicId(cliClinic)) {
    throw new Error(
      `Unknown clinic "${cliClinic}". Valid: ${CLINIC_IDS.join(', ')}.`
    );
  }
  return cliClinic;
}

function resolveCommitClinicianTempPassword(): string {
  const pwd = process.env.IMPORT_CLINICIAN_TEMP_PASSWORD?.trim() ?? '';
  if (pwd.length < 8) {
    throw new Error(
      'IMPORT_CLINICIAN_TEMP_PASSWORD must be set (min 8 characters) when using --commit and missing clinicians need provisioning.'
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

function readCellNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'object' && v !== null) {
    const obj = v as Record<string, unknown>;
    if ('result' in obj) return readCellNumber(obj.result);
  }
  return null;
}

function parseDateLogged(rawCell: unknown): string | null {
  if (rawCell instanceof Date) return rawCell.toISOString().slice(0, 10);
  const s = readCell(rawCell);
  if (!s) return null;
  // ISO-ish: 2026-04-13
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return s.slice(0, 10);
  // Australian DD/MM/YYYY or DD/MM/YY (Brookvale sheet mixes both).
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let yyyy = m[3];
    if (yyyy.length === 2) yyyy = `20${yyyy}`; // assume 21st century
    return `${yyyy}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

/** Y/Yes → true, N/No → false, blank/anything else → null. */
function parseYN(raw: string | null): boolean | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === 'y' || v === 'yes') return true;
  if (v === 'n' || v === 'no')  return false;
  return null;
}

/**
 * Prepay column convention (confirmed with Sam 2026-05-11):
 *   "✔" / "✓"  → true   (yes — offered / accepted)
 *   "X"  / "x"  → false  (no  — not offered / not accepted)
 *   blank        → false  ("consider hindi na tinanggap" — treat as no)
 *   anything else → null  (defensive: unrecognized marker → unknown)
 */
function parseTickMark(raw: string | null): boolean | null {
  if (!raw) return false;
  const v = raw.trim();
  if (v === '✔' || v === '✓') return true;
  if (v === 'X' || v === 'x') return false;
  if (v === '') return false;
  return null;
}

async function parseSheet(filePath: string, overrides: Record<number, string>): Promise<ParsedRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error(`No worksheet in ${filePath}`);

  const out: ParsedRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const dateRaw    = row.getCell(COL.date_logged).value;
    const fos        = readCell(row.getCell(COL.front_staff).value);
    const cl         = readCell(row.getCell(COL.clinician).value);
    const patient    = readCell(row.getCell(COL.patient).value);
    const tpRaw      = readCell(row.getCell(COL.tp_provided).value);
    const recsRaw    = readCellNumber(row.getCell(COL.case_recs).value);
    const bookedRaw  = readCellNumber(row.getCell(COL.appts_booked).value);
    const ppoRaw     = readCell(row.getCell(COL.prepay_offered).value);
    const ppaRaw     = readCell(row.getCell(COL.prepay_accepted).value);
    const trRaw      = readCell(row.getCell(COL.transition).value);
    const notes      = readCell(row.getCell(COL.notes).value);

    if (!dateRaw && !fos && !cl && !patient) continue;

    out.push({
      rowIdx:          r,
      date_logged:     overrides[r] ?? parseDateLogged(dateRaw),
      front_staff:     fos,
      clinician:       cl,
      patient:         patient,
      tp_provided:     parseYN(tpRaw),
      case_recs:       recsRaw,
      appts_booked:    bookedRaw,
      prepay_offered:  parseTickMark(ppoRaw),
      prepay_accepted: parseTickMark(ppaRaw),
      transition:      parseTickMark(trRaw),
      notes,
    });
  }
  return out;
}

/**
 * Match a clinician by name across both directions:
 *   - exact match against sheet text (sheet="Angus Clarke", DB="Angus Clarke")
 *   - first-word match against sheet text (sheet="Angus Clarke", DB="Angus")
 *   - DB-starts-with-first-word (sheet="Angus", DB="Angus Clarke")
 * This handles the case where one sheet uses bare first names and another
 * uses full names for the same physio.
 */
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
 * Find a CLINICIAN by name in ANY clinic. Used for cross-clinic reuse:
 * per Sam (2026-05-11), some physios rotate between Newport / Narrabeen /
 * Brookvale, so an existing CLINICIAN account is reused regardless of the
 * user-record's primary `clinic_id`. The CLINICIAN scope filter goes by
 * `clinician_id` (not `clinic_id`), so the same user naturally sees entries
 * from every clinic they cover.
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
  // Strip whitespace and any character that's not local-part-safe.
  const local = firstName.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9.+_-]/g, '');
  return `${local}@physioward.com.au`;
}

/**
 * Resolve or auto-provision a CLINICIAN user for the target clinic.
 * Mirrors the dropouts importer's behavior.
 */
async function ensureClinician(
  firstName: string,
  clinic: ClinicId,
  commit: boolean,
  tempPasswordPlain: string
): Promise<{ id: string | null; created: boolean; reused: boolean; email: string }> {
  // 1. Same-clinic match wins.
  const inTarget = await findClinicianByFirstName(firstName, clinic);
  if (inTarget) {
    return { id: inTarget.id, created: false, reused: false, email: inTarget.email };
  }

  // 2. Cross-clinic reuse — same physio rotating between clinics (Sam's call).
  //    Only reuses CLINICIAN-role accounts; never collapses a non-clinician
  //    user (e.g. front-desk Ben) into a clinician identity.
  const elsewhere = await findClinicianAnywhere(firstName);
  if (elsewhere) {
    return { id: elsewhere.id, created: false, reused: true, email: elsewhere.email };
  }

  // 3. Create a new clinician. If the base email is taken by a different
  //    role (e.g. ben@physioward.com.au held by the receptionist), append a
  //    clinic suffix so the new clinician gets a distinct identity.
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

async function findFrontStaffUser(name: string): Promise<UserRow | null> {
  const { rows } = await query<UserRow>(
    `SELECT *
       FROM users
      WHERE role IN ('FRONT_DESK','FRONT_DESK_GLOBAL','CLINICIAN')
        AND is_active = true
        AND LOWER(full_name) = LOWER($1)
      ORDER BY
        CASE role
          WHEN 'FRONT_DESK_GLOBAL' THEN 0
          WHEN 'FRONT_DESK'        THEN 1
          ELSE                          2
        END,
        id ASC
      LIMIT 1`,
    [name]
  );
  return rows[0] ?? null;
}

function validateRow(
  r: ParsedRow,
  clinic: ClinicId,
  adminId: string,
  clinicianMap: Map<string, string>,
  frontStaffMap: Map<string, string>,
  clinicianAliases: Record<string, string>
):
  | { ok: true; value: ValidRow; flag?: CoercionFlag; enteredByFallback?: boolean }
  | { ok: false; reason: string }
{
  if (!r.date_logged) return { ok: false, reason: 'unparseable date_logged' };
  if (!r.patient)     return { ok: false, reason: 'missing patient_name' };
  if (!r.clinician)   return { ok: false, reason: 'missing clinician name' };

  const clinicianKey = clinicianAliases[r.clinician] ?? r.clinician;
  const clinicianId  = clinicianMap.get(clinicianKey);
  if (!clinicianId) {
    return { ok: false, reason: `clinician "${r.clinician}" not provisioned in ${clinic}` };
  }

  let recs   = r.case_recs   ?? 0;
  let booked = r.appts_booked ?? 0;
  let flag: CoercionFlag | undefined;

  const recsBlank   = r.case_recs   === null;
  const bookedBlank = r.appts_booked === null;
  if (recsBlank && !bookedBlank && booked > 0) {
    recs = booked;
    flag = 'recs_set_to_booked';
  } else if (recsBlank && bookedBlank && r.tp_provided === null) {
    recs = 0;
    booked = 0;
    flag = 'header_only_zeroed';
  }

  if (booked > recs) {
    recs = booked;
    flag = 'recs_bumped_to_booked';
  }

  return {
    ok: true,
    flag,
    enteredByFallback: false, // populated by caller after fs map lookup
    value: {
      clinic_id:               clinic,
      entered_by:              adminId, // placeholder — set by caller
      front_staff_name:        r.front_staff ? r.front_staff.trim().slice(0, 120) : null,
      clinician_id:            clinicianId,
      patient_name:            r.patient.slice(0, 200),
      date_logged:             r.date_logged,
      treatment_plan_provided: r.tp_provided,
      case_recommendations:    recs,
      appointments_booked:     booked,
      prepay_offered:          r.prepay_offered,
      prepay_accepted:         r.prepay_accepted,
      transition_notes:        r.transition === true ? 'Done' : null,
      notes:                   r.notes ? r.notes.slice(0, 2000) : null,
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
  const xlsx   = resolveSpreadsheetPath(getArg('--xlsx'));
  const cfg    = CLINIC_CONFIG[clinic];

  console.log(`[import] mode:   ${commit ? 'COMMIT' : 'DRY-RUN'}`);
  console.log(`[import] source: ${path.resolve(xlsx)}`);
  console.log(`[import] clinic: ${clinic}`);

  const admin = await userRepository.findByEmail(env.CEO_EMAIL);
  if (!admin) throw new Error(`Admin user ${env.CEO_EMAIL} not found — run db:seed first.`);
  console.log(`[import] entered_by fallback: ${admin.email} (id=${admin.id})`);

  const rows = await parseSheet(xlsx, cfg.dateLoggedOverrides);
  console.log(`[import] parsed ${rows.length} non-empty data rows`);

  // Collect every distinct clinician name (after alias resolution) referenced.
  const namesInSheet = [...new Set(rows
    .map((r) => r.clinician)
    .filter((s): s is string => !!s)
    .map((s) => cfg.clinicianAliases[s] ?? s))];
  console.log(`[import] clinicians referenced (after aliases): ${namesInSheet.join(', ')}`);

  // Resolve / provision clinicians.
  const tempPwd = (commit && namesInSheet.length > 0)
    ? (await needsProvisioning(namesInSheet, clinic) ? resolveCommitClinicianTempPassword() : '')
    : '';

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
  // For dry-run we still want validation to proceed past the clinician check
  // for "would-create" names — seed with a placeholder id.
  if (!commit) {
    for (const name of namesInSheet) {
      if (!clinicianMap.has(name)) clinicianMap.set(name, '<dry-run>');
    }
  }

  // Resolve every distinct front-of-staff name to a user account.
  const frontStaffMap = new Map<string, string>();
  const fsNamesInSheet = [...new Set(rows
    .map((r) => r.front_staff?.trim())
    .filter((s): s is string => !!s)
    .map((s) => cfg.frontStaffAliases[s] ?? s))];
  console.log(`\n[import] resolving front-of-staff users:`);
  for (const name of fsNamesInSheet) {
    const u = await findFrontStaffUser(name);
    if (u) {
      frontStaffMap.set(name, u.id);
      console.log(`  ✓ ${name.padEnd(14)}  ${u.role.padEnd(18)}  ${u.email}  (id=${u.id})`);
    } else {
      console.log(`  ✗ ${name.padEnd(14)}  no user found — entered_by will fall back to admin`);
    }
  }

  const valid:    ValidRow[]   = [];
  const skipped:  SkippedRow[] = [];
  const flagged:  { rowIdx: number; flag: CoercionFlag; patient: string }[] = [];
  const futureDated: { rowIdx: number; date: string; patient: string }[] = [];
  const adminFallback: { rowIdx: number; fs: string | null; patient: string }[] = [];
  const today = new Date(); today.setHours(0,0,0,0);

  for (const r of rows) {
    const result = validateRow(r, clinic, admin.id, clinicianMap, frontStaffMap, cfg.clinicianAliases);
    if (!result.ok) {
      skipped.push({ rowIdx: r.rowIdx, reason: result.reason });
      continue;
    }
    // Resolve entered_by AFTER validation so we know the row is otherwise valid.
    const fsName        = result.value.front_staff_name;
    const fsLookup      = fsName ? (cfg.frontStaffAliases[fsName] ?? fsName) : null;
    const fsUserId      = fsLookup ? frontStaffMap.get(fsLookup) : undefined;
    const enteredBy     = fsUserId ?? admin.id;
    const enteredByFallback = !fsUserId;
    result.value.entered_by = enteredBy;

    valid.push(result.value);
    if (result.flag) {
      flagged.push({ rowIdx: r.rowIdx, flag: result.flag, patient: result.value.patient_name });
    }
    if (enteredByFallback) {
      adminFallback.push({ rowIdx: r.rowIdx, fs: result.value.front_staff_name, patient: result.value.patient_name });
    }
    const d = new Date(result.value.date_logged);
    if (d > today) {
      futureDated.push({ rowIdx: r.rowIdx, date: result.value.date_logged, patient: result.value.patient_name });
    }
  }

  console.log(`\n[import] validation:`);
  console.log(`  valid                 ${valid.length}`);
  console.log(`  skipped               ${skipped.length}`);
  console.log(`  recs_set_to_booked    ${flagged.filter((f) => f.flag === 'recs_set_to_booked').length}`);
  console.log(`  recs_bumped_to_booked ${flagged.filter((f) => f.flag === 'recs_bumped_to_booked').length}`);
  console.log(`  header_only_zeroed    ${flagged.filter((f) => f.flag === 'header_only_zeroed').length}`);
  console.log(`  future-dated          ${futureDated.length}`);
  console.log(`  entered_by → admin    ${adminFallback.length}  (no front-of-staff user match)`);

  if (flagged.length) {
    console.log(`\n[import] coercions applied:`);
    for (const f of flagged) {
      console.log(`  row ${f.rowIdx} (${f.patient}): ${f.flag}`);
    }
  }
  if (futureDated.length) {
    console.log(`\n[import] future-dated rows (imported as-is):`);
    for (const f of futureDated) {
      console.log(`  row ${f.rowIdx}: ${f.date} — ${f.patient}`);
    }
  }
  if (adminFallback.length) {
    console.log(`\n[import] entered_by fell back to admin for these rows:`);
    for (const a of adminFallback.slice(0, 30)) {
      console.log(`  row ${a.rowIdx}: front_staff="${a.fs ?? ''}" — ${a.patient}`);
    }
    if (adminFallback.length > 30) console.log(`  … and ${adminFallback.length - 30} more`);
  }
  if (skipped.length) {
    console.log(`\n[import] skipped rows:`);
    for (const s of skipped) console.log(`  row ${s.rowIdx}: ${s.reason}`);
  }

  // Sanity rail: warn if this clinic already has data in the source range.
  if (valid.length > 0) {
    const minDate = valid.reduce((m, v) => v.date_logged < m ? v.date_logged : m, valid[0].date_logged);
    const maxDate = valid.reduce((m, v) => v.date_logged > m ? v.date_logged : m, valid[0].date_logged);
    const { rows: existing } = await query<{ n: string }>(
      `SELECT COUNT(*)::bigint AS n
         FROM case_acceptances
        WHERE clinic_id = $1
          AND date_logged BETWEEN $2 AND $3`,
      [clinic, minDate, maxDate]
    );
    const n = Number(existing[0]?.n ?? 0);
    if (n > 0) {
      console.log(
        `\n[import] WARNING: ${n} existing case_acceptances rows already in ${clinic} ` +
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
        `INSERT INTO case_acceptances (
           clinic_id, entered_by, front_staff_name, clinician_id,
           patient_name, date_logged, treatment_plan_provided,
           case_recommendations, appointments_booked,
           prepay_offered, prepay_accepted, transition_notes, notes
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          v.clinic_id, v.entered_by, v.front_staff_name, v.clinician_id,
          v.patient_name, v.date_logged, v.treatment_plan_provided,
          v.case_recommendations, v.appointments_booked,
          v.prepay_offered, v.prepay_accepted, v.transition_notes,
          v.notes,
        ]
      );
    }
  });
  console.log(`[import] inserted ${valid.length} rows into case_acceptances.`);
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
