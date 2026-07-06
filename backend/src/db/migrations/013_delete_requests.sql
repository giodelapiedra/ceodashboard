-- 013_delete_requests.sql
-- Admin-approval workflow for deleting dropout / case-acceptance entries.
--
-- Non-admin encoders (clinician / front desk) can no longer hard-delete their
-- own rows. Instead they file a delete REQUEST; an ADMIN approves it (which
-- performs the actual delete) or rejects it (entry stays).
--
-- entity_type + entity_id point at the row in patient_dropouts /
-- case_acceptances. We snapshot patient_name / clinic_id / entry_date so the
-- admin review list reads cleanly without joining two different entry tables,
-- and so the record still makes sense after the entry is deleted on approval.

CREATE TABLE IF NOT EXISTS delete_requests (
  id            BIGSERIAL PRIMARY KEY,
  entity_type   TEXT   NOT NULL CHECK (entity_type IN ('dropout', 'case_acceptance')),
  entity_id     BIGINT NOT NULL,
  requested_by  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason        TEXT,

  -- snapshot of the target entry for the admin review screen
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

-- At most one OPEN request per entry — re-requesting while one is pending is a
-- no-op conflict, not a duplicate. Approved/rejected rows are unconstrained so
-- history accumulates.
CREATE UNIQUE INDEX IF NOT EXISTS delete_requests_one_pending
  ON delete_requests (entity_type, entity_id)
  WHERE status = 'pending';

-- Admin review queue: pending first, newest first.
CREATE INDEX IF NOT EXISTS delete_requests_status_idx
  ON delete_requests (status, created_at DESC);

-- "Which of my entries have an open request?" — drives the requester's UI.
CREATE INDEX IF NOT EXISTS delete_requests_requester_idx
  ON delete_requests (requested_by, status);
