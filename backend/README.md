# backend — Node + Express

The API, the PostgreSQL database and every calculation: attendance from punches, payroll with PF, ESI, professional tax and income tax, settlements, reports.

**Built with:** Node 20+, Express 4, Prisma with PostgreSQL 16, Zod, BullMQ + Redis (optional), pino, Vitest.

```
src/
  modules/     HTTP routes under /api/v1 — auth, employees, offers, attendance, tablet, leave, setup,
               sites, payroll, money, audit, dashboard, misc
  services/    load data from the database for the engines; payroll run, reports, settlement
  engines/     the calculations — attendance, pay, statutory, settlement. Pure: no database, no clock,
               so every figure can be tested and a disputed payslip reproduced
  lib/         auth, audit log, PII encryption, list paging, jobs, errors
  app.ts       the Express app; server.ts starts it; worker.ts runs queued jobs
prisma/        schema.prisma, migrations (with database-level guarantees), seed.ts (sample data)
shared/        the rules the frontend reuses: money in integer paise, IST dates, validation schemas,
               statutory tables (package @ajpwer/shared)
test/          engines/ (spec §20 acceptance), api/ (integration), load/ (performance budgets)
```

- It also serves the face model files from `face/models` at `/face-models`, and matches faces with `face/src/match.ts`.
- In production one process serves the API and the built frontend (`SERVE_WEB_DIR=frontend/dist`).
- Settings come from the `.env` file in the project root (copy `.env.example`).

```bash
npm run dev --workspace=@ajpwer/backend      # http://localhost:4000
npm run test:engines --workspace=@ajpwer/backend
npm run test:api --workspace=@ajpwer/backend # needs TEST_DATABASE_URL
```
