-- 033_weekly_kpi_comments.sql
-- Comments on a weekly KPI report — Sam's ask, 2026-08-24:
--   "si super admin mas maganda ba kapag nag submit sila puwede rin mag comment
--    si super admin regarding sa submitted weekly-kpi tapos ma notify si
--    clinician na nag comment"
--
-- WHY THIS EXISTS AT ALL: the Friday half closes the loop for the physio, but
-- there was no way for Sam to answer. A mojo of 3, or a filled-in `flag_for_sam`,
-- had to be picked up in Teams or in person — which means the response lives
-- nowhere near the week it is about, and is gone by the next review. A comment
-- thread hangs the reply off the report itself, so the week and the answer to
-- it are read together, this week and a year from now.
--
-- WHO SEES A THREAD: exactly two parties — the physio the report belongs to,
-- and the super admin. Enforced in the service (weeklyKpiService.assertThread-
-- Participant), not here; SQL has no notion of the caller. Deliberately NOT
-- visible to the rest of the team: this is coaching, and a comment other
-- physios can read turns into a public mark on someone's week.
--
-- WHY A THREAD AND NOT A SINGLE "admin_note" COLUMN: Sam's answer on the same
-- day was two-way — the physio can reply. A column would hold one side of a
-- conversation and quietly overwrite itself on every edit; a thread keeps who
-- said what, in order, which is the part worth having.
--
-- ISOLATION: two new tables and their indexes. Nothing existing is altered —
-- weekly_kpi_reports itself is untouched, so the tracker, the form and every
-- other feature behave identically if this migration is rolled back by hand.

CREATE TABLE IF NOT EXISTS weekly_kpi_comments (
  id          BIGSERIAL   PRIMARY KEY,

  -- The week being discussed. CASCADE, unlike the RESTRICT used for user
  -- references everywhere else: a comment has no meaning without the report it
  -- hangs off, so if a report is ever removed its thread goes with it rather
  -- than blocking the delete. (Reports are not deletable today — there is no
  -- endpoint for it. This is about what the row MEANS, not about a live path.)
  report_id   BIGINT      NOT NULL REFERENCES weekly_kpi_reports(id) ON DELETE CASCADE,

  -- Who wrote it: the super admin, or the physio replying. RESTRICT matches
  -- every other user reference in the schema — accounts are deactivated, never
  -- deleted, and a thread must survive that.
  author_id   BIGINT      NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  body        TEXT        NOT NULL,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Bumped on edit. `updated_at > created_at` is how the UI knows to print
  -- "edited" — there is no separate flag to keep in sync.
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- An empty comment is a mis-click, not a message.
  CONSTRAINT wkc_body_present CHECK (btrim(body) <> ''),
  -- Same ceiling the API validator uses. A comment is a note on one week, not
  -- a document; without a cap one paste can make the tracker row unreadable.
  CONSTRAINT wkc_body_length  CHECK (char_length(body) <= 4000)
);

-- The thread read: every comment on one report, oldest first.
CREATE INDEX IF NOT EXISTS wkc_thread
  ON weekly_kpi_comments (report_id, created_at);

-- "What have I written lately" and the author check on edit/delete.
CREATE INDEX IF NOT EXISTS wkc_author
  ON weekly_kpi_comments (author_id, created_at DESC);


-- ── Read state ──────────────────────────────────────────────────────────────
-- One stamp per (thread, person). Unread, for a given viewer, is:
--     comments WHERE author_id <> viewer AND created_at > COALESCE(read_at, -inf)
--
-- A per-thread stamp rather than a per-comment read row: a thread has exactly
-- two participants and is read as a whole, so a row per comment would be a lot
-- of bookkeeping for a number that never differs from this one. COALESCE to
-- -infinity means a thread nobody has opened yet counts as fully unread, which
-- is the behaviour that makes the badge appear the first time Sam writes.
CREATE TABLE IF NOT EXISTS weekly_kpi_comment_reads (
  report_id  BIGINT      NOT NULL REFERENCES weekly_kpi_reports(id) ON DELETE CASCADE,
  user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  read_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (report_id, user_id)
);

-- The physio's badge query: "every thread of mine with something unread in it"
-- goes user-first, so the index does too.
CREATE INDEX IF NOT EXISTS wkcr_user_lookup
  ON weekly_kpi_comment_reads (user_id, report_id);
