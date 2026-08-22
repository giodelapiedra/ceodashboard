# PhysioWard CEO Dashboard v2 — Features List

> Buong listahan ng features ng system. Clinics: **Newport, Narrabeen, Brookvale** (+ "Overall").
> Stack: Node/Express + TypeScript + PostgreSQL (backend) · React 18 + Vite + Zustand + Recharts (frontend) · Nookal API (v2 REST + v3 GraphQL/OAuth) · Google Ads, Facebook Ads, Google Sheets integrations.
>
> Last updated: 2026-06-16

---

## 1. Login & Security
- Login screen (email + password, PhysioWard branding)
- JWT auth — access token (15 min) + refresh token (7 days), auto-refresh sa background
- Refresh token rotation (luma na token, ininvalidate; tokens naka-sha256 hash sa DB)
- Login rate-limiting (10 attempts / 15 min)
- Change password (self) — kino-kansela lahat ng existing sessions
- Logout
- Security headers (Helmet), CORS, httpOnly refresh cookie

## 2. User Roles (5 roles)
| Role | Scope | Pwedeng gawin |
|------|-------|---------------|
| **ADMIN** (CEO) | Lahat ng clinic | Full access — lahat ng dashboard, reports, user management, audit log |
| **CLINICIAN** | Isang clinic (pero pwedeng mag-rotate) | Dropout + Case Acceptance entry |
| **FRONT_DESK** | Naka-pin sa isang clinic | Dropout + Case Acceptance entry |
| **FRONT_DESK_GLOBAL** | Lahat ng clinic | Dropout + Case Acceptance entry (pumili ng clinic kada entry) |
| **ADSPEND** | Global | Ad Spend entry lang (encoder role) |

## 3. CEO Dashboard (ADMIN)
- Clinic selector — Newport / Narrabeen / Brookvale / Overall
- Month + Year picker + presets (This Month, Last Month, 2/3 Months Ago)
- "Fetch Nookal" button — auto-pull ng 5 weeks + monthly actual mula sa Nookal
- Snapshot caching (Postgres, ~60 min/4 hr TTL) — di na uulit kumuha sa Nookal; may `?refresh=1` force option
- Print-optimized (A4 landscape, repeated header, page breaks)
- **Metrics displayed (weekly + monthly):**
  - **Finance:** Total Revenue, Product Sales Revenue, Upfront Revenue (account credits), Cash from Insurance (Health Fund / Medicare / DVA), Ageing Debts (hand-typed kada week column; ang Monthly Actual ay sum — tingnan ang §14)
  - **Marketing:** New Opt-ins, New Patients, Patient Reactivations, Ad Spend, Cost Per Patient
  - **Sales/Ops:** Total Patients, Appointments Attended, Show-Up Rate %, Cancelled (no rebook), Cancelled & Rebooked, Cancellation %, No Shows, Case Acceptance %, Upfront Plan Accepted, Products Upsold, Complementary Transitions, Active/Inactive Patients

## 4. CEO Analytics (ADMIN) — visual dashboard
- Hero KPI cards na may sparklines: Total Revenue, New Patients, Show-Up Rate, Case Acceptance
- Revenue Trend (area chart: Services / Products / Upfront / Insurance)
- Revenue Mix (donut chart)
- Patient Flow funnel (New → Reactivations → Total → Attended → No-shows)
- Performance Rates (line chart: Show-Up vs Cancellation vs Case Acceptance %)
- Operational Metrics grid (No-shows, Cancelled, Rebooked, Upfront Accepted, Products Upsold, Active Patients)
- Ad Spend bar chart (Facebook + Google by week)

## 5. Patient Dropouts
**Entry page** (ADMIN, CLINICIAN, FRONT_DESK, FRONT_DESK_GLOBAL)
- Form: Date, Clinic, Clinician, Front-desk staff, Patient name, Cancellation dates (array), Status, Reason, Notes
- Paginated table (search, edit, delete)
- Clinic picker depende sa role
- Auto-stamp ng entered_by + front-staff name

**Admin view (ADMIN)**
- Consolidated lahat ng clinic + per-clinic tabs
- Filters: Date range, Status, Reason, Search
- Summary counts (status/reason tallies)
- Export sa XLSX

**Dropout Analytics (ADMIN)**
- Total count, peak day, avg/day KPI cards
- Daily trend (area chart)
- Status breakdown (pie)
- Top 6 reasons (bar chart)
- Per-clinic split (Overall view)

## 6. Case Acceptance
**Entry page** (ADMIN, CLINICIAN, FRONT_DESK, FRONT_DESK_GLOBAL)
- Form: Date, Clinic, Clinician, Front-desk staff, Patient, Treatment plan provided (Y/N), Case recommendations, Appointments booked, Prepay offered/accepted, Transition notes, Notes
- Auto-calculate ng Case Acceptance % (booked ÷ recommendations)
- Date-range filter (persisted), clinician filter, search, pagination

**Admin view (ADMIN)**
- Consolidated + per-clinic tabs
- Summary: total recommendations, total booked, acceptance %, treatment-plan split, prepay offered/accepted, transitions
- Styled XLSX export (cyan title, header pills, Excel dropdowns, live acceptance % formula)

## 7. Ad Spend (ADSPEND + ADMIN)
- Weekly entry form — 5 channels: Facebook, Google, Instagram, TikTok, Other
- Auto-sync mula sa **Google Ads API** at **Facebook Ads API** (admin-only sync; date range)
- Weekly report — pivot ng spend by channel
- Summary (total spend over filtered range)
- Global pool (hindi naka-clinic scope)
- ADSPEND role lang makakapag-create; ADMIN nakaka-edit/correct

## 8. User Management (ADMIN)
- List users — filter by Clinic, Role, Active/Inactive
- Create user (email, password, full name, role, clinic)
- Edit user (name, role, clinic, active toggle)
- Reset password
- Deactivate / Reactivate (di pwede i-deactivate ang sarili)

## 9. Audit Log / Activity Log (ADMIN)
- Immutable trail ng lahat ng aksyon (create / update / delete / deactivate / password reset)
- Fields: timestamp, user, role, action, entity, details
- Filters: Date range, Action type, User ID search
- Color-coded action pills, paginated

## 10. Integrations
- **Nookal v2 (REST):** Invoices, Appointments, Patients, Inventory (paginated)
- **Nookal v3 (GraphQL + OAuth):** primary data source ng dashboard (revenue reports, etc.)
- **Google Ads API** — ad spend sync
- **Facebook Ads API** — ad spend sync
- **Google Sheets import** — dropouts + case acceptance (full-replace; refresh token may 7-day expiry sa testing mode)
- **PostgreSQL** — data persistence + snapshot cache

## 11. Shared / UX
- Reusable AppShell nav (role-based menu tree), collapsible groups
- Toast notifications (success / error / info)
- Confirm + prompt dialogs
- **Duplicate guard** (dropouts, case acceptance, ad leads) — tingnan ang §12
- Date-range picker, pagination, debounced search
- XLSX export (dropouts, case acceptance)
- Print support (CEO dashboard)
- Loading/error states, form validation
- Health check endpoint (`GET /api/health`)

## 12. Duplicate Guard (Dropouts · Case Acceptance · Ad Leads)
Nagbabala kapag mukhang nadoble ang entry — pero **hindi bumabara**. Laging kayang i-save ng encoder ang entry niya.

**Natural key** (pareho lahat = duplicate). Ang pangalan ay ni-no-normalize muna: lowercase, trim, at ini-isa ang sunod-sunod na space — kaya `"cedric  ADAMS "` = `"Cedric Adams"`.
| Form | Key |
|------|-----|
| Dropouts | clinic + clinician + patient + `date_logged` |
| Case Acceptance | clinic + clinician + patient + `date_logged` |
| Ad Leads | clinic + patient + **platform** + `date_added` (magkaibang platform sa parehong araw = dalawang tunay na lead) |

**Dalawang tier — pareho, babala lang**
- **Exact** — pareho ang natural key → lalabas ang **Duplicate dialog** na may field-by-field diff (existing vs. bagong tina-type), tapos 2 pagpipilian lang: **Save anyway** (nagda-dagdag ng pangalawang entry, hindi ginagalaw ang naunang row) · **Cancel**. Cancel ang default (Esc / click sa labas); walang Enter shortcut para mabasa muna ang diff.
- **Similar** — parehong patient sa parehong clinic sa loob ng ±14 araw pero ibang clinician/date/platform → babala lang din. Kasama rito ang **parehong patient sa ibang appointment date** — normal iyon, kaya hindi kailanman hinaharangan.

**Walang overwrite, walang approval** (binago 2026-08-12) — dating pwedeng ipatong ang bagong entry sa luma, at kapag hindi ikaw ang nag-encode ay napupunta iyon sa **edit-request approval queue** sa gitna mismo ng pag-eencode. Tinanggal na iyon nang tuluyan: walang role — pati ADMIN — ang makakapag-overwrite mula sa duplicate dialog, at walang entry ang napupunta sa review dahil lang duplicate. Kung mali ang naunang row, i-edit iyon nang hiwalay mula sa listahan (doon pa rin nananatili ang dating approval rules).

**Ligtas pa rin sa double-click / sabay na encoder** — hindi lang client-side check ito. Ang totoong check ay nasa server sa loob ng isang transaction na may `pg_advisory_xact_lock()` sa natural key. Ang pre-flight check sa browser ay para sa UI lang; kapag may nakaunang mag-save sa pagitan ng check at ng save, 409 ang isasagot ng server (kasama ang existing row) at lalabas ulit ang parehong dialog.

Walang UNIQUE constraint sa DB — sadya, dahil pinapayagan ang "hindi naman talaga duplicate". Laging `*.create` ang audit-log entry ngayon; wala nang `*.overwrite` dahil wala nang path na bumubura ng dating values.

## 13. Sino ang pwedeng mag-edit / mag-delete ng entry
Ang **nakikita** mo ay clinic-scoped na dati pa: FRONT_DESK = sariling clinic, FRONT_DESK_GLOBAL = lahat, CLINICIAN = mga entry kung saan siya ang naka-tag, ADMIN = lahat.

| Role | Edit | Delete |
|------|------|--------|
| ADMIN | Diretso, lahat | Diretso, lahat |
| FRONT_DESK / FRONT_DESK_GLOBAL | **Kahit sinong entry na nakikita nila** — dumadaan sa **admin approval** (edit request) | Sariling entry lang, dumadaan sa approval |
| CLINICIAN | Sariling entry lang, dumadaan sa approval | Sariling entry lang, dumadaan sa approval |
| ADSPEND (ad leads lang) | **Kahit anong lead** — dumadaan sa admin approval | **Wala** |

**Binago 2026-08-12** (hiling ni Sam: "make it so all frontstaff can edit each others entries") — dati, "sarili mong entry lang" ang panuntunan sa Dropouts + Case Acceptance, kaya hindi maituwid ng kasamahan ang maling na-encode ng kapwa front staff. Ngayon, **nakikita = pwedeng ituwid**. Ang mga hindi ginalaw:
- **Approval**: nananatili — dumadaan pa rin sa Edit Requests queue ng admin (desisyon noong 2026-08-06).
- **Delete**: sariling entry pa rin — ang binuksan ay pag-eedit, hindi pagbura.
- **CLINICIAN**: walang pagbabago.

Kapag may kapwa front staff na may naka-pending nang edit sa parehong row, 409 ang isasagot ng server (*"An edit request for this entry is already pending admin approval"*) — hindi nagse-stack ang dalawang request sa iisang entry.

### Ad Leads: adspend@ (binago rin 2026-08-12)
Shared team inbox ang ad leads — kung nakikita mo, pwede mo nang ituwid, kahit hindi ikaw ang nag-encode. Dati **hindi kasama** ang `adspend@` dito (add + view lang siya). Ngayon, hiling ni Sam ("puwede rin dapat siya mag edit dito, pero may permission din pareho sa iba"), **pwede na siyang mag-edit ng kahit anong lead — pero laging dumadaan sa approval mo**, kahit sariling lead niya (walang diretsong PATCH ang account na iyon).

Ang natitirang hangganan ng `adspend@`: **hindi pa rin siya makakabura** ng lead — walang Delete at walang delete request. Nawala na ang dating "add-only" na konsepto: lahat ng nakakapasok sa section ay pwedeng mag-add at mag-edit; ang tanging natitirang tanong ay kung pwede bang mag-delete (`canRemoveAdLead()` sa `roles.ts`, naka-mirror sa frontend `types.ts` — palitan ang dalawa nang sabay).

## 14. Ageing Debts — manual entry kada week (migrations 027 + 028)
Hand-typed ang Ageing Debts sa CEO dashboard, hindi hinihila sa Nookal. **Binago 2026-08-12:** dati isang box lang sa ilalim ng Monthly Actual; ngayon **may box na ang bawat week column**, at ang **Monthly Actual ay automatic na sum** ng mga napunang linggo.

- **Kada clinic + buwan + week column** ang storage (`ageing_debts_manual_week`). Ang `week_num` ay **posisyon ng column** (1-based), hindi ISO week — Week 1–4 plus Remainder ang grid, at para sa ilang buwan galing pa iyon sa mga transcribed na range ni Cath (`week.calculator.ts`).
- **Blangko ≠ zero.** Walang row = "—" (hindi pa naila-lagay). Naka-type na `0` = totoong wala nang utang. Kapag binura mo ang laman ng box, mabubura ang row para sa linggong iyon.
- **Read-only na ang Monthly Actual.** Sum na lang ito ng mga week — walang tinatype doon.
- **`overall`** ay hiwalay pa rin na tina-type, HINDI sinusuma mula sa tatlong clinic — pareho pa rin ng dahilan sa migration 027.
- **Ang mga lumang buwan ay hindi nawawala.** Kung walang week row ang isang buwan, ipapakita pa rin ang dating buwanang halaga mula sa migration 027 (may paalala sa definition column). Sa sandaling mag-type ka ng kahit isang week doon, buburahin ang lumang buwanang row para hindi magkaroon ng dalawang pinagmumulan ang iisang buwan.

> **Babala tungkol sa kahulugan:** balance ang Ageing Debts (kung magkano ang nakabinbin sa isang punto), at ang pagsuma ng balance sa apat-limang linggo ay lumalabas na mas malaki kaysa totoo. Ipinaliwanag ito kay Sam noong 2026-08-12 at **sum pa rin ang pinili niya** — kaya ang numerong tina-type kada linggo ay basahin bilang "utang na para sa linggong iyon", hindi running total. Huwag itong basta ibalik sa last-week-wins.

---

### API Endpoints (reference)
- **Auth:** `/api/auth/login`, `/refresh`, `/logout`, `/me`, `/change-password`
- **Dashboard:** `/api/dashboard/clinics`, `/monthly`, `/week`, `/ageing-debts`, `/revenue`, `/cash-insurance`, `/upfront-revenue`, `/patient-metrics`
- **Users:** `/api/users` (CRUD), `/staff`, `/:id/password`, `/:id/deactivate`, `/:id/reactivate`
- **Dropouts:** `/api/dropouts` (CRUD), `/summary`, `/check-duplicate`
- **Case Acceptance:** `/api/case-acceptance` (CRUD), `/summary`, `/export`, `/check-duplicate`
- **Ad Leads:** `/api/ad-leads` (CRUD), `/summary`, `/check-duplicate`
- **Ad Spend:** `/api/ad-spend` (CRUD), `/summary`, `/weekly-report`, `/sync-facebook`, `/sync-google`
- **Audit Log:** `/api/audit-log`, `/actions`
- **Health:** `/api/health`
