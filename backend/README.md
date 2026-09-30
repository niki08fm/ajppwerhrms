# backend — Node.js + Express.js

The API, the PostgreSQL database and every calculation: attendance from punches, payroll with PF, ESI, professional tax and income tax, settlements, reports. Plain JavaScript (ES modules), run directly by Node — no build step.

**Built with:** Node 22+, Express 4, Prisma with PostgreSQL 16, Zod, BullMQ + Redis (optional), pino, Vitest.

```
src/
  server.js        starts the HTTP server
  app.js           the Express app: security headers, CORS, JSON, cookies, /api/v1 routes, error handler
  config/          env.js (settings from .env), db.js (Prisma client), logger.js
  routes/          one Express router per area — index.js mounts them all under /api/v1
                   e.g. employee.routes.js:  router.get('/:id/pay', requirePerm('salary.read'), employeeController.getPay)
  controllers/     request handlers per area — read the request, call services, send the response
  services/        business logic and database access: payroll run, payslips, salary, settlement, reports…
  middleware/      auth.js (who is signed in, permission checks), errorHandler.js, upload.js, idempotency.js
  calculations/    attendance, pay, statutory (PF, ESI, PT, TDS), settlement — pure functions with no
                   database and no clock, so every figure can be tested and a disputed payslip reproduced
  jobs/            queue.js (background jobs), handlers.js (payroll run), retention.js (nightly clean-up)
  utils/           errors, asyncHandler, audit log, PII encryption, dates, geofence, list paging
  worker.js        runs queued jobs in a separate process (when REDIS_URL is set)
shared/            the rules the frontend reuses: money in integer paise, IST dates, validation schemas,
                   statutory tables (package @ajpwer/shared)
prisma/            schema.prisma (the database tables), migrations, seed.js (sample data)
tests/             engines/ (spec §20 acceptance), api/ (integration), load/ (performance budgets)
```

A request flows **route → middleware → controller → service → database**, with the calculations called by the services.

- It also serves the face model files from `face/models` at `/face-models`, and matches faces with `face/src/recognition.js`.
- In production one process serves the API and the built frontend (`SERVE_WEB_DIR=frontend/dist`).
- Settings come from the `.env` file in the project root (copy `.env.example`).

```bash
npm run dev --workspace=@ajpwer/backend      # http://localhost:4000, restarts on changes
npm run start --workspace=@ajpwer/backend
npm run test:engines --workspace=@ajpwer/backend
npm run test:api --workspace=@ajpwer/backend # needs TEST_DATABASE_URL
```
