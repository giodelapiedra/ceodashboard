# Occupancy from Nookal — Practitioner Stats

**Date:** 2026-08-20
**Scope:** `/admin/practitioner-stats` → Occupancy column, per clinician per week
**Status:** built and tested end to end locally.

> ### Correction, later the same day: the API CAN reproduce the report
>
> Everything below marked "cannot be done from the API" was checked against
> Nookal **v3** (GraphQL) only. Both missing pieces are in **v2** (REST), and the
> `NOOKAL_API_KEY` this document calls dead is alive — `env.ts` was right that v2
> is still in use.
>
> | What v3 lacked | Where it actually is |
> |---|---|
> | the roster — "Scheduled Minutes" | v2 `getSchedules`, a 15-minute grid per practitioner, per location, per day |
> | event types, all `typeID: null` in v3 | v2 `getEvents`, carrying `EventID`, `CategoryName`, `EventTitle` |
>
> So Occupancy now syncs automatically. See
> [Occupancy from the v2 API](#occupancy-from-the-v2-api-the-automatic-path) —
> that is the live path; the sections before it are the reasoning that led there
> and are kept because the *freshness* limit they describe is real and still
> governs when the sync may run.

---

## What changed

Occupancy now arrives as the **exact figure from Nookal's own Occupancy report**,
loaded from the report's Export button. Migration 024 recorded it as having "no
API path" — that is still true of the number Nookal actually reports, and this
document is largely the evidence for why.

**Sync does NOT fill Occupancy.** It cannot: Nookal divides by rostered hours,
which the API does not expose. An earlier build of this work derived a substitute
from the diary; Sam's call on 2026-08-20 was to stop showing it, because measured
against his report it ran up to 23 points high and put 5 of 11 practitioners in
the wrong zone — always the flattering way:

| | Nookal | derived | gap | zone |
|---|---|---|---|---|
| Isabella | 56.96% | 80.00% | **+23.0** | reset → **thriving** |
| Ben | 72.46% | 86.21% | +13.8 | refining → thriving |
| Angus | 68.06% | 80.00% | +11.9 | reset → **thriving** |
| Noah | 73.13% | 81.67% | +8.5 | refining → thriving |
| Caitlin | 77.78% | 81.36% | +3.6 | refining → thriving |
| Emma | 61.19% | 55.22% | −6.0 | reset (same) |
| Jervis | 90.00% | 90.74% | +0.7 | thriving (same) |

So a week with no import shows **blank**, not an estimate. The derivation is kept
as a diagnostic behind `npm run verify:occupancy` and described below, because it
is the thing a v2 API key would replace.

## The diary-derived figure (diagnostic only, not shown on the board)

Nookal v3 GraphQL has no `occupancy` query. It does have `availabilities`, which
returns the **free bookable slots left in a practitioner's diary**:

```graphql
availabilities(dateFrom: "2026-08-10", dateTo: "2026-08-16",
               locationID: [1,2,6], staffID: [117], slotDuration: 15) {
  range { slots { startTime date location_id ProviderID } }
}
```

Probed live for Angus Clark, week of 10 Aug 2026:

| slotDuration | slots returned on 2026-08-10 | implied free time |
|---|---|---|
| 15 | 14:30 14:45 15:00 15:15 15:30 15:45 | 90 min |
| 30 | 14:30 15:00 15:30 | 90 min |
| 60 | 14:30 | 60 min — trailing half hour lost |

He was booked until 14:00 and again from 16:00, so the slots tile his free gap
exactly, at whatever granularity is asked for, without overlapping. Therefore:

```
free minutes = slot count × slotDuration
```

The sync asks for **15**. Every appointment length in the practice is a multiple
of 15 (measured over two sample weeks: 15, 30, 45, 60, 75, 90), so 15 loses
nothing while 60 silently truncates.

Combining that with the start/end times on the appointments the sync already
fetches:

```
occupancy = booked ÷ (booked + still-bookable)
```

### What counts as what

| Nookal record | Counts as | Why |
|---|---|---|
| `Consultation` — Completed, StdAppt, Waiting | **booked** | patient time held |
| `Consultation` — DNA | **booked** | the slot was held and could not be resold |
| `Consultation` — Cancelled | ignored | the slot went back on the market, and Nookal hands that same window back as free — counting it as booked would double-count it |
| `Class` | **booked** | one window, however many participants |
| `DiaryEvent` | **blocked** | breaks, meetings, admin — recorded, but outside the denominator |
| `DiaryNote` | ignored | an annotation pinned to a time; several sit on top of live appointments |

Minutes are measured as a **union over a 5-minute grid**, not as a sum of
durations. Double-booked consultations, all-day blockouts laid over normal days,
and one practitioner split across two clinics on one date all occur in this
data; summing durations would count that time twice and push occupancy over
100%. Locations are unioned for the same reason — the practitioner is one person.

### Blocked time is excluded, on purpose

A break or a meeting is time the diary was **closed to patients**, not time the
practitioner failed to fill. So it is not in the denominator.

That is a judgement, and it is a large one — blocked time runs 3–15h per
practitioner-week. Which is exactly why `occupancy_blocked_minutes` is stored
alongside the percentage: **the rule can be changed by recomputing from the
stored columns, with no re-sync.** Counting blocked time against the
practitioner would drop the whole board by roughly 15–25 points.

## What the derived path stores (kept for reference)

Migration 029 adds to `practitioner_week_inputs`:

| Column | Meaning |
|---|---|
| `occupancy_booked_minutes` | consultation and class minutes held |
| `occupancy_available_minutes` | still-bookable minutes |
| `occupancy_blocked_minutes` | blockout minutes, excluded from the denominator |
| `occupancy_source` | `nookal` \| `manual` \| NULL (pre-029, all hand-entered) |
| `occupancy_synced_at` | separate from `synced_at`, which covers the appointment figures |

Three ownership rules, all tested:

1. **A figure you typed in is never overwritten by a sync.** Verified: a planted
   `manual` value and a planted pre-029-shaped value (a value with a NULL
   source) both survived two syncs.
2. **Re-saving a row without touching Occupancy does not steal it from the
   sync.** The edit form posts all three figures on every save, so marking every
   save `manual` would quietly freeze that week forever. Only a value that
   *differs* from what is stored counts as a person's own.
3. **Clearing Occupancy hands the week back to the sync**, which refills it on
   the next run.

A week Nookal cannot measure is left exactly as it was, never blanked.

### Why some weeks stay blank

`availabilities` answers from the roster **as it stands today**, not as it stood
in a past week. Free hours per week, measured 2026-08-20:

| Week | Free hours | Practitioners with any free time |
|---|---|---|
| 2026-08-17 | 157 | 12 |
| 2026-07-06 | 119 | 11 |
| 2026-04-06 | 93 | 10 |
| 2026-02-09 | 144 | 10 |
| **2026-01-12** | **49** | **5** |
| 2025-10-20 | 55 | 5 |
| 2025-02-10 | 46 | 3 |

There is a cliff between February 2026 and January 2026. Before roughly Feb
2026, the roster behind a week is no longer in Nookal.

So when a practitioner-week reports **zero free minutes**, "booked solid" and
"roster is gone" are indistinguishable — and the sync writes **nothing** rather
than a fake 100%. The Sync toast reports these as *"not measurable"*. Fill those
weeks by hand from Nookal → Reports → Occupancy.

Practically: **Feb 2026 onward syncs; earlier months stay hand-entered.**

## The Team row now pools

Migration 024 could only average per-practitioner percentages, because the hours
behind each one were never recorded. With the minutes stored, the Team row is a
real weighted rate:

```
SUM(booked) ÷ SUM(booked + available)
```

Week of 10 Aug 2026: 206.5h booked of 283.5h bookable = **72.84%**. Averaging
the ten percentages instead gives 74.3% — a practitioner with four rostered
hours had been counting as much as one with thirty-five.

A row mixing synced and hand-typed weeks falls back to the mean and says so, in
the cell's warning tooltip. It does not present a half-pooled figure as a clean
one.

## Checking a figure

Every synced cell carries its own working. Hovering it shows:

> From the Nookal diary: 22.0h booked of 27.5h bookable (5.5h still free, 9.8h
> blocked out and excluded) — Thriving

There is also a read-only script that prints the same working for a whole month
without touching the database:

```bash
npm run verify:occupancy 2026 8
```

## Nookal's own formula, confirmed

Sam's screenshot of `Reports → Occupancy` (03/08/2026-09/08/2026, All Locations,
All Providers) settled it:

```
Occupancy = Occupied minutes ÷ Scheduled Minutes
```

Checked against every row on that report:

| Provider | Scheduled | Occupied | Nookal | check |
|---|---|---|---|---|
| Gabriella Whittaker | 1380 | 1410 | 102.17% | 1410/1380 ✓ |
| Jervis Goodsell | 2100 | 1890 | 90% | ✓ |
| Caitlin Read | 1890 | 1470 | 77.78% | ✓ |
| Noah Djordjevic | 2010 | 1470 | 73.13% | ✓ |
| Ben Bryden | 2070 | 1500 | 72.46% | ✓ |
| Angus Clark | 2160 | 1470 | 68.06% | ✓ |
| Emma Sloot | 2010 | 1230 | 61.19% | ✓ |
| Isabella Wallace | 2370 | 1350 | 56.96% | ✓ |
| Kyle Walsh | 2100 | 990 | 47.14% | ✓ |
| Zac Fielding | 1890 | 870 | 46.03% | ✓ |
| Samuel Ward | 0 | 180 | 100% | division by zero |

Report filters in use: Locations *All Locations*, Providers *All Providers*,
*Include Services*, *Include Classes*, **not** *Include Notes*, *Exclude DNAs*,
and **Events: 4 of 11 Events Selected**.

### Why the API cannot reproduce it

**"Scheduled Minutes" is rostered shift time, and it is not in the v3 API.** The
entire schema was walked on 2026-08-20 — 60 types, and not one carries a shift,
roster, scheduled-minute or working-hour field. `availabilities` is the only
availability surface and it returns free slots, not rostered time.

Nor can it be reconstructed. Adding blocked time back in (`booked + free +
blocked`) lands 60-480 minutes per practitioner away from the report:

| | Angus | Ben | Noah | Isabella | Jervis | Gabriella |
|---|---|---|---|---|---|---|
| booked+free+blocked | 2310 | 2010 | 2130 | 2550 | 2235 | 1860 |
| Nookal Scheduled | 2160 | 2070 | 2010 | 2370 | 2100 | 1380 |
| error | +150 | −60 | +120 | +180 | +135 | +480 |

Two reasons it will not converge: blockouts spill outside roster hours, and the
**Events: 4 of 11** filter means Nookal counts *some* event types as occupied.
The residual per practitioner is exactly event-shaped — Ben 0, Kyle 0, most +30,
Angus +60, Emma +150, Jervis +420 — but v3 reports **every** DiaryEvent with
`typeID: null`, `typeName: null`, `notes: ""` (all 154 in that week), so there is
no field on which to reproduce that filter.

The `Occupied` column, by contrast, we *can* compute: completed consultations
plus classes matched the report **exactly** for Ben (1500) and Kyle (990), and
came within 30 minutes for six more.

## Three ways to get the number

### 1. Sync Occupancy button — browser automation (NEW)

Click the **Sync Occupancy** button (purple) on `/admin/practitioner-stats` to
scrape the Occupancy report directly from Nookal's web interface using browser
automation (Puppeteer).

Requires environment variables in `.env`:
```
NOOKAL_WEB_EMAIL=your-nookal-login@email.com
NOOKAL_WEB_PASSWORD=your-nookal-password
```

This automates:
1. Log into Nookal web app
2. Navigate to Reports → Occupancy
3. Set filters (date range, All Locations, All Providers)
4. Scrape the report table
5. Import figures into the database

Takes 1-2 minutes for a full month. Writes with `occupancy_source = 'nookal_report'`,
same precedence as the CSV import — outranks API-derived but loses to manual entry.

### 2. Import the exact report — CSV/XLSX export

Nookal → Reports → Occupancy, set the date range to one week, Locations = *All
Locations*, then **Export**.

```bash
npm run db:import:occupancy -- --file "path/occupancy.csv" --year 2026 --month 8 --week 1
```

Reads CSV or XLSX, finds the header row wherever it sits, matches each Provider
through Nookal's `staffID` to `users.nookal_staff_id`, and writes
`occupancy_source = 'nookal_report'` with both minute columns. Tested against the
figures above: all 11 practitioners imported at exactly the percentage Nookal
prints, and the Team row pools to 69.22% (230.5h occupied of 333.0h rostered).
`--dry-run` prints without writing.

A practitioner with nothing rostered and nothing booked is skipped rather than
written as 0% — they did not work that week.

### 3. A live v2 REST API key — makes it automatic

Nookal v2 has `getSchedules`, and it names its own parameters when they are
missing:

```
GET /getSchedules?api_key=…            → "Missing variable: practitioner_id"
        + practitioner_id=117          → "Missing variable: location_id"
        + location_id=6                → "Missing variable: date_from"
        + date_from=…&date_to=…        → L004
```

The last call fails because **the `NOOKAL_API_KEY` in `.env` is dead** — same
`L003`/`L004` refusal as a deliberately garbage key, across `getSchedules`,
`getPractitioners`, `getLocations` and `getAppointments`. The v3 GraphQL
credentials are fine; only the v2 key is expired or revoked. A fresh one from
Nookal → Setup → Integrations → API turns the roster into an API call, and then
Sync reproduces the report with no export step.

## Precedence

Highest wins, and nothing below ever overwrites something above it:

1. `manual` — a person typed it
2. `nookal_report` — the exact figure off the Occupancy report
3. `nookal` — derived from the diary by Sync

Verified: after importing week 1 and then pressing Sync for the whole month, all
11 report figures were untouched.

## Side note found on the way

Three Nookal providers have no PhysioWard account, so they contribute nothing to
any figure on this board: **Finn Van Lathum** (staffID 170), Jarryd Edgar (105),
and "Sam Reformer Bed" (114, a resource rather than a person). Finn is rostered
— 480 scheduled minutes in the week of 3 Aug — so his row is genuinely missing
from Practitioner Stats, not empty. Worth an account if he should be tracked.

---

## Occupancy from the v2 API — the automatic path

Added 2026-08-20, after the sections above. Migration 031, and:

| File | What it does |
|---|---|
| `services/nookal-occupancy.service.ts` | measures one week from v2 |
| `features/practitioner-stats/practitioner-stats.occupancy-api.ts` | writes it under the precedence rule |
| `db/sync-occupancy-nookal.ts` | `npm run db:sync:occupancy` — the cron's entry point |

The Sync button calls the same code, so pressing Sync now fills Occupancy for
any week still fresh enough to measure.

### The two formulas

```
Scheduled Minutes = 15 x (grid slots != -1)  -  15 x (grid slots == 3)
Occupied          = union of non-cancelled appointments, classes,
                    and diary events of a counted type
Occupancy         = Occupied / Scheduled Minutes
```

`getSchedules` returns one value per 15 minutes, per practitioner, per location:

| Value | Meaning |
|---|---|
| `-1` | not rostered |
| `0` | rostered, still free |
| `1` | rostered, booked |
| `3` | rostered, break or blockout |

Read straight off Angus Clark, Narrabeen, 2026-08-04 — a 07:00–17:00 shift:

```
07:00=1 07:15=1 07:30=0 07:45=0 08:00=1 ... 11:00=3 ... 12:45=3 13:00=1 ...
```

Values come in identical pairs because the diary is booked in 30-minute blocks,
but the grid is 15-minute, so a slot is worth 15 minutes. Subtracting the `3`s is
not a guess: the report's own xlsx header names the column *"Scheduled Minutes
(Scheduled Time − Scheduled Breaks)"*.

Two things the endpoint does that will bite anyone who forgets them:

- **`date_to` is EXCLUSIVE here**, unlike `getAppointments` and `getEvents` where
  it is inclusive. `03→09` returns 03..08; `03→10` returns 03..09; `from == to`
  returns that one day. The service passes the day after the week.
- A practitioner's locations are **merged, not added** — two clinics can report
  the same 15 minutes. On disagreement the stronger claim wins (booked, then
  free, then break), because a slot free at one clinic is genuinely still
  bookable.

### Which events count as occupied

The report's `Events: 4 of 11 Events Selected` is a checkbox set no API exposes,
so it was solved for. This account uses seven event types — `1` General, `15`
Business, `18` 1-on-1, `21` CPD, `24` Event, `29` Team Meeting, `35` Team
Training — and every subset was scored against the eleven rows of the
03/08/2026 report. `{15, 18, 29}`, active events only, won: four practitioners
exact on appointments alone became eight.

Override with `NOOKAL_OCCUPIED_EVENT_IDS=15,18,29` in `.env`. **Reading the
report's own Events dropdown is the authority; this is a fit, not a fact.**

Two rules that fell out of matching the report, both worth keeping straight:

- **DNAs count as occupied.** The slot was held and could not be resold. Including
  them is what put Noah (1470), Gabriella (1410) and Emma (1230) exactly on their
  reported figures; excluding them missed all three.
- **Cancellations do not.** The slot went back on the market.

The report's *Services* count excludes DNAs while its *Occupied* column includes
their minutes — that is not a contradiction, it is two different questions.

### How accurate, measured against the 03/08/2026 report

Occupied, exact for five of eleven and within one 30-minute block for the rest:

| | Nookal | computed | |
|---|---|---|---|
| Samuel Ward | 180 | 180 | exact |
| Noah Djordjevic | 1470 | 1470 | exact |
| Gabriella Whittaker | 1410 | 1410 | exact |
| Ben Bryden | 1500 | 1500 | exact |
| Emma Sloot | 1230 | 1230 | exact |
| Jervis Goodsell | 1890 | 1860 | −30 |
| Angus Clark | 1470 | 1500 | +30 |
| Isabella Wallace | 1350 | 1320 | −30 |
| Caitlin Read | 1470 | 1440 | −30 |
| Zac Fielding | 870 | 840 | −30 |
| Kyle Walsh | 990 | 1020 | +30 |

180 minutes of error across roughly 14,000 — about 1%, or a percentage point of
occupancy. Nailing the last block needs the real Events selection.

Scheduled reproduced exactly for Gabriella (1380) and Finn Van Lathum (480) and
drifted for the others — but that week was already eleven days old when it was
measured, which is the next section and the reason the sync runs weekly.
Gabriella's whole row still comes back off the API as **1380 / 1410 = 102.17%**,
digit for digit what the report prints.

### The freshness limit, and the guard that enforces it

`getSchedules` answers from the roster **as it stands today**. A booking outside
today's roster comes back as `-1`, so an old week loses the rostered window *and*
the booking inside it. Grid booked minutes against the appointments actually in
the diary, measured 2026-08-20:

| Week measured | Agreement |
|---|---|
| 17–19 Aug (1–3 days old) | within 15–90 min per practitioner |
| 03–09 Aug (11 days old) | short by up to **840 min** (Ben Bryden) |

Two independent guards, both needed:

1. **`--max-age-days` (default 10).** A week older than this is skipped, not
   written low. Checked *before* fetching, since measuring a week costs about
   forty `getSchedules` calls.
2. **Roster coverage.** Even inside the window, a practitioner whose grid reports
   less than 90% of the booked minutes the appointment feed shows is skipped —
   the roster is missing shifts, and the percentage would read high. Ben
   Bryden's week of 10 Aug came out at **156%** without this. The tolerance is
   one-sided: the grid may legitimately read higher, because counted events sit
   in it too.

The first run over August 2026 wrote 8 practitioner-weeks and held back 3 on the
coverage guard, naming each one and its numbers.

### Precedence, now four deep

Highest wins; nothing below ever overwrites something above it.

1. `manual` — a person typed it
2. `nookal_report` — the exact figure off the report's Export button
3. `nookal_api` — measured from v2 while the week was fresh
4. `nookal` — the abandoned diary estimate; no longer written, and ignored on read

Verified: week 1 of August, already imported from Sam's report export, was
untouched by a full API sync of the month.

### Running it

```bash
npm run db:migrate
npm run db:sync:occupancy -- --year 2026 --month 8 --dry-run   # look first
npm run db:sync:occupancy -- --year 2026 --month 8
```

Weekly, on the box, Monday morning — the week just ended is then 1 day old:

```
15 6 * * 1 cd /var/www/physioward/backend && /usr/bin/npm run db:sync:occupancy -- --year $(date +\%Y) --month $(date +\%m) >> /var/log/physioward-occupancy.log 2>&1
```

A week that spans a month boundary is written under the month whose sheet owns
it, exactly as `getWeekRanges` decides for every other figure on the board.

### A bug fixed on the way

`addWeekInput` in `practitioner-stats.service.ts` claimed to ignore the abandoned
`nookal` estimate, and did not: the `return` sat *after* `occSum` and `occN` had
already been incremented. So those rows went on feeding the mean-of-percentages
fallback, and on any row with no minutes to pool they **were** the number shown —
the exact figure Sam ruled out on 2026-08-20 for reading up to 23 points high.
The test now runs before the counters.
