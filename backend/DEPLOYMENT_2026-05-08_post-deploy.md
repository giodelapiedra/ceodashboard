# PhysioWard — Post-Deploy Operations Record

**Date:** 2026-05-08
**Performed by:** Sam (sam@physioward.com.au) with Claude Code assistance
**Builds on:** `DEPLOYMENT_2026-05-07.md` (original deploy)
**This document:** records the post-deploy tasks done a day after go-live —
Vercel frontend, passwordless SSH, multi-origin CORS, database data migration,
SSL cert, and full source code refresh.

---

## 1. SSH access — passwordless from Sam's Windows machine

Original deploy used password-based root SSH. Switched to ed25519 key auth
on 2026-05-08 so future operations don't require typing the VPS password.

**Local key location (Windows):**

```
C:\Users\GIO\.ssh\id_ed25519       (private — never share)
C:\Users\GIO\.ssh\id_ed25519.pub   (public — already deployed to server)
```

**Public key fingerprint (for verification):**

```
SHA256:bXO2LSigfEVHGh4ozGVHbTnv3CtzRHS5iuc7YetB1bA physioward-deploy
```

**How it was set up (one-time, do not repeat):**

```powershell
# 1. Generate key on Windows (no passphrase)
ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\id_ed25519" -N '""' -C "physioward-deploy"

# 2. Copy public key
Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub"
```

Then on the Ubuntu server (one time):

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINBOpkdrY0lZ5jyD9jQuEzwTmrXROxrupLm2YB4pojnV physioward-deploy" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

**Connecting from now on (no password):**

```powershell
ssh root@api.physioward.com.au
# or in scripts:
ssh -o BatchMode=yes root@api.physioward.com.au "<command>"
```

**Test that passwordless still works:**

```powershell
ssh -o BatchMode=yes -o ConnectTimeout=10 root@api.physioward.com.au "echo ok"
```

If it ever stops working (e.g. Windows profile reset, key file deleted),
regenerate and re-add the public key per the steps above.

---

## 2. Frontend deployed to Vercel

| Property               | Value                                                 |
| ---------------------- | ----------------------------------------------------- |
| Vercel account         | `giodelapiedra-7847` (login email: `giodelapiedra@gmail.com`) |
| Vercel scope/team      | `gios-projects-3753c34c` (Sam's personal scope)       |
| Project name           | `frontend`                                            |
| Production URL         | `https://frontend-flax-five-43.vercel.app` (stable alias) |
| Latest deploy URL      | `https://frontend-h2ngjd6cd-gios-projects-3753c34c.vercel.app` |
| Dashboard              | `https://vercel.com/gios-projects-3753c34c/frontend`  |
| Source dir             | `physioward-v2/frontend/`                             |
| Vercel CLI version     | 50.11.0 (installed at `C:\nvm4w\nodejs\vercel.cmd`)   |
| Build framework        | Vite (auto-detected)                                  |
| Build command          | `npm run build`                                       |
| Output directory       | `dist`                                                |

**`vercel.json` (in `physioward-v2/frontend/`):**

```json
{
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "framework": "vite",
  "rewrites": [
    { "source": "/api/:path*", "destination": "https://api.physioward.com.au/api/:path*" },
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

The `/api/*` rewrite proxies every API call from the Vercel-hosted frontend
to the Hostinger backend. From the browser's perspective everything looks
same-origin, so the auth cookies + `withCredentials: true` work cleanly.

**Re-deploy command (from `physioward-v2/frontend/`):**

```powershell
vercel --prod --yes --scope gios-projects-3753c34c
```

The first deploy created `.vercel/project.json` linking the directory to
the Vercel project — keep this file checked in (or just don't delete it)
so future `vercel --prod` runs target the same project.

**One-time login (only if Vercel CLI ever logs out):**

```powershell
vercel login giodelapiedra@gmail.com
# OAuth flow opens browser — approve.
vercel teams ls   # verify gios-projects-3753c34c is listed
```

---

## 3. Backend code change — multi-origin CORS

The original `backend/src/index.ts` allowed only one frontend origin
(`env.FRONTEND_URL` as a string passed to `cors()`). The Vercel frontend
needed to be added without removing `https://app.physioward.com.au`, so
the schema and the CORS setup were both updated to accept a comma-
separated list of origins.

**File: `backend/src/config/env.ts`**

```ts
// before:
FRONTEND_URL: z.string().url().default('http://localhost:5173'),
// after:
FRONTEND_URL: z.string().min(1).default('http://localhost:5173'),
```

`.url()` was dropped because zod's URL validator rejects comma-separated
input. `.min(1)` keeps it required.

**File: `backend/src/index.ts`**

```ts
// before:
app.use(cors({
  origin:      env.FRONTEND_URL,
  credentials: true,
}));

// after:
const allowedOrigins = env.FRONTEND_URL.split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin:      allowedOrigins.length === 1 ? allowedOrigins[0] : allowedOrigins,
  credentials: true,
}));
```

When the array has multiple entries, `cors()` reflects the matching origin
back in `Access-Control-Allow-Origin` and rejects unknown origins. When
the env has a single URL, behaviour is unchanged from before.

**Production `FRONTEND_URL` in `.env`:**

```
FRONTEND_URL=https://app.physioward.com.au,https://frontend-flax-five-43.vercel.app,https://ceoadmin.physioward.com.au
```

To add a new allowed origin in the future: append `,https://new-origin`
to that line, then restart PM2 (see Section 7).

---

## 4. SSL certificate — Let's Encrypt via certbot

The original deploy created the Nginx vhost (`/etc/nginx/sites-enabled/
physioward-api`) listening only on port 80. Without an SSL cert,
`https://api.physioward.com.au` was falling back to the default vhost,
which served the `aegira` certificate — confusing browsers and breaking
the Vercel proxy.

Fix (one command, certbot auto-configures Nginx):

```bash
certbot --nginx -d api.physioward.com.au \
  --non-interactive --agree-tos \
  --email sam@physioward.com.au --redirect
```

**Result:**

- Cert at `/etc/letsencrypt/live/api.physioward.com.au/`
- Expires 2026-08-05 (renewed automatically by certbot's systemd timer)
- Nginx vhost rewritten to listen on 443 with the new cert, with a 301
  redirect from port 80

**Verify cert is healthy:**

```bash
certbot certificates | grep -A2 api.physioward.com.au
systemctl status certbot.timer    # auto-renew is active
```

---

## 5. Database data migration — local Postgres → Ubuntu

The Ubuntu DB started with only the seeded CEO user (post-deploy state).
The actual data Sam had been entering on the local development DB
(`postgres://postgres:2210@localhost:5432/nookal`) was migrated up.

**Counts before migration (Ubuntu side):**

```
users               | 1   (just the seeded sam@physioward.com.au)
patient_dropouts    | table did not exist (older migrations on server)
case_acceptances    | table did not exist
audit_log           | 0
dashboard_snapshots | 0
```

**Counts on local at time of migration:**

```
users               | 19
patient_dropouts    | 722
case_acceptances    | 0
audit_log           | 8
dashboard_snapshots | 27   (cache, harmless)
```

**Steps performed:**

1. Dump local DB on Windows (uses PostgreSQL 18 client at
   `C:\Program Files\PostgreSQL\18\bin\pg_dump.exe`):

   ```powershell
   $env:PGPASSWORD = "2210"
   & "C:\Program Files\PostgreSQL\18\bin\pg_dump.exe" -U postgres -h localhost -d nookal `
     --clean --if-exists --no-owner --no-acl `
     -f "D:\New folder (7)\PhysioWard_v2\local-dump.sql"
   Remove-Item Env:\PGPASSWORD
   ```

   `--clean --if-exists` makes the dump self-contained: it drops every
   object before recreating it, so a re-run is safe. `--no-owner --no-acl`
   strips ownership so the import doesn't fail on missing roles.

2. Upload to Ubuntu (passwordless thanks to Section 1):

   ```powershell
   scp "D:\New folder (7)\PhysioWard_v2\local-dump.sql" `
     root@api.physioward.com.au:/tmp/local-dump.sql
   ```

3. Backup the Ubuntu DB before clobbering it (mandatory safety step):

   ```bash
   ssh root@api.physioward.com.au
   mkdir -p /var/backups/physioward
   sudo -u postgres pg_dump nookal > \
     /var/backups/physioward/ubuntu-pre-migration-$(date +%Y%m%d-%H%M%S).sql
   ls -lh /var/backups/physioward/
   ```

4. Stop the backend so nothing writes during the restore, then restore
   AS the `physioward` Postgres user (not `postgres`!) so new objects
   get owned by the application's role:

   ```bash
   sudo -u physioward HOME=/var/www/physioward PM2_HOME=/var/www/physioward/.pm2 \
     pm2 stop physioward-backend

   PGPASSWORD='<password from DATABASE_URL in .env>' psql \
     -h 127.0.0.1 -U physioward -d nookal \
     -v ON_ERROR_STOP=0 \
     -f /tmp/local-dump.sql
   ```

   The password is the bit between `physioward:` and `@127.0.0.1` in
   `/var/www/physioward/backend/physioward-backend/.env` →
   `DATABASE_URL=...`.

5. Verify counts match local:

   ```bash
   sudo -u postgres psql -d nookal -c "
     SELECT 'users=' || COUNT(*) FROM users
     UNION ALL SELECT 'patient_dropouts=' || COUNT(*) FROM patient_dropouts
     UNION ALL SELECT 'case_acceptances=' || COUNT(*) FROM case_acceptances
     UNION ALL SELECT 'audit_log=' || COUNT(*) FROM audit_log;
   "
   ```

6. Restart the backend (Section 7).

**Rollback (if the restore went badly):**

```bash
sudo -u physioward HOME=/var/www/physioward PM2_HOME=/var/www/physioward/.pm2 \
  pm2 stop physioward-backend
PGPASSWORD='<...>' psql -h 127.0.0.1 -U physioward -d nookal \
  -f /var/backups/physioward/ubuntu-pre-migration-<TIMESTAMP>.sql
sudo -u physioward HOME=/var/www/physioward PM2_HOME=/var/www/physioward/.pm2 \
  pm2 start physioward-backend
```

---

## 6. Full source code refresh — local → Ubuntu

The CORS-only edit revealed that the source on Ubuntu was an OLDER
snapshot than local: only `auth` and `dashboard` routes existed on
the server; there was no `src/features/` directory at all. Local had
the full set (`users`, `dropouts`, `case-acceptance`, `audit-log`).
The complete `src/` was tarballed up and re-deployed.

**On Windows (in `physioward-v2/backend/`):**

```powershell
Push-Location "D:\New folder (7)\PhysioWard_v2\physioward-v2\backend"
tar -czf "$env:TEMP\backend-src.tar.gz" `
  --exclude='node_modules' --exclude='dist' --exclude='.env' --exclude='*.log' `
  src package.json package-lock.json tsconfig.json
Pop-Location

scp "$env:TEMP\backend-src.tar.gz" root@api.physioward.com.au:/tmp/backend-src.tar.gz
```

Tarball was ~85 KB. Stays small because `node_modules`, `dist`, `.env`,
and `*.log` are excluded.

**On Ubuntu:**

```bash
cd /var/www/physioward/backend/physioward-backend

# Backup the existing source first
cp -r src "src.backup-$(date +%Y%m%d-%H%M%S)"
cp package.json "package.json.backup-$(date +%Y%m%d-%H%M%S)"

# Extract — overwrites src/ in place, no need to delete first
tar -xzf /tmp/backend-src.tar.gz

# Reinstall deps (only changes anything if package-lock.json differs)
npm ci

# Build TypeScript → dist/
npm run build

# Restart PM2 (under the physioward user — see Section 7 for the gotcha)
sudo -u physioward HOME=/var/www/physioward PM2_HOME=/var/www/physioward/.pm2 \
  pm2 restart physioward-backend --update-env
```

**Verify all routes are registered after restart:**

```bash
for path in /api/health /api/dropouts /api/users /api/case-acceptance /api/audit-log /api/dashboard/clinics; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "https://api.physioward.com.au$path")
  echo "$path -> HTTP $code"
done
```

Expected:

- `/api/health` → 200 (public)
- everything else → 401 (route exists, auth-required)

A 404 on the auth-protected routes means the route module didn't load —
go re-check `src/index.ts` and the build output.

---

## 7. PM2 — the dual-daemon gotcha

This is the sharpest tripwire on this server. It cost an hour of
debugging, so write it down.

**Two PM2 daemons run on this VPS:**

| Daemon          | OS user      | `PM2_HOME`                   | Manages              |
| --------------- | ------------ | ---------------------------- | -------------------- |
| Root daemon     | `root`       | `/root/.pm2`                 | `aegira-api`         |
| PhysioWard daemon | `physioward` | `/var/www/physioward/.pm2`   | `physioward-backend` |

A bare `pm2 list` shown over an SSH session (logged in as `root`) hits
the **root** daemon — which only sees `aegira-api`. It will say
`physioward-backend` does not exist, even though it is running fine
under the other daemon.

**To talk to the right daemon:**

```bash
sudo -u physioward HOME=/var/www/physioward PM2_HOME=/var/www/physioward/.pm2 \
  pm2 list
sudo -u physioward HOME=/var/www/physioward PM2_HOME=/var/www/physioward/.pm2 \
  pm2 restart physioward-backend --update-env
sudo -u physioward HOME=/var/www/physioward PM2_HOME=/var/www/physioward/.pm2 \
  pm2 logs physioward-backend --lines 50 --nostream
sudo -u physioward HOME=/var/www/physioward PM2_HOME=/var/www/physioward/.pm2 \
  pm2 save
```

The `HOME=` and `PM2_HOME=` variables both matter — without them, PM2
falls back to root's `~/.pm2` and you end up controlling the wrong
daemon.

**Convenience wrapper (optional — drop into `/root/.bashrc`):**

```bash
alias pm2pw='sudo -u physioward HOME=/var/www/physioward PM2_HOME=/var/www/physioward/.pm2 pm2'
# usage: pm2pw list    pm2pw restart physioward-backend    pm2pw logs physioward-backend
```

**`--update-env` is important when restarting after `.env` changes.** PM2
caches the environment from the moment the process was first launched.
A plain `pm2 restart` re-uses that cached env, even if `.env` on disk
has changed. With `--update-env`, PM2 refreshes from the current shell
env before respawning, and the app's `dotenv.config()` then reads the
new `.env` values. (Alternative: `pm2 delete <name>` followed by
`pm2 start ecosystem.config.cjs` always picks up a fresh env.)

**How to confirm which daemon owns a process:**

```bash
ps -ef | grep -E 'physioward-backend|aegira' | grep -v grep
# look at the user column (root vs physiow+) and the parent PID:
ps -o pid,ppid,user,cmd -p <PID>
```

A parent of `PM2 v6.0.14: God Daemon (/var/www/physioward/.pm2)` means
the physioward daemon. `(/root/.pm2)` means the root daemon.

---

## 8. End-to-end verification (run anytime)

```bash
# 1. Backend health (public)
curl -s https://api.physioward.com.au/api/health
# expect: {"status":"ok","timestamp":"..."}

# 2. CORS reflection — Vercel origin should be echoed back
curl -sI -X OPTIONS https://api.physioward.com.au/api/health \
  -H 'Origin: https://frontend-flax-five-43.vercel.app' \
  -H 'Access-Control-Request-Method: GET' \
  | grep -i access-control-allow-origin
# expect: Access-Control-Allow-Origin: https://frontend-flax-five-43.vercel.app

# 3. CORS rejection — random origin gets NO Allow-Origin header
curl -sI -X OPTIONS https://api.physioward.com.au/api/health \
  -H 'Origin: https://evil.example.com' \
  -H 'Access-Control-Request-Method: GET' \
  | grep -i access-control-allow-origin
# expect: (empty — no Allow-Origin line)

# 4. PM2 process status
sudo -u physioward HOME=/var/www/physioward PM2_HOME=/var/www/physioward/.pm2 \
  pm2 list
# expect: physioward-backend online

# 5. Database row counts
sudo -u postgres psql -d nookal -c "
  SELECT 'users=' || COUNT(*) FROM users
  UNION ALL SELECT 'patient_dropouts=' || COUNT(*) FROM patient_dropouts
  UNION ALL SELECT 'case_acceptances=' || COUNT(*) FROM case_acceptances
  UNION ALL SELECT 'audit_log=' || COUNT(*) FROM audit_log;
"
# expect: users=19, patient_dropouts=722, audit_log=8 (case_acceptances may grow)

# 6. Browser smoke test
# Open https://frontend-flax-five-43.vercel.app, log in as
# sam@physioward.com.au, confirm dashboard + dropouts list render.
```

---

## 9. Known minor issues (not blocking)

- **`express-rate-limit` warns about `X-Forwarded-For`.** The error log
  shows `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` because the app is behind
  Nginx but `app.set('trust proxy', 1)` is not set in `src/index.ts`.
  Functionally fine; rate-limit just sees the Nginx loopback IP for
  every request. Fix later by adding `app.set('trust proxy', 1);` after
  `const app = express();`.

- **Two leftover `src.backup-*` directories** on the server from the
  source refresh (Section 6). Delete after a couple of weeks of
  uneventful operation:
  `cd /var/www/physioward/backend/physioward-backend && rm -rf src.backup-*`

- **`CEO_PASSWORD` is still the seeded `ChangeMe123!`** — change in-app
  after first login.

- **Daily Postgres backup cron** is still not scheduled. The
  `/var/backups/physioward/ubuntu-pre-migration-*.sql` from this session
  is a one-off, not an ongoing backup.

---

## 10. Quick reference — common day-2 commands

```bash
# Connect
ssh root@api.physioward.com.au

# Tail backend logs
sudo -u physioward HOME=/var/www/physioward PM2_HOME=/var/www/physioward/.pm2 \
  pm2 logs physioward-backend

# Restart backend (with fresh env from .env)
sudo -u physioward HOME=/var/www/physioward PM2_HOME=/var/www/physioward/.pm2 \
  pm2 restart physioward-backend --update-env

# Edit .env (e.g. add a new allowed origin)
sudo nano /var/www/physioward/backend/physioward-backend/.env
# then restart with --update-env (above)

# Manual ad-hoc DB backup
sudo -u postgres pg_dump nookal > \
  /var/backups/physioward/manual-$(date +%Y%m%d-%H%M%S).sql

# Re-deploy frontend after a change
cd "D:\New folder (7)\PhysioWard_v2\physioward-v2\frontend"
vercel --prod --yes --scope gios-projects-3753c34c

# Re-deploy backend source (full src refresh)
# 1. Tar from Windows (see Section 6)
# 2. scp to /tmp/backend-src.tar.gz
# 3. On server: cd app dir, backup, extract, npm ci, npm run build,
#    pm2 restart with --update-env
```
