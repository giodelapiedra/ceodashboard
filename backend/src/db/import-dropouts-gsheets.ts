/**
 * import-dropouts-gsheets.ts
 *
 * Imports a clinic's "Daily Patient Dropout Tracking" tab from Google Sheets
 * directly into `patient_dropouts` via the Sheets API v4.
 *
 * Usage:
 *   npm run db:import:dropouts:gsheets -- --clinic newport              # dry-run
 *   npm run db:import:dropouts:gsheets -- --clinic newport --commit     # insert
 *   npm run db:import:dropouts:gsheets -- --clinic narrabeen --commit --clear
 *
 * Required env: GOOGLE_SHEETS_REFRESH_TOKEN, GOOGLE_SHEETS_CLIENT_ID/SECRET
 */

import path from 'path';
import { google } from 'googleapis';
import { pool, query, withTransaction } from './pool';
import { env } from '../config/env';
import { authService } from '../services/auth.service';
import { userRepository, UserRow } from '../repositories/user.repository';
import {
  DROPOUT_STATUSES, DROPOUT_REASONS,
  DropoutStatus, DropoutReason, ClinicId, isClinicId,
} from '../shared/roles';

// ── Per-clinic config ─────────────────────────────────────────────────────────

interface ClinicConfig {
  sheetId:             string;
  /** Must match the exact tab name in Google Sheets. */
  sheetTab:            string;
  clinicianAliases:    Record<string, string>;
  clinicianSkips:      readonly string[];
  reasonAliases:       Record<string, DropoutReason>;
  frontStaffAliases:   Record<string, string | null>;
}

const CLINIC_CONFIGS: Record<string, ClinicConfig> = {
  newport: {
    sheetId:          '1Wl91IdBkrGkhzJfu9keSxjlAOZFyazS_Z5R5Z_y85u8',
    // Use the NAMED tab, not the first tab — the sheet was reordered (a "New
    // Patient Lead Conversion Tracker" tab is now first), so 'A:I' would read
    // the wrong tab. The dropout data lives in "Daily Patient Dropout Tracking".
    sheetTab:         "'Daily Patient Dropout Tracking'!A:I",
    clinicianAliases: {},
    clinicianSkips:   ['Other - Physio'],
    reasonAliases:    { 'Physio Discharged': 'Discharged' },
    frontStaffAliases:{ 'Front of staff name': null },
  },
  narrabeen: {
    sheetId:          '1Qoz-0UXLXH-CvojnReUg3wxwL8rgn3HFcGHBYOi43-w',
    sheetTab:         "'Daily Patient Dropout Tracking'!A:I",
    clinicianAliases: { Zac: 'Zach' },
    clinicianSkips:   ['Reformer Bed', 'Sam', 'Other - Physio'],
    reasonAliases:    { 'Work': 'Work Commitments', 'Physio Discharged': 'Discharged' },
    frontStaffAliases:{ 'No reception': null, 'Front of staff name': null },
  },
  brookvale: {
    sheetId:          '1BhEYel_NJlEK46gq-kFqmx87WgCdo0XA5PtnXF4Q4cU',
    sheetTab:         "'Daily Patient Dropout Tracking'!A:I",
    clinicianAliases: {},
    clinicianSkips:   ['Other - Physio'],
    reasonAliases:    { 'Physio Discharged': 'Discharged' },
    frontStaffAliases:{
      'Jesse':          'Other - Physio',
      'Emma physio':    'Other - Physio',
      'Jesse physio':   'Other - Physio',
      'physio':         'Other - Physio',
      'Angus':          'Other - Physio',
      'Jervis':         'Other - Physio',
      'Sam':            'Other - Physio',
      'Front of staff name': null,
    },
  },
};

/** Year used to infer the year for bare "DD.MM" appointment-cancelled tokens. */
const SOURCE_YEAR = 2026;

// ── Auth ──────────────────────────────────────────────────────────────────────
// Supports two options (checked in order):
//
//   Option A — OAuth2 refresh token (recommended — reuses existing Google Ads credentials):
//     GOOGLE_SHEETS_REFRESH_TOKEN=<token>
//     uses GOOGLE_ADS_CLIENT_ID + GOOGLE_ADS_CLIENT_SECRET from .env
//
//   Option B — Service account JSON key file:
//     GOOGLE_SHEETS_KEY_FILE=<path-to-service-account.json>

async function buildAuthClient(): Promise<any> {
  const refreshToken = process.env.GOOGLE_SHEETS_REFRESH_TOKEN?.trim();
  const keyFile      = process.env.GOOGLE_SHEETS_KEY_FILE?.trim();

  if (refreshToken) {
    const clientId     = process.env.GOOGLE_SHEETS_CLIENT_ID?.trim();
    const clientSecret = process.env.GOOGLE_SHEETS_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) {
      throw new Error(
        'GOOGLE_SHEETS_CLIENT_ID and GOOGLE_SHEETS_CLIENT_SECRET must be set in .env ' +
        'when using GOOGLE_SHEETS_REFRESH_TOKEN.'
      );
    }
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

  throw new Error(
    'Google Sheets auth not configured. Add ONE of these to .env:\n' +
    '  GOOGLE_SHEETS_REFRESH_TOKEN=<token>   (uses existing GOOGLE_ADS_CLIENT_ID/SECRET)\n' +
    '  GOOGLE_SHEETS_KEY_FILE=<path>          (service account JSON key file)'
  );
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function pad2(n: string | number): string {
  return String(n).padStart(2, '0');
}

/**
 * Parse date_logged from the Google Sheets formatted string.
 * The sheet uses Australian locale so cells display as D/M/YYYY.
 * Also accepts ISO YYYY-MM-DD if the API returns serialised dates.
 */
function parseDateLogged(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  // ISO YYYY-MM-DD (or with time)
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return s.slice(0, 10);

  // Australian D/M/YYYY or D/M/YY
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yyyy}-${pad2(m[2])}-${pad2(m[1])}`;
  }

  // D.M.YYYY fallback
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (m) {
    const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yyyy}-${pad2(m[2])}-${pad2(m[1])}`;
  }

  return null;
}

/**
 * Parse a single DD.MM or DD/MM or DD.MM.YY[YY] token.
 * A bare DD token inherits sharedMonth from the next anchored token.
 */
function parseDateToken(tok: string, sharedMonth: number | null): string | null {
  // Full date with year: DD.MM.YY or DD/MM/YY etc.
  let m = tok.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})$/);
  if (m) {
    const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yyyy}-${pad2(m[2])}-${pad2(m[1])}`;
  }
  // DD.MM or DD/MM
  m = tok.match(/^(\d{1,2})[\/.](\d{1,2})$/);
  if (m) return `${SOURCE_YEAR}-${pad2(m[2])}-${pad2(m[1])}`;
  // Bare day — inherits month from the next anchored token in the same cell
  m = tok.match(/^(\d{1,2})$/);
  if (m && sharedMonth !== null) {
    return `${SOURCE_YEAR}-${pad2(sharedMonth)}-${pad2(m[1])}`;
  }
  return null;
}

/**
 * Parse the Appointment Date Cancelled cell which may hold one or many dates
 * in free-form notation.
 *
 * Examples handled:
 *   "07.01"                        → ["2026-01-07"]
 *   "08,15,22,29.05&05.05,12.06"   → ["2026-05-08","2026-05-15","2026-05-22",
 *                                       "2026-05-29","2026-05-05","2026-06-12"]
 *   "18.02, 23.02, 02.03"          → three dates
 *   "discharged" / "" / "Y"        → []
 *
 * Algorithm: scan tokens left-to-right; a bare day number inherits the month
 * of the NEXT anchored token (DD.MM form) to the right.
 */
function parseApptCancelled(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const text = raw.trim();
  if (!text) return [];

  // Single ISO date fast-path
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return [text.slice(0, 10)];

  const normalized = text
    .replace(/\(/g, ' ').replace(/\)/g, ' ')
    .replace(/\b(?:and|AND|And|DNA|dna)\b/g, ' ');

  const tokens = normalized
    .split(/[,\s&]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  // Regex to detect a token that carries an explicit month (DD.MM or DD/MM [.YYYY])
  const monthRegex = /^(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?$/;
  const out: string[] = [];

  let i = 0;
  while (i < tokens.length) {
    // Look ahead to the next token that has an explicit month
    let j = i;
    while (j < tokens.length && !monthRegex.test(tokens[j])) j++;
    if (j >= tokens.length) break; // no more anchors — remaining bare days have no month

    const anchorMatch = tokens[j].match(monthRegex)!;
    const sharedMonth = parseInt(anchorMatch[2], 10);

    // All bare-day tokens between i and j inherit sharedMonth
    for (let k = i; k < j; k++) {
      const bare = tokens[k].match(/^(\d{1,2})$/);
      if (bare) {
        out.push(`${SOURCE_YEAR}-${pad2(sharedMonth)}-${pad2(bare[1])}`);
      }
    }

    // The anchor token itself
    const explicit = parseDateToken(tokens[j], sharedMonth);
    if (explicit) out.push(explicit);

    i = j + 1;
  }

  // Deduplicate while preserving order; cap at 50 (DB/validator limit)
  return [...new Set(out)].slice(0, 50);
}

// ── Clinician helpers (mirrors import-dropouts-2026.ts) ───────────────────────

function firstWord(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

async function findClinicianByFirstName(firstName: string, clinicId: string): Promise<UserRow | null> {
  const fw = firstWord(firstName);
  const { rows } = await query<UserRow>(
    `SELECT * FROM users
      WHERE role = 'CLINICIAN'
        AND clinic_id = $1
        AND (
          LOWER(full_name) = LOWER($2)
          OR LOWER(full_name) = LOWER($3)
          OR LOWER(full_name) LIKE LOWER($4)
        )
      ORDER BY id ASC LIMIT 1`,
    [clinicId, firstName, fw, `${fw} %`]
  );
  return rows[0] ?? null;
}

async function findClinicianAnywhere(firstName: string): Promise<UserRow | null> {
  const fw = firstWord(firstName);
  const { rows } = await query<UserRow>(
    `SELECT * FROM users
      WHERE role = 'CLINICIAN'
        AND is_active = true
        AND (
          LOWER(full_name) = LOWER($1)
          OR LOWER(full_name) = LOWER($2)
          OR LOWER(full_name) LIKE LOWER($3)
        )
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
  firstName:         string,
  clinicId:          string,
  commit:            boolean,
  tempPasswordPlain: string,
): Promise<{ id: string | null; created: boolean; reused: boolean; email: string }> {
  const inTarget = await findClinicianByFirstName(firstName, clinicId);
  if (inTarget) return { id: inTarget.id, created: false, reused: false, email: inTarget.email };

  const elsewhere = await findClinicianAnywhere(firstName);
  if (elsewhere) return { id: elsewhere.id, created: false, reused: true, email: elsewhere.email };

  const baseEmail  = firstNameToEmail(firstName);
  let   email      = baseEmail;
  const baseTaken  = await userRepository.findByEmail(baseEmail);
  if (baseTaken) email = `${firstName.toLowerCase().replace(/[^a-z0-9]/g, '')}-${clinicId}@physioward.com.au`;
  if (!commit) return { id: null, created: true, reused: false, email };

  const passwordHash = await authService.hashPassword(tempPasswordPlain);
  const created = await userRepository.create({
    email, passwordHash, role: 'CLINICIAN', full_name: firstName, clinic_id: clinicId,
  });
  return { id: created.id, created: true, reused: false, email: created.email };
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ParsedRow {
  sheetRowNum: number;
  date_logged: string | null;
  front_staff: string | null;
  clinician:   string | null;
  patient:     string | null;
  appt_dates:  string[];
  status:      string | null;
  reason:      string | null;
  notes:       string | null;
}

interface ValidRow {
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
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cell(row: string[], idx: number): string | null {
  const v = (row[idx] ?? '').trim();
  return v === '' ? null : v;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const clear  = process.argv.includes('--clear');

  const clinicArg = process.argv[process.argv.indexOf('--clinic') + 1];
  if (!clinicArg || !isClinicId(clinicArg)) {
    throw new Error(`Pass --clinic <id>. Valid: ${Object.keys(CLINIC_CONFIGS).join(', ')}`);
  }
  const CLINIC = clinicArg as ClinicId;
  const cfg    = CLINIC_CONFIGS[CLINIC];

  console.log(`[gsheets] mode:    ${commit ? 'COMMIT' : 'DRY-RUN'}`);
  console.log(`[gsheets] clinic:  ${CLINIC}`);
  console.log(`[gsheets] sheet:   ${cfg.sheetId}`);
  console.log(`[gsheets] tab:     ${cfg.sheetTab}`);
  if (clear) console.log(`[gsheets] --clear: existing ${CLINIC} rows will be DELETED before inserting`);

  // ── Auth & fetch ───────────────────────────────────────────────────────────
  const auth    = await buildAuthClient();
  const sheets  = google.sheets({ version: 'v4', auth });

  console.log('\n[gsheets] fetching sheet data…');
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: cfg.sheetId,
    range:         cfg.sheetTab,
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const allRows: string[][] = (resp.data.values ?? []).map(
    (r) => r.map((v) => String(v ?? ''))
  );
  console.log(`[gsheets] ${allRows.length} rows fetched (including header)`);

  // ── Parse ──────────────────────────────────────────────────────────────────
  // Skip row 0 (header). Also skip any subsequent row whose col-0 value is
  // "date" (in case of repeated header pastes in the data area).
  const parsed: ParsedRow[] = [];
  for (let i = 1; i < allRows.length; i++) {
    const r        = allRows[i];
    const col0     = (r[0] ?? '').trim().toLowerCase();
    if (col0 === 'date') continue; // repeated header row in data area

    const date_logged = parseDateLogged(cell(r, 0));
    const front_staff = cell(r, 1);
    const clinician   = cell(r, 2);
    const patient     = cell(r, 3);
    const appt_dates  = parseApptCancelled(cell(r, 4));
    const status      = cell(r, 5);
    // r[6] = "Appts Attended on DC" — Narrabeen-specific field, not stored
    const reason      = cell(r, 7);
    const notes       = cell(r, 8);
    // r[9]  = Cross-checked    — intentionally excluded from SHEET_RANGE fetch
    // r[10] = Note from Cath   — intentionally excluded
    // r[11] = Transferred?     — intentionally excluded

    // Skip fully blank rows
    if (!date_logged && !front_staff && !clinician && !patient && !status) continue;

    parsed.push({
      sheetRowNum: i + 1,
      date_logged,
      front_staff,
      clinician,
      patient,
      appt_dates,
      status,
      reason,
      notes,
    });
  }
  console.log(`[gsheets] ${parsed.length} non-empty data rows`);

  // ── Admin user (entered_by) ────────────────────────────────────────────────
  const admin = await userRepository.findByEmail(env.CEO_EMAIL);
  if (!admin) throw new Error(`Admin user ${env.CEO_EMAIL} not found — run db:seed first.`);
  console.log(`[gsheets] entered_by: ${admin.email} (id=${admin.id})`);

  // ── Clinicians ─────────────────────────────────────────────────────────────
  const namesInSheet = [...new Set(
    parsed
      .map((r) => r.clinician)
      .filter((s): s is string => !!s)
      .filter((s) => !cfg.clinicianSkips.includes(s as any))
      .map((s) => cfg.clinicianAliases[s] ?? s),
  )];
  console.log(`[gsheets] clinicians referenced (after aliases): ${namesInSheet.join(', ')}`);

  const needsCreate = commit && await (async () => {
    for (const name of namesInSheet) {
      if (!await findClinicianByFirstName(name, CLINIC) && !await findClinicianAnywhere(name)) return true;
    }
    return false;
  })();

  const tempPwd = (commit && needsCreate)
    ? (() => {
        const p = process.env.IMPORT_CLINICIAN_TEMP_PASSWORD?.trim() ?? '';
        if (p.length < 8) throw new Error(
          'IMPORT_CLINICIAN_TEMP_PASSWORD must be set (min 8 chars) when new clinicians need provisioning.'
        );
        return p;
      })()
    : '';

  const clinicianMap = new Map<string, string>();
  console.log('\n[gsheets] resolving clinicians:');
  for (const name of namesInSheet) {
    const r = await ensureClinician(name, CLINIC, commit, tempPwd);
    if (r.id === null) {
      console.log(`  + would create  ${name.padEnd(12)}  ${r.email}`);
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
    // In dry-run mode, populate the map with placeholders so validate() can proceed
    for (const name of namesInSheet) {
      if (!clinicianMap.has(name)) clinicianMap.set(name, '<dry-run>');
    }
  }

  // ── Validate ───────────────────────────────────────────────────────────────
  const valid:   ValidRow[]                            = [];
  const skipped: { row: number; reason: string }[]    = [];
  const nullStatusRows: number[]                       = [];
  const nullReasonRows: number[]                       = [];

  for (const r of parsed) {
    if (!r.status) nullStatusRows.push(r.sheetRowNum);
    if (!r.reason) nullReasonRows.push(r.sheetRowNum);

    if (!r.date_logged) {
      skipped.push({ row: r.sheetRowNum, reason: 'unparseable date_logged' }); continue;
    }
    if (!r.patient) {
      skipped.push({ row: r.sheetRowNum, reason: 'missing patient_name' }); continue;
    }
    if (!r.clinician) {
      skipped.push({ row: r.sheetRowNum, reason: 'missing clinician' }); continue;
    }
    if (cfg.clinicianSkips.includes(r.clinician as any)) {
      skipped.push({ row: r.sheetRowNum, reason: `clinician "${r.clinician}" skipped` }); continue;
    }

    const clinicianKey = cfg.clinicianAliases[r.clinician] ?? r.clinician;
    const clinicianId  = clinicianMap.get(clinicianKey);
    if (!clinicianId) {
      skipped.push({ row: r.sheetRowNum, reason: `clinician "${r.clinician}" not provisioned` }); continue;
    }

    let status: DropoutStatus | null = null;
    if (r.status) {
      // Case-insensitive match to handle sheet inconsistencies like
      // "No future bookings" vs "No Future Bookings"
      const matched = (DROPOUT_STATUSES as readonly string[]).find(
        (s) => s.toLowerCase() === r.status!.toLowerCase()
      );
      if (!matched) {
        skipped.push({ row: r.sheetRowNum, reason: `unknown status "${r.status}"` }); continue;
      }
      status = matched as DropoutStatus;
    }

    let reason: DropoutReason | null = null;
    if (r.reason) {
      const aliased = cfg.reasonAliases[r.reason] ?? r.reason;
      if (!(DROPOUT_REASONS as readonly string[]).includes(aliased)) {
        skipped.push({ row: r.sheetRowNum, reason: `unknown reason "${r.reason}"` }); continue;
      }
      reason = aliased as DropoutReason;
    }

    let frontStaff: string | null = null;
    if (r.front_staff) {
      if (Object.prototype.hasOwnProperty.call(cfg.frontStaffAliases, r.front_staff)) {
        frontStaff = cfg.frontStaffAliases[r.front_staff];
      } else {
        frontStaff = r.front_staff.trim().slice(0, 120);
      }
    }

    valid.push({
      clinic_id:                   CLINIC,
      entered_by:                  admin.id,
      front_staff_name:            frontStaff,
      clinician_id:                clinicianId,
      patient_name:                r.patient.slice(0, 200),
      date_logged:                 r.date_logged,
      appointment_cancelled_dates: r.appt_dates,
      status,
      reason,
      notes:                       r.notes ? r.notes.slice(0, 2000) : null,
    });
  }

  console.log(`\n[gsheets] validation:`);
  console.log(`  valid         ${valid.length}`);
  console.log(`  skipped       ${skipped.length}`);
  console.log(`  status NULL   ${nullStatusRows.length}  (blank in source — stored as NULL)`);
  console.log(`  reason NULL   ${nullReasonRows.length}  (blank in source — stored as NULL)`);

  if (skipped.length) {
    console.log('\n[gsheets] skipped rows:');
    for (const s of skipped) console.log(`  row ${s.row}: ${s.reason}`);
  }

  // ── Overlap warning (skip when --clear since we're replacing anyway) ────────
  if (!clear && valid.length > 0) {
    const minDate = valid.reduce((m, v) => v.date_logged < m ? v.date_logged : m, valid[0].date_logged);
    const maxDate = valid.reduce((m, v) => v.date_logged > m ? v.date_logged : m, valid[0].date_logged);
    const { rows: existing } = await query<{ n: string }>(
      `SELECT COUNT(*)::bigint AS n
         FROM patient_dropouts
        WHERE clinic_id  = $1
          AND date_logged BETWEEN $2 AND $3`,
      [CLINIC, minDate, maxDate]
    );
    const n = Number(existing[0]?.n ?? 0);
    if (n > 0) {
      console.log(`\n[gsheets] WARNING: ${n} existing newport rows overlap ${minDate}..${maxDate}.`);
      console.log('[gsheets]           Re-run with --clear --commit to delete all rows first.');
    }
  }

  if (!commit) {
    console.log(`\n[gsheets] DRY-RUN complete. Re-run with --commit to insert ${valid.length} rows.`);
    return;
  }

  // ── Commit ─────────────────────────────────────────────────────────────────
  await withTransaction(async (client) => {
    if (clear) {
      const del = await client.query(
        `DELETE FROM patient_dropouts WHERE clinic_id = $1`, [CLINIC]
      );
      console.log(`\n[gsheets] cleared ${del.rowCount} existing ${CLINIC} rows`);
    }

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

  console.log(`[gsheets] inserted ${valid.length} rows into patient_dropouts.`);
  if (needsCreate) {
    console.log('[gsheets] New clinician accounts were created with IMPORT_CLINICIAN_TEMP_PASSWORD.');
    console.log('[gsheets] Share credentials out-of-band and ask each user to change their password.');
  }
}

if (require.main === module) {
  run()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[gsheets] failed:', err);
      pool.end().finally(() => process.exit(1));
    });
}
