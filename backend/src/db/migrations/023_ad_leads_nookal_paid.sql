-- Persisted Nookal account totals per ad lead.
--
-- Before this, "Paid (Nookal)" lived only in frontend state: the Sync button
-- resolved names against Nookal and the result vanished on reload. Per Sam
-- (2026-07-30): save it per lead instead, so the page loads instantly from
-- the DB, Sync just refreshes the stored values, and the ad-spend page can
-- total Paid per platform (Google vs Meta) against ad spend.
--
-- nookal_candidates mirrors NookalPaidLookup.candidates verbatim (JSONB array
-- of {clientID, fullName, invoiceCount, invoiced, paid}) so the hover list for
-- "multiple" matches keeps working from stored data. nookal_paid is the
-- matched candidate's paid total, denormalized for cheap SUM() by platform.

ALTER TABLE ad_leads ADD COLUMN IF NOT EXISTS nookal_status     TEXT;
ALTER TABLE ad_leads ADD COLUMN IF NOT EXISTS nookal_candidates JSONB;
ALTER TABLE ad_leads ADD COLUMN IF NOT EXISTS nookal_paid       NUMERIC(12,2);
ALTER TABLE ad_leads ADD COLUMN IF NOT EXISTS nookal_synced_at  TIMESTAMPTZ;
