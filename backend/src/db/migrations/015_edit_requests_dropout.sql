-- 015_edit_requests_dropout.sql
-- Extend the edit_requests entity_type constraint to also cover patient_dropouts.
-- Postgres inline CHECK constraints cannot be altered directly — drop and recreate.

ALTER TABLE edit_requests
  DROP CONSTRAINT IF EXISTS edit_requests_entity_type_check;

ALTER TABLE edit_requests
  ADD CONSTRAINT edit_requests_entity_type_check
  CHECK (entity_type IN ('case_acceptance', 'dropout'));
