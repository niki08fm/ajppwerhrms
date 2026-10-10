# Operations

How to run AJPWER Workforce in production. The system holds Aadhaar, PAN, bank accounts, salaries, biometric embeddings and location data for an Indian company, so the Digital Personal Data Protection Act applies. Treat this as a checklist, not reading material.

## 1. Where it runs

Host it on infrastructure **in India** — for latency at the sites and because data-localisation expectations are tightening. Any provider with a Mumbai or Hyderabad region works (a managed PostgreSQL 16 with point-in-time recovery, a small VM or container service for the app, and Redis).

## 2. Deploying

One Node process serves the backend API and the built frontend; a second process from the same build works the job queue.

```bash
npm ci
npm run build                                   # database client + frontend/dist
npx prisma migrate deploy --schema backend/prisma/schema.prisma
SERVE_WEB_DIR=frontend/dist node backend/src/server.js      # API + web app on API_PORT
node backend/src/worker.js                                  # job worker (when REDIS_URL is set)
```

Run both under a process manager (systemd or pm2) so they restart on failure and on boot. The backend also serves the tablet's guidance model (Tiny Face Detector) from `face/models` at `/face-models`; keep that folder next to `backend/` (or set `FACE_MODELS_DIR`). The face service (§2a) runs next to them.

Production settings in `.env`:

- `NODE_ENV=production`, `COOKIE_SECURE=true`, `WEB_ORIGIN=https://hr.your-domain.in`, `TRUST_PROXY=1` behind a reverse proxy
- `REDIS_URL` set (payroll runs and large exports go to the queue; the worker process handles them)
- Terminate **TLS** at a reverse proxy (nginx, Caddy, or the cloud load balancer). Everything is HTTPS; the database is never reachable from the internet.

## 2a. The face service (face v2)

Punches are recognised on this server by a small Python service (`face/service`) that only the backend calls. See [face/INTEGRATION.md](../face/INTEGRATION.md) for the rules.

**Install** (Python 3.10 or newer; Ubuntu 24.04 ships 3.12):

```bash
sudo apt install python3-venv
cd /opt/ajpwer/face/service
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt       # fastapi, uvicorn, python-multipart, opencv-python-headless>=4.9, onnxruntime>=1.17, numpy
.venv/bin/python download_models.py             # every deploy: fetches the four models into face/service/models and checks each size and checksum
```

The models are not in git. `download_models.py` fetches them:
- YuNet and SFace from the OpenCV Zoo;
- MiniFASNetV2 and V1SE from the yakhyo/face-anti-spoofing GitHub releases.

The server therefore needs outbound HTTPS to `media.githubusercontent.com` and `github.com` (and GitHub's download host) **at deploy time**. It exits non-zero when a file is missing or wrong; make the deploy fail on that. All four models are Apache 2.0.

**Configure.** In the app's `.env`, which both the backend and the service read:
- `FACE_SERVICE_URL=http://127.0.0.1:8100`
- `FACE_SERVICE_TOKEN` — a long random string (`openssl rand -hex 32`). The backend sends it as `X-Face-Token` and the service refuses anything else.

The backend refuses to start without both. The thresholds (`FACE_MATCH_MIN`, `FACE_LIVE_MIN`…) are optional; see `.env.example`.

**Run under systemd:**

```bash
sudo cp face/deploy/ajpwer-face.service /etc/systemd/system/     # edit User, WorkingDirectory, EnvironmentFile to your paths
sudo systemctl daemon-reload
sudo systemctl enable --now ajpwer-face
systemctl status ajpwer-face                                      # journalctl -u ajpwer-face for its log
```

The unit:
- runs one worker on **127.0.0.1:8100**;
- checks the model files before starting;
- restarts itself on failure (`Restart=always`);
- is killed and restarted if it grows past **700 MB** (`MemoryMax=700M`, `MemorySwapMax=0`).

Measured: about 250 MB resident with all four models loaded, and about 0.1 s per two-frame punch on one CPU core. While it is working on one request, others wait up to `FACE_QUEUE_WAIT_MS` (2 s). After that the tablet is told "busy" and retries the same upload, which never counts as a failed try.

**Never expose port 8100.** Nginx (or the load balancer) forwards only to the backend; do not add a `location` for 8100. The service listens on 127.0.0.1 only, and a firewall rule blocking 8100 from outside is a good second lock.

**Memory and swap.** The backend (~200 MB), the job worker, PostgreSQL and the face service fit in 2 GB. On a 1–2 GB VM add 1–2 GB of swap for PostgreSQL and the Node processes:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

The face service itself is kept out of swap (`MemorySwapMax=0`): if it would need swap, it is better restarted than slow.

**Health.** Run `npm run face:check` from the repository root. It reads the existing environment, calls authenticated `/health`, checks readiness and the model version, and exits non-zero on failure without printing credentials or face data. If the service is down, tablets show "Face check is not working right now. Tell your site in-charge." Nobody can punch by face until it is back; HR can enter punches manually.

**After go-live: tune the thresholds.** For the first weeks, download **Approvals → Punch attempts (CSV)** weekly. Every analysed scan is there, with no images and no face codes:
- the match score and the margin to the next person;
- the live score;
- both head angles;
- the outcome, and what happened next (CONFIRMED, NOT_ME).

What to look for:
- **Genuine people failing:** "not live" or "no match" rows followed by a confirmed punch in the same session. Lower `FACE_LIVE_MIN` or `FACE_MATCH_MIN` carefully.
- **Wrong people shown:** rows resolved as NOT_ME. Raise `FACE_MATCH_MIN` or `FACE_MATCH_MARGIN`.
- **Spoofing:** before go-live, try a printed photo and a phone screen at one site and check their live scores sit well below `FACE_LIVE_MIN`.

**Development.** `npm run face:install` (a venv in `face/service/.venv` and the models), then `FACE_SERVICE_DEV=1` in `.env`; `npm run dev` starts the service too. Tests: `npm run test:face`.

Model downloads use system TLS trust. `SSL_CERT_FILE` or `SSL_CERT_DIR` can select a trusted company CA bundle or directory; otherwise certifi roots supplement system trust. Certificate, hostname and model-checksum verification remain enabled.

**Registration says the face service is unavailable.** Run `npm run face:check`. For local development, `npm run dev:face` explicitly starts the service even if `FACE_SERVICE_DEV` is unset or `0`; keep it running beside the backend and frontend. Install the environment and models with `npm run face:install`, or restore only missing models with `npm run face:models`. If health reports an authentication failure, match `FACE_SERVICE_TOKEN` in both process environments and restart both. If it reports a model mismatch, run the service and backend from the same checkout. In production, use the systemd unit above rather than the development command.

### Site maps (OpenStreetMap)

- The site form shows OpenStreetMap tiles, loaded by HR's browser from `tile.openstreetmap.org`, with the required "© OpenStreetMap contributors" attribution. If a content-security policy is added at the proxy, allow `img-src https://tile.openstreetmap.org`. The OSM tile policy suits light use like HR editing sites; for heavy use, switch the tile URL in `frontend/src/components/sites/SiteMap.jsx` to a paid tile provider.
- Place search goes only through the backend (`GET /api/v1/geo/search`), which calls Nominatim at most once a second with the `NOMINATIM_USER_AGENT` and `NOMINATIM_EMAIL` from `.env` and caches answers for 24 hours. Set the email to a mailbox someone reads. The server needs outbound HTTPS to `nominatim.openstreetmap.org`.

## 3. Least-privilege database role

Run migrations as the owner; run the application as a separate role without UPDATE or DELETE on the append-only tables:

```sql
CREATE ROLE ajpwer_app LOGIN PASSWORD '…';
GRANT CONNECT ON DATABASE ajpwer TO ajpwer_app;
GRANT USAGE ON SCHEMA public TO ajpwer_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ajpwer_app;
REVOKE UPDATE, DELETE ON punch, audit_log FROM ajpwer_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ajpwer_app;
```

(The constraints migration applies the revokes automatically if `ajpwer_app` already exists when it runs.) Triggers enforce the same rules regardless of role. The nightly retention job needs DELETE on `punch` for rows older than three years: run it as the owner role, or grant DELETE on `punch` to a separate `ajpwer_retention` role.

## 4. Secrets

- Secrets live in environment variables or the platform's secret store — never in the repository.
- `PII_ENCRYPTION_KEY` encrypts PAN, Aadhaar and bank accounts. **Store a copy offline, separately from database backups.** A restored database without the key is unreadable; a key leaked with the backups defeats the encryption.
- Rotating `JWT_SECRET` signs everyone out. Resetting a site password or disabling its login (Sites → the site → Tablet login) signs that site's tablets out on their next request. The tablet cannot change its own password.

## 5. Backups — and a restore rehearsed before go-live

An untested backup is not a backup.

1. **Daily automated backups with point-in-time recovery.** On a managed database, enable PITR with at least 7 days of WAL retention. Self-managed: pgBackRest or WAL-G with continuous WAL archiving to object storage in an Indian region, plus a nightly full backup.
2. **Uploaded documents** (`UPLOAD_DIR`) are backed up alongside the database (object storage sync).
3. **Rehearse a restore before go-live, and quarterly after:**
   ```bash
   # restore last night's backup into a scratch database
   createdb ajpwer_restore_test
   pg_restore --no-owner -d ajpwer_restore_test backup.dump      # or restore a PITR target
   # point a scratch copy of the app at it and check it
   DATABASE_URL=postgresql://…/ajpwer_restore_test PII_ENCRYPTION_KEY=… npm run test:load --workspace=@ajpwer/backend
   ```
   Then sign in, open a locked month's payslip and a profile's identity panel (proves the PII key works), and record the date and duration of the rehearsal.

## 6. Scheduled jobs

Run nightly (for example 01:30 IST):

```bash
npm run jobs:retention        # or: node backend/src/jobs/retention.js
```

It deletes gate snapshots and manual-request face crops older than 30 days, deletes the face embedding of anyone who has exited, marks site changes from earlier days that never reached the named site as not counted, deletes punch attempts older than `RETENTION_PUNCH_ATTEMPT_DAYS`, deletes punches older than three years (the only deletion the append-only trigger allows), prunes login attempts and idempotency keys, rebuilds the cached daily aggregates, and writes one audit entry with what it did. Payroll records are kept seven years and are never deleted by this job.

## 7. Before the first live payroll

- Confirm the income-tax slabs against the current Finance Act (Setup → Statutory rules).
- Verify professional-tax slabs for any state other than Andhra Pradesh and Telangana.
- Enter the company's PAN, TAN, PF and ESI codes (`COMPANY_*` in `.env` before seeding, or the `/company` API).
- Run one month in parallel with the current payroll software and compare the salary register line by line.
- Answer the open questions in spec §22 that change a rule (mid-month revisions, mid-month pay-group moves, fixed-term contracts, leave encashment cap, notice recovery basis).

## 8. Monitoring

- `GET /api/v1/health` for liveness.
- The API logs JSON (pino) with request ids; PII fields and cookies are redacted.
- Alert on: failed payroll jobs (`job.status = 'FAILED'`), repeated `geofence.rejected` or `auth.login_failed` audit entries, a growing held-back list on the dashboard, the face service down (`systemctl is-active ajpwer-face`, or punch attempts with outcome `SERVICE_DOWN`), and many `BUSY` attempts (a slow CPU or too many tablets for one worker).
- CI runs the engine tests, API tests, builds, a dependency scan, the Playwright flows and the performance budgets against 200 employees and three years of punches on every push.
