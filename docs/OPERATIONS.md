# Operations

How to run AJPWER Workforce in production. The system holds Aadhaar, PAN, bank accounts, salaries, biometric embeddings and location data for an Indian company, so the Digital Personal Data Protection Act applies. Treat this as a checklist, not reading material.

## 1. Where it runs

Host it on infrastructure **in India** — for latency at the sites and because data-localisation expectations are tightening. Any provider with a Mumbai or Hyderabad region works (a managed PostgreSQL 16 with point-in-time recovery, a small VM or container service for the app, and Redis).

## 2. Deploying

One Node process serves the backend API and the built frontend; a second process from the same build works the job queue.

```bash
npm ci
npm run build                                   # → backend/dist and frontend/dist
npx prisma migrate deploy --schema backend/prisma/schema.prisma
SERVE_WEB_DIR=frontend/dist node backend/dist/server.js     # API + web app on API_PORT
node backend/dist/worker.js                                 # job worker (when REDIS_URL is set)
```

Run both under a process manager (systemd or pm2) so they restart on failure and on boot. The backend also serves the face model files from `face/models` at `/face-models`; keep that folder next to `backend/` (or set `FACE_MODELS_DIR`).

Production settings in `.env`:

- `NODE_ENV=production`, `COOKIE_SECURE=true`, `WEB_ORIGIN=https://hr.your-domain.in`, `TRUST_PROXY=1` behind a reverse proxy
- `REDIS_URL` set (payroll runs and large exports go to the queue; the worker process handles them)
- Terminate **TLS** at a reverse proxy (nginx, Caddy, or the cloud load balancer). Everything is HTTPS; the database is never reachable from the internet.

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
- Rotating `JWT_SECRET` signs everyone out. Rotating a site password (Sites → Reissue login) signs that site's tablets out.

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
npm run jobs:retention        # or: node backend/dist/jobs/retention.js
```

It deletes gate snapshots older than 30 days, deletes the face embedding of anyone who has exited, deletes punches older than three years (the only deletion the append-only trigger allows), prunes login attempts and idempotency keys, rebuilds the cached daily aggregates, and writes one audit entry with what it did. Payroll records are kept seven years and are never deleted by this job.

## 7. Before the first live payroll

- Confirm the income-tax slabs against the current Finance Act (Setup → Statutory rules).
- Verify professional-tax slabs for any state other than Andhra Pradesh and Telangana.
- Enter the company's PAN, TAN, PF and ESI codes (`COMPANY_*` in `.env` before seeding, or the `/company` API).
- Run one month in parallel with the current payroll software and compare the salary register line by line.
- Answer the open questions in spec §22 that change a rule (mid-month revisions, mid-month pay-group moves, fixed-term contracts, leave encashment cap, notice recovery basis).

## 8. Monitoring

- `GET /api/v1/health` for liveness.
- The API logs JSON (pino) with request ids; PII fields and cookies are redacted.
- Alert on: failed payroll jobs (`job.status = 'FAILED'`), repeated `geofence.rejected` or `auth.login_failed` audit entries, and a growing held-back list on the dashboard.
- CI runs the engine tests, API tests, builds, a dependency scan, the Playwright flows and the performance budgets against 200 employees and three years of punches on every push.
