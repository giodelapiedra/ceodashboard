-- 018_user_show_in_picker.sql
-- Some clinicians leave the practice (or shouldn't be picked for new entries)
-- but must stay fully usable: their historical dropout / case-acceptance data
-- stays in the dashboard, their account stays active (still resolvable by the
-- Google-Sheets importers, still able to log in), we just don't want them
-- cluttering the "who is the clinician for this entry" pickers anymore.
--
-- `is_active` couldn't express this: flipping it to false hides them from the
-- pickers but ALSO blocks login and marks the account inactive. This flag
-- separates "show in the clinician picker" from "active account".
--
-- Default TRUE so every existing + future clinician stays selectable unless a
-- human explicitly hides them.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS show_in_picker BOOLEAN NOT NULL DEFAULT TRUE;
