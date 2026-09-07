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

## 15. Team Performance KPI Reporting (migration 032)
Ang lingguhang KPI + wins cycle mula sa **"Weekly KPI & Wins Process — Build spec"** (Sam, 2026-08-22). Ang spec ay para sa Teams Adaptive Cards + Power Automate + SharePoint list; **ang utos ni Sam ay sa dashboard muna gawin, iwan muna ang Teams** — kaya sinunod ang lahat ng field, wording at ang Monday/Friday cycle, pero **walang Teams/Power Automate na ginawa**.

**Isang row kada physio kada linggo** (`weekly_kpi_reports`, unique sa `clinician_id + week_start`). Ito ang match key ng spec: ang Monday submit ang gumagawa ng row, ang Friday submit ang nagsasara nito — hindi bagong row.

### Sino ang gumagawa ng ano (spec section 2)
| Role | Pwede |
|---|---|
| **CLINICIAN** | Sagutan ang form (Monday + Friday) at tingnan **ang sarili nilang history lang** |
| **ADMIN (Sam)** | Tingnan ang **tracker ng buong team** at ang history ng kahit sinong physio — **walang sinasagutan** |
| FRONT_DESK / FRONT_DESK_GLOBAL / ADSPEND | Wala — wala sa feature |

Tinatanggihan ng server ang submit mula sa ADMIN token (403). Sinadya ito: viewer si Sam sa spec, hindi participant.

### Walang tina-type na Name at Clinic
Required ang Name at Clinic sa spec dahil **hindi alam ng Teams card kung sino ang nagpupuno**. Alam ito ng app. Kaya:
- **Name** — galing sa JWT (`clinician_id`). Hindi tinatanggap mula sa body — kung tinanggap, puwedeng mag-file ang isang physio sa pangalan ng kasama niya.
- **Clinic** — galing sa default clinic ng account (`users.clinic_id`). Nakikita read-only sa header ng form.
- **Naka-store pa rin ang `clinic_id`** (hindi lang joined): naglilipat-lipat ng clinic ang mga physio, at kailangang manatiling tama ang lumang linggo.
- Kung **walang clinic** ang account, sinasabi ng form at ng server na ipaayos sa admin — hindi ito nagde-default sa kahit anong clinic.

### Mga field
- **Monday** — KPI #1–#3 (name / target / result), "If you did not hit the goal", **Effectiveness 1–10**, **Mojo (Energy) 1–10** (nasa ilalim ng bawat isa ang **buong rubric**, laging nakikita — hinihingi ng spec), Intentions for the week (required), case to discuss, what help is needed, **Do you need a 15-minute check-in?** + follow-up kapag Yes.
- **Friday** — What went well, **Did you achieve your Monday goal and intention?** + reflection kapag No, anything else to flag to Sam.
- Ang mga conditional na field ay ipinapakita **lang** kung tugma ang sagot, at tinatanggihan ng validator ang kontradiksyon (halimbawa: reflection kasama ang "goal achieved = Yes").

### Pwede pang baguhin sa loob ng linggo — walang approval
Ang re-submit ng **kasalukuyang linggo** ay **upsert**: tinatama ang parehong row, walang duplicate. **Frozen ang mga nakalipas na linggo.**
- **Hindi** ito dumadaan sa edit-request / approval queue, kaiba sa dropouts at case acceptance. Iyon ay shared operational records — ang typo ng isa ay maling numero ng iba. Self-report ito: ang may-akda lang ang tinutumbok ng pagtatama, at "7 pala hindi 8 ang mojo ko" ay hindi kailangang dumaan sa CEO.
- Hindi binubura ng pag-tama sa Monday half ang Friday half na naipasok na.
- Walang delete — history ito.

### Ang tracker ni Sam (spec section 8)
`/admin/weekly-kpi`, isang linggo sa isang tingin, naka-group per clinic. **Scan columns lang** sa table (Name, Intention, Eff, Mojo, Goal hit, Check-in) — ang KPI detail, wins, reflection at case to discuss ay **nasa loob ng row** pagka-click. Ito ang pinili ng spec mismo: *"Too much on the surface means Sam scans nothing properly."*
- Filter: **Check-in requested** (ang "optional second view" ng spec) at **Friday still open**; per clinic din.
- Summary cards: ilan ang nag-submit, ilan ang nagsara ng loop, average Effectiveness at Mojo.
- **"Not submitted for this week"** — wala ito sa spec dahil **hindi kayang ipakita ng SharePoint list ang row na wala**. Ang physio na lumaktaw ay siya mismong kailangang makita ni Sam. Active CLINICIAN lang, at hindi kasama ang naka-`show_in_picker = false` (mga dating physio tulad ni Jesse at Tim) — kung hindi, permanenteng noise sila kada linggo.
- Mojo **1–2** ay pula kahit saan ito lumitaw: iyon ang *"talk to me now"* band ng rubric.

### Saan nakikita ang history
- **Physio** — sa ilalim ng sariling form (`/weekly-kpi`), "My previous weeks", pinaka-bago sa itaas, i-click ang linggo para sa buong report.
- **Sam** — bagong tab na **"Weekly KPI Reports"** sa Clinician Profile page ng bawat physio, at drill-in mula sa tracker. Iisang component lang ang ginagamit ng dalawa — iba lang ang endpoint.

### Week keying — hindi ito ang grid ng CEO dashboard
Plain **ISO week** (Monday–Sunday) ang `week_start`, **hindi** ang Week 1–4 + Remainder grid ng `week.calculator.ts`. Sinadya:
- May Monday half at Friday half ang form. Ang "Remainder [30-31]" na column ay wala sa dalawa.
- Hindi humihinto sa dulo ng buwan ang linggo ng physio. Kapag hinati sa dalawang row ang isang working week, mababali ang one-row-per-person-per-week — ang match key mismo ng Friday submit.

Basahin ang `docs/WEEKLY_KPI_2026-08-22.md` at `docs/WEEK_GRID_2026-08-06.md` bago ito pagsamahin sa grid ng dashboard.

### Tungkol sa UI (in-ayos 2026-08-24 — flat white)
**Minimalist, flat, puti — "tulad sa Apple".** Utos ni Sam noong 2026-08-24: tinanggal lahat ng gradient, glow, dark hero band at shadow sa dalawang page. Puting surface, hairline border, at ang laki/timbang ng type ang nagdadala ng hierarchy; may kulay lang kung may kahulugan (critical mojo, hinihinging check-in, napiling kontrol). Nasa `weeklyKpi.ui.tsx` ang buong system (`PageHeader`, `Panel`, `Chip`, `RatingMeter`, segmented `PillGroup`) kaya iisa ang mukha ng form, history at tracker. Detalye sa `docs/WEEKLY_KPI_2026-08-22.md` seksyon 14.

<details><summary>Ang lumang bersyon (2026-08-22, hindi na ginagamit)</summary>

Ang palette, gradient, panel at accent bar noon ay **galing sa `CEOAnalyticsPage`** para pareho ang mukha nito sa buong dashboard, at nakalagay sa `weeklyKpi.ui.tsx` bilang shared primitives (`Panel`, `PanelHeader`, `PillGroup`, `Avatar`, `ProgressRing`, `EmptyState`) — iisang design ang form, ang history at ang tracker.
- **Dark hero band** sa tracker (week + navigator + roster ring) at sa form (avatar + pangalan + clinic). Dito nakikita ang Name at Clinic ng spec — identity, hindi input.
- **`RatingMeter` (10 segments + pangalan ng band) kapalit ng number pill.** Ang hanay ng dalawang-digit na numero ay pare-pareho ang hitsura, kaya kailangan pang basahin lahat. May **hugis** na ngayon ang bawat row, at ang "Mostly on track" / "Running empty" ang naghahatid ng kahulugan ng rubric.
- **Kulay lang sa kailangang aksyunan:** may left stripe ang row kung critical ang mojo (pula) o may hinihingi na check-in (amber). Tahimik ang lahat ng iba, kaya kita agad ang dalawang exception.
- Sa form, **naka-highlight ang banda ng napiling score** sa rubric at kinukuha ng napiling numero ang kulay ng banda niya.

Buong detalye sa `docs/WEEKLY_KPI_2026-08-22.md` seksyon 12.
</details>

### Comment thread kada linggo (migration 033, 2026-08-24)
Puwede nang **mag-comment si Sam sa isang na-submit na linggo, at makakasagot ang physio** — utos ni Sam 2026-08-24. Bago nito, ang sagot sa mababang mojo o sa `flag_for_sam` ay napupunta sa Teams o sa usapan, kaya wala itong bakas sa linggong pinag-uusapan.
- **Dalawa lang ang nasa thread:** ang physio na may-ari ng report at ang super admin. **404** ang nakukuha ng kahit sinong iba — hindi 403; hindi kailangang malaman ng ibang tao kung may ganitong report. **Hindi ito nakikita ng ibang physio** — coaching ito, hindi pampublikong marka.
- **Dalawang direksyon:** parehong panig puwedeng mag-post. **Ang may-akda lang** ang puwedeng mag-edit o mag-delete ng sarili niyang mensahe. Walang approval queue — mensahe ito na may iisang may-akda, hindi shared record.
- Naka-audit log ang `weekly_kpi.comment.create / update / delete`.

### Notification (in-app, walang Teams at walang email)
Patay ang Teams sa prod at walang email sender, kaya ang **polled counter** ang notification — kaparehong pattern ng edit/delete approval badges (60s + on focus).
- **Red badge** sa hub card ng physio ("Team Performance KPI Reporting") at ni Sam ("Team Performance KPI").
- **Banner** sa itaas ng `/weekly-kpi` at ng `/my-profile`, at **`N new comments` pill** sa row ng linggo sa history + comment marker sa tracker row.
- **Parehong panig ang na-notify:** ang physio kapag nag-comment si Sam; si Sam kapag may sumagot **sa thread na sinalihan niya** — hindi sa lahat ng report.
- Kapag bukas na ang thread at may dumating na bagong mensahe, kusang nagre-refresh — hindi na kailangang mag-reload.

### `/my-profile` — sariling profile view ng physio
Tatlong tab: **Weekly KPI history (kasama ang thread), sariling Patient Dropouts, sariling Case Acceptance.**
- **HINDI ito bagong page.** Iisang component (`ClinicianProfilePage`) na may `selfMode` flag ang gamit ng `/admin/clinician-profile` at ng `/my-profile` — pareho ang filters, summary cards, table at pagination. Ang unang bersyon ay hiwalay na page na may sariling UI; tama ang punto ni Sam: dalawang kopya ng iisang table ang kailangang ayusin nang dalawang beses tuwing may babaguhin.
- Ang inaalis ng `selfMode`: **account controls** (edit profile / reset password / deactivate), **Delete button kada row** (kailangan ng ADMIN o approved delete request sa server, kaya error lang ang mangyayari), at ang **`clinician_id` sa URL** — sa session galing ang physio, kaya hindi puwedeng buksan ang profile ng kasama sa pamamagitan ng pagpalit ng URL. Nakabukas muna ang Weekly KPI tab at may banner ng bagong comment.
- **Walang bagong backend:** matagal nang naka-pin ang CLINICIAN caller sa sariling rows ng `applyScope` sa dropout at case-acceptance repositories.

### Drawer, hindi accordion (2026-08-24)
Pag-click ng row sa tracker, **bumubukas ang report sa kanang sidebar** (560px), hindi na pababa sa loob ng table. Dati, ang pagbukas ng isang report ay nagtutulak sa lahat ng physio sa ibaba palabas ng screen — kabaligtaran ng silbi ng page na ito, na paghahambing ng tao sa loob ng isang linggo.
- Hindi gumagalaw ang table; may accent marker sa kaliwa ng nakabukas na row para alam mo kung kanino ang panel.
- Ang **header ng panel** ay may pangalan, Effectiveness, Mojo at status chips — nakatigil habang nag-i-scroll ang laman. Ang **footer** ay naka-pin: "Full history →" at (super admin) "Delete this week".
- Hindi na inuulit ang scores sa loob (`compact` mode ng detail) — yun ang "ayusin mo ang format".
- Esc o pag-click sa labas para isara.
- **Pati sa Weekly KPI Reports tab ng Clinician Profile** (`/admin/clinician-profile` at `/my-profile`) — pag-click ng linggo, sa sidebar din lumalabas. Nakatago doon ang "Full history →" dahil nandoon ka na nga.
- **Pababa pa rin sa form page ng physio** (`/weekly-kpi`, "Previous weeks") — form yun na may history sa ilalim, hindi listahang sinusuyod. Isang flag lang kung gusto mo ring i-drawer.

### Confirm bago mag-submit (2026-08-24)
May **"are you sure"** na bago mag-save — **pareho sa Monday at Friday** ("basta lagi", kaya pareho).
- Lumalabas **pagkatapos** ng field validation, hindi bago — para hindi ka pa tinatanong sa bagay na tatanggihan din pala ng form.
- **Nakasulat sa dialog ang mga sagot na aaksyunan ni Sam** — Effectiveness, Mojo at check-in sa Monday; goal achieved sa Friday. Hindi lang "are you sure?": ang bare na confirm ay natututunang pindutin agad, ang may numero ay huling pagkakataong mahuli ang maling pindot sa 1–10.
- Kapag pag-uulit, sinasabi nito nang diretso: "This replaces what you submitted on …". Ang mga button ay `Submit Monday` / `Update Friday` / `Keep editing` — hindi OK/Cancel.

### Delete (2026-08-24) — super admin lang
Puwede nang **burahin ni super admin ang isang buong weekly report** (`DELETE /api/weekly-kpi/:id`). Binabaligtad nito ang "walang delete — history ito" **para sa isang role lang**.
- **Permanente**, gaya ng lahat ng delete sa app — walang soft delete kahit saan dito. Kasama ang **buong comment thread** ng linggong iyon (ON DELETE CASCADE).
- **Audit log ang natitirang bakas:** `weekly_kpi.delete` — id, pangalan ng physio, linggo, kung may Friday half na, at ilan ang comment na nabura kasama nito.
- **Hindi puwede ang physio** kahit sarili niyang linggo: ang kasalukuyang linggo ay tinatama sa pag-re-submit, at frozen ang mga nakaraan. Walang delete-request queue — iisang account lang ang hihiling at aaprub.
- Sa UI: nasa **loob ng nakabukas na row lang** (tracker o history), kulay abo hanggang i-hover, at nakasulat sa confirm ang pangalan, ang linggo at ang bilang ng comment na kasamang mabubura.
- **Ang comment delete ay author-only pa rin** — hindi mo mabubura ang sagot ng physio, hindi niya mabubura ang comment mo.

### Hindi pa ginawa (sinadya)
- **Teams / Power Automate / SharePoint** — utos ni Sam na dashboard muna.
- **Monday at Friday reminders** — walang nagtutulak ng card sa physio; sila ang pumapasok sa hub card. Ang "Not submitted" na listahan ang pansamantalang panghalili.
- **Pilot scoping sa Brookvale** (spec section 9) — bukas ito sa lahat ng clinic ngayon. Kung Brookvale-lang muna ang gusto, sabihin lang — isang gate lang ang kailangan.

---

### API Endpoints (reference)
- **Auth:** `/api/auth/login`, `/refresh`, `/logout`, `/me`, `/change-password`
- **Dashboard:** `/api/dashboard/clinics`, `/monthly`, `/week`, `/ageing-debts`, `/revenue`, `/cash-insurance`, `/upfront-revenue`, `/patient-metrics`
- **Users:** `/api/users` (CRUD), `/staff`, `/:id/password`, `/:id/deactivate`, `/:id/reactivate`
- **Dropouts:** `/api/dropouts` (CRUD), `/summary`, `/check-duplicate`
- **Case Acceptance:** `/api/case-acceptance` (CRUD), `/summary`, `/export`, `/check-duplicate`
- **Ad Leads:** `/api/ad-leads` (CRUD), `/summary`, `/check-duplicate`
- **Ad Spend:** `/api/ad-spend` (CRUD), `/summary`, `/weekly-report`, `/sync-facebook`, `/sync-google`
- **Weekly KPI:** `/api/weekly-kpi/me`, `/me/history`, `/me/unread`, `/monday`, `/friday`, `/tracker`, `/clinician/:id/history`, `/:id`, `/:id` (DELETE, admin), `/:id/comments` (GET/POST), `/:id/comments/read`, `/comments/:commentId` (PATCH/DELETE)
- **Audit Log:** `/api/audit-log`, `/actions`
- **Health:** `/api/health`
