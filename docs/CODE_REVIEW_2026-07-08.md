# Code Review — Bugs & Logic Issues Found 2026-07-08

Full-system review (3 parallel review passes: importers, KPI/dashboard
calculations, feature modules). Top findings were hand-verified against the
code. Status column: ❌ = not fixed yet, ✅ = fixed, ⚠️ = needs Sam's decision.

> **UPDATE (same day):** the feature-module bugs (#5, #10–14 and several LOW
> items) were fixed and **DEPLOYED TO PROD** (build clean, PM2 online, health
> 200, fixes verified in compiled dist/). Rollback backup on server:
> `src.before-20260707-163522`. No migration, no .env change, frontend
> untouched. The dashboard/KPI bugs (#1, #2, #4) and importer bugs
> (#7–9, #15–16) are still unfixed.

---

## 🔴 HIGH — wrong numbers shown, or data integrity risk

### 1. "Patient Reactivations" is always 0 — formula is inverted ❌
`src/services/kpi.calculator.ts:42-48`
The code computes `created_date − last_appointment_date > 90`. For any real
returning patient the last appointment is AFTER the record creation, so the
result is always negative and nobody ever counts as a reactivation.
**Effect:** the weekly dashboard (`GET /api/dashboard/week`) shows Patient
Reactivations = 0 forever. The monthly dashboard uses a different service and
is not affected.
**Fix:** the metric should compare the *gap between the previous appointment
and the new appointment in the queried week* (> 90 days = reactivation).

### 2. Weekly vs monthly dashboard use DIFFERENT formulas — numbers disagree ❌
`src/services/kpi.calculator.ts:55-58` vs `src/services/dashboard.service.ts:105-124`
- **Cancellation rate** (`/week`): `cancelled / attended` — can exceed 100%
  (attended 2, cancelled 5 → shows 250%), excludes rebooked, shows "—" when
  attended = 0 even if there were cancellations. Monthly uses
  `(cancelled + rebooked) / (attended + cancelled + rebooked)`.
- **Show-up rate** (`/week`): denominator = ALL appointments including
  no-shows; monthly excludes no-shows. Same week, two different percentages.
**Fix:** make `/week` use the same formulas as the monthly dashboard.

### 3. Imported dropouts with blank Status are invisible to the CEO dashboard ⚠️
`src/features/dropouts/dropout.repository.ts:427-439` (`dropoutCountsByDate`)
Dashboard cancellation/show-up rates only count rows whose status is one of
the three known values. The GSheets import stores blank statuses as NULL
(6 Newport + 3 Narrabeen rows right now) — those rows appear in the Dropout
Admin totals but are excluded from the dashboard rates, so **the two screens
disagree** with no explanation. Also `aggregate()` emits a literal `"null"`
bucket in by-status/by-reason charts.
**Decision needed:** treat NULL-status rows as "Cancelled - not rescheduled"?
Exclude them from admin totals too? Or force staff to fill status in sheets?

### 4. Ad-spend sync can leave stale/duplicated rows ❌
`src/features/ad-spend/ad-spend.service.ts:134-207`
- If Google/FB later corrects a day's spend to **$0**, that date disappears
  from the API response, so the old row is never deleted → month total
  overstated forever.
- The dedup DELETE matches `entered_by = <ADSPEND user picked by LIMIT 1
  without ORDER BY>` — if a second ADSPEND user is ever created, old rows stop
  matching and every sync **re-inserts duplicates** (double-counted spend).
- DELETE + INSERT loop is not in a transaction — a crash mid-sync temporarily
  undercounts.
**Fix:** delete by `(platform, date range, auto_synced flag)` instead of
`entered_by`, inside a transaction, covering the full requested range.

### 5. Approve/reject workflow has race conditions ✅ FIXED (local)
`edit-request.repository.ts:165-178`, `delete-request.repository.ts` (same),
services `edit-request.service.ts:106-140`, `delete-request.service.ts:101-119`
- Two admins acting on the same request simultaneously: both pass the
  "is it still pending?" check → you can end with a **deleted entry whose
  request says "rejected"**, or a rejection flipped to approved.
- Approving an old edit request applies the **stale patch verbatim** — if the
  row was corrected after the request was filed, approval silently reverts
  the newer correction.
- Patch + status update are not in one transaction.
**Fix:** `SELECT … FOR UPDATE` + `WHERE status='pending'` in the UPDATE, wrap
in a transaction, and block/warn when the row changed after the request date.

### 6. Dropouts can be edited directly, bypassing the approval workflow ⚠️
`src/features/dropouts/dropout.service.ts:117-128`
A clinician can directly PATCH their own dropout entry any time (the code
comment says this is deliberate). But **case acceptance forces the
edit-request approval flow** for the same situation, and migration 015
explicitly added dropout support to edit_requests. One of the two policies is
wrong.
**Decision needed (Sam):** should dropout edits require admin approval like
case acceptance, or should CA also allow direct self-edit?

---

## 🟠 MEDIUM

### 7. Importer year-coercion breaks on 3-digit-year typos (months 10–12) ❌
`import-dropouts-gsheets.ts:396`, `import-case-acceptance-gsheets.ts:286`
`slice(5)` assumes a 4-digit year. A typo like `25/12/206` parses to
`206-12-25`, then coercion produces `2026-2-25` — **Dec 25 silently becomes
Feb 25**. Month 10 produces an invalid date that aborts the whole import.
(The `0206` typo we saw was 4-digit, so it worked by luck.)

### 8. Importer `parseNumber` glues digits together ❌
`import-case-acceptance-gsheets.ts:153-157`
Strips all non-digits then parses: cell `"1-2"` → **12** recommendations,
`"2.5"` → **25**. Silently inflates case recommendations.

### 9. CA importer silently drops rows with a blank Date cell ❌
`import-case-acceptance-gsheets.ts:277`
A filled row whose Date is empty vanishes without appearing in the skip
report. The dropout importer reports the same case as "unparseable
date_logged" — the two behave differently on identical input.

### 10. Date validation is regex-only — impossible dates pass ✅ FIXED (local)
`dropout.validators.ts:7`, `case-acceptance.validators.ts:4`, `edit-request.validators.ts:18,28`
`2026-02-30` passes validation → Postgres error → 500. Worse: a typo year
like `0226-06-01` **inserts cleanly** and the row silently disappears from
every date-filtered view. Web forms need the same "must be 2026-ish" guard
the importers now have.

### 11. ID validator is self-neutralizing ✅ FIXED (local)
`dropout.validators.ts:8`, `case-acceptance.validators.ts:5`
`z.string().regex(/^\d+$/).or(z.string().min(1))` — the `.or()` accepts ANY
non-empty string, so `clinician_id: "abc"` reaches the DB → 500 instead of 400.

### 12. Edit-request limits diverge from direct-entry limits ✅ FIXED (local)
`edit-request.validators.ts:15-33`
Via edit request an admin can approve values the form forbids: recs with no
max (form caps 1000), cancelled-dates array with no 50 cap, notes 5000 vs
2000. Also FRONT_DESK users can rewrite `front_staff_name` through an edit
request even though direct edits strip it. And `front_staff_name` max is 100
here vs 120 on the form — a 110-char name can never be corrected.

### 13. Successful dropout edit can return 404 ✅ FIXED (local)
`dropout.service.ts:148-149`
If a clinician reassigns their own entry to another clinician, the write
succeeds but the re-read (scoped to the editor) finds nothing → client gets
404 for an edit that actually applied.

### 14. Draft autosave wipes fields the client omits ✅ FIXED (local)
`draft.service.ts:41-53`, `draft.repository.ts:97-109`
A PATCH sending only `form_data` nulls out `clinic_id` and `patient_name` on
the stored draft — drafts list shows nameless drafts.

### 15. Importer: clinician lookup can match a DEACTIVATED account ❌
`import-dropouts-gsheets.ts:252-267` (same in CA importer)
The in-clinic lookup has no `is_active` filter (the cross-clinic fallback
does). A deactivated clinician at the target clinic wins over an active
same-name clinician elsewhere.

### 16. Importer: cancelled-date list loses trailing bare days ❌
`import-dropouts-gsheets.ts:222`
Bare day numbers inherit the month of the NEXT anchor only. Month-first cells
like `"12.06, 19, 26"` keep only 12.06 — the 19th and 26th are silently
dropped. Date ranges (`"12.05-19.05"`) are dropped entirely. Also explicit
year tokens in the cancel-dates column bypass 2026 coercion (`"07.01.25"` →
2025 stored).

### 17. Ad-spend weekly report: weekend spend hidden in a Mon–Fri label ❌
`ad-spend.repository.ts:297-306`
Weekly totals sum all 7 days but the label says Mon–Fri — Saturday spend
makes the weekly total look wrong vs the daily entries shown.

---

## 🟡 LOW (bag of smaller ones)

- **Misleading log:** dropout importer overlap warning hardcodes "newport"
  regardless of clinic (`import-dropouts-gsheets.ts:572`).
- **Misreported import stats:** `status NULL` counts include rows that were
  then skipped — log overstates what was stored.
- **Feb-29 coercion:** year-typo on a leap-day (`29/02/2028`) coerces to
  non-existent `2026-02-29` → import aborts with raw DB error.
- **`FRONT_STAFF_NAMES` whitelist never enforced** despite 3 comments
  claiming it is (`dropout.validators.ts:17`) — free text fragments analytics.
- **Double-submit edit/delete request** → 500 instead of a clean "already
  pending" message (unique index catches it, error unhandled).
- **XLSX export** pages with OFFSET while rows can be inserted → rare
  duplicate/skipped rows in big exports.
- **Draft deleted mid-update** → TypeError 500 (`draft.repository.ts:97-109`).
- **Prepay parser:** cross GLYPHS (✗ ✘ ❌) fall through to NULL instead of NO
  (letter X works). Only matters if a sheet uses glyph crosses.
- **Dead helper** `withinSameDayWindow` in ad-spend.service.ts — never called,
  and wrong (rolling 24h, not Sydney calendar day). Delete before someone
  uses it.
- **Feb sentinel week** `9999-12-31` from week.calculator.ts leaks into the
  API payload (frontend must special-case it).

---

## ✅ Checked and CLEAN (verified, no bug)

- All SQL is parameterized — no injection anywhere (including ORDER BY/search).
- `appointment_cancelled_dates` array is never unnested in aggregations — no
  double counting of dropouts.
- DATE/timezone handling in repositories converts via local components —
  no UTC day-shift on stored dates; range filters inclusive & consistent.
- Division-by-zero everywhere renders `null` → "—", never NaN/Infinity.
- Dashboard snapshot cache (60-min TTL) overlays live dropout/CA/ad-spend on
  every hit — no stale-key bug; `?refresh=1` busts Nookal data.
- Booked ≤ recommendations enforced per row (validator + DB CHECK) — weighted
  case acceptance can't exceed 100%.
- Drafts are correctly owner-scoped; pagination math correct.
- ADSPEND role can't see or create clinic data.

## Design note (not a bug, but know this)
Monthly show-up/cancellation rates mix two sources: attended comes from
Nookal, cancelled/rebooked from the manually-logged dropout rows bucketed by
**entry date** (not the appointment's date). A cancellation from the 5th
that's typed in on the 8th shifts the rate impact to the later week. Fine at
month grain if staff log within the month; weekly rates are approximate.
