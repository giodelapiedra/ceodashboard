-- 030_occupancy_nookal_report.sql
-- Let the EXACT figure from Nookal's own Occupancy report be stored, and rank it
-- above the value migration 029 computes.
--
-- Migration 029 derives occupancy as booked / (booked + still-bookable), because
-- v3 GraphQL exposes no roster. Sam's screenshot of Nookal -> Reports ->
-- Occupancy (03/08/2026-09/08/2026, All Locations) settled what Nookal actually
-- divides by:
--
--     Occupancy = Occupied minutes / Scheduled minutes
--
-- Verified against every row on that report: Gabriella 1410/1380 = 102.17%,
-- Jervis 1890/2100 = 90%, Caitlin 1470/1890 = 77.78%, Noah 1470/2010 = 73.13%,
-- Ben 1500/2070 = 72.46%, Angus 1470/2160 = 68.06%, Emma 1230/2010 = 61.19%,
-- Isabella 1350/2370 = 56.96%, Kyle 990/2100 = 47.14%, Zac 870/1890 = 46.03%.
--
-- "Scheduled minutes" is ROSTER time. That is why the report can read above
-- 100% (Gabriella worked 30 minutes past her roster) while migration 029's
-- figure structurally cannot. Two facts closed off deriving it:
--
--   1. The whole v3 schema was walked on 2026-08-20 — 60 types, and not one
--      exposes a shift, roster, scheduled-minute or working-hour field.
--      `availabilities` is the only availability surface and it returns free
--      slots, not rostered time.
--   2. Reconstructing it as booked + free + blocked does not work either: it
--      lands 60-480 minutes off per practitioner against the report, because
--      blockouts spill outside roster hours and Nookal's own "Events: 4 of 11
--      Events Selected" filter counts some event types as occupied. v3 gives no
--      way to tell event types apart — all 154 DiaryEvents in that week return
--      typeID null, typeName null, notes empty.
--
-- So the exact figure arrives one of two ways: this import (Export button on the
-- report), or v2 REST getSchedules once a live NOOKAL_API_KEY exists.

ALTER TABLE practitioner_week_inputs
  ADD COLUMN IF NOT EXISTS occupancy_scheduled_minutes INTEGER;

COMMENT ON COLUMN practitioner_week_inputs.occupancy_scheduled_minutes IS
  'Nookal "Scheduled Minutes" — rostered shift time. Only set by the Occupancy-report import; the API-derived path cannot see the roster. occupancy_booked_minutes holds the report''s "Occupied" on those rows.';

-- Precedence, highest first:
--   manual        a person typed it and owns it
--   nookal_report the exact figure off Nookal's Occupancy report
--   nookal        derived from the diary by the sync (migration 029)
-- The sync only ever overwrites its own work or a blank, so neither of the
-- first two is ever lost to a Sync press.
DO $$
BEGIN
  ALTER TABLE practitioner_week_inputs DROP CONSTRAINT IF EXISTS pwi_occupancy_source_valid;
  ALTER TABLE practitioner_week_inputs
    ADD CONSTRAINT pwi_occupancy_source_valid
    CHECK (occupancy_source IS NULL
           OR occupancy_source IN ('nookal', 'manual', 'nookal_report'));

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pwi_occupancy_scheduled_nonneg'
       AND conrelid = 'practitioner_week_inputs'::regclass
  ) THEN
    ALTER TABLE practitioner_week_inputs
      ADD CONSTRAINT pwi_occupancy_scheduled_nonneg
      CHECK (occupancy_scheduled_minutes IS NULL OR occupancy_scheduled_minutes >= 0);
  END IF;
END $$;
