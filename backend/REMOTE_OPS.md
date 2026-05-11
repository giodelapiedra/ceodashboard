# Remote Ops via SSH — PhysioWard Backend

Operational playbook for the live Ubuntu server. Use this when you need to
update code, run a one-off import, check the DB, or restart the process.
Companion to `DEPLOY_UBUNTU.md` (first-time setup); this doc is for the
**day-to-day "I already have a deployed box" workflow**.

| | Value |
| --- | --- |
| Host         | (kept out of repo — keep the IP/hostname in your local notes only) |
| SSH login    | `root@<host>` (key-based, no password) |
| App user     | `physioward` (separate system user; runs PM2 + owns app files) |
| App dir      | `/var/www/physioward/backend/physioward-backend` |
| Env file     | `$APP/.env` (chmod 600, owned by `physioward`) |
| DB           | PostgreSQL local, db `nookal`, role `physioward` (creds in `.env`) |
| PM2 process  | `physioward-backend` |
| Public URL   | `https://api.physioward.com.au` → `127.0.0.1:3001` |
| Co-located   | `aegira` app shares this VPS — **never** modify shared services (Nginx, postgres, pm2) |

---

## 1. Connect

```bash
ssh root@your.server.host
```

For one-off non-interactive commands (used by Claude / scripts):

```bash
ssh -o BatchMode=yes root@your.server.host 'echo connected; whoami; hostname; uptime'
```

After connecting, switch to the app user before touching anything app-related:

```bash
sudo -iu physioward
cd /var/www/physioward/backend/physioward-backend
```

**Never run app commands as root.** Mixing root-owned and physioward-owned
files in `dist/`, `node_modules/`, etc. causes `EACCES` errors on the next
build (we saw this on 2026-05-11).

---

## 2. Status / health checks

```bash
# As root or physioward — works for both
sudo -iu physioward pm2 status              # process up?
sudo -iu physioward pm2 logs physioward-backend --lines 100 --nostream
curl -s http://127.0.0.1:3001/api/health    # backend reachable locally?
curl -s https://api.physioward.com.au/api/health   # reachable through Nginx + TLS?

# Confirm aegira still alive after any change
sudo -iu physioward pm2 status              # aegira-api should still be "online"
```

---

## 3. Query the DB

```bash
APP=/var/www/physioward/backend/physioward-backend

# Open psql shell against the prod DB
sudo -u physioward psql "$(sudo -u physioward grep ^DATABASE_URL $APP/.env | cut -d= -f2-)"

# One-shot query (useful for scripts)
sudo -u physioward psql "$(sudo -u physioward grep ^DATABASE_URL $APP/.env | cut -d= -f2-)" -c \
  "SELECT clinic_id, COUNT(*) FROM case_acceptances GROUP BY clinic_id ORDER BY clinic_id;"

# Run a SQL file
sudo -u physioward psql "$(sudo -u physioward grep ^DATABASE_URL $APP/.env | cut -d= -f2-)" -f /path/to/script.sql
```

---

## 4. Deploy a code update

**Important:** The server does **NOT** have `.git` checked out — code was
originally deployed via rsync, not `git clone`. So `git pull` won't work.
Updates have to be pushed file-by-file via `scp` (or `rsync` if you have it
on your dev machine).

### 4.1 From Windows PowerShell / Git Bash

```bash
# 1. Bundle only the changed files into a tarball.
cd /path/to/physioward-v2
tar -czf /tmp/backend-update.tgz \
  backend/src/services/revenue.service.ts \
  backend/src/features/case-acceptance/case-acceptance.service.ts \
  backend/package.json
# (replace the file list with whatever you actually changed)

# 2. scp to server.
scp /tmp/backend-update.tgz root@your.server.host:/tmp/
```

### 4.2 On the server

```bash
APP=/var/www/physioward/backend/physioward-backend

# 1. Backup current src/ (safety net if you need to roll back).
sudo cp -a $APP/src $APP/src.before-$(date +%Y%m%d-%H%M%S)

# 2. Extract the tarball over the app dir.
sudo tar -xzvf /tmp/backend-update.tgz -C $APP --strip-components=1

# 3. Fix ownership (tarball extracts as root, but physioward must own src/).
sudo chown -R physioward:physioward $APP/src $APP/package.json

# 4. Install + build as the app user.
sudo -u physioward bash -lc "cd $APP && npm ci && npm run build"

# 5. Restart PM2.
sudo -u physioward pm2 restart physioward-backend
sleep 2
curl -s -w "\nHTTP %{http_code}\n" http://127.0.0.1:3001/api/health

# 6. Tail logs for ~1 min to confirm no startup errors.
sudo -u physioward pm2 logs physioward-backend --lines 30 --nostream
```

### 4.3 Gotchas observed 2026-05-11

- **`EACCES: permission denied` writing to `dist/...`** during build → mixed
  ownership in `dist/`. Fix: `sudo chown -R physioward:physioward $APP/dist
  $APP/.npm /var/www/physioward/.npm` then rebuild.
- **`/var/www/physioward/.npm` doesn't always exist** — that's fine, the chown
  warning is benign.
- **`src.backup-*` / `src.before-*` directories accumulate** under `$APP/` if
  you don't clean them up — delete after a week of stable operation:
  ```bash
  sudo find $APP -maxdepth 1 -name 'src.before-*' -mtime +7 -exec rm -rf {} +
  sudo find $APP -maxdepth 1 -name 'src.backup-*' -exec rm -rf {} +
  ```

---

## 5. Run a one-off DB script / importer

For an import that needs the app's services (e.g.
`npm run db:import:case-acceptance`):

```bash
APP=/var/www/physioward/backend/physioward-backend

# Upload the xlsx (or other artifact) to the server.
# From Windows:
#   scp 'C:\path\to\file.xlsx' root@your.server.host:/tmp/

# Move to a stable spot owned by physioward.
sudo mkdir -p /var/www/physioward/imports
sudo mv /tmp/file.xlsx /var/www/physioward/imports/
sudo chown -R physioward:physioward /var/www/physioward/imports

# Make sure the env var the script needs is set (only required when --commit
# creates new accounts). The value below is a placeholder — replace
# <temp-password> with a real strong value (min 8 chars). Whoever runs this
# is responsible for sharing the actual value out-of-band with the new staff.
sudo -u physioward grep -q '^IMPORT_CLINICIAN_TEMP_PASSWORD=' $APP/.env || \
  echo 'IMPORT_CLINICIAN_TEMP_PASSWORD=<temp-password>' | sudo -u physioward tee -a $APP/.env

# Dry-run first — never --commit blind.
sudo -u physioward bash -lc \
  "cd $APP && npm run db:import:case-acceptance -- --clinic newport --xlsx /var/www/physioward/imports/file.xlsx"

# After reviewing the dry-run output, commit:
sudo -u physioward bash -lc \
  "cd $APP && npm run db:import:case-acceptance -- --clinic newport --xlsx /var/www/physioward/imports/file.xlsx --commit"
```

For a quick one-off probe script (TypeScript), the pattern is:

```bash
# 1. From Windows: scp the .ts file to /tmp/ on the server.
scp 'D:\path\to\_probe.ts' root@your.server.host:/tmp/_probe.ts

# 2. On server: move into $APP/src/db/, chown, run via ts-node-dev.
sudo mv /tmp/_probe.ts $APP/src/db/_probe.ts
sudo chown physioward:physioward $APP/src/db/_probe.ts
sudo -u physioward bash -lc "cd $APP && npx ts-node-dev --transpile-only src/db/_probe.ts"

# 3. Always delete the probe afterwards so the source tree stays clean.
sudo rm $APP/src/db/_probe.ts
```

---

## 6. Refresh cached dashboard snapshots

The dashboard caches monthly snapshots in Postgres (`dashboard_snapshots`,
TTL controlled by `SNAPSHOT_TTL_MINUTES`). After a code change that affects
revenue logic (e.g. the ICB orthotic exclusion on 2026-05-11), you have to
bust the cache by hitting the dashboard endpoint with `?refresh=1`.

```bash
APP=/var/www/physioward/backend/physioward-backend
CEO_PWD=$(sudo -u physioward grep '^CEO_PASSWORD=' $APP/.env | cut -d= -f2-)

# Login locally on the server.
ACCESS=$(curl -s -H 'Content-Type: application/json' \
  -d "{\"email\":\"sam@physioward.com.au\",\"password\":\"$CEO_PWD\"}" \
  http://127.0.0.1:3001/api/auth/login | python3 -c "import json,sys; print(json.load(sys.stdin).get('accessToken',''))")

# Force-refresh each clinic's snapshot for the affected month.
for clinic in newport narrabeen brookvale overall; do
  curl -s -H "Authorization: Bearer $ACCESS" \
    "http://127.0.0.1:3001/api/dashboard/monthly?clinic=$clinic&month=5&year=2026&refresh=1" >/dev/null
done
```

---

## 7. Frontend deploys

The frontend is **not** on this VPS — it's hosted on Vercel.

```bash
# From your Windows dev machine, inside frontend/:
cd /path/to/physioward-v2/frontend
vercel --prod --yes
```

After the deploy, the alias `https://ceoadmin.physioward.com.au` flips to
the new build automatically (zero downtime). Vercel auth is per-user — if
you're not logged in, run `vercel login` first.

---

## 8. Today's session — worked example (2026-05-11)

Sequence used to deploy case-acceptance imports + revenue patch + admin
update/delete capability:

1. **Pre-flight check** — confirm DB empty for clinic, PM2 healthy:
   ```bash
   ssh root@your.server.host 'sudo -u physioward pm2 status; \
     sudo -u physioward psql "$(sudo -u physioward grep ^DATABASE_URL \
       /var/www/physioward/backend/physioward-backend/.env | cut -d= -f2-)" -c \
       "SELECT clinic_id, COUNT(*) FROM case_acceptances GROUP BY clinic_id;"'
   ```

2. **Bundle + ship** — 9 changed backend files + 3 xlsx artifacts:
   ```bash
   tar -czf /tmp/backend-update.tgz <list of changed .ts files> backend/package.json
   scp /tmp/backend-update.tgz \
       'C:\path\to\casenewport.xlsx' \
       'C:\path\to\Narrabeen.xlsx' \
       'C:\path\to\Brookvale.xlsx' \
       root@your.server.host:/tmp/
   ```

3. **Apply, build, restart** — backup → extract → chown → build → restart.
   (Section 4.2 commands.)

4. **Rename data quirk** — Gabby → Gabriella before import so the importer's
   sheet-name "Gabriella" matches DB:
   ```bash
   sudo -u physioward psql "$DB_URL" -f src/db/_pre_import_check.sql
   ```

5. **Set env var** — added `IMPORT_CLINICIAN_TEMP_PASSWORD=<temp-password>`
   to `.env` so the importer could auto-provision new clinicians. The actual
   value chosen for that run was shared out-of-band; never store it in this
   doc or in the repo.

6. **Dry-run then commit** — 3 clinics, sequential — see Section 5.

7. **Restart + refresh snapshots** — PM2 restart picks up the revenue patch;
   `?refresh=1` busts the cached May 2026 snapshots so the new numbers show.

8. **Frontend deploy** — `vercel --prod` from Windows.

Total wall time: ~15 minutes including dry-runs and verification.

---

## 9. Rolling back

If a backend deploy goes wrong, the `src.before-<timestamp>` directory
created in Section 4.2 step 1 is your roll-back point:

```bash
APP=/var/www/physioward/backend/physioward-backend
# Find the most recent backup.
ls -d $APP/src.before-* | tail -1
# Swap it back.
sudo mv $APP/src $APP/src.broken-$(date +%Y%m%d-%H%M%S)
sudo mv $APP/src.before-XXXX $APP/src
sudo chown -R physioward:physioward $APP/src
sudo -u physioward bash -lc "cd $APP && npm run build"
sudo -u physioward pm2 restart physioward-backend
```

For frontend, redeploy a previous Vercel build:

```bash
vercel ls                  # list past deployments
vercel rollback <deployment-url>
```

For DB changes you can't undo via SQL, the daily `pg_dump` cron in
`DEPLOY_UBUNTU.md` Section 8 → `/var/www/physioward/backups/`.

---

## 10. What lives in `.env` that the importer/scripts depend on

You don't normally edit `.env` — but these vars are required for specific
operations:

| Var | When needed |
| --- | --- |
| `DATABASE_URL` | always (boot) |
| `CEO_EMAIL`, `CEO_PASSWORD` | first boot seeds the initial admin; not used after |
| `JWT_SECRET` | always (boot) |
| `NOOKAL_*` | dashboard endpoints (every monthly fetch) |
| `FRONTEND_URL` | CORS — must exactly match the frontend origin (`https://ceoadmin.physioward.com.au`) |
| `IMPORT_CLINICIAN_TEMP_PASSWORD` | only the case-acceptance / dropouts importer, when `--commit` would create new clinician accounts |
| `IMPORT_CASE_ACCEPTANCE_XLSX` | optional default path; the `--xlsx` CLI arg overrides |
| `SNAPSHOT_TTL_MINUTES` | how long dashboard caches before refetching (default 60) |

After changing `.env`, restart the backend:

```bash
sudo -u physioward pm2 restart physioward-backend --update-env
```

`--update-env` is important — without it PM2 keeps the old env block in
memory and your changes don't take effect.
