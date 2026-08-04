-- 019_ad_leads.sql
-- Meta/Google ADS Leads — prospective-patient leads captured from paid ad
-- campaigns (Facebook lead forms / landing pages, Google Ads). The Brookvale
-- front desk encodes each lead; the super admin gets a read-only full view.
--
-- Columns are an EXACT match of the visible columns in the sheet's
-- "Meta/Google ADS Leads" tab (gayang-gaya):
--   Prospective Patient Name · Platform Source · Campaign Name · Date Added ·
--   Booked? · Bella Called? · Bella SMS? · Bella Remarks
--
-- ISOLATION: this migration ONLY creates a new table. It does NOT alter users,
-- dropouts, case_acceptance, ad_spend, or any existing object — so it cannot
-- affect existing data. No new role is needed (existing FRONT_DESK encodes,
-- ADMIN views). Deliberately SEPARATE from the CEO dashboard.
--
-- `platform` is intentionally NOT CHECK-constrained: the entry form offers a
-- fixed dropdown (AD_LEAD_PLATFORMS), but the importer may insert any historical
-- value verbatim without a migration.

CREATE TABLE IF NOT EXISTS ad_leads (
  id             BIGSERIAL   PRIMARY KEY,
  -- Which clinic the lead belongs to. Only 'brookvale' runs paid ads today,
  -- but the column keeps the feature multi-clinic-ready.
  clinic_id      TEXT        NOT NULL,
  entered_by     BIGINT      NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  patient_name   TEXT        NOT NULL,   -- Prospective Patient Name
  platform       TEXT        NOT NULL,   -- Platform Source
  campaign_name  TEXT,                   -- Campaign Name
  date_added     DATE        NOT NULL,   -- Date Added
  booked         BOOLEAN     NOT NULL DEFAULT FALSE,  -- Booked?
  bella_called   TEXT,                   -- Bella Called?
  bella_sms      TEXT,                   -- Bella SMS?
  bella_remarks  TEXT,                   -- Bella Remarks
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by     BIGINT               REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS ad_leads_clinic_date_idx ON ad_leads (clinic_id, date_added DESC);
CREATE INDEX IF NOT EXISTS ad_leads_entered_by_idx  ON ad_leads (entered_by);
CREATE INDEX IF NOT EXISTS ad_leads_platform_idx    ON ad_leads (platform);
