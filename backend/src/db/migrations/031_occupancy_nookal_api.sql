-- 031_occupancy_nookal_api.sql
-- Occupancy straight from the Nookal API, matching the Occupancy report's own
-- formula. This reverses the conclusion recorded in migrations 029 and 030.
--
-- Those two said the report could not be reproduced from the API, for two
-- reasons. Both were wrong, and both for the same underlying reason: they were
-- checked against Nookal v3 (GraphQL) only, while the answers live in v2 (REST).
--
--   1. "The roster is not in the API." It is. v2 getSchedules returns a 15-minute
--      grid per practitioner, per location, per day:
--
--        -1 = not rostered      0 = rostered and free
--         1 = rostered, booked  3 = rostered, break/blockout
--
--      so  Scheduled Minutes = 15 x (slots != -1) - 15 x (slots == 3)
--      which is exactly the report's own header, "Scheduled Time - Scheduled
--      Breaks". Verified on the 03/08/2026-09/08/2026 report: Gabriella
--      Whittaker 1380 and Finn Van Lathum 480, both to the minute.
--
--   2. "Event types cannot be told apart, so the report's Events: 4 of 11 filter
--      cannot be reproduced." v3 does report every DiaryEvent with typeID null
--      and typeName null, which is what migration 030 recorded. But v2 getEvents
--      carries EventID, CategoryName and EventTitle on every one of the same 154
--      events in that week: 1 General, 15 Business, 18 1-on-1, 21 CPD, 24 Event,
--      29 Team Meeting, 35 Team Training.
--
-- And the NOOKAL_API_KEY that migration 029 called dead is alive — getSchedules,
-- getEvents, getAppointments, getClasses, getPractitioners and getLocations all
-- answer on it. env.ts was right all along: v2 is still in use.
--
-- ── The limit that DOES hold ────────────────────────────────────────────────
-- getSchedules answers from the roster as it stands NOW, not as it stood in a
-- past week. Measured 2026-08-20 by comparing the grid's booked slots against
-- the appointments actually in the diary:
--
--   days 17-19 Aug (this week)    grid agrees within 15-90 min per practitioner
--   days 03-09 Aug (two weeks on) grid is short by up to 840 min (Ben Bryden)
--
-- Bookings that fall outside today's roster come back as -1, so an old week
-- silently loses both rostered time and the bookings inside it. A week must
-- therefore be measured while it is still fresh. That is what
-- occupancy_source = 'nookal_api' means: measured from the live roster, close to
-- the week itself. Older weeks stay on the report import or a person's own
-- figure, which is why 'nookal_report' still outranks this.

-- Precedence, highest first. Nothing below ever overwrites something above it:
--   manual         a person typed it and owns it
--   nookal_report  the exact figure off Nookal's Occupancy report (an export)
--   nookal_api     computed from v2 getSchedules + getAppointments + getEvents
--   nookal         the old diary-derived estimate (migration 029); no longer written
ALTER TABLE practitioner_week_inputs DROP CONSTRAINT IF EXISTS pwi_occupancy_source_valid;
ALTER TABLE practitioner_week_inputs
  ADD CONSTRAINT pwi_occupancy_source_valid
  CHECK (occupancy_source IS NULL
         OR occupancy_source IN ('nookal', 'manual', 'nookal_report', 'nookal_api'));

-- Which day's roster the figure was measured against, so a stale measurement can
-- be told from a fresh one without guessing from occupancy_synced_at (which also
-- moves when an old week is re-imported from a report export).
ALTER TABLE practitioner_week_inputs
  ADD COLUMN IF NOT EXISTS occupancy_measured_days_after INTEGER;

COMMENT ON COLUMN practitioner_week_inputs.occupancy_measured_days_after IS
  'Days between the end of the week and the moment occupancy was measured from the live Nookal roster. Only set for occupancy_source = ''nookal_api''. 0-7 is fresh; a large number means the roster had moved on and the figure understates both rostered and booked time.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pwi_occupancy_measured_nonneg'
       AND conrelid = 'practitioner_week_inputs'::regclass
  ) THEN
    ALTER TABLE practitioner_week_inputs
      ADD CONSTRAINT pwi_occupancy_measured_nonneg
      CHECK (occupancy_measured_days_after IS NULL OR occupancy_measured_days_after >= 0);
  END IF;
END $$;

-- occupancy_blocked_minutes already means "diary minutes excluded from the
-- denominator"; for 'nookal_api' rows it holds the roster's own breaks (grid
-- value 3), which is the same idea and the same exclusion.
COMMENT ON COLUMN practitioner_week_inputs.occupancy_blocked_minutes IS
  'Minutes excluded from the occupancy denominator. For ''nookal_api'' rows: the roster''s scheduled breaks (getSchedules grid value 3), already subtracted from occupancy_scheduled_minutes. For the old ''nookal'' rows: DiaryEvent blockouts.';
