import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { nookalV3 } from '../services/nookal-v3/client';
import { getWeekRanges } from '../services/week.calculator';
import { pool, query } from './pool';

/**
 * Import the EXACT Occupancy figures from Nookal's own report.
 *
 * Nookal → Reports → Occupancy → Export. One report per week, Locations = "All
 * Locations", Providers = "All Providers".
 *
 *   npm run db:import:occupancy -- --file "C:\\path\\occupancy.csv" \
 *                                  --year 2026 --month 8 --week 1
 *
 * ── Why an import and not an API call ───────────────────────────────────────
 * Nookal's report is Occupied ÷ Scheduled Minutes, where Scheduled Minutes is
 * ROSTER time. Verified against every row of the 03/08/2026-09/08/2026 report:
 * Gabriella 1410/1380 = 102.17%, Jervis 1890/2100 = 90%, Angus 1470/2160 =
 * 68.06%, and so on down to Zac 870/1890 = 46.03%.
 *
 * The roster is not in the v3 GraphQL API. The whole schema was walked on
 * 2026-08-20 — 60 types, none carrying a shift, roster, scheduled-minute or
 * working-hour field. Nor can it be reconstructed: booked + free + blocked lands
 * 60-480 minutes per practitioner away from the report, because blockouts spill
 * past roster hours and Nookal's "Events: 4 of 11 Events Selected" filter counts
 * some event types as occupied — and v3 reports every DiaryEvent with typeID
 * null, typeName null and empty notes, so those types cannot be told apart.
 *
 * So this file exists to carry the real number until a live v2 REST API key
 * makes `getSchedules` reachable, at which point the sync can compute it.
 *
 * Writes with occupancy_source = 'nookal_report', which outranks the sync's own
 * 'nookal' but loses to a person's 'manual' (migration 030). Re-running for the
 * same week corrects it in place.
 */

interface ReportRow {
  provider:  string;
  scheduled: number;
  occupied:  number;
}

// ── Argument parsing ───────────────────────────────────────────────────────

function args(): { file: string; year: number; month: number; week: number; dryRun: boolean } {
  const a = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = a.indexOf(`--${name}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const file  = get('file');
  const year  = Number(get('year'));
  const month = Number(get('month'));
  const week  = Number(get('week'));

  if (!file || !Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(week)) {
    console.error(
      'usage: import-occupancy-nookal.ts --file <export.csv|xlsx> --year 2026 --month 8 --week 1 [--dry-run]\n\n' +
      '  Export one Nookal Occupancy report per week, Locations = All Locations.\n' +
      '  --week 5 is the Remainder column the sheet carries after Week 4.'
    );
    process.exit(1);
  }
  if (month < 1 || month > 12) { console.error('month must be 1-12'); process.exit(1); }
  if (week  < 1 || week  > 5)  { console.error('week must be 1-5 (5 = Remainder)'); process.exit(1); }

  return { file, year, month, week, dryRun: a.includes('--dry-run') };
}

// ── Reading the export ─────────────────────────────────────────────────────

/** Header keys reduced to letters only, so "Scheduled Minutes", "scheduled_minutes"
 *  and "ScheduledMinutes" all land on the same column. */
const key = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');

/** Nookal writes "1,380" and "102.17%" — strip everything that is not part of a
 *  number rather than trusting Number() with the punctuation. */
function num(v: unknown): number {
  if (typeof v === 'number') return v;
  const cleaned = String(v ?? '').replace(/[^0-9.\-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Split one CSV line, honouring double-quoted fields. Nookal quotes the provider
 * name and thousands-separated numbers, so a plain split(',') tears rows apart.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // "" inside a quoted field is a literal quote.
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function pickColumns(header: string[]): { provider: number; scheduled: number; occupied: number } {
  const keys = header.map(key);
  // Substring match, not exact equality: Nookal's xlsx export renders the
  // "Scheduled Minutes" header as a merged cell with the column name repeated
  // plus a parenthetical description ("Scheduled Minutes\nScheduled Minutes\n
  // (Scheduled Time - Scheduled Breaks)"), which normalises to one long run
  // of letters that CONTAINS "scheduledminutes" but never equals it exactly.
  const find = (...cands: string[]) => {
    for (const c of cands) {
      const i = keys.findIndex((k) => k.includes(c));
      if (i >= 0) return i;
    }
    return -1;
  };
  const provider  = find('provider', 'practitioner', 'staff', 'name');
  const scheduled = find('scheduledminutes', 'scheduled', 'scheduledmins');
  const occupied  = find('occupied', 'occupiedminutes', 'occupiedmins');

  const missing = [
    provider  < 0 ? 'Provider'          : null,
    scheduled < 0 ? 'Scheduled Minutes' : null,
    occupied  < 0 ? 'Occupied'          : null,
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `export is missing column(s): ${missing.join(', ')}\n` +
      `  header seen: ${header.join(' | ')}\n` +
      `  Export the Occupancy report itself (the Summary table), not a drill-down.`
    );
  }
  return { provider, scheduled, occupied };
}

function sheetToGrid(ws: ExcelJS.Worksheet): string[][] {
  const grid: string[][] = [];
  ws.eachRow((row) => {
    const vals: string[] = [];
    // row.values is 1-based with a leading hole; values[0] is never a cell.
    const raw = row.values as unknown[];
    for (let i = 1; i < raw.length; i++) {
      const v = raw[i] as { text?: string; result?: unknown } | null;
      vals.push(v && typeof v === 'object'
        ? String(v.text ?? v.result ?? '')
        : String(v ?? ''));
    }
    grid.push(vals);
  });
  return grid;
}

/** Hunt for the row that actually looks like the header in a grid, rather than
 *  assuming it is the first — the export may carry title/date lines above the
 *  table. Returns null if this grid has no such row. */
function findHeader(grid: string[][]): { headerAt: number; cols: { provider: number; scheduled: number; occupied: number } } | null {
  for (let i = 0; i < Math.min(grid.length, 25); i++) {
    try { return { headerAt: i, cols: pickColumns(grid[i]) }; } catch { /* keep looking */ }
  }
  return null;
}

/** Rows out of the Summary table, whichever format the Export button produced. */
async function readRows(file: string): Promise<ReportRow[]> {
  if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);
  const ext = path.extname(file).toLowerCase();

  let grid: string[][];
  let found: ReturnType<typeof findHeader> = null;
  if (ext === '.xlsx' || ext === '.xls') {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    if (!wb.worksheets.length) throw new Error('workbook has no sheets');
    // The export can carry a "Parameters" info sheet ahead of the "Summary"
    // table — try every sheet rather than assuming the table is the first.
    grid = sheetToGrid(wb.worksheets[0]);
    for (const ws of wb.worksheets) {
      const g = sheetToGrid(ws);
      found = findHeader(g);
      if (found) { grid = g; break; }
    }
  } else {
    grid = fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
      .map(splitCsvLine);
    found = findHeader(grid);
  }

  if (!found) {
    // Re-run on the first row so the thrown error names the header it did see.
    pickColumns(grid[0] ?? []);
    throw new Error('could not find a header row');
  }
  const { headerAt, cols } = found;

  const rows: ReportRow[] = [];
  for (let i = headerAt + 1; i < grid.length; i++) {
    const r = grid[i];
    const provider = String(r[cols.provider] ?? '').trim();
    if (!provider) continue;
    // Nookal appends a "Total"/"Summary" line; it is not a practitioner.
    if (/^(total|totals|summary|grand total)$/i.test(provider)) continue;

    const scheduled = num(r[cols.scheduled]);
    const occupied  = num(r[cols.occupied]);
    if (!Number.isFinite(scheduled) || !Number.isFinite(occupied)) continue;

    rows.push({ provider, scheduled, occupied });
  }
  return rows;
}

// ── Provider → PhysioWard user ─────────────────────────────────────────────

const norm = (s: string | null | undefined) =>
  (s ?? '').toLowerCase().replace(/[^a-z]/g, '');

/**
 * The report prints Nookal's own provider names, and users.nookal_staff_id is
 * already resolved by the sync's syncProviderMapping. So go name → staffID →
 * user, and never re-guess the name matching that already has a home.
 */
async function providerToUser(): Promise<Map<string, { userId: string; fullName: string }>> {
  const data = await nookalV3.query<{ staff: { staffID: number; fullName: string | null }[] }>(
    `query S($pageLength: Int!) { staff(isProvider: 1, pageLength: $pageLength) { staffID fullName } }`,
    { pageLength: 200 }
  );
  const staff = Array.isArray(data.staff) ? data.staff : data.staff ? [data.staff] : [];

  const { rows: users } = await query<{ id: string; full_name: string | null; nookal_staff_id: number }>(
    `SELECT id, full_name, nookal_staff_id FROM users WHERE nookal_staff_id IS NOT NULL`
  );
  const userByStaffId = new Map<number, { userId: string; fullName: string }>();
  for (const u of users) {
    userByStaffId.set(Number(u.nookal_staff_id), { userId: u.id, fullName: u.full_name ?? '' });
  }

  const out = new Map<string, { userId: string; fullName: string }>();
  for (const s of staff) {
    const u = userByStaffId.get(Number(s.staffID));
    if (u && s.fullName) out.set(norm(s.fullName), u);
  }
  return out;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { file, year, month, week, dryRun } = args();

  const weeks = getWeekRanges(year, month);
  const wr = weeks.find((w) => (w.weekNum === 'remainder' ? 5 : w.weekNum) === week);
  if (!wr || wr.dateFrom === '9999-12-31') {
    console.error(`${year}-${month} has no week ${week}`);
    process.exit(1);
  }
  console.log(`\nImporting Nookal Occupancy → ${year}-${String(month).padStart(2, '0')} week ${week}`);
  console.log(`Week range in this app: ${wr.dateFrom} .. ${wr.dateTo}`);
  console.log(`CHECK: the report you exported must cover exactly that range.\n`);

  const rows = await readRows(file);
  console.log(`read ${rows.length} provider row(s) from ${path.basename(file)}`);

  const map = await providerToUser();

  const { rows: admins } = await query<{ id: string }>(
    `SELECT id FROM users WHERE role = 'ADMIN' ORDER BY id LIMIT 1`
  );
  const actingUserId = admins[0]?.id;
  if (!actingUserId) throw new Error('no ADMIN user to attribute the import to');

  let written = 0, skippedIdle = 0, unmatched: string[] = [], keptManual = 0;

  console.log('\nprovider                sched   occ   occupancy   result');
  for (const r of rows) {
    // Nothing rostered and nothing booked: the practitioner did not work that
    // week. Writing 0% would read as a total failure to fill a diary that was
    // never open.
    if (r.scheduled === 0 && r.occupied === 0) { skippedIdle += 1; continue; }

    const u = map.get(norm(r.provider));
    if (!u) { unmatched.push(r.provider); continue; }

    // Nookal shows 100% when Scheduled is 0 but time was booked. Reproduced so
    // the board matches the report, and flagged by the caller via the stored
    // scheduled_minutes = 0 — it is a roster error, not a full diary.
    const pct = r.scheduled > 0
      ? Math.round((r.occupied / r.scheduled) * 100 * 100) / 100
      : (r.occupied > 0 ? 100 : 0);

    const label = `${r.provider.padEnd(22)}${String(r.scheduled).padStart(6)}${String(r.occupied).padStart(6)}${(pct.toFixed(2) + '%').padStart(11)}`;
    if (dryRun) { console.log(`${label}   (dry run)`); continue; }

    // Insert the row if the week has none yet, then apply occupancy under the
    // precedence rule. Two statements rather than one upsert because the insert
    // must not disturb total_appts / new_cases / cancelled_count, which belong
    // to the appointment sync.
    await query(
      `INSERT INTO practitioner_week_inputs (clinician_id, year, month, week_num, entered_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (clinician_id, year, month, week_num) DO NOTHING`,
      [u.userId, year, month, week, actingUserId]
    );

    const { rowCount } = await query(
      `UPDATE practitioner_week_inputs
          SET occupancy_pct               = $5,
              occupancy_booked_minutes    = $6,
              occupancy_scheduled_minutes = $7,
              occupancy_available_minutes = NULL,
              occupancy_blocked_minutes   = NULL,
              occupancy_source            = 'nookal_report',
              occupancy_synced_at         = NOW(),
              updated_at                  = NOW(),
              updated_by                  = $8
        WHERE clinician_id = $1 AND year = $2 AND month = $3 AND week_num = $4
          -- A person's own figure outranks even the report (migration 030). A
          -- NULL source with a value present predates migration 029 and was
          -- hand-entered, so it counts as a person's too.
          AND (occupancy_pct IS NULL
               OR occupancy_source IN ('nookal', 'nookal_report'))`,
      [u.userId, year, month, week, pct, r.occupied, r.scheduled, actingUserId]
    );

    if (rowCount && rowCount > 0) { written += 1; console.log(`${label}   → ${u.fullName}`); }
    else                          { keptManual += 1; console.log(`${label}   kept hand-entered value for ${u.fullName}`); }
  }

  console.log(`\nwritten: ${written}`);
  console.log(`skipped, nothing rostered or booked: ${skippedIdle}`);
  console.log(`kept a hand-entered value: ${keptManual}`);
  if (unmatched.length) {
    console.log(`\nNO PhysioWard ACCOUNT for ${unmatched.length} provider(s) — their occupancy was NOT imported:`);
    for (const n of unmatched) console.log(`   ${n}`);
    console.log('These need a user with a matching nookal_staff_id, or they stay blank on the board.');
  }
  if (dryRun) console.log('\nDRY RUN — nothing was written.');
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error(`\nimport failed: ${e.message}`); process.exit(1); });
