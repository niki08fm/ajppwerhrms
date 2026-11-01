# Desktop HR workflow update

This update keeps the existing AJPower navigation and visual identity and makes the desktop screens easier to act on. It builds on the action-speed update. No database migration or additional service is required.

## Payroll reviews

The reviews now use familiar names: Attendance, Joiners and exits, Employee checks, Held salaries, Final settlements (F&F), and One-time adjustments. The underlying stage numbers, calculations and statutory settings are unchanged.

- Confirm a review to move to the next one. The app uses the server's confirmed result immediately, so the screen does not jump back while a refresh is pending.
- Loading or failed review data cannot be confirmed. Retry from the affected section; your place in the workflow is retained.
- A refused confirmation keeps its explanation visible on the page.
- Reopen review explains exactly which completed reviews must be checked again. Cancel leaves them complete; reopening keeps the saved entries and clears their review status.
- A confirmation finishing after you leave the review does not navigate you back.
- View-only roles can read the review but cannot confirm or reopen it.
- The server rechecks the period after acquiring its lock. Confirmation and reopening are refused while generation is queued or if the payroll became generated while the request was waiting.

## Employee records and setup

- Employee screens use shorter, task-specific descriptions. Salary revision has one primary entry point for active employees; onboarding employees retain their in-tab revision action.
- The employee overview shows the working calendar, shift and attendance rules first. Open **Overtime, leave and other policies** for the remaining rules.
- Salary-structure cards show assigned employees and an example salary split. Open **View salary components** for the component table; important validation warnings remain visible.
- Pay-group cards show calendar, shift and weekly off. Open **View … pay policies** for the policy list.
- **Manage employees** stays directly available. Setup edits, duplication and deletion are under the card's **Actions** menu. Typed-name deletion and reassignment requirements still apply.
- Loan, exit, payroll and statutory messages explain the task or saved change instead of exposing audit-log or implementation detail in the main flow.

## Sign-in

General sign-in and dedicated tablet sign-in now follow the same site-login policy: signing in does not request GPS. Recording attendance and registering a face still use their existing location checks. No geofence restriction on attendance has been removed.

## Validation

Tests cover confirmed-state navigation during a slow refresh, keeping errors visible, retrying an unavailable review, cancellation and confirmation of reopening, late responses after navigation, read-only roles, concurrent payroll generation, salary and ESI component settings, deletion, profile editing, and both site sign-in paths. UI validation uses fictional records; API tests use the isolated local test database.

## Update

Update `/opt/ajpwer` from `feature/clean-hrms-experience`, reload systemd if its service definition changed, and restart `ajpwer-api`. Deploy/promote the same commit to the AJPower Vercel production frontend.

If upgrading from before the action-speed update, also run `npm run build --workspace=@ajpwer/backend` to regenerate Prisma Client for joined reads. No SQL migration is needed.
