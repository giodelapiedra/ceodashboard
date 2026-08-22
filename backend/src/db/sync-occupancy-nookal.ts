import 'dotenv/config';
import {
  syncOccupancy,
  MAX_AGE_DAYS,
} from '../features/practitioner-stats/practitioner-stats.occupancy-api';
import { pool, query } from './pool';

/**
 * Fill Occupancy on Practitioner Stats from the Nookal v2 API.
 *
 *   npm run db:sync:occupancy -- --year 2026 --month 8
 *   npm run db:sync:occupancy -- --year 2026 --month 8 --week 2 --dry-run
 *
 * This is the automatic path migrations 029 and 030 concluded did not exist. It
 * does: v2 getSchedules carries the roster — the report's "Scheduled Minutes" —
 * and v2 getEvents carries the event types v3 reports as null. Migration 031 has
 * the evidence.
 *
 * MEANT TO RUN WEEKLY, on a cron, the day after a week ends. Nookal's roster
 * answers as it stands today, so a week measured late comes back missing shifts
 * and the bookings inside them. Weeks older than --max-age-days are skipped
 * rather than written low; those belong to db:import:occupancy (the report's own
 * Export) or to a person typing the figure in, both of which outrank this.
 *
 * The Sync button on Practitioner Stats now calls the same code for any week
 * still fresh enough, so this script is for the cron and for backfilling a month
 * by hand.
 */

function args() {
  const a = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = a.indexOf(`--${name}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const year  = Number(get('year'));
  const month = Number(get('month'));
  const week  = get('week') !== undefined ? Number(get('week')) : undefined;

  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    console.error(
      'usage: sync-occupancy-nookal.ts --year 2026 --month 8 [--week 1-5] [--dry-run]\n' +
      '                                [--max-age-days N] [--force-stale]\n\n' +
      '  Fills Occupancy from Nookal v2 for every week of the month that has\n' +
      `  ENDED and is less than ${MAX_AGE_DAYS} days old. Older weeks are skipped —\n` +
      '  the Nookal roster has moved on by then and the figures would read low.\n' +
      '  --force-stale measures them anyway, which is for diagnosis, not the board.'
    );
    process.exit(1);
  }
  if (month < 1 || month > 12) { console.error('month must be 1-12'); process.exit(1); }
  if (week !== undefined && (week < 1 || week > 5)) { console.error('week must be 1-5 (5 = Remainder)'); process.exit(1); }

  const maxAge = Number(get('max-age-days'));
  return {
    year, month, week,
    dryRun:     a.includes('--dry-run'),
    maxAgeDays: Number.isFinite(maxAge) ? maxAge : undefined,
    forceStale: a.includes('--force-stale'),
  };
}

async function firstAdminId(): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM users WHERE role = 'ADMIN' ORDER BY id LIMIT 1`
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('no ADMIN user to attribute the sync to');
  return id;
}

async function main(): Promise<void> {
  const { year, month, week, dryRun, maxAgeDays, forceStale } = args();
  const today = new Date().toISOString().slice(0, 10);

  console.log(`\nOccupancy from Nookal v2 -> ${year}-${String(month).padStart(2, '0')}`);
  console.log(`Today ${today}. Refusing weeks measured more than ${maxAgeDays ?? MAX_AGE_DAYS} day(s) ` +
              `after they ended${forceStale ? ' — OVERRIDDEN by --force-stale' : ''}.`);

  const actingUserId = await firstAdminId();
  const s = await syncOccupancy(year, month, actingUserId, {
    week, dryRun, maxAgeDays, forceStale, today, log: (l) => console.log(l),
  });

  console.log(`\ncounting event types [${s.eventIds.join(', ')}] as occupied`);
  console.log(`written: ${s.written}`);
  console.log(`kept an existing hand-entered or report figure: ${s.keptOwned}`);
  console.log(`skipped, neither rostered nor booked: ${s.skippedIdle}`);
  console.log(`skipped, roster in Nookal does not cover the diary: ${s.skippedRoster}`);
  console.log(`weeks skipped: ${s.skippedWeeks}`);
  if (s.unmatched.length) {
    console.log(`\nNO PhysioWard ACCOUNT for ${s.unmatched.length} provider(s) — not imported:`);
    for (const n of s.unmatched) console.log(`   ${n}`);
    console.log('These need a user with a matching nookal_staff_id, or they stay blank on the board.');
  }
  if (dryRun) console.log('\nDRY RUN — nothing was written.');
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error(`\nsync failed: ${e.message}`); process.exit(1); });
