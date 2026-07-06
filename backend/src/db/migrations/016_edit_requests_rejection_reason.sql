-- 016_edit_requests_rejection_reason.sql
-- Stores the admin's explanation when rejecting an edit request, shown to the
-- requesting clinician/front-desk so they know why the edit was not applied.

ALTER TABLE edit_requests
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
