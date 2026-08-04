-- 022_duplicate_guard_indexes.sql
-- Indexes backing the duplicate guard on the three manual-entry tables.
--
-- Deliberately NOT unique. A patient can legitimately drop out twice, or be
-- re-assessed, or come in from two ad campaigns — the guard warns and lets the
-- encoder confirm ("save as a separate entry"). A hard UNIQUE constraint would
-- make that impossible and would reject the legit case with a 500-looking
-- error. Correctness under concurrency comes from pg_advisory_xact_lock() in
-- the service layer instead (see shared/duplicates.ts).
--
-- The name expression MUST match NAME_NORM_SQL() in shared/duplicates.ts
-- character for character, otherwise the planner won't use these indexes.
-- All three functions (lower / btrim / regexp_replace) are IMMUTABLE, so they
-- are legal in an index expression.
--
-- `[[:space:]]+` not `\s+`: `\s` was verified NOT to match on this server (a
-- name with a double space came back uncollapsed), and a backslash pattern
-- also depends on standard_conforming_strings. The POSIX class has no escape
-- to get lost.

-- Dropouts. Natural key: clinic + clinician + patient + date_logged.
-- Column order is (clinic, name, date) so the SAME index serves both the exact
-- lookup and the ±14-day "similar" scan, which has no clinician predicate.
CREATE INDEX IF NOT EXISTS dropouts_dupkey_idx
  ON patient_dropouts (
    clinic_id,
    (lower(btrim(regexp_replace(patient_name, '[[:space:]]+', ' ', 'g')))),
    date_logged
  );

-- Case acceptance. Same natural key shape as dropouts.
CREATE INDEX IF NOT EXISTS case_acc_dupkey_idx
  ON case_acceptances (
    clinic_id,
    (lower(btrim(regexp_replace(patient_name, '[[:space:]]+', ' ', 'g')))),
    date_logged
  );

-- Ad leads. Natural key: clinic + patient + platform + date_added. Platform is
-- part of the key because the same person really can arrive as a Meta lead and
-- a Google lead on the same day — that is two leads, not one.
CREATE INDEX IF NOT EXISTS ad_leads_dupkey_idx
  ON ad_leads (
    clinic_id,
    (lower(btrim(regexp_replace(patient_name, '[[:space:]]+', ' ', 'g')))),
    date_added
  );
