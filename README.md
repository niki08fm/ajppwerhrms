# AJPWER Workforce

Attendance, payroll and settlement for AJ Power Engineering — built to the *AJPWER Workforce — Requirements & Build Specification* (30 September 2026).

It records attendance from face punches at geofenced sites, turns punches into paid days under each pay group's policies, runs monthly payroll with full Indian statutory deduction (PF, ESI, professional tax, income tax), settles people who leave, and reports labour cost per project.

**Stack:** React 18 + Vite (frontend) · Node + Express 4 (backend) · PostgreSQL 16 + Prisma · Python face service with YuNet, SFace and MiniFASNet (face) · plain JavaScript (ES modules) throughout · TanStack Query / Table / Virtual · Tailwind CSS v4 · Zod · BullMQ + Redis · Vitest, Supertest, Playwright.

---

## Quick start

Prerequisites: **Node 22.9 or newer**, **PostgreSQL 16** and **Python 3.10 or newer** (for the face service). Redis is optional (without it, jobs run inside the backend).

```bash
# 1. Configuration — fill in your own values (see "Environment" below)
cp .env.example .env

# 2. Install, create the database tables, load sample data
npm install
npm run db:migrate       # creates the database named in DATABASE_URL if it does not exist
npm run db:seed          # prints the admin login and each site tablet's login once
npm run face:install     # the face service: a Python venv and the four model files (set FACE_SERVICE_DEV=1 in .env)

# 3. Run the backend (port 4000), the frontend (port 5173) and the face service (127.0.0.1:8100)
npm run dev
```

Open **http://localhost:5173** and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`.
A site tablet signs in at **http://localhost:5173/tablet** with a site login (it only works inside that site's geofence — for local testing, set your browser's location to the site's coordinates in DevTools → Sensors). The seeded people have only old face templates: register a face first with **Register face** on the tablet (employee ID and name), or from the profile.

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
| `FACE_SERVICE_URL`, `FACE_SERVICE_TOKEN` | Where the face service listens (127.0.0.1:8100) and the shared secret it requires. Optional `FACE_*` thresholds: see `.env.example` |
| `GPS_MAX_ACCURACY_M` | GPS accuracy needed to sign in and punch |
| `NOMINATIM_USER_AGENT`, `NOMINATIM_EMAIL` | Identify the app to OpenStreetMap's place search, used by the site map |

The API refuses to start with a clear list of what is missing or malformed.

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Backend (`node --watch`), frontend (Vite), and the face service when `FACE_SERVICE_DEV=1`; `dev:backend` / `dev:frontend` run one |
| `npm run face:install` | Face service: Python venv, packages and the four model files (`face:models` re-checks the models) |
| `npm run build` | Generates the database client and builds the frontend (`frontend/dist`); the backend runs as it is |
| `npm start` | Start the built backend; with `SERVE_WEB_DIR=frontend/dist` it also serves the frontend |
| `npm run db:migrate` | Apply migrations (`prisma migrate deploy`) |
| `npm run db:seed` | Development seed |
| `npm run db:reset` | Drop and re-create the schema (development only) |
| `npm run db:seed:load` | Add 200 employees and three years of punches (load testing) |
| `npm test` | Engine acceptance tests and API integration tests |
| `npm run test:engines` | Spec §20 acceptance tests against the pure engines (no database) |
| `npm run test:face` | The face service's Python tests (`npm run service:test -w @ajpwer/face`) |
| `npm run test:api` | Spec §20.25–31 and the database guarantees, against `TEST_DATABASE_URL` |
| `npm run test:e2e` | Playwright browser flows against a running, seeded stack |
| `npm run test:load` | Spec §15 performance budgets against a load-test database |
| `npm run jobs:retention` | Nightly retention and aggregate rebuild — schedule it with cron |

## Repository layout

Three folders, one job each:

```
frontend/     React (Vite) — every screen: the admin app and the site tablet
backend/      Node + Express — the API, the PostgreSQL database (Prisma), payroll and attendance engines
face/         Face v2 — the Python face service (detection, recognition, live-face check), the punch rules, tablet guidance
```

In more detail:

```
frontend/                   React 18 + Vite + Tailwind (.jsx)
  src/pages/<area>/         one file per screen: people, attendance, payroll, sites, setup, tablet…
  src/components/           shared pieces (shell, data table, charts, ui/) and area parts (people/, payroll/…)
  src/services/             api.js — every call to the backend; face.js — the tablet's face guidance (no recognition)
  src/hooks/  src/context/  useLookups and list hooks; SessionContext (who is signed in)
  src/utils/                formatting helpers
  e2e/                      Playwright browser flows

backend/                    Node + Express 4 + Prisma (PostgreSQL 16)
  src/server.js             starts the HTTP server;  src/app.js  builds the Express app
  src/config/               env.js (settings), db.js (Prisma client), logger.js
  src/routes/               one Express router per area: URL → middleware → controller
  src/controllers/          request handlers: read the request, call services, send the response
  src/services/             business logic and database access (*.service.js)
  src/middleware/           auth (who is signed in, permissions), errorHandler, upload, idempotency
  src/calculations/         attendance, pay, statutory (PF, ESI, PT, TDS), settlement — pure functions
  src/jobs/                 job queue, payroll-run handlers, nightly retention
  src/utils/                errors, asyncHandler, audit, crypto, dates, geo, list paging
  shared/                   the business rules both sides use: money in integer paise, IST dates,
                            validation schemas, statutory tables (package @ajpwer/shared)
  prisma/                   schema.prisma (the database), migrations, seed.js, seed-load.js
  tests/                    engines/ (spec §20 acceptance), api/ (integration), load/ (budgets)

face/                       Face v2 (package @ajpwer/face) — see face/INTEGRATION.md
  service/                  Python face service on 127.0.0.1:8100: YuNet, SFace, MiniFASNetV2 + V1SE
  src/                      the backend's punch rules (decidePunch, sessions, gallery, client) and tablet guidance
  models/                   the Tiny Face Detector for tablet guidance, served at /face-models (no outside CDN)
  deploy/                   systemd unit for the face service

docs/OPERATIONS.md          production setup, backups and a restore rehearsal, retention, hosting
```

Each folder has its own README. The root `package.json` ties them together (npm workspaces), so one `npm install` and one `npm run dev` cover all three.

## How it is built

**The five domain rules** (spec §3) are enforced structurally, not by convention:

1. *Nobody belongs to a site.* There is no `employee.site_id`. Each punch carries a site; a day split across sites is one day valued by total hours, and project labour cost splits each person's cost by the minutes at each project's sites.
2. *Pay groups control working rules; salary structures belong to employees.* Calendar method, weekly off, shift and policies come from the pay group. Each employee salary agreement selects its own structure. Moving between pay groups applies the new working rules while preserving that person's salary history.
3. *Salaries and policies are effective-dated.* A salary revision closes the old agreement and inserts a new one. Unlocked salary history can be corrected or deleted with an audit trail; at least one agreement remains once configured, and salary history used by locked or paid payroll is protected. A PostgreSQL **exclusion constraint** makes overlapping salary rows impossible.
4. *Statutory is personal, rates are corporate.* PF/ESI/PT/regime choices live on the person; rates and slabs are versioned data. Each payroll run records the rates row it used.
5. *Computed → override → effective.* Attendance is computed from the ledger every time; an override is a separate row storing both what was computed and what was substituted; payroll reads only the effective layer.

**Money is integer paise** end to end (`bigint` in the database). Percentages are converted once to integer micro-percent and multiplied in `BigInt` with explicit rounding (PF to the nearest rupee, ESI up, TDS to the nearest rupee).

**The calculations are pure** (`backend/src/calculations`): data in, data out, no database, no clock. That is what makes the acceptance tests possible and a disputed payslip reproducible.

**Guarantees in the database, not just the code** (`prisma/migrations/*_constraints`): the punch ledger and audit log are append-only (triggers, plus revoked grants for the application role); payslips in a LOCKED or PAID month cannot be updated (trigger); salary rows cannot overlap (exclusion constraint); weekly-off values are checked; trigram and partial indexes back search and audit.

**The payroll run** is claimed atomically (a second concurrent run is rejected, not queued), executed as one transaction in a background job, and writes a snapshot — payslips, lines, the statutory rates row and engine version — that every report and payslip reads afterwards. Every state transition reverses and is audited; mark-paid is idempotent.

**The list contract** (spec §15) is one hook and one table component: server-side filtering, sorting and keyset pagination (never OFFSET), page sizes 50/100/200, filter state in the URL, filter chips, saved views, "select all N matching" bulk actions with before/after previews, filtered CSV export, sticky header and first column, virtualised rows past 200.

**Security** (spec §18): argon2id passwords; JWT in httpOnly SameSite=Lax cookies with an 8-hour sliding session; five failed sign-ins in 15 minutes lock by account and IP; permissions are a lookup (`role.permissions`), not `isAdmin`; site tablets sign in with a login ID and password set by HR (argon2id; the password is shown once and never stored, returned again or logged) and only inside their geofence, which is re-checked on every punch; resetting a site password or disabling its login invalidates its tokens; PAN, Aadhaar and bank accounts are AES-256-GCM encrypted at rest, Aadhaar is masked everywhere, and every read of identity data is audited; face data is stored as face codes (embeddings), never photographs, is made on our own server by the face service (which keeps nothing), and is deleted on exit; face crops of failed tries are kept 30 days for HR only when a manual request is raised; gate snapshots are deleted after 30 days; punches store distance from the site centre, never a coordinate trail.

## Verification

| Check | Result |
| --- | --- |
| Engine acceptance tests (spec §20.1–24, 32–33 and more), geofence and face rules | 118 passing |
| API integration tests (spec §20.25–31, DB guarantees, auth, PII, sites and tablet sign-in, face v2 punches, structures, pay group moves, salary breakups) | 75 passing |
| Face service (Python: API, head-turn geometry, model download; the real-model tests need the models and a test photo) | 21 passing, 2 skipped without models |
| Playwright flows (dashboard; a month through all five steps, run, reports, lock, paid; register correction and revert; people search and profile) | 4 passing |
| Performance budgets (spec §15) at 200 employees and 568,125 punches | all passing — e.g. people list 16 ms (budget 400), month register 509 ms (1,500), 199-payslip run 2.5 s (30 s), register export 101 ms (3 s) |

## Decisions and deviations from the spec

Recorded here as the spec asks for any "SHOULD" done differently.

- **§20.10 marginal relief, third case.** The spec says ₹13,20,000 income gets "full slab tax with no relief". By the statutory formula it still gets relief (taxable ₹12,45,000; excess ₹45,000 < slab tax ₹66,750 → tax ₹46,800 with cess). The engine follows the formula; the test asserts ₹13,20,000 → ₹46,800 and uses ₹14,00,000 for the no-relief case. ₹12,75,000 → ₹0 and ₹12,90,000 → ₹15,600 hold exactly as specified.
- **§20.1 / §20.7 trial figures.** "5 flagged ambiguous" is reproduced exactly on the test structure (Basic 50%, HRA 40% of basic, ₹1,600 conveyance, balance; statutory-minimum PF). The ₹545-versus-₹506 overtime figures depend on the trial build's structure, which the spec does not give, so the test asserts the property (2× on basic + HRA beats 3× on basic) and the spec's own ₹16,800 → ₹80.77/hour → ₹1,615 example exactly.
- **PF has one limit: the wage ceiling.** §7 lists a ₹25,000 ceiling *and* a ₹6,000 maximum contribution. The maximum is not a separate rule: 12% of the ₹25,000 ceiling is ₹3,000 from the employee and ₹3,000 from the company, ₹6,000 together, so the ceiling already fixes it, and as an employee-side cap it could never bite. Keeping two numbers only invited them to drift apart, so the rates hold the ceiling alone and the screens show the largest contribution worked out from it (`pfMaxContribution`). Someone with restrict-to-ceiling off contributes on the full PF wage, with no rupee cap. Pension (EPS) and EDLI stay on the statutory ₹15,000 whatever the ceiling. Engine tests use the statutory-minimum ₹15,000 ceiling (as §20.13 does); the seed uses AJPWER's ₹25,000.
- **Salary structure components** are built as: name → percentage or fixed → for a percentage, what it is of (**gross**, **CTC** or **basic**) → an optional **maximum**. There is no minimum: whatever is left of gross is always the **Special Allowance**, added automatically and kept last, so a minimum could only push gross over. A maximum caps a percentage and the excess falls to the Special Allowance. "% of CTC" is a share of the annual CTC spread over twelve months: on a CTC agreement it uses the agreed CTC; on a gross agreement it uses the CTC that gross works out to (solved as a fixed point, because employer PF on a CTC-based basic feeds back into CTC). Yearly components use the same monthly figures as §5 says, so a yearly "8.33% of basic" is 8.33% of one month's basic.
- **Employee salary structures.** Structures are selected when adding an employee, issuing an offer or revising salary, independently of the pay group. Salary and statutory has separate Salary and Statutory views; salary shows the current breakup, revision history and pay-group assignment. New structures include removable DA at ₹0 by default. Overtime can use gross or any combination of Basic, HRA and DA; a missing DA component contributes zero.
- **Manage pay-group employees.** Setup → Pay groups can add employees to a group or move selected members to another group. Each policy dropdown includes None. Salary revisions, salary structure and agreed amounts are preserved during a membership change, which is recorded in the employee journey alongside designation changes.
- **Company contributions are employer PF 12% (pension + EPF) and, when the person is eligible, employer ESI** — nothing else. CTC = gross + those contributions (+ yearly items). EDLI and PF admin charges are still worked out and paid with the PF challan (the PF report shows them), but they are not part of CTC, the salary breakup, or the payslip's contributions section. Payslips from engine 1.2.0 carry them in their snapshot for the challan; earlier payslips keep their own lines.
- **PF, ESI and professional tax are not typed-in components.** They are worked out from the statutory rates (Setup → Statutory rules), the components switched on as PF wage, gross, and each person's own choices (PF on/off, restrict to ceiling, voluntary PF, ESI on/off, PT state on the profile's Pay tab), as §4 requires. The structure builder shows each of them at the sample gross, with take-home and CTC.
- **ESI and PT base.** Computed on salary earnings (components after LOP, overtime, off-day pay) and not on adhoc bonuses, pending the open question in §6. Change in `assemblePayslip` (`statutory_gross`) if AJPWER decides otherwise.
- **Open questions §22, taken at the spec's current rule:** the salary and pay group valid on the last day of the month apply to the whole month; leave encashment pays the whole encashable balance; notice shortfall is recovered at gross ÷ 30; no fixed-term contract type; overtime cost is spread across a person's minutes.
- **No offline punching.** Without network the tablet says "No network. Punch is not possible right now. Tell your site in-charge." and HR enters the day manually. (The earlier offline queue is gone.)
- **Face v2** (face/INTEGRATION.md).
  - Recognition and the live-face check run on our server: YuNet, SFace and MiniFASNetV2 + V1SE in a Python service. The browser only guides (Tiny Face Detector).
  - A punch needs a live face and a head turn in the direction the server asks, then "Is this you?".
  - Five failed tries (including "This is not me") open an ID and name form that becomes a manual request for HR, with the face crops.
  - Templates made by the old face-api are kept as `faceapi-v1` and never matched. Everyone registers once more, and until then their punches go through the manual request.
  - Confident punches add rolling templates (at most five per person).
  - Change site records travel, which counts only on arrival at the named site the same day; HR can change it.
- **Face exception review** shows the face crops of the failed tries (or the gate snapshot for older exceptions). Enrolled photographs are not stored (only face codes, per §18), so HR compares the crops with the person or their ID.
- **Sites.** HR marks each site on an OpenStreetMap map (drag the marker, search a place, paste coordinates or a Google Maps link, or use the browser's location) with a 50–2000 m geofence, and sets the tablet's login ID and password on the same form (typed, or generated: 12 characters without look-alikes). A new centre or radius is audited and applies from the next sign-in and punch; past punches keep the distance recorded when they were made. Site names are unique ignoring case. The migration that introduced this brought any radius outside 50–2000 m inside it and appended the code to duplicate names, and recorded each change in the audit log. Permission `sites.write` became `sites.manage`.
- **Tablet sign-in order.** The login ID, then the password, then the lockout, then GPS accuracy, then distance, each with its own message. The lockout is looked up before the password is checked, so a locked-out caller cannot keep guessing.
- **People search** covers name, code, designation and phone. PAN is encrypted at rest, so it is not substring-searchable.
- **Theme.** The tweakcn theme referred to in §2 was not in the document; the tokens in `frontend/src/styles.css` follow the same shadcn/tweakcn format (with both font corrections applied), so a tweakcn export can be pasted over `:root` and `.dark`.
- **Dependency advisories.** `npm audit` reports four *moderate* advisories (React Router 6 client-side redirect handling; `uuid` inside `exceljs`). Neither path is exercised in a way that is exploitable here; upgrading to React Router 7 is a planned follow-up. CI fails on any *high* advisory.

## Honest limits (spec §19)

Face recognition is not identity proof — there is always a human exception path. The live-face check raises the effort of a photo or screen attack but does not rule it out; tune `FACE_LIVE_MIN` from real attempts. Browser GPS is spoofable; the geofence raises the effort, and the Android wrapper reading `isFromMockProvider` is the real fix. TDS is a projection (no quarterly true-up yet). Income-tax surcharge above ₹50 lakh is not built. Tamil Nadu's half-yearly professional tax is not built. Verify PT slabs for states other than Andhra Pradesh and Telangana, and the income-tax slabs against the Finance Act, before the first live run.

See [docs/OPERATIONS.md](docs/OPERATIONS.md) for production deployment, backups with a rehearsed restore, retention and hosting.
