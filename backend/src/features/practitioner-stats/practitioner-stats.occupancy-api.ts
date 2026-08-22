import { fetchWeekOccupancy, occupiedEventIds } from '../../services/nookal-occupancy.service';
import { getWeekRanges } from '../../services/week.calculator';
import { query } from '../../db/pool';

/**
 * Writing Occupancy from the Nookal v2 API onto Practitioner Stats.
 *
 * Two callers share this: the Sync button (via syncMonth) and the
 * db:sync:occupancy CLI that a weekly cron runs. They share it rather than each
 * holding their own copy of the precedence rule, because that rule is the whole
 * guarantee that a figure someone typed in is never overwritten — see migration
 * 031 for the ordering and nookal-occupancy.service.ts for how the figures are
 * measured.
 */

/** A week measured more than this many days after it ended is not trusted.
 *
 *  Nookal's roster answers as it stands today, so an old week loses shifts and
 *  the bookings inside them. Measured 2026-08-20: the grid tracked the diary to
 *  within 15-90 minutes at 1-3 days old, and by 11 days it had lost 840 minutes
 *  for one practitioner. Hence a line nearer the fresh end. */
export const MAX_AGE_DAYS = 10;

export interface OccupancySyncSummary {
  written:       number;
  keptOwned:     number;
  skippedIdle:   number;
  /** Practitioner-weeks where Nookal's roster could not account for the
   *  bookings already in the diary, so no figure was written. */
  skippedRoster: number;
  skippedWeeks:  number;
  unmatched:     string[];
  eventIds:      string[];
}

export interface OccupancySyncOptions {
  /** Just one week of the month (1-4, or 5 for the sheet's Remainder column). */
  week?:       number;
  dryRun?:     boolean;
  maxAgeDays?: number;
  /** Measure weeks Nookal can no longer describe. For diagnosis, not the board. */
  forceStale?: boolean;
  /** Where to send the running commentary. Silent by default, which is what the
   *  HTTP caller wants; the CLI passes console.log. */
  log?:        (line: string) => void;
  today?:      string;
}

/**
 * v2's practitioner IDs are the same numbers as v3's staffID — checked against
 * every provider on 2026-08-20 (Angus 117, Finn Van Lathum 170, "Sam Reformer
 * Bed" 114). So users.nookal_staff_id, which the appointment sync already
 * maintains, is the join, and no name matching is needed.
 */
async function usersByStaffId(): Promise<Map<number, { userId: string; fullName: string }>> {
  const { rows } = await query<{ id: string; full_name: string | null; nookal_staff_id: number }>(
    `SELECT id, full_name, nookal_staff_id FROM users WHERE nookal_staff_id IS NOT NULL`
  );
  const out = new Map<number, { userId: string; fullName: string }>();
  for (const r of rows) out.set(Number(r.nookal_staff_id), { userId: r.id, fullName: r.full_name ?? '' });
  return out;
}

export async function syncOccupancy(
  year:         number,
  month:        number,
  actingUserId: string,
  opts:         OccupancySyncOptions = {}
): Promise<OccupancySyncSummary> {
  const log        = opts.log ?? (() => {});
  const dryRun     = opts.dryRun ?? false;
  const maxAgeDays = opts.maxAgeDays ?? MAX_AGE_DAYS;
  const today      = opts.today ?? new Date().toISOString().slice(0, 10);

  const summary: OccupancySyncSummary = {
    written: 0, keptOwned: 0, skippedIdle: 0, skippedRoster: 0, skippedWeeks: 0,
    unmatched: [], eventIds: occupiedEventIds(),
  };

  const weeks = getWeekRanges(year, month)
    .filter((w) => w.dateFrom !== '9999-12-31')
    .map((w) => ({ ...w, num: w.weekNum === 'remainder' ? 5 : (w.weekNum as number) }))
    .filter((w) => opts.week === undefined || w.num === opts.week);

  const map       = await usersByStaffId();
  const unmatched = new Set<string>();

  for (const w of weeks) {
    log(`\n── week ${w.num}  ${w.dateFrom} .. ${w.dateTo}`);

    // A part-week understates both columns, so it is not measured at all.
    if (w.dateTo >= today) {
      log('   still running — skipped.');
      summary.skippedWeeks += 1;
      continue;
    }

    // Age is checked BEFORE fetching. Measuring a week costs one getSchedules
    // call per practitioner per location — around forty for this practice — and
    // there is no reason to spend them on a week that will be thrown away.
    const daysAfter = Math.round(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${w.dateTo}T00:00:00Z`)) / 86_400_000
    );
    if (daysAfter > maxAgeDays && !opts.forceStale) {
      log(`   ${daysAfter} days old — skipped. Nookal's roster has moved on; use db:import:occupancy for this week.`);
      summary.skippedWeeks += 1;
      continue;
    }

    const result = await fetchWeekOccupancy(w.dateFrom, w.dateTo, today);
    log(`   measured ${result.measuredDaysAfter} day(s) after the week ended`);
    log('   provider                sched   occ   occupancy   result');

    for (const p of result.providers) {
      // Neither rostered nor booked: not a 0% week, just not a working week.
      if (p.occupancyPct === null) { summary.skippedIdle += 1; continue; }

      const u = map.get(p.providerId);
      if (!u) { unmatched.add(`${p.providerName} (staffID ${p.providerId})`); continue; }

      // The roster cannot account for the bookings that are in the diary, so the
      // denominator is missing shifts and the percentage would read high — Ben
      // Bryden's week of 10 Aug came out at 156% this way. Leave the cell alone
      // rather than put a number on the board that the roster contradicts.
      if (p.rosterIncomplete) {
        summary.skippedRoster += 1;
        log(`${p.providerName.padEnd(22)} roster incomplete in Nookal — it shows ` +
            `${p.gridBookedMinutes} booked minutes against ${p.appointmentOnlyMinutes} ` +
            `minutes of real appointments. Not written.`);
        continue;
      }

      const label =
        `${p.providerName.padEnd(22)}${String(p.scheduledMinutes).padStart(6)}` +
        `${String(p.occupiedMinutes).padStart(6)}${(p.occupancyPct.toFixed(2) + '%').padStart(11)}`;

      if (dryRun) { log(`${label}   (dry run) -> ${u.fullName}`); continue; }

      // Insert before update so the appointment sync's own columns (total_appts,
      // new_cases, cancelled_count) are never disturbed by this one.
      await query(
        `INSERT INTO practitioner_week_inputs (clinician_id, year, month, week_num, entered_by)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (clinician_id, year, month, week_num) DO NOTHING`,
        [u.userId, year, month, w.num, actingUserId]
      );

      const { rowCount } = await query(
        `UPDATE practitioner_week_inputs
            SET occupancy_pct                 = $5,
                occupancy_booked_minutes      = $6,
                occupancy_scheduled_minutes   = $7,
                occupancy_blocked_minutes     = $8,
                occupancy_available_minutes   = NULL,
                occupancy_source              = 'nookal_api',
                occupancy_measured_days_after = $9,
                occupancy_synced_at           = NOW(),
                updated_at                    = NOW(),
                updated_by                    = $10
          WHERE clinician_id = $1 AND year = $2 AND month = $3 AND week_num = $4
            -- Precedence (migration 031): a person's own figure and the report
            -- export both outrank this. A NULL source with a value present
            -- predates migration 029 and was hand-entered, so it counts as a
            -- person's too. 'nookal' is the abandoned diary estimate, which this
            -- is free to replace.
            AND (occupancy_pct IS NULL
                 OR occupancy_source IN ('nookal', 'nookal_api'))`,
        [u.userId, year, month, w.num,
         p.occupancyPct, p.occupiedMinutes, p.scheduledMinutes, p.breakMinutes,
         daysAfter, actingUserId]
      );

      if (rowCount && rowCount > 0) { summary.written   += 1; log(`${label}   -> ${u.fullName}`); }
      else                          { summary.keptOwned += 1; log(`${label}   kept the existing owned figure for ${u.fullName}`); }
    }
  }

  summary.unmatched = [...unmatched];
  return summary;
}
