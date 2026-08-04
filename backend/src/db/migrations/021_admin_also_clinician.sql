-- 021_admin_also_clinician.sql
-- Allow an account to be selectable as a treating clinician even when its
-- PRIMARY role is not CLINICIAN — e.g. a super admin (CEO) who also treats
-- patients and must appear in the clinician picker.
--
-- Additive + safe: defaults to false, so every existing account behaves
-- exactly as before. Only accounts explicitly flagged true are also offered
-- in the clinician dropdowns (on top of real CLINICIAN accounts).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS also_clinician BOOLEAN NOT NULL DEFAULT false;
