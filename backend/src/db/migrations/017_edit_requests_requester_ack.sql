-- 017_edit_requests_requester_ack.sql
-- Rejected-edit banners used to be dismissed only in the browser's
-- localStorage, so they reappeared on other devices / cleared storage for the
-- whole 30-day window. Track acknowledgement server-side instead: once the
-- requester dismisses a rejection, it never shows again anywhere.

ALTER TABLE edit_requests
  ADD COLUMN IF NOT EXISTS requester_ack_at TIMESTAMPTZ;
