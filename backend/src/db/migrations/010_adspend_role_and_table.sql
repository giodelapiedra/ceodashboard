-- 010_adspend_role_and_table.sql
-- New role: ADSPEND — a dedicated marketing-spend encoder. This account does
-- ONE thing: log ad spend line items (per campaign/channel). It never sees the
-- CEO dashboard, dropouts, or case acceptance. The CEO dashboard derives the
-- weekly "Ad Spend" + "Cost Per Patient" rows from these entries by date range
-- (week is computed from spend_date — never stored, same as every other KPI).
--
-- Ad spend is GLOBAL (one pool for the whole business) — NOT attributed per
-- clinic. So ad_spend has no clinic_id; the dashboard shows the same overall
-- figure regardless of the clinic selector.
--
-- Scoping rules (extends 008):
--   ADMIN              → clinic_id IS NULL (cross-clinic, no data entry)
--   FRONT_DESK_GLOBAL  → clinic_id IS NULL (cross-clinic, picks clinic per entry)
--   ADSPEND            → clinic_id IS NULL (no clinic — ad spend is global)
--   CLINICIAN          → clinic_id NOT NULL (own entries / own clinic)
--   FRONT_DESK         → clinic_id NOT NULL (pinned to a single clinic)

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('ADMIN', 'CLINICIAN', 'FRONT_DESK', 'FRONT_DESK_GLOBAL', 'ADSPEND'));

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_clinic_scope_check;
ALTER TABLE users
  ADD CONSTRAINT users_clinic_scope_check
  CHECK (
    (role IN ('ADMIN', 'FRONT_DESK_GLOBAL', 'ADSPEND') AND clinic_id IS NULL) OR
    (role IN ('CLINICIAN', 'FRONT_DESK')               AND clinic_id IS NOT NULL)
  );

-- Ad spend line items. One row per campaign/channel spend on a given day.
-- GLOBAL — no clinic_id (ad spend is one business-wide pool). The CEO
-- dashboard sums these into the existing Mon–Fri week buckets via the date
-- range returned by getWeekRanges() — there is no week column on purpose.
CREATE TABLE IF NOT EXISTS ad_spend (
  id            BIGSERIAL PRIMARY KEY,
  -- The calendar day the spend applies to. Week is derived from this.
  spend_date    DATE        NOT NULL,
  -- Marketing channel from the fixed AD_CHANNELS list (validated app-side):
  -- Facebook / Google / Instagram / TikTok / Other.
  channel       TEXT        NOT NULL,
  -- Optional free-text campaign label (e.g. "Winter Knee Pain").
  campaign_name TEXT,
  amount        NUMERIC(12,2) NOT NULL,
  notes         TEXT,
  entered_by    BIGINT      NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by    BIGINT               REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT ad_spend_amount_nonneg CHECK (amount >= 0)
);

CREATE INDEX IF NOT EXISTS ad_spend_date_idx       ON ad_spend (spend_date DESC);
CREATE INDEX IF NOT EXISTS ad_spend_entered_by_idx ON ad_spend (entered_by);
