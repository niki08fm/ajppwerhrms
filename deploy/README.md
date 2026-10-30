# AWS Lightsail + Neon + Vercel

Target branch: `feature/clean-hrms-experience`. These are deployment templates;
no cloud resources are created by adding these files. Keep the existing face
service on the AWS machine. Lambda is not implemented by this deployment.

## 1. Neon database

Create a PostgreSQL 16 project in a region close to the Lightsail server. Use a
separate branch/database for production, not the API test database. Save both
connection strings in a password manager: **pooled** for the running API and
**direct** for Prisma migrations and administrative imports. Retain Neon's SSL
parameters. Never put either URL in Git, Vercel frontend variables or chat.

The initial migration creates `btree_gist`, `pg_trgm` and `pgcrypto`. Verify the
chosen Neon project permits these extensions before migrating. Use the project
owner for initial migrations. Do not replace PostgreSQL with MySQL.

Free-tier storage, compute, idle suspension and backup allowances can change;
check the Neon dashboard before using it for live payroll. Cold starts can add
latency. Back up the database and the PII encryption key separately.

## 2. Lightsail

Use Ubuntu 24.04 LTS, an x86-64 CPU instance and a static IP. Start with the
planned 2 GB instance for a pilot, then measure memory and face-scan latency
under realistic concurrent punches. Install Node **22.9+**, Python 3.12 with
venv, Git, Nginx and Certbot. Node must be available at `/usr/bin/node` for the
provided service file; otherwise update its ExecStart.

Allow inbound HTTPS 443 and HTTP 80; restrict SSH 22 to your administrator IP.
Keep 4000, 5432 and 8100 closed in the Lightsail firewall. Face processing only
listens on localhost. Point `api.YOUR-DOMAIN` to the static IP.

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

Copy `deploy/runtime.env.example` to `/etc/ajpwer/runtime.env`, replace every
placeholder and use root ownership/mode 0600. Generate separate JWT/face secrets
with `openssl rand -hex 48`; generate the PII key with `openssl rand -base64 32`.
For an existing database **preserve its original PII key** or encrypted records
will become unreadable. WEB_ORIGIN is the actual Vercel frontend URL or custom
frontend domain, not the AWS API URL. Leave COOKIE_DOMAIN empty.

## 3. Migrate, then choose the data source

In an administrator shell, set `DATABASE_URL` to the Neon **direct** URL using a
secure environment manager or a non-echoing prompt. Do not put secrets directly
in command history. Then, from the repository root:

```sh
npm run db:deploy
```

This applies additive migrations; do not use `db:reset`, `migrate dev` or the
sample-data seed against production. `db:deploy` reads the current shell's
DATABASE_URL; it does not automatically load `/etc/ajpwer/runtime.env`.

Choose one initial-data path:

- **Existing employees and payroll:** securely back up and transfer the existing
  PostgreSQL database with pg_dump/pg_restore into an empty Neon database, then
  deploy pending migrations. Retain the existing PII key. Transfer uploads and
  exports separately. Verify employee counts and a saved payslip before cutover.
- **Fresh database:** after migration, load the production environment in a secure
  administrator shell and run `npm run db:seed:setup` once. This creates setup
  and the admin without sample employees. Confirm which employee import should
  be used before importing real records. Do not run a replacement/reset script
  automatically during deployment.

Unset migration credentials when finished. The running services use the pooled
URL from runtime.env; they do not need the direct URL.

## 4. Start AWS services and HTTPS

Copy the two `deploy/systemd/*.service` units into `/etc/systemd/system/`.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now ajpwer-face ajpwer-api
sudo systemctl status ajpwer-face ajpwer-api
curl --fail http://127.0.0.1:4000/api/v1/health
```

Copy the Nginx example into sites-available, replace api.example.com, enable it
in sites-enabled, then run `sudo nginx -t` and reload Nginx. Once DNS resolves,
use Certbot's Nginx integration to issue the API certificate and redirect HTTP
to HTTPS. Check `https://api.YOUR-DOMAIN/api/v1/health`.

The application health route checks the API process only. Also verify Neon
connectivity by signing in and opening employees, and verify the face service
with `npm run face:check` in a shell containing the runtime face configuration.
Back up `/var/lib/ajpwer` and runtime.env securely. They are not backed up by Git
or Neon. Monitor service restarts, disk, memory and failed payroll jobs.

## 5. Vercel frontend

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
preview access to production data; use an isolated Neon branch for staging.

## 6. Before cutover

Check HR and site sign-in/out, reload on an employee deep link, employee data,
PDF/ZIP downloads, manual sheet submission and HR approval, and a payroll preview.
On an actual HTTPS tablet test camera permission, face registration, confirmation,
punch-in/out and geofence rejection outside the site. Confirm TLS renewal and
backup restore. Keep the existing deployment/data available until checks pass.

For future updates, back up first; pull with `git pull --ff-only`, install and
build, apply migrations using the direct Neon URL, then restart the services and
deploy the matching frontend. Never reset the database as part of an update.
