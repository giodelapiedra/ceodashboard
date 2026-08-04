-- 020_edit_delete_requests_ad_lead.sql
-- Extend the edit_requests AND delete_requests entity_type constraints to also
-- cover ad_leads. The Brookvale front desk now edits / deletes ad-leads through
-- the SAME super-admin approval workflow as dropout / case_acceptance:
-- a non-admin change becomes a request that the ADMIN approves (applies /
-- deletes) or rejects (entry unchanged).
--
-- Postgres inline CHECK constraints cannot be altered directly — drop and
-- recreate. The constraint names are the auto-generated ones from migrations
-- 013 / 014 (matched by 015 for the dropout extension).

ALTER TABLE edit_requests
  DROP CONSTRAINT IF EXISTS edit_requests_entity_type_check;

ALTER TABLE edit_requests
  ADD CONSTRAINT edit_requests_entity_type_check
  CHECK (entity_type IN ('case_acceptance', 'dropout', 'ad_lead'));

ALTER TABLE delete_requests
  DROP CONSTRAINT IF EXISTS delete_requests_entity_type_check;

ALTER TABLE delete_requests
  ADD CONSTRAINT delete_requests_entity_type_check
  CHECK (entity_type IN ('dropout', 'case_acceptance', 'ad_lead'));
