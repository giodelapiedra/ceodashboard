/**
 * import-ad-leads-gsheets.ts
 *
 * Imports the Brookvale "Meta/Google ADS Leads" tab from Google Sheets into
 * `ad_leads` via the Sheets API v4.
 *
 * Only Brookvale runs paid-ad lead tracking (Newport / Narrabeen have no such
 * tab), so this importer is Brookvale-only.
 *
 * Imported columns (0-indexed) — an EXACT match of the tab's visible columns:
 *   0  Prospective Patient Name
 *   1  Platform Source
 *   2  Campaign Name
 *   3  Date Added       ("Mmm D, YYYY", e.g. "Mar 27, 2026")
 *   4  Booked?          ("Y - G" / "Y - FB" / blank)
 *   12 Bella Called?
 *   13 Bella SMS?
 *   14 Bella Remarks?
 * (Columns 5–11 in the API — Amt Paid / Last App Date / As of May 4 / Timeline /
 *  Moon's Audit — are hidden/legacy in the sheet and are intentionally ignored.)
 *
 * Usage:
 *   npm run db:import:ad-leads:gsheets -- --clinic brookvale            # dry-run
 *   npm run db:import:ad-leads:gsheets -- --clinic brookvale --commit   # insert
 *   npm run db:import:ad-leads:gsheets -- --clinic brookvale --clear --commit  # full replace
 *
 * Required env: GOOGLE_SHEETS_REFRESH_TOKEN + GOOGLE_SHEETS_CLIENT_ID/SECRET
 * (falls back to GOOGLE_ADS_CLIENT_ID/SECRET), OR GOOGLE_SHEETS_KEY_FILE.
 */

import path from 'path';
import { google } from 'googleapis';
import { pool, query, withTransaction } from './pool';
import { env } from '../config/env';
import { userRepository } from '../repositories/user.repository';
import { isClinicId } from '../shared/roles';

interface ClinicConfig {
  sheetId:  string;
  sheetTab: string;
}

// Only Brookvale has a Meta/Google ADS Leads tab.
const CLINIC_CONFIGS: Record<string, ClinicConfig> = {
  brookvale: {
    sheetId:  '1BhEYel_NJlEK46gq-kFqmx87WgCdo0XA5PtnXF4Q4cU',
    sheetTab: "'Meta/Google ADS Leads'!A:O",
  },
};

const SOURCE_YEAR = 2026;

// ── Auth (mirrors import-dropouts-gsheets.ts) ─────────────────────────────────
async function buildAuthClient(): Promise<any> {
  const refreshToken = process.env.GOOGLE_SHEETS_REFRESH_TOKEN?.trim();
  const keyFile      = process.env.GOOGLE_SHEETS_KEY_FILE?.trim();

  if (refreshToken) {
    const clientId     = (process.env.GOOGLE_SHEETS_CLIENT_ID     || process.env.GOOGLE_ADS_CLIENT_ID)?.trim();
    const clientSecret = (process.env.GOOGLE_SHEETS_CLIENT_SECRET || process.env.GOOGLE_ADS_CLIENT_SECRET)?.trim();
    if (!clientId || !clientSecret) {
      throw new Error('GOOGLE_SHEETS_CLIENT_ID and GOOGLE_SHEETS_CLIENT_SECRET (or GOOGLE_ADS_*) must be set.');
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
  throw new Error('Set GOOGLE_SHEETS_REFRESH_TOKEN or GOOGLE_SHEETS_KEY_FILE in .env');
}

// ── Date parsing ──────────────────────────────────────────────────────────────
function pad2(n: number): string { return String(n).padStart(2, '0'); }

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 31;
}

/**
 * Parse "Mmm D, YYYY" (e.g. "Mar 27, 2026"), tolerating ISO and D/M/YYYY.
 * Returns YYYY-MM-DD or null.
 */
function parseSheetDate(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  let m = s.match(/^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    const day   = parseInt(m[2], 10);
    const year  = parseInt(m[3], 10);
    if (month && day >= 1 && day <= daysInMonth(year, month)) return `${year}-${pad2(month)}-${pad2(day)}`;
    return null;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return s.slice(0, 10);
  // AU D/M/YYYY or D.M.YY[YY] (e.g. "10.06.26" = 10 June 2026).
  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/);
  if (m) {
    const day = parseInt(m[1], 10), month = parseInt(m[2], 10);
    const year = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)) {
      return `${year}-${pad2(month)}-${pad2(day)}`;
    }
  }
  return null;
}

function cell(row: string[], idx: number): string | null {
  const v = (row[idx] ?? '').trim();
  return v === '' ? null : v;
}

// ── Main ──────────────────────────────────────────────────────────────────────
export async function run(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const clear  = process.argv.includes('--clear');

  const clinicArg = process.argv[process.argv.indexOf('--clinic') + 1];
  if (!clinicArg || !isClinicId(clinicArg) || !CLINIC_CONFIGS[clinicArg]) {
    throw new Error(`Pass --clinic <id>. Valid: ${Object.keys(CLINIC_CONFIGS).join(', ')}`);
  }
  const CLINIC = clinicArg;
  const cfg    = CLINIC_CONFIGS[CLINIC];

  console.log(`[ad-leads] mode:   ${commit ? 'COMMIT' : 'DRY-RUN'}`);
  console.log(`[ad-leads] clinic: ${CLINIC}`);
  console.log(`[ad-leads] sheet:  ${cfg.sheetId}`);
  console.log(`[ad-leads] tab:    ${cfg.sheetTab}`);
  if (clear) console.log(`[ad-leads] --clear: existing ${CLINIC} ad_leads will be DELETED first`);

  const auth   = await buildAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  console.log('\n[ad-leads] fetching sheet data…');
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId:     cfg.sheetId,
    range:             cfg.sheetTab,
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const allRows: string[][] = (resp.data.values ?? []).map((r) => r.map((v) => String(v ?? '')));
  console.log(`[ad-leads] ${allRows.length} rows fetched (including header)`);

  const admin = await userRepository.findByEmail(env.CEO_EMAIL);
  if (!admin) throw new Error(`Admin ${env.CEO_EMAIL} not found — run db:seed first.`);
  console.log(`[ad-leads] entered_by: ${admin.email} (id=${admin.id})`);

  interface ValidRow {
    patient_name:  string;
    platform:      string;
    campaign_name: string | null;
    date_added:    string;
    booked:        boolean;
    bella_called:  string | null;
    bella_sms:     string | null;
    bella_remarks: string | null;
  }

  const valid:   ValidRow[]                        = [];
  const skipped: { row: number; reason: string }[] = [];
  let dateFixes = 0;

  for (let i = 1; i < allRows.length; i++) {
    const r    = allRows[i];
    const name = cell(r, 0);
    if (!name || name.toLowerCase() === 'prospective patient name') continue;

    let date_added = parseSheetDate(cell(r, 3));
    if (!date_added) {
      skipped.push({ row: i + 1, reason: `unparseable Date Added "${cell(r, 3) ?? ''}"` });
      continue;
    }
    if (!date_added.startsWith(`${SOURCE_YEAR}-`)) {
      date_added = `${SOURCE_YEAR}-${date_added.slice(5)}`;
      dateFixes++;
    }

    const bookedRaw = cell(r, 4);
    valid.push({
      patient_name:  name.slice(0, 200),
      platform:      (cell(r, 1) ?? 'Facebook Lead Form Ads').slice(0, 200),
      campaign_name: cell(r, 2)?.slice(0, 200) ?? null,
      date_added,
      booked:        bookedRaw ? /^y/i.test(bookedRaw) : false,
      bella_called:  cell(r, 12)?.slice(0, 200) ?? null,
      bella_sms:     cell(r, 13)?.slice(0, 200) ?? null,
      bella_remarks: cell(r, 14)?.slice(0, 2000) ?? null,
    });
  }

  console.log(`\n[ad-leads] validation:`);
  console.log(`  valid    ${valid.length}`);
  console.log(`  skipped  ${skipped.length}`);
  if (dateFixes) console.log(`  ⚠ ${dateFixes} date(s) had year coerced to ${SOURCE_YEAR}`);
  if (skipped.length) skipped.forEach((s) => console.log(`  row ${s.row}: ${s.reason}`));

  const booked = valid.filter((v) => v.booked).length;
  const platforms: Record<string, number> = {};
  valid.forEach((v) => { platforms[v.platform] = (platforms[v.platform] ?? 0) + 1; });
  console.log(`\n[ad-leads] booked leads: ${booked}/${valid.length}`);
  console.log(`[ad-leads] platforms: ${JSON.stringify(platforms)}`);

  if (!clear && valid.length > 0) {
    const { rows: ex } = await query<{ n: string }>(
      `SELECT COUNT(*)::bigint AS n FROM ad_leads WHERE clinic_id = $1`, [CLINIC]);
    if (Number(ex[0]?.n ?? 0) > 0) {
      console.log(`\n[ad-leads] WARNING: ${ex[0].n} existing ${CLINIC} rows. Re-run with --clear to replace.`);
    }
  }

  if (!commit) {
    console.log(`\n[ad-leads] DRY-RUN complete. Re-run with --commit to insert ${valid.length} rows.`);
    return;
  }

  await withTransaction(async (client) => {
    if (clear) {
      // Scoped to this importer's own rows — see the long note in
      // import-dropouts-gsheets.ts. Bella encodes ad-leads directly in the
      // app (9 Brookvale rows as of 2026-08-06); a clinic-wide delete would
      // wipe them and they are not in the sheet to be re-created.
      const del = await client.query(
        `DELETE FROM ad_leads WHERE clinic_id = $1 AND entered_by = $2`,
        [CLINIC, admin.id]
      );
      const kept = await client.query<{ n: string }>(
        `SELECT COUNT(*)::bigint AS n FROM ad_leads
          WHERE clinic_id = $1 AND entered_by <> $2`,
        [CLINIC, admin.id]
      );
      console.log(`\n[ad-leads] cleared ${del.rowCount} previously-imported ${CLINIC} rows`);
      console.log(`[ad-leads] preserved ${kept.rows[0]?.n ?? 0} manually-encoded ${CLINIC} rows`);
    }
    for (const v of valid) {
      await client.query(
        `INSERT INTO ad_leads (
           clinic_id, entered_by, patient_name, platform, campaign_name,
           date_added, booked, bella_called, bella_sms, bella_remarks
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          CLINIC, admin.id, v.patient_name, v.platform, v.campaign_name,
          v.date_added, v.booked, v.bella_called, v.bella_sms, v.bella_remarks,
        ]
      );
    }
  });

  console.log(`[ad-leads] inserted ${valid.length} rows into ad_leads.`);
}

if (require.main === module) {
  run()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[ad-leads] failed:', err);
      pool.end().finally(() => process.exit(1));
    });
}
