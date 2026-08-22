-- 028_ageing_debts_manual_week.sql
-- Ageing Debts moves from ONE typed figure per month to one per WEEK COLUMN,
-- with the Monthly Actual computed as their sum. Sam asked for this 2026-08-12:
-- "manual entry ... available per week instead and monthly actual computes the
-- sum automatically from Week 1 to total ng month".
--
-- NOTE ON MEANING: migration 027 described this figure as an outstanding
-- BALANCE, and summing a balance across weeks overstates it. Sam was shown that
-- and chose the sum anyway, so the weekly number is to be read as "the debt
-- belonging to that week", not as a running total. Do not silently switch this
-- back to last-week-wins.
--
-- week_num is the 1-based POSITION of the column the dashboard renders, not a
-- calendar ISO week: the grid is Week 1-4 plus a Remainder column, and for some
-- months it comes from Cath's transcribed ranges (see week.calculator.ts). The
-- payload decides how many columns exist, so the CHECK is a loose 1..6 backstop
-- rather than a hard 5.
--
-- The monthly table from 027 is KEPT, not dropped: it still holds the figures
-- Sam typed between 2026-08-11 and today, and those must not vanish off the
-- dashboard. The read rule is "weeks if any exist, else the 027 row", and
-- writing the first week of a month deletes that month's 027 row so a month can
-- never have two competing sources.

CREATE TABLE IF NOT EXISTS ageing_debts_manual_week (
  id         BIGSERIAL     PRIMARY KEY,

  -- Matches the dashboard's clinic selector, including the synthetic 'overall'.
  -- 'overall' is typed on its own here too, NOT summed from the three clinics —
  -- same reasoning as migration 027.
  clinic_id  TEXT          NOT NULL,
  year       INTEGER       NOT NULL,
  month      INTEGER       NOT NULL,
  week_num   INTEGER       NOT NULL,

  amount     NUMERIC(14,2) NOT NULL,

  entered_by BIGINT        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_by BIGINT                 REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT admw_clinic_valid  CHECK (clinic_id IN ('newport', 'narrabeen', 'brookvale', 'overall')),
  CONSTRAINT admw_month_range   CHECK (month    BETWEEN 1 AND 12),
  CONSTRAINT admw_year_range    CHECK (year     BETWEEN 2020 AND 2100),
  CONSTRAINT admw_week_range    CHECK (week_num BETWEEN 1 AND 6),
  CONSTRAINT admw_amount_nonneg CHECK (amount >= 0)
);

-- One row per clinic per month per column — the upsert target, so re-typing a
-- week corrects it instead of leaving two rows the sum would double-count.
CREATE UNIQUE INDEX IF NOT EXISTS admw_unique_period
  ON ageing_debts_manual_week (clinic_id, year, month, week_num);

-- The dashboard always reads a whole month at once.
CREATE INDEX IF NOT EXISTS admw_month_lookup
  ON ageing_debts_manual_week (clinic_id, year, month);
