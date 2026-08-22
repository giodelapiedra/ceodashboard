import { scrapeNookalOccupancy, OccupancyScrapeResult, NookalOccupancyScraper } from '../../services/nookal-occupancy-scraper.service';
import { nookalV3 } from '../../services/nookal-v3/client';
import { getWeekRanges } from '../../services/week.calculator';
import { query } from '../../db/pool';

/**
 * Import Occupancy data from the Nookal web report via browser automation.
 *
 * This bridges the gap between the API-based sync (which only works for fresh weeks)
 * and the manual CSV import. It automates the browser to scrape the exact figures
 * Nookal displays on the Occupancy report page.
 *
 * Writes with occupancy_source = 'nookal_report', which outranks the API-derived
 * 'nookal_api' but loses to a person's 'manual'. Same precedence as the CSV import.
 */

const norm = (s: string | null | undefined): string =>
  (s ?? '').toLowerCase().replace(/[^a-z]/g, '');

export interface OccupancyScrapeSyncResult {
  written: number;
  keptManual: number;
  skippedIdle: number;
  unmatched: string[];
  scraped: number;
  dateFrom: string;
  dateTo: string;
}

/**
 * Map scraped provider names to PhysioWard user IDs using nookal_staff_id.
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

/**
 * Sync occupancy from the Nookal web report for a specific week.
 */
export async function syncOccupancyFromScraper(
  year: number,
  month: number,
  weekNum: number,
  actingUserId: string,
  options: { dryRun?: boolean; log?: (line: string) => void } = {}
): Promise<OccupancyScrapeSyncResult> {
  const log = options.log ?? (() => {});
  const dryRun = options.dryRun ?? false;

  if (!NookalOccupancyScraper.isConfigured()) {
    throw new Error(
      'Nookal web credentials not configured. Set NOOKAL_WEB_EMAIL and NOOKAL_WEB_PASSWORD in .env'
    );
  }

  // Get week ranges for the month
  const weeks = getWeekRanges(year, month).filter(w => w.dateFrom !== '9999-12-31');
  const week = weeks.find(w => (w.weekNum === 'remainder' ? 5 : w.weekNum) === weekNum);

  if (!week) {
    throw new Error(`Week ${weekNum} not found in ${year}-${month}`);
  }

  log(`[occupancy-scraper] Syncing week ${weekNum}: ${week.dateFrom} to ${week.dateTo}`);

  // Scrape the occupancy data from Nookal
  const scrapeResult = await scrapeNookalOccupancy(week.dateFrom, week.dateTo);
  log(`[occupancy-scraper] Scraped ${scrapeResult.rows.length} provider rows`);

  // Map providers to users
  const map = await providerToUser();

  const result: OccupancyScrapeSyncResult = {
    written: 0,
    keptManual: 0,
    skippedIdle: 0,
    unmatched: [],
    scraped: scrapeResult.rows.length,
    dateFrom: week.dateFrom,
    dateTo: week.dateTo,
  };

  for (const row of scrapeResult.rows) {
    // Skip rows with no scheduled or occupied time
    if (row.scheduledMinutes === 0 && row.occupiedMinutes === 0) {
      result.skippedIdle++;
      continue;
    }

    const u = map.get(norm(row.provider));
    if (!u) {
      result.unmatched.push(row.provider);
      continue;
    }

    // Calculate occupancy percentage if not provided
    const pct = row.occupancyPct > 0
      ? row.occupancyPct
      : row.scheduledMinutes > 0
        ? Math.round((row.occupiedMinutes / row.scheduledMinutes) * 100 * 100) / 100
        : row.occupiedMinutes > 0 ? 100 : 0;

    log(`  ${row.provider} → ${u.fullName}: ${row.scheduledMinutes} sched, ${row.occupiedMinutes} occ, ${pct}%`);

    if (dryRun) continue;

    // Insert the row if it doesn't exist
    await query(
      `INSERT INTO practitioner_week_inputs (clinician_id, year, month, week_num, entered_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (clinician_id, year, month, week_num) DO NOTHING`,
      [u.userId, year, month, weekNum, actingUserId]
    );

    // Update with occupancy data, respecting precedence
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
          AND (occupancy_pct IS NULL
               OR occupancy_source IN ('nookal', 'nookal_api', 'nookal_report'))`,
      [u.userId, year, month, weekNum, pct, row.occupiedMinutes, row.scheduledMinutes, actingUserId]
    );

    if (rowCount && rowCount > 0) {
      result.written++;
    } else {
      result.keptManual++;
    }
  }

  log(`[occupancy-scraper] Done: ${result.written} written, ${result.keptManual} kept manual, ${result.skippedIdle} skipped idle`);
  if (result.unmatched.length > 0) {
    log(`[occupancy-scraper] Unmatched providers: ${result.unmatched.join(', ')}`);
  }

  return result;
}

/**
 * Sync occupancy from the Nookal web report for all weeks in a month.
 */
export async function syncMonthOccupancyFromScraper(
  year: number,
  month: number,
  actingUserId: string,
  options: { dryRun?: boolean; log?: (line: string) => void } = {}
): Promise<OccupancyScrapeSyncResult[]> {
  const log = options.log ?? (() => {});
  const weeks = getWeekRanges(year, month)
    .filter(w => w.dateFrom !== '9999-12-31')
    .map(w => ({ ...w, num: w.weekNum === 'remainder' ? 5 : (w.weekNum as number) }));

  log(`[occupancy-scraper] Syncing ${weeks.length} weeks for ${year}-${month}`);

  const results: OccupancyScrapeSyncResult[] = [];
  for (const w of weeks) {
    try {
      const result = await syncOccupancyFromScraper(year, month, w.num, actingUserId, options);
      results.push(result);
    } catch (err) {
      log(`[occupancy-scraper] Error syncing week ${w.num}: ${(err as Error).message}`);
    }
  }

  return results;
}
