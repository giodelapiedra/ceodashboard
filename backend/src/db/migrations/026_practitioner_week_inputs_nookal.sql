-- 026_practitioner_week_inputs_nookal.sql
-- Let practitioner_week_inputs hold Nookal-synced figures alongside the
-- hand-entered ones, so one table serves the whole Practitioner Stats row.
--
-- Validated live against the Nookal v3 appointment feed for Week 1 July 2026
-- (6-12 Jul), grouped by providerID and compared to the spreadsheet:
--   Total Appts (status = 'Completed')  9 of 10 practitioners match exactly
--   NC          (isNewCase)           10 of 10 match exactly
-- so those two columns no longer need a human at all.
--
-- Cancelled is stored as its own count rather than a percentage because it does
-- NOT yet reconcile: Angus matches the sheet exactly (3/40 = 7.50%), but the
-- others run high because v3's 'Cancelled' status includes appointments that
-- were rescheduled, while the sheet's figure excludes them. Keeping the raw
-- count lets the rate be recomputed once the exclusion rule is settled, without
-- another sync.

ALTER TABLE practitioner_week_inputs
  ADD COLUMN IF NOT EXISTS cancelled_count INTEGER;

-- Which figures in this row came from Nookal vs a person. A sync overwrites the
-- Nookal-derived columns and leaves occupancy_pct alone, so a hand-read
-- occupancy is never destroyed by pressing Sync.
ALTER TABLE practitioner_week_inputs
  ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ;

-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, and re-running a migration must
-- be harmless, so guard on pg_constraint. Same pattern as migration 009.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pwi_cancelled_nonneg'
       AND conrelid = 'practitioner_week_inputs'::regclass
  ) THEN
    ALTER TABLE practitioner_week_inputs
      ADD CONSTRAINT pwi_cancelled_nonneg
      CHECK (cancelled_count IS NULL OR cancelled_count >= 0);
  END IF;
END $$;

COMMENT ON COLUMN practitioner_week_inputs.cancelled_count IS
  'Nookal v3 appointments with status = Cancelled for this practitioner-week. Includes rescheduled ones, unlike the spreadsheet figure — see migration 026.';
COMMENT ON COLUMN practitioner_week_inputs.synced_at IS
  'When total_appts / new_cases / cancelled_count were last pulled from Nookal. NULL = hand-entered only.';
