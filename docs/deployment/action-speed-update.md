# Faster actions and clearer desktop workflows

This update prioritizes desktop action latency. It does not introduce a mobile redesign or change statutory calculations.

## What changed

- Bodyless API reads no longer send a JSON content-type header. Direct cross-origin reads can avoid unnecessary CORS preflights. CORS permissions for JSON mutations can be reused for ten minutes; session and permission checks still run for every actual request. Same-origin Vercel rewrites already avoid cross-origin browser preflights.
- Prisma joins related PostgreSQL records in one database operation. The employee profile fixture returns the same complete record with one database round trip instead of seven. This particularly helps when the API and database are far apart.
- Payroll loads salary revisions and components for its whole roster in two bulk reads, replacing per-person queries. Current and historical effective dates, ESI contribution-block wages, deleted revisions and component flags retain their existing selection rules.
- Repeated rates, policy, salary and component reads share pending results within a single read operation. The scope is discarded afterward; it is not a shared payroll cache. Transactions use distinct scope keys. Mutating HTTP requests do not use the GET read scope; pure payroll computation has a separate scope ending before the payroll writes.
- Independent attendance, recoveries, hold, salary and final-month inputs load together. Independent per-person payroll and F&F reads use at most four concurrent tasks, preserve output order and serialize progress callbacks. Transactional writes and payroll stage checks remain ordered.
- Concurrent requests share the short-lived signed-in-user lookup. Invalidating permissions while a lookup is pending cannot restore old permission data to the cache.
- Employee profile pay, leave, hold and lookup requests start using the URL employee ID, without waiting for the complete employee profile. Requests respect the viewer's permissions and reuse the section query keys.
- Desktop employee profiles keep the common actions visible; advances, exit and typed-name deletion are under **More actions**. All twelve payroll reports are available in a labelled, grouped **Report** selector. TDS uses the label **TDS / Income tax**. Technical calculation metadata is under **Calculation details**, and generation timestamps use IST.

## Validation and measurement

Only a dedicated local PostgreSQL test database and fictional browser fixtures were used. No production employee or payroll data was modified.

| Check | Before | After |
| --- | --- | --- |
| Complete employee relation read | 7 PostgreSQL trips | 1, with equivalent returned data |
| Three-person payroll preview | 37 Prisma operations | 30 |
| Payroll salary/component reads | 6 individual salary reads + 3 component reads | 1 bulk salary read + 1 bulk component read |
| Pay view statutory-rate reads | 2 | 1 |
| Independent employee sections | Start after profile response | Start while profile response is pending |

With an artificial 15 ms delay on each Prisma operation, the same local payroll-preview fixture took 401 ms before and approximately 211 ms after. This isolates the effect of fewer operations and less sequential waiting. It is not a production benchmark or a promise of a fixed speedup. Request-level operation counts and PostgreSQL round trips are separate measurements.

Regression coverage includes payroll lifecycle, frozen snapshots, held salary, settlements, ESI/PF calculations, salary edits, deletion, permission invalidation, CORS headers, parallel profile loading and the desktop report selector.

## Redis

Redis is not required for this update. The measured bottlenecks are database round trips, repeated reads and requests waiting for other responses. The existing optional Redis/BullMQ integration is for background jobs. Do not set `REDIS_URL` just to enable these improvements: Redis-backed jobs also require a running worker. No new Redis service or configuration is needed here.

## Update AWS

Run from the existing checkout:

```bash
cd /opt/ajpwer
git pull --ff-only origin feature/clean-hrms-experience
npm run build --workspace=@ajpwer/backend
sudo systemctl daemon-reload
sudo systemctl restart ajpwer-api
curl --fail --retry 5 --retry-connrefused --retry-delay 2 \
  http://127.0.0.1:4000/api/v1/health
```

**The backend build is required:** it regenerates Prisma Client with joined relation reads. Confirm it prints `Generated Prisma Client`. This changes the generated client, not the database tables, and needs no SQL migration or dependency installation.

Deploy/promote the same commit to the Vercel production frontend so the request-header, parallel-loading and desktop changes are included. Refresh the app after deployment.

If real actions remain slow afterward, use a browser Network trace to distinguish server processing, network travel, database wake-up and frontend rendering. These local tests do not measure the production AWS–Neon connection, cold starts or hardware face capture.
