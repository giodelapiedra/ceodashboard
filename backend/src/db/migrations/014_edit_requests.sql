-- 014_edit_requests.sql
-- Admin-approval workflow for editing case-acceptance entries by non-admin users.
--
-- When a clinician / front-desk user edits their own entry, instead of applying
-- the patch immediately they submit an edit REQUEST with a mandatory reason.
-- An ADMIN approves (applies the patch) or rejects (entry stays unchanged).
--
-- patch: JSONB snapshot of the proposed field changes (UpdateInput shape).
-- clinic_id / patient_name / entry_date are snapshotted for the admin queue
-- so the list reads cleanly without joining case_acceptances.

CREATE TABLE IF NOT EXISTS edit_requests (
  id            BIGSERIAL PRIMARY KEY,
  entity_type   TEXT   NOT NULL CHECK (entity_type IN ('case_acceptance')),
  entity_id     BIGINT NOT NULL,
  requested_by  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason        TEXT   NOT NULL,

  -- Proposed changes (subset of updatable case_acceptance fields).
  patch         JSONB  NOT NULL,

  -- Snapshot for the admin review queue.
  clinic_id     TEXT,
  patient_name  TEXT,
  entry_date    DATE,

  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at   TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One open edit request per entry at a time.
CREATE UNIQUE INDEX IF NOT EXISTS edit_requests_one_pending
  ON edit_requests (entity_type, entity_id)
  WHERE status = 'pending';

-- Admin review queue: pending first, newest first.
CREATE INDEX IF NOT EXISTS edit_requests_status_idx
  ON edit_requests (status, created_at DESC);

-- "Which of my entries have an open edit request?" — drives the requester's UI.
CREATE INDEX IF NOT EXISTS edit_requests_requester_idx
  ON edit_requests (requested_by, status);
