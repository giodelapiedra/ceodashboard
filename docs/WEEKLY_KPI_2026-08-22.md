# Team Performance KPI Reporting — build notes

**Date:** 2026-08-22
**Source spec:** `Weekly_KPI_Process_Build_Spec.pdf` — "Weekly KPI & Wins Process, Build spec for Teams + Power Automate — final field list"
**Source mockup:** `kpi_form_preview (1).html` (the HTML preview referenced in the spec)
**Migration:** `032_weekly_kpi_reports.sql`
**Status:** built and tested locally; **not yet deployed to prod**

---

## 1. What was asked for, and what was built

Sam's instruction, verbatim in the parts that decided the design:

> "pag login ng mga physio … clinician meron Team Performance KPI Reporting dito
> https://ceoadmin.physioward.com.au/admin-home sa selection pero mga clinician lang diba
> meron na sila kanya kanya account **hindi need lagay name nila at clinic nila kasi meron na
> sila default clinic** diba tapos **ma save sa kanya kanya profile nila** ung Team Performance
> KPI Reporting **para may history** … si super admin [PDF] … pero **sa teams wala na muna, sa
> dashboard ko talaga gagawin muna yan** … sundan mo at auto accept mo nalang, idea lang yan
> nasa pdf"

So: follow the spec's fields and cycle, build it in this app instead of Teams, drop the two
fields the login already answers, and keep per-physio history.

| Spec says | Built as |
|---|---|
| Teams Adaptive Card, posted by a Power Automate flow | A page in this app: `/weekly-kpi` |
| Card stores its Teams message ID so Friday can update it | Not needed — the DB row **is** the card. `(clinician_id, week_start)` is the handle. |
| SharePoint list / Excel Online as the shared record | `weekly_kpi_reports` |
| Teams tab pointing at the list, for shared viewing | `/admin/weekly-kpi` (super admin only) |
| Name — short answer, required | **Removed.** Off the JWT. |
| Clinic — choice of three, required | **Removed.** Off the account's `clinic_id`. |
| Everything else (sections 5, 6, 7, 8) | Followed as written |

The spec's own build note — *"this needs a bit more than a one-shot form flow … worth a quick
feasibility check with whoever builds it before committing to a launch date"* — is about the
Teams message-ID bookkeeping. That whole problem disappears in this build, which is the main
practical argument for having done it here first.

---

## 2. Why Name and Clinic are gone

The spec asks for both because **a Teams card cannot know who is filling it in**. This app can.

- **Name** comes from the JWT (`scope.userId` → `clinician_id`). The API does **not** accept a
  clinician id in the request body. If it did, any physio could file a report under a
  colleague's name, and the tracker Sam reads would be forgeable.
- **Clinic** comes from `users.clinic_id`. Both are shown read-only in the form header so the
  physio can see what the report is being filed against.

`clinic_id` is still **stored on the row**, not just joined from `users`. Physios rotate between
clinics and accounts get moved; a week reported at Newport has to keep reading as Newport after
the account moves to Brookvale.

If a CLINICIAN account has no `clinic_id`, the form and the API both refuse and say to have the
admin set it. They deliberately do **not** pick a default — a report filed to the wrong clinic is
worse than one not filed at all. (A CLINICIAN always has a clinic in practice: the role is
single-clinic by definition and is not in `CROSS_CLINIC_ROLES`. A null there means the account
was mis-created.)

---

## 3. One row per person per week

Spec section 7: *"One row per person per week, matched on Name + Week starting so the Friday flow
updates the same row Monday created, rather than duplicating it."*

That rule is the unique index `wkr_unique_person_week (clinician_id, week_start)`:

- `POST /monday` upserts onto it.
- `POST /friday` finds the row through it and writes only the Friday columns.
- The Monday upsert does **not** touch the Friday columns, so correcting a Monday half never
  wipes a Friday half already filled in.

**Re-submitting the current week corrects it. Past weeks are frozen.**

### Why no approval queue

Dropouts and case acceptance route edits through the approval queue. This does not, on purpose:

- Those are **shared operational records** — one person's typo becomes another person's wrong
  number on a dashboard.
- This is a **self-report**. The only person a correction concerns is its author. Routing
  "I meant 7 not 8 on my own mojo rating" through the CEO's approval queue is friction with
  nothing on the other side of it.
- What actually needs protecting is the tracker not moving under Sam after he has read it —
  and freezing past weeks does that directly.

There is no delete. This is history.

---

## 4. Week keying — and why it is NOT the dashboard's week grid

`week_start` is a plain **ISO Monday** (Monday–Sunday week, no month boundary).

It is deliberately **not** `week.calculator.ts`, which builds Week 1–4 + Remainder inside a
calendar month and, for months Cath already built by hand, uses her transcribed ranges verbatim
(see `WEEK_GRID_2026-08-06.md`). That grid is right for tying out with her spreadsheet and wrong
here:

1. This form has a **Monday half and a Friday half**. A `Remainder [30-31]` column has neither.
2. A physio's working week does not stop at a month boundary. Splitting one week across two rows
   would break one-row-per-person-per-week — the exact match key the Friday submit depends on.

The rule lives in `backend/src/features/weekly-kpi/weekly-kpi.week.ts`, mirrored on the frontend
in `weeklyKpi.ui.tsx`. Both treat **Sunday as belonging to the week that is ending**, not the one
about to start.

Do not "unify" the two week systems without reading `WEEK_GRID_2026-08-06.md` first.

---

## 5. Access model

Spec section 2 is unusually explicit, and it is the whole model:

> "Physios are the only ones who interact with the card … no one else submits anything."
> "Sam (and anyone else) only ever views the shared tracker tab — he never fills in a card
> himself. He's a viewer of the data, not a participant in the form."

| | Submit | Own history | Whole team |
|---|---|---|---|
| CLINICIAN | yes | yes | no |
| ADMIN | **no (403)** | n/a | yes |
| FRONT_DESK / FRONT_DESK_GLOBAL / ADSPEND | no | no | no |

This is **not** the usual "admin can do everything" pattern — ADMIN reads every row and writes
none. `canSubmitWeeklyKpi()` / `canViewWeeklyKpiTracker()` in `backend/src/shared/roles.ts` are
the source of truth, mirrored in `frontend/src/types.ts`.

`GET /api/weekly-kpi/:id` returns **404, not 403**, to a clinician asking for someone else's
report — whether a given id exists is not information a third party needs.

### Note on `also_clinician`

`sam@physioward.com.au` is ADMIN. Migration 021 gave it `also_clinician` so it shows in clinician
pickers. That flag deliberately does **not** grant submit rights here — the spec puts Sam on the
viewing side by name.

Separately, the dev DB also holds `samuelward@physioward.com.au` as a **real CLINICIAN account**
(id 32, brookvale). That account **will** get the form and **will** appear in "Not submitted",
because it is a clinician account like any other. If that is not wanted, the fix is one line in
`canSubmitWeeklyKpi` or `show_in_picker` — **ask Sam first**, don't guess.

---

## 6. The tracker (spec section 8)

Spec section 8 raises a column trade-off and picks a side:

> "Recommend a main table view with the fields that matter for a quick scan (Name, Clinic, Week,
> Intention, Effectiveness, Mojo, Goal hit, Check-in needed), with the rest — KPI detail, wins,
> reflections, the case to discuss — available by clicking into that person's row. Too much on
> the surface means Sam scans nothing properly."

Built exactly that. Plus:

- Week navigator (prev / next / any date / "This week"). Any date snaps to its Monday.
- Group by clinic — the spec offers "Clinic or Name"; clinic wins because the pilot is
  per-clinic and a mixed list invites comparing clinics that don't compare.
- Filters: **Check-in requested** (the spec's "optional second view") and **Friday still open**.
- Summary cards: submitted, loop closed, team average Effectiveness, team average Mojo.
- Mojo at **1–2** renders red everywhere — that is the rubric's *"talk to me now"* band, and
  Sam should not have to spot a small number in a column of numbers.

### One addition the spec does not have: who has NOT submitted

A SharePoint list can only show rows that **exist**. A physio who skipped the week is invisible
in it — and that is exactly the person Sam most needs to see. So the tracker ends with a
"Not submitted for this week" block.

It counts **active CLINICIAN accounts with `show_in_picker = true`**. `show_in_picker = false`
(migration 018) marks ex-physios like Jesse and Tim whose accounts stay active so their
historical data keeps counting; listing them as "did not submit" every week forever would be
permanent noise.

---

## 7. Where the history lives

Sam: *"ma save sa kanya kanya profile nila … para may history"* — so, two places, one component:

- **The physio**, under their own form: "My previous weeks", newest first, click a week for the
  full report.
- **Sam**, on a new **"Weekly KPI Reports"** tab on each clinician's Profile page — alongside the
  existing Patient Dropouts and Case Acceptance tabs — and by drilling into a tracker row.

Both mount `WeeklyKpiHistory`; only the endpoint differs. Read-only on the admin side: the super
admin views this data and never writes it, so there is no edit or delete affordance there.

---

## 8. Files

**Backend**
```
src/db/migrations/032_weekly_kpi_reports.sql
src/features/weekly-kpi/weekly-kpi.week.ts          ISO-week keying (and why not week.calculator)
src/features/weekly-kpi/weekly-kpi.repository.ts    SQL + DTO
src/features/weekly-kpi/weekly-kpi.validators.ts    zod; conditional-field rules
src/features/weekly-kpi/weekly-kpi.service.ts       access model, upsert rules, tracker assembly
src/features/weekly-kpi/weekly-kpi.routes.ts        /api/weekly-kpi
src/shared/roles.ts                                 + canSubmitWeeklyKpi / canViewWeeklyKpiTracker
src/index.ts                                        + mount
```

**Frontend**
```
src/api/weeklyKpi.api.ts
src/components/WeeklyKpi/weeklyKpi.ui.tsx           shared primitives + read-only detail + rubrics
src/components/WeeklyKpi/WeeklyKpiPage.tsx          the physio's form
src/components/WeeklyKpi/WeeklyKpiHistory.tsx       history list (mounted twice)
src/components/Admin/WeeklyKpiTrackerPage.tsx       the shared tracker
src/types.ts                                        + DTO, rubric copy, access mirrors
src/store/nav.store.ts                              + /weekly-kpi, /admin/weekly-kpi
src/App.tsx                                         + routing for CLINICIAN and ADMIN
src/components/Clinician/ClinicianHomePage.tsx      + two hub cards
src/components/Admin/ClinicianProfilePage.tsx       + "Weekly KPI Reports" tab
```

### Endpoints

| Method | Path | Who |
|---|---|---|
| GET | `/api/weekly-kpi/me?week=` | CLINICIAN — own current (or past) week |
| GET | `/api/weekly-kpi/me/history` | CLINICIAN — own history |
| POST | `/api/weekly-kpi/monday` | CLINICIAN — save/correct this week's Monday half |
| POST | `/api/weekly-kpi/friday` | CLINICIAN — close this week's loop |
| GET | `/api/weekly-kpi/tracker?week=&clinic_id=&checkin_only=&open_only=` | ADMIN |
| GET | `/api/weekly-kpi/clinician/:id/history` | ADMIN |
| GET | `/api/weekly-kpi/:id` | owner **or** ADMIN (404 to anyone else) |

Both writes are audited (`weekly_kpi.monday`, `weekly_kpi.friday`).

### Navigation

- **Clinician** hub (`/clinician-home`) → **"Team Performance KPI Reporting"**, first card.
- **Super admin** hub (`/admin-home`) → **"Team Performance KPI"** → the tracker.

Neither goes in the topbar nav, matching the 2026-08-16 decision that Clinical Impact and Ad
Spend live as hub cards and are not duplicated in a dropdown.

---

## 9. Isolation

Migration 032 **only** creates one table and its indexes. It alters nothing: not `users`, not
`patient_dropouts`, not `case_acceptances`, not `ad_spend`, not `ad_leads`. No new role. No
change to any existing endpoint's behaviour. It cannot affect existing data.

---

## 10. What was verified locally (2026-08-22)

Ran against the local `nookal` dev DB, as a real clinician account (Caitlin, Newport). **Every
test row was deleted afterwards** — `weekly_kpi_reports` is back to 0 rows and the test
`audit_log` entries were removed.

- `tsc --noEmit` clean on backend and frontend; `vite build` clean.
- Migration applies cleanly.
- **Week maths** — Monday→itself, Wednesday→back, Sunday→the ending week, next Monday→its own week.
- **Validators** — empty KPI #1 rejected; whitespace-only intention rejected; ratings 0 and 11
  rejected; check-in focus without a check-in rejected; reflection with "goal achieved = Yes"
  rejected; blank optional text normalised to `null`.
- **Monday upsert** — re-submitting the same week updates the same row id, still exactly one row
  for the week.
- **Friday** — writes onto the same row; leaves the Monday half untouched; drops the reflection
  when the goal was hit; refused outright when there is no Monday half.
- **Access** — ADMIN submit 403 at both the route and the service; CLINICIAN tracker 403; front
  desk 403 on both sides; unauthenticated 401; another clinician gets 404 on `/:id`; owner and
  admin both get 200.
- **Tracker** — correct rows, counts, averages, week picker; check-in / open / clinic filters all
  narrow correctly; the author is absent from "missing" and other clinicians are present.
- **DB constraints** — non-Monday `week_start`, rating 11, unknown clinic, blank intention,
  Friday answer with no timestamp, and duplicate person+week are each refused by name.

---

## 11. Deliberately not built

- **Teams / Power Automate / SharePoint** (spec sections 3, 4) — Sam's call: dashboard first.
  Note the Teams notifier in this repo is also currently disabled on prod (2026-08-06).
- **Monday and Friday reminders.** Nothing pushes the card at the physio — they open the hub card
  themselves. The "Not submitted" list is the stand-in. A weekly reminder is the obvious next
  step whenever Teams or email is back on.
- **Brookvale-first pilot** (spec section 9: *"Pilot with Brookvale first — Emma and Jervis on
  board — for two weeks"*). The feature is open to all three clinics as built. Scoping it to
  Brookvale for the pilot is one gate in `canSubmitWeeklyKpi` plus a clinic check — say the word.
- **Retiring the Tuesday SnapForms KPI form** (spec section 9). Sam's call, once the new cycle is
  confirmed working.
- **Numeric KPI targets.** `kpi*_target` / `kpi*_result` are TEXT, because the source carries
  "85%", "4 per week" and "$2,400" in the same column and the spec calls all three short answers.
  Anything needing arithmetic belongs in `practitioner_week_inputs`, which is already numeric.

---

## 12. UI revision (same day) — SUPERSEDED by section 14

First cut shipped as flat white cards with flat `8/10` score pills. Sam's verdict:
*"ayusin mo naman ui neto, minamalsit, white flat lang design."* Fair — it was styled like a form,
not like the rest of the dashboard.

The fix was to stop inventing a look and adopt the one `CEOAnalyticsPage` already uses: the soft
`#eef0f3` hairline, `linear-gradient(180deg, #fff, #fbfcfd)` panel fills, the teal gradient bar as
a section marker, corner radial glows, and `DM Mono` for figures. Those now live in
`weeklyKpi.ui.tsx` as shared primitives (`Panel`, `PanelHeader`, `PillGroup`/`PillBtn`, `Avatar`,
`ProgressRing`, `EmptyState`, `BAND_COLORS`), so the form, the history list and the tracker are one
design rather than three.

Three changes did most of the work:

1. **A dark hero band** on both the tracker and the form. The page previously started on a white
   card against a white-grey body and had no top edge. The tracker's hero carries the week, the
   navigator and a roster-completion ring; the form's carries the physio's avatar, name and clinic
   — which is also the honest place for the spec's Name and Clinic fields, since they are identity
   here, not inputs. `AppShell` is now mounted `withHeader={false}` on both, because its plain `h1`
   was printing the page title directly above a hero that already said it.

2. **`RatingMeter` replaced the score pill.** A column of two-digit numbers all looks the same, so
   finding the one that mattered meant reading every cell. Ten filled segments give each row a
   shape you can scan down, and the band name underneath ("Mostly on track", "Running empty")
   carries the rubric's meaning instead of asking Sam to remember which band a 6 is. This needed
   `min`/`max`/`short` on `RubricBand` in `types.ts` plus `rubricBandFor()`. A mojo in the
   1–2 "talk to me now" band goes red and gets a ⚠ wherever it appears.

3. **Colour is reserved for what needs acting on.** A row gets a left stripe only for a critical
   mojo (red) or a requested check-in (amber). Everything else stays quiet, which is what makes the
   two exceptions visible at all.

Smaller ones: avatars use first-initial-of-each-word (`Emma Sloot` → `ES`; the old two-character
slice gave `EM`, which collides constantly on this roster); the four summary cards pin their
captions with `marginTop: auto` and the two counting cards carry a thin fill bar, so all four read
as one row; the rubric on the form highlights the band the current answer falls in and the picked
number takes that band's colour; the drill-in detail caps its reading column at 860px and puts the
answers Sam acts on (intention, help needed, check-in focus, flagged-to-Sam) in tinted wells;
empty and loading states are illustrated rather than a grey line of text.

`ScorePill` and the detail's `showWho` prop were deleted in the same pass — both had no callers
left once the meter landed, and a second unused rendering of the same score is how the two drift
apart later.

Verified in a real browser at 1440px against seven seeded rows spanning every score band, both
row-stripe cases, and closed/open Friday halves. **All seeded rows were deleted afterwards** —
`weekly_kpi_reports` is back to 0.

## 13. Deploying

Nothing special. `runMigrations()` runs on boot, so a normal backend deploy applies 032. No seed,
no backfill, no env var, no cron. Frontend is a normal Vercel deploy.

Ordering note: deploy the **backend first**. A frontend that has the hub card but no
`/api/weekly-kpi` behind it shows a physio an error on their first click.

## 14. Flat white redesign (2026-08-24)

Section 12 is history now. Sam looked at both pages again and asked for the opposite of what that
revision delivered: *"minimalist lang ung design ng KPI, panget ng gradient, white minimalist lang,
flat design lang, tulad sa Apple."*

So the CEOAnalyticsPage idiom was pulled back out of this feature. What replaced it:

| Was (section 12)                                  | Now                                                        |
|---------------------------------------------------|------------------------------------------------------------|
| Dark navy→teal gradient hero band on both pages    | `PageHeader` — 28px title on white, one hairline under it   |
| `linear-gradient(180deg,#fff,#fbfcfd)` panel fills | Flat `#fff` with a single `#e6e6ea` hairline, no shadow     |
| Teal gradient bar as the section marker            | Nothing — weight and size carry the hierarchy               |
| Gradient rating buttons with a coloured glow       | Flat band-coloured fill, flat grey hover                    |
| Ten-segment gradient meter                         | Number + a 3px proportional bar in the band's flat colour   |
| Four gradient stat cards with corner glows + icons | One bordered strip, four figures, hairline dividers         |
| Amber gradient "not submitted" panel               | A normal panel; the only amber left is a 7px dot            |
| Gradient avatars with a drop shadow                | Flat grey circles (amber only for the not-submitted list)   |
| Tinted wells around every read-back answer         | Label + answer, hairline between rows                       |

Neutrals are the Apple system greys (`#1d1d1f` / `#515154` / `#86868b` / `#f5f5f7` / `#e6e6ea`);
the accent stays PhysioWard teal `#0f6e56` and is now spent only on selection and on the two things
the spec says to act on — a critical mojo and a requested check-in. `BAND_COLORS` dropped its
`from`/`to`/`line`/`glow` keys and is one flat `fg` plus a `tint` used behind small text only.

Both pages also stopped rendering on the shell's grey `#f0f2f5`: they set `pageSurface`, a
full-bleed white surface, because a white page was the actual brief.

Architecture did not move — everything still lives in `weeklyKpi.ui.tsx` and the two pages consume
it. The kit gained `PageHeader`, `Loading`, `Note`, `SectionLabel`, `captionStyle` and `pageSurface`
(the two pages had each been hand-rolling their own hero, spinner and status note), and lost
`CARD_SHADOW` / `PANEL_SHADOW` / `HOVER_SHADOW` / `NAVY` / `TEAL_LIGHT` / `TRACK`-as-segment-fill,
which had no meaning left once the shadows and gradients went.

`npx tsc --noEmit` and `npx vite build` are clean. No API, payload, validation, permission or
wording change — this pass is presentation only.

## 15. Comment threads + the physio's own profile (2026-08-24)

Sam, same day as the flat-white redesign:

> *"si super admin mas maganda ba kapag nag submit sila puwede rin mag comment si super admin
> regarding sa submitted weekly-kpi tapos ma notify si clinician na nag comment at dapat meron
> profile view din si clinician makita niya data tulad ng /admin/clinician-profile"*

Three decisions were his, taken before any code:

| Question | Answer |
|---|---|
| One-way or two-way? | **Two-way** — the physio can reply. A comment asking "why?" with no reply box just moves the conversation into Teams, which is what this feature exists to stop. |
| How is the physio notified? | **In-app only** — polled count → badge + banner. Teams is disabled on prod (2026-08-06) and there is no email sender; re-opening either was explicitly rejected as out of scope. |
| What is on the physio's profile? | **Weekly KPI + own dropouts + own case acceptance**, read-only. Not Clinical Impact — that is CEO-level and a separate decision. |

### The thread

Migration **033_weekly_kpi_comments** adds `weekly_kpi_comments` and `weekly_kpi_comment_reads`.
Nothing existing is altered. A thread has exactly **two** parties — the physio who owns the report,
and the super admin — and anyone else gets a **404** (not a 403) on every endpoint, same reasoning
as `getOne`. Deliberately not visible to the rest of the team: this is coaching, and a note other
physios can read is a public mark on someone's week.

Rules, all enforced in `weekly-kpi.service.ts`:

* both sides may post; **only the author** may edit or delete their own message (404 otherwise);
* no approval queue — a comment is a message with one author, not a shared operational record;
* hard delete, no tombstone; the audit log carries `weekly_kpi.comment.create/update/delete`;
* `edited` is `updated_at > created_at`, strictly — both default to `NOW()` in the same INSERT, so
  an unedited row has them exactly equal.

Endpoints (all under `/api/weekly-kpi`, all before the `/:id` catch-all):

```
GET    /:id/comments            the thread, oldest first
POST   /:id/comments            post (either side)
POST   /:id/comments/read       "this is on screen" — clears the caller's unread
PATCH  /comments/:commentId     edit your own
DELETE /comments/:commentId     delete your own
GET    /me/unread               the notification: { total, threads[] }
```

`comment_count` / `unread_count` ride along on every `WeeklyKpiDTO` the API returns, computed
**per viewer** in one extra grouped query per list (`withCommentCounts`) — never one query per row.
Unread means *written by the other party, after the last time you opened the thread*; a thread you
have never opened counts as fully unread, which is what makes the badge appear the first time Sam
writes.

### The notification

No push channel exists in this app, so the notification is the pattern that already works here: a
zustand store polling every 60 s and on window focus (`weeklyKpiUnread.store.ts`, modelled on
`pendingApprovals.store.ts`), driving

* a red count badge on the hub card — "Team Performance KPI Reporting" for the physio, "Team
  Performance KPI" for Sam;
* a banner at the top of `/weekly-kpi` and of `/my-profile`;
* a `N new comments` pill on the week's row in the history list, and a comment marker on the
  tracker row.

Both sides poll the same endpoint. A physio is told when Sam comments; Sam is told when someone
replies **on a thread he is already in** — not on every report in the system, which would make his
badge a count of the team talking to itself.

An open thread also self-refreshes off that poll, so a reply that lands while the other person has
the row expanded appears without a reload.

### `/my-profile`

CLINICIAN only, three tabs: weekly KPI history (with the threads), patient dropouts, case
acceptance. **No backend change was needed** — `applyScope` in both the dropout and
case-acceptance repositories has always pinned a CLINICIAN caller to rows where they are the named
clinician.

**It is not a new page.** The first cut was, and Sam rejected it on sight: *"baket ka pa gumawa ng
sarili ui profile ng clinician, diba meron na 'un ui pagination format dito"*, pointing at
`/admin/clinician-profile`. Correct — two pages rendering the same three tabs of the same data is
two of every table, filter and pagination control to keep in step, and the second copy is the one
that gets forgotten.

So `ClinicianProfilePage` now takes a `selfMode` flag and serves both routes. `MyProfilePage` is a
three-line wrapper around it. What the flag changes, and nothing else:

| | admin | selfMode |
|---|---|---|
| Whose profile | `?clinician_id=` query param | **the session** — a clinician_id in the URL is not read at all |
| Account controls | Edit profile · Reset password · Deactivate | none — an account does not administer itself |
| Per-row Delete | yes | **column removed** — the server needs ADMIN or an approved delete request, so the button could only ever error |
| Weekly KPI tab | `/clinician/:id/history` | `/me/history` (the other endpoint is ADMIN-only) |
| Opening tab | Dropouts | Weekly KPI — that is where Sam's comments are |
| Unread banner | — | "N new comments from Sam" |

### Verified locally (2026-08-24)

A throwaway service-level smoke test (written, run, deleted) covered, all passing: counts on
`myWeek` / tracker rows, unread appearing for the physio and not for the author, listing NOT
clearing the badge while `markThreadRead` does, the reply notifying Sam, a third clinician getting
404 on read/post/mark, cross-author edit and delete both refused, the `edited` flag, and the
empty-body CHECK constraint. Everything it created was deleted — `weekly_kpi_reports`,
`weekly_kpi_comments` and `weekly_kpi_comment_reads` are all back to 0 rows locally.
`npx tsc --noEmit` clean on both sides; `npx vite build` clean.

Deploy order is unchanged and still matters: **backend first** (migration 033 runs on boot), then
the frontend.

## 16. Super admin can delete a report (2026-08-24)

> *"puwede rin mag delete si super admin Team performance KPI"*

This reverses "No delete — history ito" (section 3) for ONE role. Sam's two calls:

* **What:** a whole weekly report — not individual comments. Comment delete stays author-only, so
  he still cannot remove a physio's reply and a physio still cannot remove his note.
* **How:** **permanent**, matching every other delete in this app (dropouts, case acceptance, ad
  leads). A recoverable soft delete was offered and turned down; nothing in this codebase has a
  `deleted_at` column, and adding the first one means every future query has to remember to filter.

No new migration. `DELETE /api/weekly-kpi/:id`, `requireRole('ADMIN')` on the route AND
`canDeleteWeeklyKpiReport` in the service, so the two layers fail closed independently.

What goes with the row: **the whole comment thread and both sides' read stamps**, via the
ON DELETE CASCADE already declared in migration 033. That was designed in for exactly this — a
thread about a week that no longer exists is not something anyone can act on.

What survives: the **audit entry**. `weekly_kpi.delete` is written after the delete and carries the
report id, the clinician id AND name, the week, whether the Friday half had been submitted, and how
many comments were on it. The row is gone, so anything worth knowing has to be in that payload —
which is why the service counts the thread *before* deleting.

Who cannot delete: everyone else, including the physio who wrote it. The current week is corrected
by re-submitting it (the Monday upsert) and past weeks stay frozen — "I typed it wrong" never needs
a delete. There is no delete-request queue either, unlike dropouts and case acceptance: there, the
asker and the approver are different people; here they would both be Sam.

In the UI (`DeleteReportButton`), one component used in both places a report can be opened — the
tracker's expanded row and a week opened in the history list. It renders nothing for a non-admin,
sits **inside the open row only** (never on a collapsed list), stays grey until hovered, and its
confirmation names the physio, the week, and the number of comments about to go with it.

Verified locally 2026-08-24 with a throwaway service-level test (written, run, deleted), all
passing: both physio roles refused with the row surviving, the admin delete returning the row for
the audit with the right comment count, the report/thread/read-stamps all gone, a second delete
404ing, and no phantom unread badge left behind. Local tables are back to 0 rows.

## 17. The tracker's report opens in a drawer (2026-08-24)

> *"imbis na pababa ung info … sidebar dapat pero ma ayos format"*

The tracker row was an accordion: clicking a physio expanded the whole report — KPI table, two
meters, six free-text answers, the Friday half, the comment thread — *inside* the table, pushing
everyone below it off the screen. On a page whose entire job is comparing people within one week,
reading one person cost you the row you were comparing them against.

Now the row opens `WeeklyKpiDrawer`: a 560px right-hand panel over a light scrim. The table never
moves, the open row keeps an accent marker on its left edge so it is obvious which of twelve rows
the panel belongs to, and clicking the next physio swaps the panel's contents instead of collapsing
one accordion and opening another. Esc or the scrim closes it; the close button takes focus on
open; the page behind is scroll-locked while it is up.

The "ma ayos format" half:

* the panel **header** carries identity and the three things worth seeing before any prose —
  effectiveness, mojo, and the check-in / Friday status chips — and stays put while the body
  scrolls;
* `WeeklyKpiDetail` gained a `compact` flag that drops the meters and the check-in block, because
  the header above now carries them. Printing the same two scores twice, forty pixels apart, was
  the actual formatting complaint;
* the **footer** is pinned: "Full history →" and (super admin) "Delete this week" no longer sit at
  the bottom of a comment thread that grows every week.

Scope, after Sam extended it the same day (*"pati dito ganon din dapat … pag click dun side din
lalabas"*, on `/admin/clinician-profile`): the **Weekly KPI Reports tab of the profile page** opens
its weeks in the same drawer. `WeeklyKpiHistory` takes a `drawer` flag for it — on for the profile
page (both the admin's view and the physio's `/my-profile`), off everywhere else.

Off means the physio's own form page (`/weekly-kpi`) still expands its "Previous weeks" in place.
That page is a form with its history underneath rather than a list you scan, so nothing there needs
to hold still while a week is open. One flag if that should change too.

On the profile page the drawer hides its "Full history →" button — that is the page you are already
on.

## 18. Confirm before submitting (2026-08-24)

> *"tska dun Submit Monday basta lagi meron validation are you sure submit para ganon lagi"*

Both halves now ask before they save. Applied to Friday as well as Monday on the strength of
"lagi" — from the physio's side the two are the same act, and a confirmation on one but not the
other is the kind of inconsistency that makes people stop reading dialogs.

Two things about where and what:

* it fires **after** the existing field checks, never before. Asking someone to confirm a
  submission the form is about to reject anyway is how a confirm step gets trained out of people;
* it **restates the answers Sam acts on** — effectiveness, mojo and the check-in answer on Monday;
  goal achieved on Friday — rather than saying "are you sure?". A bare confirmation is a speed bump
  people learn to click through; one that shows the numbers is a last chance to catch a mis-tap on
  the 1–10 scale, which is the actual risk here.

Re-submitting says so explicitly ("This replaces what you submitted on …"), and the buttons are
labelled with the action (`Submit Monday` / `Update Friday` / `Keep editing`), never OK/Cancel.
