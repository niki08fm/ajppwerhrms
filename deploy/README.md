# AWS Lightsail (API + PostgreSQL) + Vercel

Target branch: `feature/clean-hrms-experience`. These are deployment templates;
no cloud resources are created by adding these files. The API, the face service
and PostgreSQL all run on one Lightsail machine; Vercel serves the frontend and
forwards `/api` to it. Lambda is not implemented by this deployment.

## Why the database is on the same machine

Each API request makes several database queries, some one after another, so
the API–database distance is multiplied many times per screen. Measured on the
production machine (Lightsail Mumbai):

| Database | One query | Busiest screens (server time) |
| --- | --- | --- |
| Neon free plan, AWS US East 2 (Ohio) | ~208 ms, plus 1–2 s when waking from idle | 3–6 s |
| PostgreSQL 16 on the Lightsail machine | ~0.6 ms | well under 0.3 s |

Keep the database in the same region as the API — ideally on the same machine.
The user–server distance matters far less (Hyderabad → Mumbai is ~30 ms, paid
once per request). A managed database in the same region (Lightsail database,
RDS) is also fine when the budget allows; a database on another continent is not.

## 1. Lightsail machine

Use Ubuntu 24.04 LTS, an x86-64 **General purpose, Dual-stack** instance with at
least **2 GB RAM** (the $12 plan: 2 vCPUs, 60 GB SSD), in Mumbai `ap-south-1`.
1 GB is not enough for Node, the face service and PostgreSQL together; do not
choose an IPv6-only plan (DuckDNS/Vercel reach the API over IPv4). Attach a
static IP. Install Node **22.9+**, Python 3.12 with venv, Git, Nginx and Certbot.
Node must be available at `/usr/bin/node` for the provided service file;
otherwise update its ExecStart.

Lightsail cannot resize an instance in place. To change plan: take a manual
snapshot, create a new instance from it with the larger plan, move the static
IP, and delete the old instance. New accounts have a low vCPU quota, so a second
instance may be refused until the old one is deleted (or the quota is raised).
**Firewall rules are not copied from the snapshot** — re-add HTTPS afterwards.

Firewall: allow HTTPS 443 and HTTP 80 from anywhere; restrict SSH 22 to your
administrator IP plus Lightsail browser SSH. Keep 4000, 5432 and 8100 closed.
PostgreSQL and face processing listen on localhost only. Point the API hostname
to the static IP.

Create a dedicated `ajpwer` system user/group, clone this repository and branch
into `/opt/ajpwer`, and make the clone writable by the deployment administrator.
Give the service user read/traverse access to the clone and Python environment.
Create `/var/lib/ajpwer/uploads` and `/var/lib/ajpwer/exports`, owned by `ajpwer`,
mode 0700. Create `/etc/ajpwer`, root-owned, mode 0700.

From `/opt/ajpwer` install dependencies and CPU face models:

```sh
npm ci
npm run build --workspace=@ajpwer/backend
python3 -m venv face/service/.venv
face/service/.venv/bin/pip install -r face/service/requirements.txt
(cd face/service && .venv/bin/python download_models.py)
```

The downloader installs the four Python recognition/liveness models. Browser
guidance assets are already tracked under `face/models`; keep that directory
in the deployment. Check model download output before starting the service.

## 2. PostgreSQL 16 on the machine

Ubuntu 24.04 ships PostgreSQL 16. It listens on localhost only by default.

```sh
sudo apt update && sudo apt install -y postgresql postgresql-contrib
```

Tune it for a 2 GB machine shared with Node and the face service:

```sh
sudo -u postgres psql -c "ALTER SYSTEM SET shared_buffers='256MB'" \
  -c "ALTER SYSTEM SET effective_cache_size='768MB'" -c "ALTER SYSTEM SET work_mem='8MB'" \
  -c "ALTER SYSTEM SET maintenance_work_mem='64MB'" -c "ALTER SYSTEM SET max_connections=40" \
  -c "ALTER SYSTEM SET timezone='UTC'"
sudo systemctl restart postgresql
```

Create the role, database and extensions (`btree_gist`, `pg_trgm`, `pgcrypto`)
with a random hex password, so it needs no URL encoding and is never printed:

```sh
DBPASS=$(openssl rand -hex 24)
sudo -u postgres psql -c "CREATE ROLE ajpwer LOGIN PASSWORD '$DBPASS'" -c "CREATE DATABASE ajpwer OWNER ajpwer"
sudo -u postgres psql -d ajpwer -c "CREATE EXTENSION IF NOT EXISTS btree_gist" \
  -c "CREATE EXTENSION IF NOT EXISTS pg_trgm" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto"
echo "DATABASE_URL=postgresql://ajpwer:${DBPASS}@127.0.0.1:5432/ajpwer?connection_limit=10"
unset DBPASS
```

Put that `DATABASE_URL` line into `/etc/ajpwer/runtime.env` (next section)
without echoing it into chat, tickets or Git; or replace an existing line with
`sudo sed -i "s#^DATABASE_URL=.*#DATABASE_URL=...#" /etc/ajpwer/runtime.env`
in the same shell instead of echoing. `connection_limit=10` lets one screen's
parallel queries run together; PostgreSQL allows 40.

## 3. Runtime configuration

Copy `deploy/runtime.env.example` to `/etc/ajpwer/runtime.env`, replace every
placeholder and use root ownership/mode 0600. Generate separate JWT/face secrets
with `openssl rand -hex 48`; generate the PII key with `openssl rand -base64 32`.
For an existing database **preserve its original PII key** or encrypted records
will become unreadable. WEB_ORIGIN is the actual Vercel frontend URL or custom
frontend domain, not the AWS API URL. Leave COOKIE_DOMAIN empty.

The file is not shell syntax (values contain `&` and spaces), so do not
`source` it. Node reads it with `--env-file`; for the Prisma CLI pass only the
URL:

```sh
cd /opt/ajpwer/backend
sudo env DATABASE_URL="$(sudo grep '^DATABASE_URL=' /etc/ajpwer/runtime.env | cut -d= -f2-)" npx prisma migrate deploy
```

## 4. Migrate, then choose the data source

Apply migrations with the command above. It only applies additive migrations;
do not use `db:reset`, `migrate dev` or the sample-data seed against production.

Choose one initial-data path:

- **Fresh database:** run once

  ```sh
  cd /opt/ajpwer/backend && sudo node --env-file=/etc/ajpwer/runtime.env prisma/seed.js --setup-only
  ```

  This creates the admin (`ADMIN_EMAIL` / `ADMIN_PASSWORD`), company, calendar,
  statutory rules, policies, salary structures and pay groups — no sample
  employees. Afterwards set a new admin password (section 7) and blank
  `ADMIN_PASSWORD=` in runtime.env; only the seed reads it.
- **Existing employees and payroll:** `pg_dump -Fc` the existing database and
  `pg_restore --no-owner --role=ajpwer -d ajpwer` it into the empty database,
  then apply pending migrations. Retain the existing PII key. Transfer uploads
  and exports separately. Verify employee counts and a saved payslip before
  cutover.

## 5. Start AWS services and HTTPS

Copy the two `deploy/systemd/*.service` units into `/etc/systemd/system/`.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now ajpwer-face ajpwer-api
sudo systemctl status ajpwer-face ajpwer-api postgresql
curl --fail http://127.0.0.1:4000/api/v1/health
```

Copy the Nginx example into sites-available, replace api.example.com, enable it
in sites-enabled, then run `sudo nginx -t` and reload Nginx. Once DNS resolves,
use Certbot's Nginx integration to issue the API certificate and redirect HTTP
to HTTPS. Check `https://api.YOUR-DOMAIN/api/v1/health`.

The health route checks the API process only. Also check the database by
signing in and opening employees, and the face service with `npm run face:check`
in a shell containing the runtime face configuration. A quick database latency
check (expect about 1 ms per query after the first):

```sh
cd /opt/ajpwer/backend && sudo node --env-file=/etc/ajpwer/runtime.env --input-type=module -e '
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
for (let i = 1; i <= 5; i++) { const t = performance.now(); await p.$queryRawUnsafe("select 1 as x"); console.log(`query ${i}: ${(performance.now() - t).toFixed(1)} ms`); }
await p.$disconnect();'
```

## 6. Backups

The database now lives on the machine, so it must be backed up here.

1. **Nightly database dump** (03:00 IST, one file per weekday, 7 days kept):

   ```sh
   sudo install -d -o postgres -g postgres -m 700 /var/backups/ajpwer
   echo '30 21 * * * postgres pg_dump -Fc ajpwer > /var/backups/ajpwer/ajpwer-$(date +\%a).dump' | sudo tee /etc/cron.d/ajpwer-backup
   sudo -u postgres pg_dump -Fc ajpwer > /dev/null && echo "backup works"
   ```

2. **Lightsail automatic snapshots** (instance → Snapshots), daily at 04:00 IST (the console offers whole hours),
   after the dump. Lightsail keeps the last seven. These are stored off the
   machine and also cover runtime.env, `/var/lib/ajpwer` and the dumps.
3. Keep the **PII key** and runtime.env secrets in a password manager as well:
   a restored database is unreadable without the original PII key.

Restore a dump into an empty database:

```sh
sudo -u postgres pg_restore --no-owner --role=ajpwer -d ajpwer /var/backups/ajpwer/ajpwer-Mon.dump
```

A whole machine is restored by creating a new instance from a snapshot and
moving the static IP to it (then re-add the HTTPS firewall rule).

## 7. Admin password

There is no in-app password change for the HR admin. Set one from the server;
the prompt does not echo:

```sh
read -s -p "New admin password: " NEWPW; echo
cd /opt/ajpwer/backend && sudo env NEWPW="$NEWPW" node --env-file=/etc/ajpwer/runtime.env --input-type=module -e '
import { PrismaClient } from "@prisma/client";
const { hashPassword } = await import("./src/services/auth.service.js");
if (!process.env.NEWPW || process.env.NEWPW.length < 10) { console.log("Password too short, use 10+ characters. Nothing changed."); process.exit(1); }
const p = new PrismaClient();
const r = await p.appUser.updateMany({ where: { email: "ADMIN_EMAIL_HERE" }, data: { password_hash: await hashPassword(process.env.NEWPW) } });
console.log("Password updated for", r.count, "user");
await p.$disconnect();'; unset NEWPW
```

Use the admin email in lower case.

## 8. Vercel frontend

Once the real HTTPS API origin is known, run locally in the repository root:

```sh
node deploy/configure-vercel.mjs https://api.YOUR-DOMAIN
```

This creates root `vercel.json` with the correct workspace install/build/output,
API and browser-model proxies, and SPA deep-link fallback. It refuses to
overwrite an existing configuration. Review and commit the generated file.

Import the GitHub repository into Vercel. Keep **Root Directory = repository
root**, not frontend, because npm workspaces include shared and face packages.
Use Node 22.x and production branch `feature/clean-hrms-experience`.
Set only these public frontend variables:

```text
VITE_API_URL=/api/v1
VITE_FACE_MODEL_URL=/face-models
```

Never add DATABASE_URL, JWT secrets, PII key or FACE_SERVICE_TOKEN to VITE_ vars.
The browser talks to same-origin `/api`; Vercel forwards it to AWS. Keep secure,
HTTP-only SameSite=Lax cookies and COOKIE_DOMAIN empty. The built Vercel frontend
cannot use Vite's development proxy; the generated rewrites are required.

Set WEB_ORIGIN on AWS to the deployed frontend origin and restart ajpwer-api.
If adding a custom domain, update WEB_ORIGIN to that domain. Avoid unrestricted
preview access to production data; use a separate database for staging.

## 9. Before cutover, and updates

Check HR and site sign-in/out, reload on an employee deep link, employee data,
PDF/ZIP downloads, manual sheet submission and HR approval, and a payroll preview.
On an actual HTTPS tablet test camera permission, face registration, confirmation,
punch-in/out and geofence rejection outside the site. Confirm TLS renewal and
a backup restore. Keep the existing deployment/data available until checks pass.

For future updates: take a dump first
(`sudo -u postgres pg_dump -Fc ajpwer > /var/backups/ajpwer/before-update.dump`),
pull with `git pull --ff-only`, install and build, apply migrations with the
command in section 3, restart the services and deploy the matching frontend.
Never reset the database as part of an update.
