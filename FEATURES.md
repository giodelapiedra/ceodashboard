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
  - **Finance:** Total Revenue, Product Sales Revenue, Upfront Revenue (account credits), Cash from Insurance (Health Fund / Medicare / DVA), Ageing Debts (10-year rolling outstanding invoices)
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
- Date-range picker, pagination, debounced search
- XLSX export (dropouts, case acceptance)
- Print support (CEO dashboard)
- Loading/error states, form validation
- Health check endpoint (`GET /api/health`)

---

### API Endpoints (reference)
- **Auth:** `/api/auth/login`, `/refresh`, `/logout`, `/me`, `/change-password`
- **Dashboard:** `/api/dashboard/clinics`, `/monthly`, `/week`, `/ageing-debts`, `/revenue`, `/cash-insurance`, `/upfront-revenue`, `/patient-metrics`
- **Users:** `/api/users` (CRUD), `/staff`, `/:id/password`, `/:id/deactivate`, `/:id/reactivate`
- **Dropouts:** `/api/dropouts` (CRUD), `/summary`
- **Case Acceptance:** `/api/case-acceptance` (CRUD), `/summary`, `/export`
- **Ad Spend:** `/api/ad-spend` (CRUD), `/summary`, `/weekly-report`, `/sync-facebook`, `/sync-google`
- **Audit Log:** `/api/audit-log`, `/actions`
- **Health:** `/api/health`
