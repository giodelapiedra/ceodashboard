-- 032_weekly_kpi_reports.sql
-- Team Performance KPI Reporting — the weekly KPI & wins cycle from
-- "Weekly KPI & Wins Process — Build spec" (Sam, 2026-08-22).
--
-- WHAT THIS REPLACES: the spec was written for Teams Adaptive Cards + Power
-- Automate + a SharePoint list. Sam's instruction was to build it in the CEO
-- dashboard instead and leave Teams alone for now ("sa teams wala na muna, sa
-- dashboard ko talaga gagawin muna yan"). So: the spec's FIELDS and its
-- one-row-per-person-per-week rule are followed exactly; its Teams/Power
-- Automate plumbing is not built. The shared "tracker tab" of section 8 becomes
-- an admin page in this app.
--
-- TWO FIELDS FROM THE SPEC ARE DELIBERATELY NOT COLUMNS YOU TYPE:
--   * Name   — the spec has it as a required short answer because a Teams card
--              cannot know who is filling it in. This app does: every physio
--              logs in with their own account, so the row is keyed on
--              clinician_id straight off the JWT. Sam's instruction:
--              "meron na sila kanya kanya account, hindi need lagay name nila".
--   * Clinic — same reasoning. Taken from the account's default clinic
--              (users.clinic_id) rather than picked per submission.
-- clinic_id is still STORED (not just joined from users) because physios rotate
-- between clinics and accounts get moved; a past week must keep reading as the
-- clinic it was actually reported for.
--
-- ISOLATION: this migration ONLY creates a new table + its indexes. It does not
-- touch users, dropouts, case_acceptance, ad_spend, ad_leads, or any other
-- existing object, so it cannot affect existing data.

CREATE TABLE IF NOT EXISTS weekly_kpi_reports (
  id             BIGSERIAL   PRIMARY KEY,

  -- The physio the report belongs to. NOT "entered_by": there is no encoder
  -- here, every row is self-reported, so owner and author are the same person.
  -- ON DELETE RESTRICT matches every other table — accounts are deactivated,
  -- never deleted, and the history has to survive that.
  clinician_id   BIGINT      NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  -- Snapshot of the clinician's default clinic at submission time. See the
  -- header note on why this is stored rather than joined.
  clinic_id      TEXT        NOT NULL,

  -- The spec's "Week starting (date) — set automatically by the flow". Here the
  -- server sets it: the Monday of the ISO week the physio submitted in.
  --
  -- NOTE, and this is on purpose: this is a plain ISO Monday, NOT the CEO
  -- dashboard's week grid from week.calculator.ts. That grid exists to tie out
  -- with Cath's spreadsheet columns (Week 1-4 + Remainder within a calendar
  -- month, some months transcribed verbatim from her tabs). This is a personal
  -- weekly journal with a Monday half and a Friday half — it has to align with
  -- the physio's actual working week, not with a month-bounded reporting column,
  -- and a "Remainder" week would have no Monday and no Friday to speak of.
  -- Do not "unify" the two without reading docs/WEEK_GRID_2026-08-06.md first.
  week_start     DATE        NOT NULL,

  -- ── Monday half — spec section 5 ────────────────────────────────────────
  -- "My KPIs for the previous week": three rows of name / target / result, all
  -- free text. Target and Result are TEXT, not numeric, because the sheet these
  -- come off carries "85%", "4 per week" and "$2,400" in the same column and
  -- the spec calls all three short answers. Anything that needs arithmetic on
  -- these belongs in practitioner_week_inputs, which is already numeric.
  kpi1_name              TEXT,
  kpi1_target            TEXT,
  kpi1_result            TEXT,
  kpi2_name              TEXT,
  kpi2_target            TEXT,
  kpi2_result            TEXT,
  kpi3_name              TEXT,
  kpi3_target            TEXT,
  kpi3_result            TEXT,

  -- "If you did not hit the goal" — long answer, optional.
  missed_goal_actions    TEXT,

  -- Both 1-10 and both required by the spec. Kept as separate columns rather
  -- than a jsonb blob: Sam scans these two side by side on the tracker, and the
  -- "check in on anyone whose mojo dropped" query has to be indexable.
  effectiveness_rating   SMALLINT    NOT NULL,
  mojo_rating            SMALLINT    NOT NULL,

  -- "Intentions for the week" — long answer, REQUIRED. This is the one the
  -- Friday half closes the loop on.
  intention              TEXT        NOT NULL,

  case_to_discuss        TEXT,       -- optional
  help_needed            TEXT,       -- optional

  -- "Do you need a 15-minute check-in?" — Yes/No, required. checkin_focus is
  -- the conditional follow-up, only meaningful when this is true.
  checkin_needed         BOOLEAN     NOT NULL,
  checkin_focus          TEXT,

  monday_submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- ── Friday half — spec section 6 ───────────────────────────────────────
  -- All nullable: the row is created on Monday and lives in a half-filled state
  -- for most of the week. friday_submitted_at IS NULL is the canonical
  -- "still open" test — do not infer it from the text fields, since every
  -- Friday text field is optional and an honest Friday submission can leave
  -- all three blank.
  wins                   TEXT,
  goal_achieved          BOOLEAN,
  goal_reflection        TEXT,       -- conditional: only asked when goal_achieved = false
  flag_for_sam           TEXT,
  friday_submitted_at    TIMESTAMPTZ,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT wkr_clinic_valid CHECK (clinic_id IN ('newport', 'narrabeen', 'brookvale')),

  -- week_start must be a Monday. ISODOW: 1 = Monday. The server always derives
  -- it, so this is a backstop against a future caller inventing its own date.
  CONSTRAINT wkr_week_is_monday CHECK (EXTRACT(ISODOW FROM week_start) = 1),

  CONSTRAINT wkr_effectiveness_range CHECK (effectiveness_rating BETWEEN 1 AND 10),
  CONSTRAINT wkr_mojo_range          CHECK (mojo_rating          BETWEEN 1 AND 10),

  -- The intention drives the whole Friday half, so an empty string is as bad as
  -- a NULL and has to be refused here too.
  CONSTRAINT wkr_intention_present CHECK (btrim(intention) <> ''),

  -- The Friday half is either untouched or stamped. A goal_achieved answer
  -- without a timestamp (or the reverse) would make "still open" unanswerable.
  CONSTRAINT wkr_friday_all_or_nothing CHECK (
    (friday_submitted_at IS NULL     AND goal_achieved IS NULL)
    OR
    (friday_submitted_at IS NOT NULL AND goal_achieved IS NOT NULL)
  )
);

-- The spec's match key: "One row per person per week, matched on Name + Week
-- starting so the Friday flow updates the same row Monday created, rather than
-- duplicating it." Name is clinician_id here. This unique index IS that rule —
-- the Monday submit upserts onto it and the Friday submit updates through it.
CREATE UNIQUE INDEX IF NOT EXISTS wkr_unique_person_week
  ON weekly_kpi_reports (clinician_id, week_start);

-- "sorted by Week starting (newest first)" — the tracker's default read.
CREATE INDEX IF NOT EXISTS wkr_week_lookup
  ON weekly_kpi_reports (week_start DESC, clinic_id);

-- A physio's own history, and the same list on their profile page.
CREATE INDEX IF NOT EXISTS wkr_clinician_history
  ON weekly_kpi_reports (clinician_id, week_start DESC);

-- Spec section 8: "Optional second view filtered to Check-in needed = Yes so
-- Sam can scan for who needs attention first." Partial index — the true rows
-- are the small minority, which is exactly what makes this worth having.
CREATE INDEX IF NOT EXISTS wkr_checkin_needed
  ON weekly_kpi_reports (week_start DESC)
  WHERE checkin_needed = true;
