-- 035_weekly_kpi_friday_effectiveness.sql
-- Two changes to the Weekly Check-In, both from Sam, 2026-09-04:
--
-- 1. "What kind of drain was it?" becomes multiple-choice. mojo_drain moves
--    from a single TEXT value to TEXT[]. Existing single values are wrapped in
--    a one-element array so historical rows keep reading the same way.
--
-- 2. Effectiveness (the 30 signals) and Mojo move from the Monday half to the
--    Friday half, so both are scored at the end of the week rather than at the
--    start of it. That means a Monday-only row (Friday not yet submitted) no
--    longer carries a rating for either — effectiveness_rating and mojo_rating
--    both have to become nullable. Only new rows are affected: a row submitted
--    before this migration already has both set from the old Monday flow, and
--    nothing here touches existing data, so it keeps reading exactly as it did.
--    No "must be set together with friday_submitted_at" constraint is added for
--    the same reason — that would be true for every row from now on, but false
--    for every row that already exists.

-- ── mojo_drain: TEXT -> TEXT[] ──────────────────────────────────────────────

-- The OLD constraint ('mojo_drain IN (...)') has to go BEFORE the column type
-- changes, not after: ALTER COLUMN TYPE re-validates every constraint still on
-- the table against the NEW type, and 'text[] IN (text, text, ...)' fails with
-- "operator does not exist: text[] = text" before it ever gets the chance to be
-- replaced. Confirmed locally 2026-09-04 — dropping first, then converting the
-- column, then adding the new array-shaped constraint, is the order that works.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'weekly_kpi_reports'::regclass AND conname = 'wkr_drain_valid'
  ) THEN
    ALTER TABLE weekly_kpi_reports DROP CONSTRAINT wkr_drain_valid;
  END IF;
END $$;

ALTER TABLE weekly_kpi_reports
  ALTER COLUMN mojo_drain TYPE TEXT[]
  USING (CASE WHEN mojo_drain IS NULL THEN NULL ELSE ARRAY[mojo_drain] END);

DO $$
BEGIN
  -- Every element must be a known drain type, at least one must be picked, and
  -- 'none' ("No drain") is exclusive — it cannot be combined with a real drain.
  ALTER TABLE weekly_kpi_reports ADD CONSTRAINT wkr_drain_valid
    CHECK (mojo_drain IS NULL OR (
      mojo_drain <@ ARRAY['physical','emotional','mental','relational','none']::text[]
      AND cardinality(mojo_drain) > 0
      AND (cardinality(mojo_drain) = 1 OR NOT ('none' = ANY(mojo_drain)))
    ));
END $$;

-- ── effectiveness_rating / mojo_rating: now set on Friday, not Monday ───────

ALTER TABLE weekly_kpi_reports
  ALTER COLUMN effectiveness_rating DROP NOT NULL,
  ALTER COLUMN mojo_rating          DROP NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'weekly_kpi_reports'::regclass AND conname = 'wkr_effectiveness_range'
  ) THEN
    ALTER TABLE weekly_kpi_reports DROP CONSTRAINT wkr_effectiveness_range;
  END IF;
  ALTER TABLE weekly_kpi_reports ADD CONSTRAINT wkr_effectiveness_range
    CHECK (effectiveness_rating IS NULL OR effectiveness_rating BETWEEN 0 AND 10);

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'weekly_kpi_reports'::regclass AND conname = 'wkr_mojo_range'
  ) THEN
    ALTER TABLE weekly_kpi_reports DROP CONSTRAINT wkr_mojo_range;
  END IF;
  ALTER TABLE weekly_kpi_reports ADD CONSTRAINT wkr_mojo_range
    CHECK (mojo_rating IS NULL OR mojo_rating BETWEEN 1 AND 10);
END $$;

COMMENT ON COLUMN weekly_kpi_reports.mojo_drain IS
  'Mojo question 2, multi-select since migration 035. Array of physical/emotional/mental/relational/none; ''none'' is exclusive. A single-valued row from before this migration was wrapped in a one-element array.';

COMMENT ON COLUMN weekly_kpi_reports.effectiveness_rating IS
  'ROUND(effectiveness_score). NULL until the Friday half is submitted (migration 035 moved Effectiveness + Mojo to Friday) — except on rows submitted before this migration, which were rated on Monday and already have a value.';

COMMENT ON COLUMN weekly_kpi_reports.mojo_rating IS
  'Mojo (energy) 1-10. NULL until the Friday half is submitted (migration 035 moved this off Monday) — except on rows submitted before this migration, which already have a value from the old Monday flow.';
