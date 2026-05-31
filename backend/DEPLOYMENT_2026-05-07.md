# PhysioWard Backend — Production Deployment Record

**Date:** 2026-05-07
**Deployed by:** Sam (sam@physioward.com.au)
**Status:** ✅ LIVE at `https://api.physioward.com.au` — co-existing with `aegira`
**Deployment guide reference:** `DEPLOY_UBUNTU.md` (forward-looking how-to)
**This document:** record of what actually happened during the live deploy

---

## 1. Server overview

| Property              | Value                                                |
| --------------------- | ---------------------------------------------------- |
| Provider              | Hostinger VPS                                        |
| Hostname              | `srv1206713`                                         |
| Public IP             | `72.62.66.29`                                        |
| OS                    | Ubuntu 24.04 LTS                                     |
| PostgreSQL            | 16 (already installed for `aegira`)                  |
| Node.js               | 20.x (already installed for `aegira`)                |
| PM2                   | already installed for `aegira`                       |
| Nginx                 | already installed (status to confirm in next phase)  |

**Pre-existing app on this box:** `aegira` at `/var/www/aegira/backend/aegira-backend/`,
PM2 process `aegira-api` running as `root`. **Not modified during PhysioWard deploy.**

---

## 2. Resources created for PhysioWard (all isolated from aegira)

| Resource              | Value                                                       |
| --------------------- | ----------------------------------------------------------- |
| System user           | `physioward` (system, group, shell `/bin/bash`)             |
| App home              | `/var/www/physioward/`                                      |
| Backend code path     | `/var/www/physioward/backend/physioward-backend/`           |
| Logs path             | `/var/www/physioward/logs/`                                 |
| PostgreSQL role       | `physioward`                                                |
| PostgreSQL database   | `nookal`                                                    |
| Listening port        | `127.0.0.1:3001` (loopback only, Nginx proxies later)       |
| PM2 process name      | `physioward-backend`                                        |
| PM2 ecosystem config  | `/var/www/physioward/backend/physioward-backend/ecosystem.config.cjs` |
| Public hostname       | `api.physioward.com.au` (DNS + Nginx + cert: not yet done)  |

---

## 3. Credentials in use (where to find each value, NOT the value itself)

All actual secrets live in `.env` on the server at
`/var/www/physioward/backend/physioward-backend/.env` (chmod 600, owned by
`physioward`). Never commit this file to git.

| Variable                    | Source                                                      |
| --------------------------- | ----------------------------------------------------------- |
| `DATABASE_URL`              | password generated on server via `openssl rand -hex 24`     |
| `NOOKAL_API_KEY`            | placeholder — Nookal v2 REST not used yet                   |
| `NOOKAL_LOCATION_*`         | from Nookal v2 (1 / 2 / 6)                                  |
| `NOOKAL_V3_CLIENT_ID`       | Nookal v3 Setup → Connections → GraphQL                     |
| `NOOKAL_V3_CLIENT_SECRET`   | Nookal v3 "Basic Key" — passed verbatim, do NOT re-base64   |
| `NOOKAL_V3_LOCATION_*`      | from v3 `locations` query (1 / 2 / 6)                       |
| `CEO_EMAIL` / `CEO_PASSWORD`| seeded once on first boot — change in-app after first login |
| `JWT_SECRET`                | imported from local dev `.env` (rotate via `openssl rand -base64 48` if leaked) |

---

## 4. Working command sequence (the path that succeeded)

These are the commands that actually worked, in order. Failed attempts and
retries during the live session are not included.

### 4.1 Database

```bash
# As root, generate password
openssl rand -hex 24
# (saved as 4c7d12f5931f6714dd6607305d205c932017b97e70b65855)

# Create role + DB (heredoc avoids line-wrap issues)
sudo -u postgres psql <<'SQL'
ALTER USER physioward WITH PASSWORD '<hex-from-openssl>';
SQL

sudo -u postgres psql -c "CREATE DATABASE nookal OWNER physioward;"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE nookal TO physioward;"

# Test connection (TCP, not socket — avoids peer auth)
psql -h 127.0.0.1 -U physioward nookal
# (paste password at prompt; \q to exit)
```

### 4.2 System user + folders (mirrors aegira pattern `/var/www/<app>/backend/<app>-backend/`)

```bash
sudo useradd -r -U -d /var/www/physioward -s /bin/bash physioward
sudo mkdir -p /var/www/physioward/backend/physioward-backend
sudo mkdir -p /var/www/physioward/logs
sudo chown -R physioward:physioward /var/www/physioward
```

### 4.3 Get the code

```bash
# As root, in /var/www/physioward/backend/
git clone https://github.com/giodelapiedra/CEO-DASHBOARD.git
mv CEO-DASHBOARD/backend physioward-backend
rm -rf CEO-DASHBOARD
chown -R physioward:physioward /var/www/physioward
```

### 4.4 Switch to physioward + install

```bash
sudo -iu physioward
cd /var/www/physioward/backend/physioward-backend
npm ci
```

### 4.5 Build the .env file

The trick that worked: set long values into shell variables first (each variable
on a short line, no risk of paste line-wrap), then heredoc with unquoted EOF
expands them.

```bash
# Set short variables first
DBPASS='<hex-from-step-4.1>'
V3A='mTGX6s+Ee4+oeDRQ2QcsSJLT9wQOmRqCciREENoc'
V3B='Sg7tMTqT7pXhgdOXBCsW3NXVqv1U8k5HzoCqZjQ0SPQtMg=='
V3SEC="${V3A}${V3B}"
JWTA='xplYUhBLL14xJX5Ob+HXFwmLtwUr4AQK'
JWTB='IaRtM5ibAXwnaggbzAHxVQSlZ4FZ6wcJ'
JWT="${JWTA}${JWTB}"

# Heredoc with unquoted EOF for expansion
cat > .env <<EOF
NODE_ENV=production
PORT=3001
FRONTEND_URL=https://app.physioward.com.au

DATABASE_URL=postgres://physioward:${DBPASS}@127.0.0.1:5432/nookal
DB_POOL_MAX=10
DB_POOL_IDLE_MS=30000

NOOKAL_API_KEY=placeholder_v2_key
NOOKAL_BASE_URL=https://api.nookal.com/production/v2
NOOKAL_LOCATION_NEWPORT=1
NOOKAL_LOCATION_NARRABEEN=2
NOOKAL_LOCATION_BROOKVALE=6

NOOKAL_V3_BASE_URL=https://au-apiv3.nookal.com
NOOKAL_V3_CLIENT_ID=UWQR2PPVL4AEG4FAFALZ
NOOKAL_V3_CLIENT_SECRET=${V3SEC}
NOOKAL_V3_LOCATION_NEWPORT=1
NOOKAL_V3_LOCATION_NARRABEEN=2
NOOKAL_V3_LOCATION_BROOKVALE=6

CEO_EMAIL=sam@physioward.com.au
CEO_PASSWORD=ChangeMe123!

JWT_SECRET=${JWT}
JWT_EXPIRES_IN=15m

SNAPSHOT_TTL_MINUTES=60
EOF

chmod 600 .env
```

### 4.6 Build + smoke test

```bash
npm run build
npm start
# Expected: "🚀 PhysioWard Backend — http://localhost:3001"
# Ctrl+C to stop
```

### 4.7 Run under PM2 (mirrors aegira's ecosystem.config.cjs pattern)

```bash
cat > ecosystem.config.cjs <<'EOF'
module.exports = {
  apps: [{
    name: 'physioward-backend',
    script: './dist/index.js',
    cwd: '/var/www/physioward/backend/physioward-backend',
    instances: 1,
    exec_mode: 'fork',
    env: { NODE_ENV: 'production' },
    time: true,
    max_memory_restart: '500M',
    error_file: '/var/www/physioward/logs/error.log',
    out_file: '/var/www/physioward/logs/out.log',
    merge_logs: true,
    autorestart: true,
  }],
};
EOF

pm2 start ecosystem.config.cjs
pm2 save
```

**NOTE:** PM2 has a separate daemon per OS user. `pm2 status` as
`physioward` shows only `physioward-backend`; `pm2 status` as `root` shows
only `aegira-api`. To see both apps at once, check listening ports instead:
`ss -tlnp | grep -E ':(3000|3001)'`.

### 4.7b Auto-start on reboot (run as root)

```bash
# As root (exit out of the physioward shell first)
pm2 startup systemd -u physioward --hp /var/www/physioward
# → installs /etc/systemd/system/pm2-physioward.service, enables it

# Back as physioward, freeze the running process list
sudo -iu physioward
pm2 save
```

### 4.8 Nginx reverse proxy (new site, doesn't touch aegira's config)

As root:

```bash
cat > /etc/nginx/sites-available/physioward-api <<'EOF'
server {
    listen 80;
    server_name api.physioward.com.au;

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
        proxy_read_timeout 60s;
        client_max_body_size 2m;
    }
}
EOF

ln -sf /etc/nginx/sites-available/physioward-api /etc/nginx/sites-enabled/
nginx -t                       # MUST pass before reload
systemctl reload nginx
```

### 4.9 DNS A record + HTTPS certificate

DNS A record at the registrar (added 2026-05-07):
```
api.physioward.com.au    A    72.62.66.29
```

Certbot (interactive):

```bash
certbot --nginx -d api.physioward.com.au
# Prompts:
#  Email:        sam@physioward.com.au
#  TOS:          Y
#  EFF newsletter: N
#  Auto-redirect HTTP→HTTPS: 2 (yes)
```

Outcome: cert at `/etc/letsencrypt/live/api.physioward.com.au/`, Nginx
config auto-edited to add the 443 server block + 80→443 redirect.
Auto-renew is installed as a systemd timer.

End-to-end verification:
```bash
curl https://api.physioward.com.au/api/health
# → {"status":"ok","timestamp":"..."}
```

---

## 5. Lessons from this session — gotchas to avoid next time

### 5.1 Line-wrap when pasting commands from chat / docs

The single biggest issue during the live deploy: **long single-line commands
got newlines inserted by the chat/terminal**, which broke the command at the
shell. Affected commands:
- `psql ... -c '\conninfo'` — `-c` lost its argument
- Long `sudo adduser ...` — `--home` lost its argument
- Heredoc with long values inside (DATABASE_URL, V3 secret, JWT) — values
  got split across lines, producing a corrupt `.env`

**Mitigation that worked:** keep each shell line under ~60 chars. For long
values, store them in shell variables first (short lines), then reference
the variables inside the heredoc.

### 5.2 PostgreSQL `peer` auth blocks role login from a non-matching OS user

When connecting via local socket as the `physioward` role from the `root` OS
account, peer auth fails with `Peer authentication failed for user "physioward"`.

**Fix:** connect over TCP instead — `psql -h 127.0.0.1 -U physioward nookal`.
The `host ... 127.0.0.1/32 scram-sha-256` line in `pg_hba.conf` allows
password auth there. No `pg_hba.conf` edit needed for PostgreSQL 16.

### 5.3 `apt install` on a server with another running app

Re-running `apt install postgresql nginx pm2` for tools aegira already uses
risks pulling new minor versions and triggering service restarts that drop
aegira's connections / traffic. **For shared servers: always check first
(`systemctl is-active`, `which`, `--version`) and skip the install if the
tool is already there.** Never run `apt upgrade` during a deploy.

### 5.4 GitHub clone produces a folder named after the repo, not what you ask

`git clone <url> temp` — if the second arg gets stripped by line-wrap,
clone defaults to a folder named after the repo (`CEO-DASHBOARD/`). Always
verify with `ls` before running `mv` / `rm -rf`.

### 5.5 SCP from Windows can be flakier than expected

When `scp` from PowerShell repeatedly fails with "Permission denied" even
with the right password, fall back to building the file on-server with
shell-variable + heredoc pattern (Section 4.5). Avoids needing scp/sftp
entirely.

---

## 6. Verification — how to confirm the deploy is healthy

Run on the server (any user):

```bash
# Both apps online
pm2 status

# PhysioWard listening on 3001
sudo ss -tlnp | grep 3001

# Health check via loopback
curl http://127.0.0.1:3001/api/health
# → {"status":"ok","timestamp":"..."}

# Logs (PhysioWard)
pm2 logs physioward-backend --lines 50

# DB connectivity from app's perspective
sudo -u physioward psql "$(grep ^DATABASE_URL /var/www/physioward/backend/physioward-backend/.env | cut -d= -f2-)" -c '\dt'

# aegira still alive (sanity check — should never go offline because of us)
pm2 info aegira-api | grep status
```

---

## 7. Status — what's done vs. what's left

### Done (2026-05-07)

- [x] PostgreSQL role + DB (`physioward` / `nookal`)
- [x] System user `physioward` + folder structure
- [x] Code cloned, built, `.env` complete
- [x] PM2: `physioward-backend` online on `:3001`
- [x] PM2 auto-start on reboot (`pm2-physioward.service`)
- [x] DNS A record `api.physioward.com.au → 72.62.66.29`
- [x] Nginx site `/etc/nginx/sites-available/physioward-api` enabled
- [x] HTTPS cert via certbot — `https://api.physioward.com.au/api/health` returns OK
- [x] aegira (existing app) untouched throughout — confirmed via `:3000` still listening

### Left to do (post-deploy hygiene)

- [ ] Frontend deploy (separate Nginx site, e.g. `app.physioward.com.au`)
- [ ] `CEO_PASSWORD` rotation in-app after first login (currently `ChangeMe123!`)
- [ ] Daily `pg_dump` cron under the `physioward` user
- [ ] Real Nookal v2 API key in `NOOKAL_API_KEY` if `/api/dashboard/monthly` (v2)
      is needed alongside the v3 revenue report
- [ ] Verify cert auto-renew timer: `systemctl list-timers | grep certbot`

Refer to `DEPLOY_UBUNTU.md` Sections 8 (Day-two ops) and 10 (Hardening
checklist) for those steps.

---

## 8. Day-two cheat sheet

```bash
# Restart after code change (as physioward)
cd /var/www/physioward/backend/physioward-backend
git pull         # if you set up a working git remote here
npm ci
npm run build
pm2 restart physioward-backend

# Tail logs
pm2 logs physioward-backend
# or raw files:
tail -f /var/www/physioward/logs/out.log
tail -f /var/www/physioward/logs/error.log

# Open psql on prod DB
psql -h 127.0.0.1 -U physioward nookal

# Rotate JWT (forces re-login for everyone)
openssl rand -base64 48
nano .env       # paste into JWT_SECRET=
pm2 restart physioward-backend

# Stop / remove PhysioWard entirely (aegira untouched)
pm2 stop physioward-backend && pm2 delete physioward-backend && pm2 save
```

---

## 9. Document history

| Date       | Author | Note                                                           |
| ---------- | ------ | -------------------------------------------------------------- |
| 2026-05-07 | Sam    | Initial deployment record — DB, code, .env, build, PM2 done. Nginx + cert pending. |
| 2026-05-07 | Sam    | Deployment fully live — DNS, Nginx site, HTTPS cert all in place. `https://api.physioward.com.au/api/health` returns OK. |
