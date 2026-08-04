-- 025_users_nookal_staff_id.sql
-- Map a PhysioWard user to their Nookal provider record.
--
-- Nookal v3 exposes a `staff` query returning staffID + fullName + isProvider
-- (confirmed by live introspection 2026-08-04 — 28 providers, 13 active). The
-- appointment feed's V3Appointment.providerID is that same staffID, so this one
-- column is the whole bridge between Nookal appointments and our clinicians.
--
-- With it, three of the four Practitioner Stats columns that were thought
-- unobtainable become derivable per practitioner from data the app already
-- fetches: Total Appts (status Completed), NC (isNewCase) and the cancellation
-- numerator (status Cancelled) — all grouped by providerID.
--
-- Additive and nullable: nothing reads this column unless it is set, so the CEO
-- Dashboard and every existing feature are unaffected.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS nookal_staff_id INTEGER;

-- One Nookal provider maps to at most one user. Nookal itself holds duplicate
-- and superseded provider records (two "Jarryd Edgar", an inactive "Jervis Bob
-- Goodsell" alongside the active "Jervis Goodsell"), so without this a stale ID
-- could be attached to a second account and silently double-count a week.
-- Partial: many users legitimately have no Nookal provider record at all
-- (front desk, ad-spend encoders), and NULLs must not collide.
CREATE UNIQUE INDEX IF NOT EXISTS users_nookal_staff_id_uniq
  ON users (nookal_staff_id)
  WHERE nookal_staff_id IS NOT NULL;

COMMENT ON COLUMN users.nookal_staff_id IS
  'Nookal v3 staffID for this clinician; equals V3Appointment.providerID. NULL = not a Nookal provider or not yet mapped.';
