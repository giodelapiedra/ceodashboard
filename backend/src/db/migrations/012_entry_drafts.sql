-- 012_entry_drafts.sql
-- Saved drafts for the Dropout and Case Acceptance entry forms.
--
-- A draft is a partial, work-in-progress entry the encoder can save and come
-- back to after logging out. Deliberately kept OUT of patient_dropouts /
-- case_acceptances so that:
--   1. the analytics queries on those tables never have to filter drafts out, and
--   2. partial data is allowed (drafts skip the NOT NULL / CHECK constraints
--      that finished entries must satisfy).
--
-- form_data is an opaque JSONB snapshot of the frontend FormState — the backend
-- stays generic and does not couple to each form's field shape. clinic_id and
-- patient_name are denormalised out purely so the drafts LIST can be rendered
-- without parsing every JSON blob.
--
-- Drafts are PRIVATE to their author: every read/write is scoped to owner_id.
-- ON DELETE CASCADE drops a user's drafts if the account is removed.

CREATE TABLE IF NOT EXISTS entry_drafts (
  id           BIGSERIAL PRIMARY KEY,
  kind         TEXT   NOT NULL CHECK (kind IN ('dropout', 'case_acceptance')),
  owner_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clinic_id    TEXT,
  patient_name TEXT,
  form_data    JSONB  NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Drives the per-user drafts list: "my drafts of this kind, newest first".
CREATE INDEX IF NOT EXISTS entry_drafts_owner_kind_idx
  ON entry_drafts (owner_id, kind, updated_at DESC);
