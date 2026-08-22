-- 027_ageing_debts_manual.sql
-- Ageing Debts on the CEO dashboard is now a hand-typed figure instead of a
-- live Nookal pull. Sam asked for this 2026-08-11: the 10-year invoice
-- pagination was slow enough that it needed its own on-demand button, and he
-- reads the number off Nookal himself anyway. The button is gone; this table
-- is where the typed number lives.
--
-- The Nookal path (`ageing-debts.service.ts` + `GET /api/dashboard/ageing-debts`)
-- is deliberately left in place — the diag-ageing-* scripts still use it for
-- cross-checking a typed figure against Nookal.
--
-- One row per (clinic, month). 'overall' is stored as its OWN clinic_id rather
-- than being summed from the three clinics: Sam chose to type it separately
-- (2026-08-11), because the Nookal screen he reads gives him a practice-wide
-- total that need not equal the sum of the per-location figures.
--
-- amount is NOT NULL: a row exists only once someone typed a figure, so a
-- missing row is the "blank" state and renders as "—". That keeps a real $0.00
-- (debts all cleared) distinguishable from "not entered yet", the same
-- distinction the dashboard already draws between ZERO_CURRENCY and NO_DATA.

CREATE TABLE IF NOT EXISTS ageing_debts_manual (
  id         BIGSERIAL     PRIMARY KEY,

  -- Matches the dashboard's clinic selector, including the synthetic 'overall'.
  clinic_id  TEXT          NOT NULL,
  year       INTEGER       NOT NULL,
  month      INTEGER       NOT NULL,

  -- Outstanding balance total. NUMERIC (not float) — this is money.
  amount     NUMERIC(14,2) NOT NULL,

  entered_by BIGINT        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_by BIGINT                 REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT adm_clinic_valid   CHECK (clinic_id IN ('newport', 'narrabeen', 'brookvale', 'overall')),
  CONSTRAINT adm_month_range    CHECK (month  BETWEEN 1 AND 12),
  CONSTRAINT adm_year_range     CHECK (year   BETWEEN 2020 AND 2100),
  CONSTRAINT adm_amount_nonneg  CHECK (amount >= 0)
);

-- One row per clinic per month — the upsert target, so re-typing a month
-- corrects it instead of leaving two rows the dashboard would pick between.
CREATE UNIQUE INDEX IF NOT EXISTS adm_unique_period
  ON ageing_debts_manual (clinic_id, year, month);
