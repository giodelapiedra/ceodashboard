# PhysioWard Backend — Ubuntu Side-by-Side Deployment Guide

Deploy the Node/Express + PostgreSQL backend to a self-managed Ubuntu server
that **already runs an unrelated production app** (in our case `aegira` at
`/var/www/aegira/backend/aegira-backend/`).

The whole guide mirrors the aegira folder pattern (`/var/www/<app>/backend/<app>-backend/`)
so PhysioWard sits next to it cleanly — separate folder, separate system
user, separate database, separate Nginx site, separate PM2 process,
separate port. Following the steps in order means aegira (or any other app
on the box) is **never** modified.

Tested against Ubuntu 22.04 LTS and 24.04 LTS. Assumes you have SSH access
and sudo on the box.

---

## 0. What you are deploying

| Thing             | Value                                                                |
| ----------------- | -------------------------------------------------------------------- |
| Runtime           | Node.js 20 LTS                                                       |
| Language          | TypeScript (built to `dist/` via `npm run build`)                    |
| Framework         | Express 4                                                            |
| Database          | PostgreSQL 14+ (database name `nookal`)                              |
| Listens on        | `PORT=3001` (loopback only — Nginx proxies to it)                    |
| Process manager   | PM2 via `ecosystem.config.cjs` (mirrors the aegira pattern)          |
| External services | Nookal API v2 (REST) + v3 (GraphQL)                                  |
| Public entrypoint | `https://api.physioward.com.au` → Nginx → `127.0.0.1:3001`           |
| App directory     | `/var/www/physioward/backend/physioward-backend/`                    |
| System user       | `physioward` (separate from whatever runs aegira)                    |

The backend runs migrations automatically on boot (`src/index.ts` calls
`runMigrations()` then `seedInitialUser()`), so you do **not** need to run
`npm run db:migrate` manually the first time.

> **PORT and DB name are defaults.** If the coexistence check (Section 1)
> shows that `:3001` or a database called `nookal` is already in use,
> substitute different values and use them everywhere below (e.g. `3002`,
> `nookal_pw`).

---

## 1. Coexistence check — map the existing server FIRST

Before changing anything on the box, run this **read-only** diagnostic. It
tells you which ports / DBs / Nginx sites are already taken so PhysioWard
doesn't collide with them.

SSH to the server as a sudo user, then run:

```bash
echo "=== 1. PM2 list ==="                && pm2 list
echo "=== 2. Listening TCP ports ==="     && sudo ss -tlnp
echo "=== 3. Postgres databases ==="      && sudo -u postgres psql -c '\l'
echo "=== 4. Postgres roles ==="          && sudo -u postgres psql -c '\du'
echo "=== 5. Nginx sites enabled ==="     && ls -lah /etc/nginx/sites-enabled/
echo "=== 6. SSL certificates ==="        && sudo certbot certificates 2>/dev/null
echo "=== 7. Server specs ===" && \
  echo "OS: $(lsb_release -d | cut -f2)" && \
  echo "Node: $(node --version 2>/dev/null || echo 'not installed')" && \
  echo "RAM: $(free -h | awk '/^Mem:/ {print $2}')" && \
  echo "Disk: $(df -h / | awk 'NR==2 {print $4 " free of " $2}')"
```

### What to look for in the output

| Output line                              | Action                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| `pm2 list` shows `aegira-api online`     | Existing app confirmed — leave it alone. PhysioWard's name will be `physioward-backend` |
| `ss -tlnp` shows `:3001` LISTEN          | Port 3001 taken — pick `3002` (or any free port). Update `PORT=` in `.env` and the Nginx `proxy_pass` |
| `psql \l` lists database `nookal`        | DB name collision — use a different name (e.g. `nookal_pw`) and update `DATABASE_URL` |
| `psql \du` lists role `physioward`       | Role exists already — skip the `CREATE USER` in 2.4 (or pick another role name) |
| `sites-enabled/` contains aegira files   | Existing Nginx site — yours will be a NEW file `physioward-api`, never overwritten |
| `certbot certificates` lists other certs | Certs are per-domain — adding `api.physioward.com.au` doesn't affect them       |
| `Node: not installed`                    | Install in 2.2. If installed, must be v20.x — older won't work                  |
| `RAM: < 2 GB free`                       | Tight for two Node apps + Postgres. Add swap or upsize the VPS                  |

Write down the values you'll use **before** moving on:

```
PhysioWard PORT       = ____    (must NOT clash with ss -tlnp output)
PhysioWard DB name    = ____    (must NOT exist in psql \l output)
PhysioWard PM2 name   = physioward-backend
PhysioWard app dir    = /var/www/physioward/backend/physioward-backend
PhysioWard system user = physioward
PhysioWard hostname   = api.physioward.com.au
```

The defaults below assume `PORT=3001` and DB name `nookal`. Substitute if
you chose otherwise.

---

## 2. Prepare the server

SSH as a sudo user.

> **Skip Decision Matrix** — most of this section is "install only if
> missing". Re-installing things aegira already uses can break it. Run
> the **CHECK FIRST** command at the start of each subsection; if the
> tool is already there, skip the install.

| Tool        | Check command              | If output appears, do this |
| ----------- | -------------------------- | -------------------------- |
| Node.js 20  | `node --version`           | If `v20.x`, skip 2.2 entirely. If older (v18/v16), DO NOT auto-upgrade — coordinate with aegira owner first |
| PostgreSQL  | `systemctl is-active postgresql` | If `active`, skip 2.3 install. Just create the new role + DB in 2.4 |
| Nginx       | `systemctl is-active nginx`      | If `active`, skip 6.1 install |
| certbot     | `which certbot`            | If a path prints, skip 6.1 install |
| PM2         | `which pm2`                | If a path prints, skip 5.1 install |
| UFW         | `sudo ufw status`          | If "active", skip `ufw enable` (just `ufw allow ...`) |
| git, curl   | `which git curl`           | If both paths print, skip the apt install |

### 2.1 Update package metadata only (NO apt upgrade)

```bash
sudo apt update
```

> **Do NOT run `apt upgrade`.** It will pull new versions of packages
> aegira depends on (libc, openssl, postgresql, nginx) and can require
> service restarts. Schedule full upgrades during a maintenance window
> with the aegira owner — not during this deploy.

Install only the small CLI tools, and only if missing:

```bash
# CHECK FIRST: which git curl
# (if both paths print, skip this install)

sudo apt install -y --no-install-recommends curl git ca-certificates gnupg
```

`build-essential` is only needed if `npm ci` later complains about native
addon compilation. Don't install it preemptively.

### 2.2 Install Node.js 20 (only if missing)

```bash
# CHECK FIRST:
node --version 2>/dev/null || echo "not installed"
```

| `node --version` output | What to do                                                                 |
| ----------------------- | -------------------------------------------------------------------------- |
| `v20.x.x`               | **Skip the rest of 2.2.** You're done.                                     |
| `v18.x.x` or older      | **STOP.** Do not auto-upgrade — aegira may depend on it. Talk to its owner first, or run PhysioWard with `nvm` in a side-by-side install. |
| `v22.x` or newer        | Probably fine, but verify `npm ci` works in 4.1 before continuing          |
| `not installed`         | Run the install below                                                      |

Only if Node is missing:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version       # should print v20.x
npm --version
```

### 2.3 PostgreSQL — create role + DB only (do NOT reinstall)

```bash
# CHECK FIRST:
systemctl is-active postgresql
```

| Output      | What to do                                                                           |
| ----------- | ------------------------------------------------------------------------------------ |
| `active`    | **Skip the install.** PostgreSQL is already running (likely for aegira). Go to 2.4. |
| `inactive`  | Service exists but stopped — start it: `sudo systemctl start postgresql`             |
| `unknown` / `not-found` | PostgreSQL isn't installed. Install it:                                  |

```bash
# Only run this if "is-active" said unknown / not-found:
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable --now postgresql
sudo systemctl status postgresql      # should show "active (running)"
```

> **DO NOT run `sudo apt install -y postgresql` if Postgres is already
> running.** apt may upgrade it to a newer minor version and trigger a
> restart, which briefly drops aegira's DB connections.

### 2.4 Create the PostgreSQL role + database

#### 2.4.1 Generate a strong DB password (save it somewhere)

```bash
openssl rand -base64 24
```

Sample output: `Xy9K2pQrM7vN8wT4hL5jB1cD3fG6sR0u`. **Copy it** — you'll
paste it into the `CREATE USER` statement below and into `.env` later.

#### 2.4.2 Create the role + database

Replace `PASTE_PASSWORD_HERE` with the password from 2.4.1.

```bash
sudo -u postgres psql <<SQL
CREATE USER physioward WITH PASSWORD 'PASTE_PASSWORD_HERE';
CREATE DATABASE nookal OWNER physioward;
GRANT ALL PRIVILEGES ON DATABASE nookal TO physioward;
SQL
```

Expected:
```
CREATE ROLE
CREATE DATABASE
GRANT
```

If you get `ERROR: database "nookal" already exists` (because the existing
app uses that name), retry with a different DB name:

```bash
sudo -u postgres psql -c "CREATE DATABASE nookal_pw OWNER physioward;"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE nookal_pw TO physioward;"
```

…and use `nookal_pw` in `DATABASE_URL` later.

#### 2.4.3 Verify the connection

```bash
psql "postgres://physioward:PASTE_PASSWORD_HERE@localhost:5432/nookal" -c '\conninfo'
```

Expected:
```
You are connected to database "nookal" as user "physioward" on host "localhost"...
```

If it fails with `password authentication failed`, your Postgres is using
`peer` auth for local connections. Fix it:

```bash
# find the version directory:
ls /etc/postgresql/
# example output: 14   →  use 14 in the next path

sudo nano /etc/postgresql/14/main/pg_hba.conf
```

Find this line:
```
local   all             all                                     peer
```

Insert these two lines **before** it (so role-specific rules match first):
```
local   nookal          physioward                              md5
host    nookal          physioward      127.0.0.1/32            md5
```

(Substitute `nookal_pw` if you used that name.)

```bash
sudo systemctl reload postgresql
```

Re-run the verification — `\conninfo` should now succeed.

#### 2.4.4 Confirm aegira (or other apps) still work

```bash
pm2 restart aegira-api
sleep 3
pm2 logs aegira-api --lines 30 --nostream
```

If aegira boots clean (no new errors), the Postgres changes are safe.

### 2.5 Firewall (UFW)

Only expose SSH + HTTP + HTTPS. Keep ports 3001 and 5432 private. **If
UFW is already active for the existing app, do NOT re-run `ufw enable`** —
just verify the rules:

```bash
sudo ufw status

# Add only if missing:
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'     # 80 + 443
# sudo ufw enable               # only if status was "inactive"
```

### 2.6 Create the dedicated system user (mirrors aegira pattern)

aegira runs under its own `aegira` system user. Same approach for
PhysioWard — separate identity, can't read/write into aegira's files.

```bash
sudo adduser --system --group --shell /bin/bash --home /var/www/physioward physioward
```

Verify:
```bash
id physioward
# expected: uid=XXX(physioward) gid=XXX(physioward) groups=XXX(physioward)
```

### 2.7 Create the folder structure (mirrors `/var/www/<app>/backend/<app>-backend/`)

```bash
sudo mkdir -p /var/www/physioward/backend/physioward-backend
sudo chown -R physioward:physioward /var/www/physioward
sudo chmod 755 /var/www/physioward
```

Verify:
```bash
ls -lah /var/www/ | grep -E "physioward|aegira"
# expected: both folders listed; physioward owned by physioward:physioward
```

From here on, anything that touches PhysioWard code runs as the
`physioward` user (NOT root, NOT the user that runs aegira):

```bash
sudo -iu physioward
```

---

## 3. Get the code onto the server

Pick ONE option. If your repo is private, use Option A.

### Option A — clone from Git (recommended)

As the `physioward` user:

```bash
cd /var/www/physioward/backend
rm -rf physioward-backend            # remove the empty placeholder dir
git clone https://github.com/YOUR_ORG/physioward-v2.git physioward-backend-tmp
mv physioward-backend-tmp/backend/* physioward-backend/
mv physioward-backend-tmp/backend/.[!.]* physioward-backend/ 2>/dev/null
rm -rf physioward-backend-tmp
cd physioward-backend
ls -lah                              # should show package.json, src/, tsconfig.json, .env.example
```

If the repo is private, set up a deploy key:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ''
cat ~/.ssh/id_ed25519.pub
```

Paste the public key into GitHub → Settings → Deploy keys (read-only is fine).

### Option B — rsync from your Windows dev machine

From PowerShell on your dev machine (not on the server):

```powershell
$SERVER = "youruser@your.server.ip"

rsync -avz --exclude node_modules --exclude dist --exclude .env `
  "D:/New folder (7)/PhysioWard_v2/physioward-v2/backend/" `
  "${SERVER}:/var/www/physioward/backend/physioward-backend/"
```

Then on the server, fix ownership (rsync as your sudo user — files end up
owned by you, not by `physioward`):

```bash
sudo chown -R physioward:physioward /var/www/physioward
```

Windows rsync: install via `winget install cwRsync` or use WSL.

---

## 4. Configure + build the backend

As the `physioward` user, in `/var/www/physioward/backend/physioward-backend`:

### 4.1 Install dependencies

```bash
npm ci                    # uses package-lock.json — fast + reproducible
```

### 4.2 Create `.env`

```bash
cp .env.example .env
nano .env
```

Fill these in — the app refuses to start if any are invalid (zod check in
`src/config/env.ts`):

```
NODE_ENV=production
PORT=3001                                       # change if 3001 is taken
FRONTEND_URL=https://app.physioward.com.au      # exact origin of the React app

DATABASE_URL=postgres://physioward:PASTE_PASSWORD_HERE@localhost:5432/nookal
                                                # use nookal_pw if you renamed it

NOOKAL_API_KEY=<v2 key from Nookal>
NOOKAL_BASE_URL=https://api.nookal.com/production/v2
NOOKAL_LOCATION_NEWPORT=<id>
NOOKAL_LOCATION_NARRABEEN=<id>
NOOKAL_LOCATION_BROOKVALE=<id>

NOOKAL_V3_BASE_URL=https://au-apiv3.nookal.com
NOOKAL_V3_CLIENT_ID=<v3 client id>
NOOKAL_V3_CLIENT_SECRET=<v3 Basic Key>
NOOKAL_V3_LOCATION_NEWPORT=1
NOOKAL_V3_LOCATION_NARRABEEN=2
NOOKAL_V3_LOCATION_BROOKVALE=6

CEO_EMAIL=sam@physioward.com.au
CEO_PASSWORD=<strong password — change in-app after first login>

JWT_SECRET=<paste output of: openssl rand -base64 48>
JWT_EXPIRES_IN=15m

SNAPSHOT_TTL_MINUTES=60
```

Generate the JWT secret:
```bash
openssl rand -base64 48
```

Lock down the file so only the app user can read it:
```bash
chmod 600 .env
```

### 4.3 Build TypeScript

```bash
npm run build
```

This produces `dist/` and copies `src/db/migrations/` into
`dist/db/migrations/` (see the `build` script in `package.json`).

### 4.4 Smoke test

```bash
npm start
```

Expected output:
```
[db] migrations up to date
[db] seeded CEO user: sam@physioward.com.au
🚀 PhysioWard Backend — http://localhost:3001
```

In a second terminal on the server:
```bash
curl http://127.0.0.1:3001/api/health
# → {"status":"ok","timestamp":"..."}
```

Sanity check — confirm aegira is unaffected:
```bash
pm2 status                   # aegira-api should still say "online"
```

Stop PhysioWard with `Ctrl+C`. Next step runs it under PM2.

---

## 5. Run as a service (PM2 + ecosystem.config.cjs — mirrors aegira)

### 5.1 PM2 — likely already installed (do NOT reinstall)

```bash
# CHECK FIRST:
which pm2 && pm2 --version
```

| Output                      | What to do                                                |
| --------------------------- | --------------------------------------------------------- |
| Path + version (e.g. 5.x)   | **Skip the install.** PM2 is already there for aegira.    |
| `pm2 not found`             | Install it:                                               |

```bash
# Only if pm2 was not found:
sudo npm install -g pm2
```

> **DO NOT reinstall PM2** if it's already running aegira. `npm install -g
> pm2` would pull a newer version which can change CLI flags and the
> daemon protocol — aegira's running daemon may stop accepting
> commands until you run `pm2 update`, which forcibly restarts ALL apps.

### 5.2 Create `ecosystem.config.cjs`

aegira uses an `ecosystem.config.cjs` — same approach for PhysioWard, kept
in the same folder as the code.

As the `physioward` user, in `/var/www/physioward/backend/physioward-backend`:

```bash
nano ecosystem.config.cjs
```

Paste:

```js
module.exports = {
  apps: [
    {
      name: 'physioward-backend',
      script: './dist/index.js',
      cwd: '/var/www/physioward/backend/physioward-backend',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
      time: true,
      max_memory_restart: '500M',
      error_file: '/var/www/physioward/logs/error.log',
      out_file:   '/var/www/physioward/logs/out.log',
      merge_logs: true,
      autorestart: true,
    },
  ],
};
```

Create the logs directory:
```bash
mkdir -p /var/www/physioward/logs
```

### 5.3 Start PhysioWard under PM2

```bash
cd /var/www/physioward/backend/physioward-backend
pm2 start ecosystem.config.cjs
pm2 save
```

Confirm BOTH apps are running:

```bash
pm2 status
```

Expected:
```
┌──────┬──────────────────────┬──────────┬──────┬────────┬─────────┬───────┐
│ id   │ name                 │ mode     │ pid  │ status │ cpu     │ mem   │
├──────┼──────────────────────┼──────────┼──────┼────────┼─────────┼───────┤
│ 0    │ aegira-api           │ fork     │ ...  │ online │ ...     │ ...   │
│ 1    │ physioward-backend   │ fork     │ ...  │ online │ ...     │ ...   │
└──────┴──────────────────────┴──────────┴──────┴────────┴─────────┴───────┘
```

If `pm2 startup` was already configured for aegira on this box, you don't
need to re-run it — `pm2 save` is enough; both processes auto-start on
reboot. If this is the first time PM2 has been used:

```bash
pm2 startup systemd -u physioward --hp /var/www/physioward
```

Useful commands:
```bash
pm2 status
pm2 logs physioward-backend --lines 100
pm2 restart physioward-backend
pm2 stop physioward-backend
```

---

## 6. Nginx reverse proxy + HTTPS

The backend listens on `127.0.0.1:3001` (loopback). Nginx terminates TLS
and forwards to it. PhysioWard's config goes in a **brand-new file** —
existing Nginx sites (e.g. for aegira) are not modified.

### 6.1 Nginx + certbot — likely already installed (do NOT reinstall)

```bash
# CHECK FIRST:
systemctl is-active nginx
which certbot
ls /etc/nginx/sites-available/ 2>/dev/null | head -5
```

| Output                                         | What to do                                                   |
| ---------------------------------------------- | ------------------------------------------------------------ |
| `nginx: active` AND `certbot` path exists      | **Skip the install entirely.** Both are already there.       |
| `nginx: active` only                           | Install only certbot: `sudo apt install -y certbot python3-certbot-nginx` |
| Neither found                                  | Install both (only do this if aegira does NOT use Nginx):    |

```bash
# Only if neither is installed:
sudo apt install -y nginx certbot python3-certbot-nginx
```

> **DO NOT run `apt install nginx`** if it's already serving aegira. apt
> may pull a new minor version and `systemctl restart nginx` runs as part
> of the upgrade — that's a few-second outage for aegira's traffic.

### 6.2 Point DNS

In your DNS provider (where physioward.com.au is registered), create:

```
api.physioward.com.au    A    <server public IP>
```

Wait 1–10 minutes, then verify from your laptop:
```
nslookup api.physioward.com.au
```
The IP returned must match your server's public IP.

### 6.3 New site config (does NOT touch existing sites)

```bash
sudo nano /etc/nginx/sites-available/physioward-api
```

Paste:

```nginx
server {
    listen 80;
    server_name api.physioward.com.au;

    # Allow certbot to write HTTP-01 challenge files
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        proxy_pass         http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # Cookies (refresh token) need these
        proxy_set_header   Upgrade           $http_upgrade;
        proxy_set_header   Connection        "upgrade";

        proxy_read_timeout 60s;
        client_max_body_size 2m;
    }
}
```

Enable + reload. **`nginx -t` MUST pass before reloading** — a broken
config breaks ALL sites including aegira:

```bash
sudo ln -s /etc/nginx/sites-available/physioward-api /etc/nginx/sites-enabled/
sudo nginx -t                  # must say "syntax is ok" + "test is successful"
sudo systemctl reload nginx
```

If `nginx -t` fails, **do NOT reload**. Fix the config first, or roll back:
```bash
sudo rm /etc/nginx/sites-enabled/physioward-api
```

Quick check from your laptop (HTTP, before TLS):
```
curl http://api.physioward.com.au/api/health
```

Confirm aegira's domain still responds too — if it doesn't, immediately
roll back.

### 6.4 Get an HTTPS certificate

Pass **only** `-d api.physioward.com.au` so certbot doesn't touch existing
certs (each cert is per-domain, fully isolated):

```bash
sudo certbot --nginx -d api.physioward.com.au
```

Certbot auto-edits the new config to add TLS and the 80→443 redirect.
Auto-renew is installed as a systemd timer:
```bash
systemctl list-timers | grep certbot
```

Verify end-to-end:
```
curl https://api.physioward.com.au/api/health
```

---

## 7. Frontend (brief)

The backend is now live. For the React frontend:

- Build on your machine or on the server: `cd frontend && npm ci && npm run build`
- Serve `frontend/dist/` from a separate Nginx server block (e.g.
  `app.physioward.com.au`) as static files.
- Frontend must call `https://api.physioward.com.au/api/...` and
  `FRONTEND_URL` in the backend `.env` must match the frontend origin
  exactly (CORS uses it with `credentials: true`).

If you want, I can write a separate frontend deploy guide — just ask.

---

## 8. Day-two operations

### Deploying updates

As the `physioward` user:

```bash
cd /var/www/physioward/backend/physioward-backend
git pull          # if using git
npm ci
npm run build
pm2 restart physioward-backend
```

Migrations in new `src/db/migrations/*.sql` files run automatically on
restart.

### Viewing logs

```bash
pm2 logs physioward-backend --lines 200
# or, raw log files:
tail -f /var/www/physioward/logs/out.log
tail -f /var/www/physioward/logs/error.log
```

### Database backup

Daily `pg_dump` to a local folder. As the `physioward` user, run
`crontab -e` and add:

```
15 3 * * * pg_dump -Fc "postgres://physioward:PASSWORD@localhost:5432/nookal" \
  > /var/www/physioward/backups/nookal-$(date +\%F).dump && \
  find /var/www/physioward/backups -name 'nookal-*.dump' -mtime +14 -delete
```

Create the backups dir first:
```bash
mkdir -p /var/www/physioward/backups
```

### Rotating the JWT secret

Changing `JWT_SECRET` invalidates all issued tokens (everyone has to log
in again). Do this if you suspect a leak:

```bash
openssl rand -base64 48              # copy output
nano .env                            # replace JWT_SECRET
pm2 restart physioward-backend
```

---

## 9. Troubleshooting

| Symptom                                      | Check this                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| App exits with "Invalid environment config"  | A var in `.env` is missing or wrong. Error lists which.                    |
| `ECONNREFUSED 127.0.0.1:5432`                | PostgreSQL isn't running. `sudo systemctl status postgresql`.              |
| `password authentication failed`             | `DATABASE_URL` password wrong, or pg_hba.conf still set to `peer`. See 2.4.3. |
| `EADDRINUSE :::3001`                         | Another app already binds 3001. Pick a free port (Section 1's `ss -tlnp`). |
| 502 Bad Gateway from Nginx                   | Backend is down. `pm2 status` / `pm2 logs physioward-backend`.             |
| CORS error in browser console                | `FRONTEND_URL` in `.env` doesn't exactly match the frontend origin.        |
| Login works then dies on refresh             | Refresh cookie blocked — verify HTTPS is on and `SameSite` isn't an issue. |
| Migrations didn't run                        | Check boot logs — you want `[db] migrations up to date`.                   |
| aegira went down after Nginx reload          | Roll back the symlink and reload Nginx — see Section 12.                   |
| `permission denied` writing to logs          | `chown -R physioward:physioward /var/www/physioward/logs`                  |

Find which process owns a port:
```bash
sudo ss -tlnp | grep 3001
```

---

## 10. Hardening checklist (do before going live)

- [ ] `.env` is `chmod 600` and owned by `physioward`
- [ ] `CEO_PASSWORD` from `.env` is changed in-app after first login
- [ ] `JWT_SECRET` is ≥ 32 chars and unique per environment
- [ ] UFW only exposes 22 / 80 / 443
- [ ] PostgreSQL listens on `localhost` only — `sudo ss -tlnp | grep 5432`
      should show `127.0.0.1:5432`, NOT `0.0.0.0:5432`
- [ ] `NODE_ENV=production` in `.env` (error responses hide stack traces)
- [ ] Certbot auto-renew timer is active
- [ ] Daily `pg_dump` cron is in place
- [ ] SSH: disable password auth, key-only (`/etc/ssh/sshd_config` →
      `PasswordAuthentication no`, then `sudo systemctl reload ssh`)
- [ ] PhysioWard runs as `physioward` user, NOT root (`pm2 list` "user"
      column — separate from however aegira runs)

---

## 11. Quick reference

```bash
# Tail live logs
pm2 logs physioward-backend

# Restart after code change
cd /var/www/physioward/backend/physioward-backend && \
  git pull && npm ci && npm run build && pm2 restart physioward-backend

# Open psql on the prod DB
psql "$(grep ^DATABASE_URL /var/www/physioward/backend/physioward-backend/.env | cut -d= -f2-)"

# Verify backend reachable
curl https://api.physioward.com.au/api/health

# Confirm both apps are still alive
pm2 status
```

---

## 12. Rollback — pull PhysioWard out without touching aegira

If you need to remove PhysioWard while leaving aegira (or other apps)
untouched:

### 12.1 Stop the PhysioWard process

```bash
pm2 stop physioward-backend
pm2 delete physioward-backend
pm2 save
```

### 12.2 Remove the Nginx site (does NOT touch other sites)

```bash
sudo rm /etc/nginx/sites-enabled/physioward-api
sudo nginx -t && sudo systemctl reload nginx
```

### 12.3 (Optional) Drop the database + role

Permanent — only do this if you're sure you don't need the data.

```bash
sudo -u postgres psql <<SQL
DROP DATABASE nookal;
DROP USER physioward;
SQL
```

### 12.4 (Optional) Remove the cert

```bash
sudo certbot delete --cert-name api.physioward.com.au
```

### 12.5 (Optional) Remove the app directory + system user

```bash
sudo rm -rf /var/www/physioward
sudo deluser --remove-home physioward
```

### Verify aegira is still healthy

```bash
pm2 status                       # aegira-api still "online"
sudo nginx -t                    # config still valid
curl http://<aegira-domain>/health
```

If everything still responds, rollback is complete. Total blast radius:
zero files outside `/var/www/physioward/`, the `physioward` Postgres role,
and the `physioward-api` Nginx site.
