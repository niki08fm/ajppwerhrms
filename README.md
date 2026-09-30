# AJPWER Workforce

Attendance, payroll and settlement for AJ Power Engineering — built to the *AJPWER Workforce — Requirements & Build Specification* (30 September 2026).

It records attendance from face punches at geofenced sites, turns punches into paid days under each pay group's policies, runs monthly payroll with full Indian statutory deduction (PF, ESI, professional tax, income tax), settles people who leave, and reports labour cost per project.

**Stack:** PostgreSQL 16 · Prisma · Express 4 + TypeScript · React 18 + Vite · TanStack Query / Table / Virtual · Tailwind CSS v4 · Zod (shared) · BullMQ + Redis · Vitest, Supertest, Playwright.

---

## Quick start

Prerequisites: **Node 20+** (22 recommended), **PostgreSQL 16**, and optionally **Redis 7** (without it, jobs run in-process). Docker can provide both databases.

```bash
# 1. Configuration — fill in your own values (see "Environment" below)
cp .env.example .env

# 2. Databases (or point DATABASE_URL at your own PostgreSQL 16)
docker compose up -d

# 3. Install, migrate, seed
npm install
npm run db:migrate
npm run db:seed          # prints the admin login and each site tablet's login once

# 4. Run the API (port 4000) and the web app (port 5173)
npm run dev
```

Open **http://localhost:5173** and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`.
A site tablet signs in at **http://localhost:5173/tablet** with a site login (it only works inside that site's geofence — for local testing, set your browser's location to the site's coordinates in DevTools → Sensors).

The seed creates about 30 people with three months of punches. The two months before last are run, locked and paid; last month is ready to run; the current month contains every case spec §20 asks for (a mid-month joiner with no bank account, a mid-month leaver near the gratuity threshold, a cross-site worker, a worked holiday and Sunday, a loan big enough to hit the recovery cap, an old-regime employee with declarations, a CTC-agreed salary, PF above the ceiling with restrict-to-ceiling off, two people in one crew in different PT states, and an expired document).

## Environment

Everything configurable is in [`.env.example`](.env.example), commented. The ones you must set:

| Variable | What it is |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 16 connection string |
| `TEST_DATABASE_URL` | A separate database the API tests wipe on every run |
| `JWT_SECRET`, `SITE_JWT_SECRET` | Two different long random strings (`openssl rand -base64 48`) |
| `PII_ENCRYPTION_KEY` | 32 bytes, base64 (`openssl rand -base64 32`). Encrypts PAN, Aadhaar and bank accounts. **Back it up separately — without it that data is unreadable.** |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | The HR admin account the seed creates |
| `COMPANY_*` | Company name, address, PAN, TAN, PF and ESI codes (printed on payslips and letters) |
| `REDIS_URL` | BullMQ queue for payroll runs and large exports. Blank = in-process |
| `WEB_ORIGIN`, `COOKIE_SECURE`, `TRUST_PROXY` | Set for production behind HTTPS |
| `FACE_MATCH_THRESHOLD`, `GPS_MAX_ACCURACY_M` | Face-match confidence and GPS accuracy needed for a punch |

The API refuses to start with a clear list of what is missing or malformed.

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | API (tsx watch) and web (Vite) together |
| `npm run build` | Production build of both (`apps/api/dist`, `apps/web/dist`) |
| `npm start` | Start the built API; with `SERVE_WEB_DIR=apps/web/dist` it also serves the web app |
| `npm run db:migrate` | Apply migrations (`prisma migrate deploy`) |
| `npm run db:seed` | Development seed |
| `npm run db:reset` | Drop and re-create the schema (development only) |
| `npm run db:seed:load` | Add 200 employees and three years of punches (load testing) |
| `npm run typecheck` | TypeScript across all packages |
| `npm test` | Engine acceptance tests and API integration tests |
| `npm run test:engines` | Spec §20 acceptance tests against the pure engines (no database) |
| `npm run test:api` | Spec §20.25–31 and the database guarantees, against `TEST_DATABASE_URL` |
| `npm run test:e2e` | Playwright browser flows against a running, seeded stack |
| `npm run test:load` | Spec §15 performance budgets against a load-test database |
| `npm run jobs:retention` | Nightly retention and aggregate rebuild — schedule it with cron |

## Repository layout

```
apps/
  api/                      Express + Prisma
    prisma/                 schema.prisma, migrations (incl. raw-SQL constraints), seed.ts, seed-load.ts
    src/engines/            attendance, pay, statutory, settlement — pure functions, no I/O, no clock
    src/services/           load data for the engines; payroll run, reports, settlement, register
    src/modules/            HTTP routes (auth, employees, offers, attendance, tablet, leave, setup,
                            sites, payroll, money, audit, dashboard, misc)
    src/lib/                auth, audit, PII crypto, list contract, idempotency, jobs, errors
    test/engines/           spec §20 acceptance tests
    test/api/               spec §20.25–31 integration tests
    test/load/budgets.ts    spec §15 budgets
  web/                      React
    src/features/<module>/  one folder per area, matching the API modules
    src/components/         shell, data table, list toolbar, states, charts, network diagram
    src/components/ui/      shadcn-style primitives (Radix)
    e2e/                    Playwright flows
packages/
  shared/                   Zod schemas, money (integer paise), IST dates, enums, policy rule shapes,
                            statutory seed data — imported by both apps
docs/OPERATIONS.md          production setup, backups and a restore rehearsal, retention, hosting
```

## How it is built

**The five domain rules** (spec §3) are enforced structurally, not by convention:

1. *Nobody belongs to a site.* There is no `employee.site_id`. Each punch carries a site; a day split across sites is one day valued by total hours, and project labour cost splits each person's cost by the minutes at each project's sites.
2. *The pay group is the centre of gravity.* Calendar method, weekly off, shift, salary structure and every policy hang off the pay group. The profile's "Rules that apply" panel reads all of it from the group.
3. *Everything dated is effective-dated.* Salaries and policies are never overwritten: a change closes the old row and inserts a new one. A salary structure has no date of its own; attaching it to a pay group moves the group's people onto it from a chosen month, as a dated change on each salary. A PostgreSQL **exclusion constraint** makes overlapping salary rows impossible.
4. *Statutory is personal, rates are corporate.* PF/ESI/PT/regime choices live on the person; rates and slabs are versioned data. Each payroll run records the rates row it used.
5. *Computed → override → effective.* Attendance is computed from the ledger every time; an override is a separate row storing both what was computed and what was substituted; payroll reads only the effective layer.

**Money is integer paise** end to end (`bigint` in the database). Percentages are converted once to integer micro-percent and multiplied in `BigInt` with explicit rounding (PF to the nearest rupee, ESI up, TDS to the nearest rupee).

**The engines are pure** (`apps/api/src/engines`): data in, data out, no database, no clock. That is what makes the acceptance tests possible and a disputed payslip reproducible.

**Guarantees in the database, not just the code** (`prisma/migrations/*_constraints`): the punch ledger and audit log are append-only (triggers, plus revoked grants for the application role); payslips in a LOCKED or PAID month cannot be updated (trigger); salary rows cannot overlap (exclusion constraint); weekly-off values are checked; trigram and partial indexes back search and audit.

**The payroll run** is claimed atomically (a second concurrent run is rejected, not queued), executed as one transaction in a background job, and writes a snapshot — payslips, lines, the statutory rates row and engine version — that every report and payslip reads afterwards. Every state transition reverses and is audited; mark-paid is idempotent.

**The list contract** (spec §15) is one hook and one table component: server-side filtering, sorting and keyset pagination (never OFFSET), page sizes 50/100/200, filter state in the URL, filter chips, saved views, "select all N matching" bulk actions with before/after previews, filtered CSV export, sticky header and first column, virtualised rows past 200.

**Security** (spec §18): argon2id passwords; JWT in httpOnly SameSite=Lax cookies with an 8-hour sliding session; five failed sign-ins in 15 minutes lock by account and IP; permissions are a lookup (`role.permissions`), not `isAdmin`; site tablets authenticate only inside their geofence, which is re-checked on every punch, and rotating a site password invalidates its tokens; PAN, Aadhaar and bank accounts are AES-256-GCM encrypted at rest, Aadhaar is masked everywhere, and every read of identity data is audited; face data is stored as embeddings, never photographs, and deleted on exit; gate snapshots are deleted after 30 days; punches store distance from the site centre, never a coordinate trail.

## Verification

| Check | Result |
| --- | --- |
| Engine acceptance tests (spec §20.1–24, 32–33 and more) | 87 passing |
| API integration tests (spec §20.25–31, DB guarantees, auth, PII, tablet, structures, pay group moves, salary breakups) | 34 passing |
| Playwright flows (dashboard; a month through all five steps, run, reports, lock, paid; register correction and revert; people search and profile) | 4 passing |
| Performance budgets (spec §15) at 200 employees and 568,125 punches | all passing — e.g. people list 16 ms (budget 400), month register 509 ms (1,500), 199-payslip run 2.5 s (30 s), register export 101 ms (3 s) |

## Decisions and deviations from the spec

Recorded here as the spec asks for any "SHOULD" done differently.

- **§20.10 marginal relief, third case.** The spec says ₹13,20,000 income gets "full slab tax with no relief". By the statutory formula it still gets relief (taxable ₹12,45,000; excess ₹45,000 < slab tax ₹66,750 → tax ₹46,800 with cess). The engine follows the formula; the test asserts ₹13,20,000 → ₹46,800 and uses ₹14,00,000 for the no-relief case. ₹12,75,000 → ₹0 and ₹12,90,000 → ₹15,600 hold exactly as specified.
- **§20.1 / §20.7 trial figures.** "5 flagged ambiguous" is reproduced exactly on the test structure (Basic 50%, HRA 40% of basic, ₹1,600 conveyance, balance; statutory-minimum PF). The ₹545-versus-₹506 overtime figures depend on the trial build's structure, which the spec does not give, so the test asserts the property (2× on basic + HRA beats 3× on basic) and the spec's own ₹16,800 → ₹80.77/hour → ₹1,615 example exactly.
- **PF has one limit: the wage ceiling.** §7 lists a ₹25,000 ceiling *and* a ₹6,000 maximum contribution. The maximum is not a separate rule: 12% of the ₹25,000 ceiling is ₹3,000 from the employee and ₹3,000 from the company, ₹6,000 together, so the ceiling already fixes it, and as an employee-side cap it could never bite. Keeping two numbers only invited them to drift apart, so the rates hold the ceiling alone and the screens show the largest contribution worked out from it (`pfMaxContribution`). Someone with restrict-to-ceiling off contributes on the full PF wage, with no rupee cap. Pension (EPS) and EDLI stay on the statutory ₹15,000 whatever the ceiling. Engine tests use the statutory-minimum ₹15,000 ceiling (as §20.13 does); the seed uses AJPWER's ₹25,000.
- **Salary structure components** are built as: name → percentage or fixed → for a percentage, what it is of (**gross**, **CTC** or **basic**) → an optional **maximum**. There is no minimum: whatever is left of gross is always the **Special Allowance**, added automatically and kept last, so a minimum could only push gross over. A maximum caps a percentage and the excess falls to the Special Allowance. "% of CTC" is a share of the annual CTC spread over twelve months: on a CTC agreement it uses the agreed CTC; on a gross agreement it uses the CTC that gross works out to (solved as a fixed point, because employer PF on a CTC-based basic feeds back into CTC). Yearly components use the same monthly figures as §5 says, so a yearly "8.33% of basic" is 8.33% of one month's basic.
- **Structures have no effective date.** A structure applies to the people of the pay group it is attached to. Attaching a different structure to a group that has people asks for the month it starts (default: the earliest month not yet run; a month already run is refused), previews who moves, and writes one dated salary change per person: a gross agreement keeps its gross, a CTC agreement keeps its CTC and the gross is solved again (inside the ESI band, on the side of the ceiling they are on today). People who cannot be moved automatically — a salary change already on or after that date, or a CTC no gross reproduces — are listed with the reason.
- **PF, ESI and professional tax are not typed-in components.** They are worked out from the statutory rates (Setup → Statutory rules), the components switched on as PF wage, gross, and each person's own choices (PF on/off, restrict to ceiling, voluntary PF, ESI on/off, PT state on the profile's Pay tab), as §4 requires. The structure builder shows each of them at the sample gross, with take-home and CTC.
- **ESI and PT base.** Computed on salary earnings (components after LOP, overtime, off-day pay) and not on adhoc bonuses, pending the open question in §6. Change in `assemblePayslip` (`statutory_gross`) if AJPWER decides otherwise.
- **Open questions §22, taken at the spec's current rule:** the salary and pay group valid on the last day of the month apply to the whole month; leave encashment pays the whole encashable balance; notice shortfall is recovered at gross ÷ 30; no fixed-term contract type; overtime cost is spread across a person's minutes.
- **Offline tablet punches** carry the face embedding and are matched on the server when they sync, so no biometric data is ever cached on the device; a queued punch that does not match confidently becomes a face exception at its original time.
- **Face exception review** shows the gate snapshot; enrolled photographs are not stored (only embeddings, per §18), so HR compares the snapshot with the person or their ID.
- **Face recognition** uses `@vladmandic/face-api` (tiny detector, 128-dimension descriptors) loaded only on the tablet and enrolment screens; the match threshold is `FACE_MATCH_THRESHOLD`. The spec defers ArcFace/InsightFace and liveness.
- **People search** covers name, code, designation and phone. PAN is encrypted at rest, so it is not substring-searchable.
- **Theme.** The tweakcn theme referred to in §2 was not in the document; the tokens in `apps/web/src/styles.css` follow the same shadcn/tweakcn format (with both font corrections applied), so a tweakcn export can be pasted over `:root` and `.dark`.
- **Dependency advisories.** `npm audit` reports four *moderate* advisories (React Router 6 client-side redirect handling; `uuid` inside `exceljs`). Neither path is exercised in a way that is exploitable here; upgrading to React Router 7 is a planned follow-up. CI fails on any *high* advisory.

## Honest limits (spec §19)

Face recognition is not identity proof — there is always a human exception path. Browser GPS is spoofable; the geofence raises the effort, and the Android wrapper reading `isFromMockProvider` is the real fix. TDS is a projection (no quarterly true-up yet). Income-tax surcharge above ₹50 lakh is not built. Tamil Nadu's half-yearly professional tax is not built. Verify PT slabs for states other than Andhra Pradesh and Telangana, and the income-tax slabs against the Finance Act, before the first live run.

See [docs/OPERATIONS.md](docs/OPERATIONS.md) for production deployment, backups with a rehearsed restore, retention and hosting.
