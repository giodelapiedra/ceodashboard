/**
 * import-case-acceptance-gsheets.ts
 *
 * Imports a clinic's "Daily Case Recommendation Tracker" tab from Google Sheets
 * directly into `case_acceptances` via the Sheets API v4.
 *
 * Column layout (0-indexed, same across all clinics):
 *   0 Date
 *   1 Front of staff name
 *   2 Clinician name
 *   3 Patient name
 *   4 Treatment plan provided Y/N
 *   5 Case Recommendations
 *   6 Appointments Booked
 *   7 Case Acceptance %        ← IGNORED (recomputed in backend as booked/recs×100)
 *   8 Prepay Offered
 *   9 Prepay Accepted
 *   10 Transition notes
 *   11 Notes
 *   12+ Cross-checked / Nookal checked / Transferred?  ← IGNORED
 *
 * Usage:
 *   npm run db:import:case-acceptance:gsheets -- --clinic newport
 *   npm run db:import:case-acceptance:gsheets -- --clinic newport --commit
 *   npm run db:import:case-acceptance:gsheets -- --clinic newport --clear --commit
 */

import path from 'path';
import { google } from 'googleapis';
import { pool, query, withTransaction } from './pool';
import { env } from '../config/env';
import { authService } from '../services/auth.service';
import { userRepository, UserRow } from '../repositories/user.repository';
import { ClinicId, isClinicId } from '../shared/roles';

// ── Per-clinic config ─────────────────────────────────────────────────────────

interface ClinicConfig {
  sheetId:           string;
  sheetTab:          string;
  /** Map sheet front-staff text → users.full_name (e.g. "Izzy" → "Isabella"). */
  frontStaffAliases: Record<string, string>;
  /** Map sheet clinician text → users.full_name (e.g. "Zac" → "Zach"). */
  clinicianAliases:  Record<string, string>;
  /** Raw clinician-cell values to skip entirely (non-clinicians, stray entries). */
  clinicianSkips:    readonly string[];
}

const CLINIC_CONFIGS: Record<string, ClinicConfig> = {
  newport: {
    sheetId:          '1Wl91IdBkrGkhzJfu9keSxjlAOZFyazS_Z5R5Z_y85u8',
    sheetTab:         "'Daily Case Recommendation Tracker'!A:L",
    frontStaffAliases:{ Izzy: 'Isabella' },
    clinicianAliases: {},
    clinicianSkips:   [],
  },
  narrabeen: {
    sheetId:          '1Qoz-0UXLXH-CvojnReUg3wxwL8rgn3HFcGHBYOi43-w',
    sheetTab:         "'Daily Case Recommendation Tracker'!A:L",
    frontStaffAliases:{},
    clinicianAliases: { Zac: 'Zach' },
    clinicianSkips:   [],
  },
  brookvale: {
    sheetId:          '1BhEYel_NJlEK46gq-kFqmx87WgCdo0XA5PtnXF4Q4cU',
    sheetTab:         "'Daily Case Recommendation Tracker'!A:L",
    frontStaffAliases:{},
    clinicianAliases: { 'Jesse/Angus': 'Angus' },
    clinicianSkips:   [],
  },
};

const SOURCE_YEAR = 2026;

// ── Auth ──────────────────────────────────────────────────────────────────────

async function buildAuthClient(): Promise<any> {
  const refreshToken = process.env.GOOGLE_SHEETS_REFRESH_TOKEN?.trim();
  const keyFile      = process.env.GOOGLE_SHEETS_KEY_FILE?.trim();

  if (refreshToken) {
    const clientId     = process.env.GOOGLE_SHEETS_CLIENT_ID?.trim();
    const clientSecret = process.env.GOOGLE_SHEETS_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) throw new Error('GOOGLE_SHEETS_CLIENT_ID and SECRET required.');
    const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
    oauth2.setCredentials({ refresh_token: refreshToken });
    return oauth2;
  }
  if (keyFile) {
    return new google.auth.GoogleAuth({
      keyFile: path.resolve(keyFile),
      scopes:  ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  }
  throw new Error('Set GOOGLE_SHEETS_REFRESH_TOKEN or GOOGLE_SHEETS_KEY_FILE in .env');
}

// ── Parsers ───────────────────────────────────────────────────────────────────

function pad2(n: string | number): string {
  return String(n).padStart(2, '0');
}

function parseDateLogged(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return s.slice(0, 10);
  // Australian D/M/YYYY or D/M/YY
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yyyy}-${pad2(m[2])}-${pad2(m[1])}`;
  }
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (m) {
    const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yyyy}-${pad2(m[2])}-${pad2(m[1])}`;
  }
  return null;
}

/** "Y" → true, "N" → false, blank → null */
function parseTreatmentPlan(raw: string | null): boolean | null {
  if (!raw) return null;
  const s = raw.trim().toUpperCase();
  if (s === 'Y') return true;
  if (s === 'N') return false;
  return null;
}

/**
 * Prepay marks: tick glyph → YES (true); "X"/cross → NO (false); blank → null.
 *
 * IMPORTANT: in these sheets a red "X" means NOT offered/accepted (NO), while a
 * checkmark (✔/✓) means YES. So X must map to FALSE, not TRUE.
 *   ✔ ✓ ✅ ☑ √ / TRUE / YES / Y / 1  → true  (YES)
 *   X / NO / N / 0 / FALSE           → false (NO)
 *   blank                            → null  (renders as "0")
 * Tick glyphs are matched with a regex so a trailing emoji variation selector
 * (U+FE0F) still counts.
 */
function parsePrepay(raw: string | null): boolean | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  if (/[✓✔✅☑√]/.test(s)) return true;
  const up = s.toUpperCase();
  if (up === 'TRUE' || up === 'YES' || up === 'Y' || up === '1') return true;
  if (up === 'X' || up === 'NO' || up === 'N' || up === '0' || up === 'FALSE') return false;
  return null;
}

function parseNumber(raw: string | null): number {
  if (!raw) return 0;
  const n = parseInt(raw.trim().replace(/[^0-9]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

function cell(row: string[], idx: number): string | null {
  const v = (row[idx] ?? '').trim();
  return v === '' ? null : v;
}

// ── Clinician helpers ─────────────────────────────────────────────────────────

function firstWord(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

async function findClinicianByFirstName(firstName: string, clinicId: string): Promise<UserRow | null> {
  const fw = firstWord(firstName);
  const { rows } = await query<UserRow>(
    `SELECT * FROM users
      WHERE role = 'CLINICIAN'
        AND clinic_id = $1
        AND (LOWER(full_name) = LOWER($2) OR LOWER(full_name) = LOWER($3) OR LOWER(full_name) LIKE LOWER($4))
      ORDER BY id ASC LIMIT 1`,
    [clinicId, firstName, fw, `${fw} %`]
  );
  return rows[0] ?? null;
}

async function findClinicianAnywhere(firstName: string): Promise<UserRow | null> {
  const fw = firstWord(firstName);
  const { rows } = await query<UserRow>(
    `SELECT * FROM users
      WHERE role = 'CLINICIAN' AND is_active = true
        AND (LOWER(full_name) = LOWER($1) OR LOWER(full_name) = LOWER($2) OR LOWER(full_name) LIKE LOWER($3))
      ORDER BY id ASC LIMIT 1`,
    [firstName, fw, `${fw} %`]
  );
  return rows[0] ?? null;
}

function firstNameToEmail(firstName: string): string {
  const local = firstName.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9.+_-]/g, '');
  return `${local}@physioward.com.au`;
}

async function ensureClinician(
  firstName: string, clinicId: string, commit: boolean, tempPwd: string
): Promise<{ id: string | null; created: boolean; reused: boolean; email: string }> {
  const inTarget = await findClinicianByFirstName(firstName, clinicId);
  if (inTarget) return { id: inTarget.id, created: false, reused: false, email: inTarget.email };
  const elsewhere = await findClinicianAnywhere(firstName);
  if (elsewhere) return { id: elsewhere.id, created: false, reused: true, email: elsewhere.email };
  const baseEmail = firstNameToEmail(firstName);
  let email = baseEmail;
  const taken = await userRepository.findByEmail(baseEmail);
  if (taken) email = `${firstName.toLowerCase().replace(/[^a-z0-9]/g, '')}-${clinicId}@physioward.com.au`;
  if (!commit) return { id: null, created: true, reused: false, email };
  const passwordHash = await authService.hashPassword(tempPwd);
  const created = await userRepository.create({
    email, passwordHash, role: 'CLINICIAN', full_name: firstName, clinic_id: clinicId,
  });
  return { id: created.id, created: true, reused: false, email: created.email };
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  const commit   = process.argv.includes('--commit');
  const clear    = process.argv.includes('--clear');
  const clinicIdx = process.argv.indexOf('--clinic');
  const clinicArg = clinicIdx >= 0 ? process.argv[clinicIdx + 1] : undefined;
  if (!clinicArg || !isClinicId(clinicArg)) {
    throw new Error(`Pass --clinic <id>. Valid: ${Object.keys(CLINIC_CONFIGS).join(', ')}`);
  }
  const CLINIC = clinicArg as ClinicId;
  const cfg    = CLINIC_CONFIGS[CLINIC];

  console.log(`[ca-gsheets] mode:   ${commit ? 'COMMIT' : 'DRY-RUN'}`);
  console.log(`[ca-gsheets] clinic: ${CLINIC}`);
  console.log(`[ca-gsheets] sheet:  ${cfg.sheetId}`);
  console.log(`[ca-gsheets] tab:    ${cfg.sheetTab}`);
  if (clear) console.log(`[ca-gsheets] --clear: existing ${CLINIC} case_acceptances will be deleted`);

  // Auth & fetch
  const auth   = await buildAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });
  console.log('\n[ca-gsheets] fetching sheet data…');
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId:     cfg.sheetId,
    range:             cfg.sheetTab,
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const allRows: string[][] = (resp.data.values ?? []).map(r => r.map(v => String(v ?? '')));
  console.log(`[ca-gsheets] ${allRows.length} rows fetched`);

  // Admin entered_by
  const admin = await userRepository.findByEmail(env.CEO_EMAIL);
  if (!admin) throw new Error(`Admin ${env.CEO_EMAIL} not found — run db:seed first.`);

  // Parse rows — skip title (row 0), headers (row 1), repeated headers, blanks
  interface ParsedRow {
    rowNum:                  number;
    date_logged:             string | null;
    front_staff_raw:         string | null;
    clinician_raw:           string | null;
    patient_name:            string | null;
    treatment_plan_provided: boolean | null;
    case_recommendations:    number;
    appointments_booked:     number;
    prepay_offered:          boolean | null;
    prepay_accepted:         boolean | null;
    transition_notes:        string | null;
    notes:                   string | null;
  }

  const parsed: ParsedRow[] = [];
  for (let i = 0; i < allRows.length; i++) {
    const r    = allRows[i];
    const col0 = (r[0] ?? '').trim().toLowerCase();
    // Skip title row, header rows, repeated header rows
    if (col0 === '' || col0 === 'date' || col0.startsWith('daily case')) continue;

    const date_logged    = parseDateLogged(cell(r, 0));
    const front_staff    = cell(r, 1);
    const clinician      = cell(r, 2);
    const patient        = cell(r, 3);
    const tp             = parseTreatmentPlan(cell(r, 4));
    const recs           = parseNumber(cell(r, 5));
    const booked         = parseNumber(cell(r, 6));
    // col 7 = Case Acceptance % — IGNORED
    const prepay_offered  = parsePrepay(cell(r, 8));
    const prepay_accepted = parsePrepay(cell(r, 9));
    const transition     = cell(r, 10);
    const notes          = cell(r, 11);
    // cols 12+ = Cross-checked, Nookal checked, Transferred? — IGNORED

    if (!date_logged && !clinician && !patient) continue;

    parsed.push({
      rowNum: i + 1, date_logged, front_staff_raw: front_staff,
      clinician_raw: clinician, patient_name: patient,
      treatment_plan_provided: tp,
      case_recommendations: recs, appointments_booked: booked,
      prepay_offered, prepay_accepted,
      transition_notes: transition, notes,
    });
  }
  console.log(`[ca-gsheets] ${parsed.length} non-empty data rows`);

  // Clinician resolution
  const namesInSheet = [...new Set(
    parsed.map(r => r.clinician_raw).filter((s): s is string => !!s)
      .filter(s => !cfg.clinicianSkips.includes(s))
      .map(s => cfg.clinicianAliases[s] ?? s)
  )];
  console.log(`[ca-gsheets] clinicians: ${namesInSheet.join(', ')}`);

  const needsCreate = commit && await (async () => {
    for (const n of namesInSheet) {
      if (!await findClinicianByFirstName(n, CLINIC) && !await findClinicianAnywhere(n)) return true;
    }
    return false;
  })();
  const tempPwd = (commit && needsCreate)
    ? (() => {
        const p = process.env.IMPORT_CLINICIAN_TEMP_PASSWORD?.trim() ?? '';
        if (p.length < 8) throw new Error('IMPORT_CLINICIAN_TEMP_PASSWORD must be ≥8 chars.');
        return p;
      })()
    : '';

  const clinicianMap = new Map<string, string>();
  console.log('[ca-gsheets] resolving clinicians:');
  for (const name of namesInSheet) {
    const r = await ensureClinician(name, CLINIC, commit, tempPwd);
    if (r.id === null)  console.log(`  + would create  ${name.padEnd(12)}  ${r.email}`);
    else if (r.created) console.log(`  + created       ${name.padEnd(12)}  ${r.email}  (id=${r.id})`);
    else if (r.reused)  console.log(`  ↻ reused        ${name.padEnd(12)}  ${r.email}  (id=${r.id}, cross-clinic)`);
    else                console.log(`  ✓ exists        ${name.padEnd(12)}  ${r.email}  (id=${r.id})`);
    if (r.id !== null) clinicianMap.set(name, r.id);
  }
  if (!commit) {
    for (const n of namesInSheet) { if (!clinicianMap.has(n)) clinicianMap.set(n, '<dry-run>'); }
  }

  // Validate rows
  interface ValidRow {
    clinic_id: string; entered_by: string; front_staff_name: string | null;
    clinician_id: string; patient_name: string; date_logged: string;
    treatment_plan_provided: boolean | null;
    case_recommendations: number; appointments_booked: number;
    prepay_offered: boolean | null; prepay_accepted: boolean | null;
    transition_notes: string | null; notes: string | null;
  }

  const valid:   ValidRow[]                            = [];
  const skipped: { row: number; reason: string }[]    = [];

  for (const r of parsed) {
    if (!r.date_logged) { skipped.push({ row: r.rowNum, reason: 'unparseable date' }); continue; }
    if (!r.patient_name){ skipped.push({ row: r.rowNum, reason: 'missing patient' }); continue; }
    if (!r.clinician_raw){ skipped.push({ row: r.rowNum, reason: 'missing clinician' }); continue; }
    if (cfg.clinicianSkips.includes(r.clinician_raw)) {
      skipped.push({ row: r.rowNum, reason: `clinician "${r.clinician_raw}" skipped` }); continue;
    }

    const clinKey    = cfg.clinicianAliases[r.clinician_raw] ?? r.clinician_raw;
    const clinicianId = clinicianMap.get(clinKey);
    if (!clinicianId) { skipped.push({ row: r.rowNum, reason: `clinician "${r.clinician_raw}" not provisioned` }); continue; }

    // Enforce DB constraint: booked ≤ recs
    let recs   = r.case_recommendations;
    let booked = r.appointments_booked;
    if (booked > 0 && recs === 0) recs = booked;   // recs blank but booked present
    if (booked > recs)            recs = booked;    // typo: booked > recs, trust booked

    // Front staff name (apply alias, store trimmed text)
    let frontStaff: string | null = null;
    if (r.front_staff_raw) {
      frontStaff = (cfg.frontStaffAliases[r.front_staff_raw] ?? r.front_staff_raw).trim().slice(0, 120);
    }

    valid.push({
      clinic_id:               CLINIC,
      entered_by:              admin.id,
      front_staff_name:        frontStaff,
      clinician_id:            clinicianId,
      patient_name:            r.patient_name.slice(0, 200),
      date_logged:             r.date_logged,
      treatment_plan_provided: r.treatment_plan_provided,
      case_recommendations:    recs,
      appointments_booked:     booked,
      prepay_offered:          r.prepay_offered,
      prepay_accepted:         r.prepay_accepted,
      transition_notes:        r.transition_notes ? r.transition_notes.slice(0, 2000) : null,
      notes:                   r.notes ? r.notes.slice(0, 2000) : null,
    });
  }

  console.log(`\n[ca-gsheets] validation:`);
  console.log(`  valid    ${valid.length}`);
  console.log(`  skipped  ${skipped.length}`);
  if (skipped.length) {
    skipped.forEach(s => console.log(`  row ${s.row}: ${s.reason}`));
  }

  // Overlap warning
  if (!clear && valid.length > 0) {
    const minDate = valid.reduce((m, v) => v.date_logged < m ? v.date_logged : m, valid[0].date_logged);
    const maxDate = valid.reduce((m, v) => v.date_logged > m ? v.date_logged : m, valid[0].date_logged);
    const { rows: ex } = await query<{ n: string }>(
      `SELECT COUNT(*)::bigint AS n FROM case_acceptances WHERE clinic_id=$1 AND date_logged BETWEEN $2 AND $3`,
      [CLINIC, minDate, maxDate]
    );
    if (Number(ex[0]?.n ?? 0) > 0) {
      console.log(`\n[ca-gsheets] WARNING: ${ex[0].n} existing ${CLINIC} rows overlap ${minDate}..${maxDate}.`);
      console.log('[ca-gsheets]           Re-run with --clear to delete them first.');
    }
  }

  if (!commit) {
    console.log(`\n[ca-gsheets] DRY-RUN done. Re-run with --commit to insert ${valid.length} rows.`);
    return;
  }

  await withTransaction(async (client) => {
    if (clear) {
      const del = await client.query(`DELETE FROM case_acceptances WHERE clinic_id=$1`, [CLINIC]);
      console.log(`\n[ca-gsheets] cleared ${del.rowCount} existing ${CLINIC} rows`);
    }
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
          v.prepay_offered, v.prepay_accepted, v.transition_notes, v.notes,
        ]
      );
    }
  });
  console.log(`[ca-gsheets] inserted ${valid.length} rows into case_acceptances.`);
}

if (require.main === module) {
  run()
    .then(() => pool.end()).then(() => process.exit(0))
    .catch(err => { console.error('[ca-gsheets] failed:', err); pool.end().finally(() => process.exit(1)); });
}
