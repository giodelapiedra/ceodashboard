-- 029_practitioner_week_occupancy_nookal.sql
-- Fill Occupancy from Nookal instead of by hand.
--
-- Migration 024 recorded that Occupancy had "no API path". That was true of the
-- appointment feed alone, but not of the API as a whole: Nookal v3 exposes
-- availabilities(dateFrom, dateTo, locationID, staffID, slotDuration), which
-- returns the free bookable slots left in a practitioner's diary. Probed live
-- 2026-08-20 and confirmed the slots tile each free gap exactly at
-- slotDuration granularity (15-min slots for Angus Clark, 2026-08-10: 14:30,
-- 14:45, 15:00, 15:15, 15:30, 15:45 = the 90 free minutes between his 14:00 and
-- 16:00 bookings), so free minutes = slot count x slotDuration.
--
-- Occupancy is therefore booked / (booked + still-free), both measured off the
-- same diary. The three minute figures are stored alongside the percentage
-- rather than only the percentage, for two reasons:
--
--   1. The Team row can then pool properly — SUM(booked) / SUM(booked+free) —
--      instead of averaging percentages, which migration 024 could not do
--      because the hours behind each percentage were not recorded.
--   2. The denominator rule can be changed (e.g. to count blocked-out diary
--      time against the practitioner) by recomputing from these columns,
--      without another month-long Nookal fetch.
--
-- KNOWN LIMIT — availabilities reflects the roster CURRENTLY in Nookal, not the
-- roster as it stood in a past week. Measured week by week on 2026-08-20: free
-- hours hold steady at 93-157h/week back to Feb 2026, then fall off a cliff
-- (Jan 2026: 49h, 5 practitioners; Feb 2025: 46h, 3). So a practitioner-week
-- with zero free minutes cannot be told apart from one whose roster is simply
-- gone, and the sync writes NOTHING for those rather than a fake 100%.
--
-- This does NOT reproduce Nookal's own Occupancy report exactly. That report
-- divides by rostered shift hours, which is why it can exceed 100% when
-- appointments are booked outside a shift (migration 024 cites a real 113%).
-- Dividing by booked + free can never exceed 100%. Matching it needs the shift
-- roster, which lives behind the v2 REST endpoint getSchedules — reachable, but
-- the NOOKAL_API_KEY in .env is dead (it returns the same L003/L004 refusal as
-- a garbage key, verified 2026-08-20). Left as the follow-up.

ALTER TABLE practitioner_week_inputs
  ADD COLUMN IF NOT EXISTS occupancy_booked_minutes    INTEGER,
  ADD COLUMN IF NOT EXISTS occupancy_available_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS occupancy_blocked_minutes   INTEGER,
  ADD COLUMN IF NOT EXISTS occupancy_synced_at         TIMESTAMPTZ;

-- Which hand or machine put the number in occupancy_pct. A sync only ever
-- overwrites its own work ('nookal') or a blank, so a figure someone read off
-- the Nookal report and typed in survives every future Sync.
--
-- NULL is deliberately allowed and means "written before this migration" —
-- those rows are all hand-entered, but backfilling them to 'manual' would also
-- relabel any row where somebody left occupancy blank, so the distinction is
-- left to the code, which treats a non-null occupancy_pct with a NULL source as
-- manual.
ALTER TABLE practitioner_week_inputs
  ADD COLUMN IF NOT EXISTS occupancy_source TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pwi_occupancy_source_valid'
       AND conrelid = 'practitioner_week_inputs'::regclass
  ) THEN
    ALTER TABLE practitioner_week_inputs
      ADD CONSTRAINT pwi_occupancy_source_valid
      CHECK (occupancy_source IS NULL OR occupancy_source IN ('nookal', 'manual'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pwi_occupancy_minutes_nonneg'
       AND conrelid = 'practitioner_week_inputs'::regclass
  ) THEN
    ALTER TABLE practitioner_week_inputs
      ADD CONSTRAINT pwi_occupancy_minutes_nonneg
      CHECK (
        (occupancy_booked_minutes    IS NULL OR occupancy_booked_minutes    >= 0) AND
        (occupancy_available_minutes IS NULL OR occupancy_available_minutes >= 0) AND
        (occupancy_blocked_minutes   IS NULL OR occupancy_blocked_minutes   >= 0)
      );
  END IF;
END $$;

COMMENT ON COLUMN practitioner_week_inputs.occupancy_booked_minutes IS
  'Diary minutes this practitioner-week held real consultations, counted as a union of appointment windows so a double-booking is not counted twice.';
COMMENT ON COLUMN practitioner_week_inputs.occupancy_available_minutes IS
  'Diary minutes still bookable, from Nookal v3 availabilities. 0 means the roster is unknown for that week, not that the week was full — see migration 029.';
COMMENT ON COLUMN practitioner_week_inputs.occupancy_blocked_minutes IS
  'Diary minutes taken by DiaryEvent blockouts (breaks, meetings, admin). Excluded from the occupancy denominator; kept so that rule can be revisited without a re-sync.';
COMMENT ON COLUMN practitioner_week_inputs.occupancy_source IS
  'nookal = computed by the sync, manual = typed in by a person, NULL = predates migration 029 (treat a non-null occupancy_pct as manual).';
COMMENT ON COLUMN practitioner_week_inputs.occupancy_synced_at IS
  'When occupancy was last computed from Nookal. Separate from synced_at, which covers total_appts / new_cases / cancelled_count.';
