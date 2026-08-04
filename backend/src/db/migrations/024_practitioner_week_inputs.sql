-- 024_practitioner_week_inputs.sql
-- The three Practitioner Stats figures that cannot be pulled from the Nookal
-- API: Total Appts, Occupancy and NC. Sam confirmed 2026-08-04 there is no API
-- path to them — they are read off two Nookal report screens by hand each week
-- (SOP steps 7-18) and were until now typed straight into the spreadsheet.
--
-- Storing them here lets the app show all nine SOP columns, and unlocks the
-- fourth blocked one: Cancellation % = cancellation events / total_appts, where
-- the events are already computed from patient_dropouts. That removes SOP steps
-- 30-39 — ten separate Nookal Cancellation reports plus a manual NFB
-- cross-check, the longest section of the procedure.
--
-- NOT scoped to a clinic on purpose. SOP step 8 and step 16 both set the Nookal
-- filter to "Location — All Location", so these figures are practice-wide per
-- practitioner. A clinic column would invite splitting a number that was never
-- collected per clinic.

CREATE TABLE IF NOT EXISTS practitioner_week_inputs (
  id            BIGSERIAL PRIMARY KEY,
  clinician_id  BIGINT    NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  -- Period keyed the same way week.calculator buckets it: Monday-anchored weeks
  -- 1-4 within a calendar month, plus 5 for the Remainder tail.
  year          INTEGER   NOT NULL,
  month         INTEGER   NOT NULL,
  week_num      SMALLINT  NOT NULL,

  -- All three nullable: a week may be partially entered, and a blank must stay
  -- distinguishable from a zero. That distinction is the whole reason this table
  -- exists rather than another spreadsheet column.
  total_appts   INTEGER,
  occupancy_pct NUMERIC(6,2),
  new_cases     INTEGER,

  entered_by    BIGINT    NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by    BIGINT             REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT pwi_month_range CHECK (month    BETWEEN 1 AND 12),
  -- 5 = the Remainder column the sheet carries after Week 4.
  CONSTRAINT pwi_week_range  CHECK (week_num BETWEEN 1 AND 5),
  CONSTRAINT pwi_year_range  CHECK (year     BETWEEN 2020 AND 2100),

  CONSTRAINT pwi_appts_nonneg CHECK (total_appts IS NULL OR total_appts >= 0),
  CONSTRAINT pwi_nc_nonneg    CHECK (new_cases   IS NULL OR new_cases   >= 0),
  -- Deliberately allows >100. Nookal has reported 113% occupancy for a
  -- practitioner whose roster hours were wrong, and refusing the entry would
  -- just push the bad figure back into the spreadsheet where nobody can see it.
  -- The UI flags anything over 100 as a roster error instead of silently
  -- accepting it as performance.
  CONSTRAINT pwi_occupancy_sane CHECK (occupancy_pct IS NULL OR (occupancy_pct >= 0 AND occupancy_pct <= 200))
);

-- One row per practitioner per week — an upsert target, so re-entering a week
-- corrects it instead of creating a duplicate the report would double-count.
CREATE UNIQUE INDEX IF NOT EXISTS pwi_unique_period
  ON practitioner_week_inputs (clinician_id, year, month, week_num);

-- The report reads a whole month at a time.
CREATE INDEX IF NOT EXISTS pwi_period_idx
  ON practitioner_week_inputs (year, month, week_num);
