# Desktop HR actions: clear outcomes and safe retries

This update continues the desktop workflow pass on `feature/clean-hrms-experience`.
It changes the frontend only; it does not change payroll calculations, permissions
on the server, the database schema or the deployment's database connection.

## What HR will see

- **Leave:** a shorter task description, with automatic absence treatment available
  under an explanation. Recording waits for the current dates and balance check;
  an unavailable check has a retry action. If recording succeeds but approval
  fails, the form says so, keeps the recorded details fixed and offers **Retry
  approval**. That action uses the existing leave ID rather than creating another
  request. **Close for now** leaves the saved request available for review.
- **Leave decisions:** only pending requests can be selected for bulk decisions.
  Approve/reject controls wait for an outstanding decision, and confirmations name
  the result and number of requests. Readers do not see write controls.
- **Approvals:** decision errors stay beside the request. Its fields and opposing
  decision buttons are disabled while saving. HR can select another request;
  completion of an earlier decision does not change that new selection.
- **Loans and advances:** forms say **Record loan** or **Record advance**, explain
  payroll recovery, validate repayment terms and show the monthly loan repayment
  to the paise. Errors retain entered values. While saving, forms stay open and
  fields cannot change. Initial totals show a dash until loaded, and empty search
  results explain the current view rather than claiming no loans exist.
- **Final settlements:** adjustment errors retain the reason and amounts; negative
  day overrides cannot be submitted. Successful changes refresh the statement
  and related payroll reviews. Editing waits for the refreshed statement. Write
  controls follow the existing payroll permissions; printed statements are unchanged.

A network failure during creation can leave the server outcome unknown. The loan
and leave forms explicitly ask HR to check existing records before submitting
again. This update does not introduce server-side idempotency for lost responses.

## Verification

25 Chromium browser tests passed, including 11 new action-feedback scenarios,
existing manual attendance review flows and site-transfer approvals. Tests use
fictional API fixtures against the actual frontend; no production records were
created or changed. Desktop screenshots were inspected at 1440 × 1000. The Vite
production build and `git diff --check` passed.

These checks validate frontend behavior, not live response times or production
API availability.

## Deploy

Deploy this commit to the AJPower Vercel frontend, and promote it to production
if the feature branch is still configured as Preview. Refresh the app afterward.
No API restart, Prisma generation or database migration is required for these
frontend changes. The newer local-PostgreSQL deployment documentation remains
included; this update does not perform a database migration or change AWS.
