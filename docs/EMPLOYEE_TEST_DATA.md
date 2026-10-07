# Employee test data for the Today preview

The employee import replaces the generated workforce with the active employees from an Employee Complete Information Report workbook. Only rows whose employment status is `Working` are imported; relieved employees and blank or incomplete trailing rows are excluded. Source employee codes are retained for matching the monthly attendance file later. The existing company rule treats `TI` codes as AJ Power employees.

Employee details do not establish attendance or salary. The import creates no salary agreements, punches, attendance overrides, leave, loans or payroll results. Monthly attendance and salary amounts must be supplied separately before payroll can be calculated.

Missing departments and job titles use explicit `Unassigned` / `Not provided` labels. Missing phones remain blank, and conflicting birth dates remain unset for review. `ESI Eligible` sets ESI eligibility; `PF Details Available` records document availability, so it does not disable PF. The application’s usual PF default remains until participation is confirmed alongside salary setup.

## Use a separate local database

Create a new local PostgreSQL database named `ajpwer_employee_preview`, then point `DATABASE_URL` at it. Use the same local application settings and encryption key when importing and running the backend. Keep the previous preview database intact. Do not use `TEST_DATABASE_URL`: API tests reset that database on every run.

From the repository root, with `DATABASE_URL` set to the new database:

```bash
npm run db:deploy
npm run db:seed:setup
```

`db:seed:setup` creates the admin, AJ Power company, calendar, statutory rules, policies, salary structures and pay groups. It skips the example departments, projects, sites, employees, attendance and payroll. It does not print passwords. Admin credentials come from the local environment settings. The ordinary `db:seed` command still loads the full generated development data and should not be run on this employee preview database.

## Validate and import the workbook

Keep the workbook outside the Git checkout. Supply its absolute path; the importer reads the file without copying it into the repository. The default pay group is the setup's `Head office`; `--pay-group` explicitly selects a configured group.

Validate the active employee rows first:

```bash
npm run db:import:employees -- --file /private/path/employees.xlsx --pay-group 'Head office' --check
```

Then import the same file:

```bash
npm run db:import:employees -- --file /private/path/employees.xlsx --pay-group 'Head office'
```

The target must contain only the setup configuration, with no employees. Validation must pass before data is written. Keep the source employee codes for later attendance matching, and use the dedicated database when starting the backend:

```bash
npm run dev:backend
```

An optional `--report PATH` saves import details locally. Choose an absolute path inside the ignored `backend/uploads` directory, or a private location outside the checkout. The workbook and any report may contain personal information: keep them out of Git, screenshots, published previews and shared logs. Do not publish or commit a generated report.

After import, verify that every employee has the expected source code and active status, all employees resolve to AJ Power, and there are no generated salary or attendance records. The Today screen will have no current site headcounts until actual attendance is supplied. Missing salary agreements will remain visible as payroll validation issues rather than being replaced with invented amounts.
