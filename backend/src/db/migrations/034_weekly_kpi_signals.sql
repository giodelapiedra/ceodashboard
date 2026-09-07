-- 034_weekly_kpi_signals.sql
-- Weekly Check-In — the 30 Effectiveness signals, the Mojo drain, and the nine
-- weekly counts. From "PhysioWard Weekly Check-In — Developer Reference" and
-- "Effectiveness & Mojo" (Sam, 2026-09-01) plus physioward_weekly_model.json.
--
-- WHAT THIS IS NOT: a second weekly form. The reference document describes one
-- weekly submission per clinician with its own payload, its own name/clinic
-- fields and its own duplicate rule. Almost all of that already exists here as
-- weekly_kpi_reports (migration 032, live since 2026-08-26), so this migration
-- EXTENDS that row rather than standing a parallel table beside it. Concretely:
--
--   * focus_kpis[]  -> the existing kpi1..kpi3 name/target/result columns.
--     Only the document's `hit` flag is new, added below as kpi1..3_hit.
--   * mojo.score    -> the existing mojo_rating. Only `drain` and `action`
--     are new.
--   * reflection.flag -> the existing flag_for_sam.
--   * "one weekly submission" -> the existing Monday half + Friday half on one
--     row. The document's section 5 says a duplicate submission should keep
--     BOTH rows and mark the later one current; that is refused here on
--     purpose. wkr_unique_person_week (migration 032) is the match key the
--     Friday submit updates through, and it comes from Sam's original spec
--     ("one row per person per week ... rather than duplicating it"). Two rows
--     for one person-week would leave the Friday half with no single row to
--     land on. Re-submitting corrects the week in place, and the audit log is
--     the record of the change.
--
-- ISOLATION: one new table, plus additive columns and constraints on
-- weekly_kpi_reports. Every new column is nullable (or defaulted), so the rows
-- already on prod stay valid and every existing query keeps returning exactly
-- what it returned before. Nothing outside this feature is touched.

-- ── Raw signal ratings ──────────────────────────────────────────────────────
-- One row per (report, signal). RAW ratings only, never the mapped points —
-- section 2 of the reference document is explicit about why: "If the weights or
-- the point mapping are ever retuned, raw ratings allow every historical
-- submission to be recalculated on the new model. Storing points locks history
-- to the old model permanently." The computed columns further down are a
-- snapshot of what the model said at submission time; these rows are the facts
-- behind it.
--
-- Not a jsonb blob on weekly_kpi_reports: "how did the team rate S17 this
-- month" is a question Sam will ask, and that is a GROUP BY over a table, not a
-- scan over thirty json keys.

CREATE TABLE IF NOT EXISTS weekly_kpi_signal_ratings (
  report_id  BIGINT   NOT NULL REFERENCES weekly_kpi_reports(id) ON DELETE CASCADE,

  -- 'S01'..'S30' from weekly-kpi.model.ts. Deliberately NOT a foreign key to a
  -- signals table: the registry is code, versioned with the app and stamped on
  -- each report as model_version, so a database copy of it would be a second
  -- source of truth that can drift from the one the form actually renders.
  signal_id  TEXT     NOT NULL,

  -- NULL = "N/A — did not arise this week", which the document writes as the
  -- string "NA". Stored as NULL-on-a-row-that-exists so the numeric case keeps
  -- a plain CHECK: the row's existence is the answer, its value is the rating.
  -- A signal with NO row was never answered, which section 5 says to treat as
  -- N/A as well — so both spellings of "not rated" score identically.
  rating     SMALLINT,

  PRIMARY KEY (report_id, signal_id),

  -- Section 5: "A rating outside 0-3 and not NA -> reject the submission with a
  -- validation error. Do not coerce." The API rejects it first; this is the
  -- backstop that stops a script writing one straight in.
  CONSTRAINT wksr_rating_range CHECK (rating IS NULL OR rating BETWEEN 0 AND 3)
);

-- The report reader: all thirty ratings for one week, in signal order.
CREATE INDEX IF NOT EXISTS wksr_report
  ON weekly_kpi_signal_ratings (report_id, signal_id);

-- "How is the team doing on this one behaviour over time" — the reason these
-- are rows and not a blob.
CREATE INDEX IF NOT EXISTS wksr_signal_lookup
  ON weekly_kpi_signal_ratings (signal_id, rating);


-- ── Computed score, persisted (section 7) ───────────────────────────────────
-- A snapshot of what model_version said about these ratings. Recomputable from
-- the ratings above at any time, and stored anyway so the tracker can sort and
-- filter a week without scoring thirty rows per physio in the application.
--
-- All nullable: rows submitted before this migration have no signals and
-- therefore no score. A NULL effectiveness_score is how the UI knows to show
-- the older self-rated number instead — not a gap to be backfilled with a
-- guess.

ALTER TABLE weekly_kpi_reports
  ADD COLUMN IF NOT EXISTS effectiveness_score NUMERIC(3,1),
  ADD COLUMN IF NOT EXISTS group_pct_g1        NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS group_pct_g2        NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS group_pct_g3        NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS group_pct_g4        NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS group_pct_g5        NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS standards_missed    SMALLINT,
  -- Not in the reference document. A Standard is expected EVERY week, so
  -- marking one "did not arise" is a different fact from a clean week — but
  -- standards_missed counts only 0 and 1, so without this the two are
  -- indistinguishable on the tracker. Counted, not blocked: S17 ("called every
  -- initial-consult patient") is legitimately N/A in a week with no initials.
  ADD COLUMN IF NOT EXISTS standards_na        SMALLINT,
  ADD COLUMN IF NOT EXISTS na_count            SMALLINT,
  ADD COLUMN IF NOT EXISTS band_id             TEXT,
  -- The weight set this row was scored with. Section 5: "Weights changed after
  -- go-live -> increment model_version and store it on every row. Never
  -- recalculate historical rows silently."
  ADD COLUMN IF NOT EXISTS model_version       TEXT,
  -- True only when every signal was N/A. Section 5 again: return null, not 0 —
  -- "a zero is a real, meaningful score and must not be produced by absence of
  -- data". The API refuses such a submission outright, so this should stay
  -- false for every row; the column exists so a row that somehow gets there is
  -- readable rather than looking like a genuine 0.0.
  ADD COLUMN IF NOT EXISTS is_incomplete       BOOLEAN NOT NULL DEFAULT false,

  -- ── Mojo (the "three questions" sheet) ────────────────────────────────────
  -- mojo_rating itself already exists (migration 032). These are question 2 and
  -- question 3. Nullable: rows from before this migration have neither.
  ADD COLUMN IF NOT EXISTS mojo_drain          TEXT,
  ADD COLUMN IF NOT EXISTS mojo_action         TEXT,

  -- ── focus_kpis[].hit ──────────────────────────────────────────────────────
  -- The one part of the document's focus_kpis block the existing columns do not
  -- already carry. Three-valued on purpose: NULL is "not answered", which is a
  -- different thing from "did not hit".
  ADD COLUMN IF NOT EXISTS kpi1_hit            BOOLEAN,
  ADD COLUMN IF NOT EXISTS kpi2_hit            BOOLEAN,
  ADD COLUMN IF NOT EXISTS kpi3_hit            BOOLEAN,

  -- ── reflection{} (Friday half) ────────────────────────────────────────────
  -- `flag` is the existing flag_for_sam; these are the other three.
  ADD COLUMN IF NOT EXISTS best_behaviour      TEXT,
  ADD COLUMN IF NOT EXISTS slipped             TEXT,
  ADD COLUMN IF NOT EXISTS commitment          TEXT,

  -- ── counts{} (section 6) ──────────────────────────────────────────────────
  -- Nine self-reported weekly counts. They do not affect the score.
  --
  -- READ THIS BEFORE BUILDING ANYTHING ON THEM: five of the nine are ALREADY
  -- recorded elsewhere in this database, by someone else, about the same week:
  --
  --   initials_seen, recommendations_full, plans_accepted_full/_part
  --       -> case_acceptances (migration 007), entered per patient by the
  --          front desk: case_recommendations, treatment_plan_provided,
  --          transition_completed, prepay_accepted, appointments_booked.
  --   cancellations_noshows
  --       -> practitioner_week_inputs.cancelled_count (migration 026), synced
  --          from Nookal.
  --
  -- They are stored anyway because they are a different measurement, not a
  -- duplicate of the same one: this is the physio's own count of their own
  -- week, and the gap between it and the front desk's count is itself the
  -- signal Sam wants. What must NOT happen is either number being treated as
  -- the authoritative figure for a KPI that already has a source — for revenue,
  -- case acceptance and cancellation reporting, the existing tables stay
  -- authoritative and these columns are the cross-check.
  --
  -- Genuinely new, with no other source anywhere: dropouts_contacted,
  -- consults_recorded, calls_due, calls_made.
  ADD COLUMN IF NOT EXISTS initials_seen         INTEGER,
  ADD COLUMN IF NOT EXISTS recommendations_full  INTEGER,
  ADD COLUMN IF NOT EXISTS plans_accepted_full   INTEGER,
  ADD COLUMN IF NOT EXISTS plans_accepted_part   INTEGER,
  ADD COLUMN IF NOT EXISTS dropouts_contacted    INTEGER,
  ADD COLUMN IF NOT EXISTS consults_recorded     INTEGER,
  ADD COLUMN IF NOT EXISTS calls_due             INTEGER,
  ADD COLUMN IF NOT EXISTS calls_made            INTEGER,
  ADD COLUMN IF NOT EXISTS cancellations_noshows INTEGER;


-- ── Constraints ─────────────────────────────────────────────────────────────
-- Guarded individually so a partial application can be re-run by hand; the
-- migration runner itself only ever applies this file once.

DO $$
BEGIN
  -- effectiveness_rating was CHECKed 1-10 because a physio picked it by hand
  -- off a 1-10 scale. It is now derived from effectiveness_score, and 0.0 is a
  -- real score under the new model (all thirty signals rated 0), so the floor
  -- has to come down to 0. Widening a CHECK cannot invalidate an existing row.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'weekly_kpi_reports'::regclass
       AND conname  = 'wkr_effectiveness_range'
  ) THEN
    ALTER TABLE weekly_kpi_reports DROP CONSTRAINT wkr_effectiveness_range;
  END IF;

  ALTER TABLE weekly_kpi_reports
    ADD CONSTRAINT wkr_effectiveness_range
    CHECK (effectiveness_rating BETWEEN 0 AND 10);
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'weekly_kpi_reports'::regclass AND conname = 'wkr_band_valid'
  ) THEN
    ALTER TABLE weekly_kpi_reports ADD CONSTRAINT wkr_band_valid
      CHECK (band_id IS NULL OR band_id IN ('ceiling','model','strong','gap','intervene'));
  END IF;

  -- 'none', not 'no_drain'. The reference document spells this both ways — the
  -- JSON model says "no_drain", the section 6 payload says "none" — and the
  -- wire format wins so the form and this constraint cannot disagree.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'weekly_kpi_reports'::regclass AND conname = 'wkr_drain_valid'
  ) THEN
    ALTER TABLE weekly_kpi_reports ADD CONSTRAINT wkr_drain_valid
      CHECK (mojo_drain IS NULL
             OR mojo_drain IN ('physical','emotional','mental','relational','none'));
  END IF;

  -- A score and its band travel together. One without the other means a
  -- half-written row, and the tracker would show a number in no band or a band
  -- with no number.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'weekly_kpi_reports'::regclass AND conname = 'wkr_score_band_together'
  ) THEN
    ALTER TABLE weekly_kpi_reports ADD CONSTRAINT wkr_score_band_together
      CHECK ((effectiveness_score IS NULL AND band_id IS NULL)
          OR (effectiveness_score IS NOT NULL AND band_id IS NOT NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'weekly_kpi_reports'::regclass AND conname = 'wkr_score_range'
  ) THEN
    ALTER TABLE weekly_kpi_reports ADD CONSTRAINT wkr_score_range
      CHECK (effectiveness_score IS NULL OR (effectiveness_score >= 0 AND effectiveness_score <= 10));
  END IF;

  -- 30 signals, 7 of them Standards. These are the ceilings from section 7.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'weekly_kpi_reports'::regclass AND conname = 'wkr_counts_in_range'
  ) THEN
    ALTER TABLE weekly_kpi_reports ADD CONSTRAINT wkr_counts_in_range
      CHECK ((na_count         IS NULL OR na_count         BETWEEN 0 AND 30)
         AND (standards_missed IS NULL OR standards_missed BETWEEN 0 AND 7)
         AND (standards_na     IS NULL OR standards_na     BETWEEN 0 AND 7));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'weekly_kpi_reports'::regclass AND conname = 'wkr_group_pct_range'
  ) THEN
    ALTER TABLE weekly_kpi_reports ADD CONSTRAINT wkr_group_pct_range
      CHECK ((group_pct_g1 IS NULL OR group_pct_g1 BETWEEN 0 AND 1)
         AND (group_pct_g2 IS NULL OR group_pct_g2 BETWEEN 0 AND 1)
         AND (group_pct_g3 IS NULL OR group_pct_g3 BETWEEN 0 AND 1)
         AND (group_pct_g4 IS NULL OR group_pct_g4 BETWEEN 0 AND 1)
         AND (group_pct_g5 IS NULL OR group_pct_g5 BETWEEN 0 AND 1));
  END IF;

  -- A count is a tally. Negative is a client bug, and section 5 only asks for a
  -- WARNING on counts that contradict each other (calls_made > calls_due and
  -- so on) — that stays in the service, where it can be surfaced to Sam without
  -- refusing the physio's week.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'weekly_kpi_reports'::regclass AND conname = 'wkr_weekly_counts_nonneg'
  ) THEN
    ALTER TABLE weekly_kpi_reports ADD CONSTRAINT wkr_weekly_counts_nonneg
      CHECK ((initials_seen         IS NULL OR initials_seen         >= 0)
         AND (recommendations_full  IS NULL OR recommendations_full  >= 0)
         AND (plans_accepted_full   IS NULL OR plans_accepted_full   >= 0)
         AND (plans_accepted_part   IS NULL OR plans_accepted_part   >= 0)
         AND (dropouts_contacted    IS NULL OR dropouts_contacted    >= 0)
         AND (consults_recorded     IS NULL OR consults_recorded     >= 0)
         AND (calls_due             IS NULL OR calls_due             >= 0)
         AND (calls_made            IS NULL OR calls_made            >= 0)
         AND (cancellations_noshows IS NULL OR cancellations_noshows >= 0));
  END IF;
END $$;


-- ── Indexes for the triggers in section 8 ───────────────────────────────────
-- Both partial: the flagged rows are the small minority every week, which is
-- exactly what makes a partial index worth having rather than a full one.

-- "standards_missed > 0 -> list the failing signals ... in Sam's notification."
CREATE INDEX IF NOT EXISTS wkr_standards_missed
  ON weekly_kpi_reports (week_start DESC)
  WHERE standards_missed > 0;

-- "na_count >= 6 -> flag to Sam for review. A high N/A count shrinks the
-- denominator and can inflate a score."
CREATE INDEX IF NOT EXISTS wkr_high_na
  ON weekly_kpi_reports (week_start DESC)
  WHERE na_count >= 6;


COMMENT ON TABLE weekly_kpi_signal_ratings IS
  'Raw 0-3 / NULL(=N/A) ratings for the 30 Weekly Check-In behaviour signals. Raw only, never mapped points, so history can be rescored if the model is retuned. Registry lives in code (weekly-kpi.model.ts), stamped per report as weekly_kpi_reports.model_version.';

COMMENT ON COLUMN weekly_kpi_reports.effectiveness_score IS
  'Computed 0.0-10.0 from weekly_kpi_signal_ratings under model_version. NULL for rows submitted before migration 034, which carry only the physio''s hand-picked effectiveness_rating.';

COMMENT ON COLUMN weekly_kpi_reports.effectiveness_rating IS
  'Whole-number 1-10 display score. Hand-picked by the physio before migration 034; from 034 on it is ROUND(effectiveness_score) so the tracker, the averages and the Excel export keep reading one column across both eras.';
