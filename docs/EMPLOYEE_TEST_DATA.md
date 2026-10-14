# Employee payroll test data

The development replacement imports only `Working` employees from an Employee
Complete Information Report. Relieved employees and blank-status rows are
excluded. Uploaded employee numbers are not used as application IDs: the normal
employee-code generator assigns new `AJ` codes, and a private mapping allows
later attendance files to be matched to their source rows.

The supplied report contains 59 active profiles and no salary amounts or monthly
attendance. Importing it creates no invented salary agreements, punches, leave,
loans or payroll results. Actual salary amounts and attendance are required
before payroll can be calculated. Missing departments/designations use
`Unassigned`/`Not provided`; missing phones remain blank. PF stays at the normal
application default because `PF Details Available` describes documents, not
participation. EPS defaults on, and ESI/profile details follow the report.

## Replacement configuration

The replacement retains the selected pay group's shift, attendance policies,
weekly off and holiday rules, and uses the actual 28/29/30/31-day calendar month.
It attaches OT at **2× Basic**, keeping the existing timing, hours-per-day,
rounding and cap. No leave policy is attached.

Keep the **Employee** salary structure and its component definitions. If that
name is absent, the default fallback keeps **Site staff** and renames it Employee.
Other sample structures and pay groups are removed after their test employee
history is cleared. PF/ESI rate versions, tax/PT setup, company, admin access,
sites and site credentials, face settings/models/features, shifts, holidays and
existing policy definitions remain intact. Employee-specific faces, punches and
registrations are cleared with the replaced employee records.

## Run locally

This operation is for an explicitly named local **development** database.
Stop the backend and workers first. Keep the workbook outside Git or in the
ignored `backend/uploads` directory. After pulling the branch:

```bash
npm run build
npm run db:migrate
```

Read-only validation and replacement plan:

```bash
npm run db:replace:payroll-employees -- --file "/private/path/employees.xlsx"
```

Apply the validated plan, substituting the actual development database name:

```bash
npm run db:replace:payroll-employees -- \
  --file "/private/path/employees.xlsx" \
  --replace-development-data \
  --database "ajpwer_employee_preview"
```

The command requires PostgreSQL `pg_dump` and `pg_restore`. It creates and
verifies a private custom-format backup before replacing any data. The
replacement runs in one transaction and checks that protected settings and
retained salary components are unchanged. Changes to protected setup or record
counts invalidate the plan and roll back replacement. Stop writers before
backing up and replacing data. No database reset or reseed is used.

Optional settings: `--pay-group`, `--structure`, `--fallback-structure`,
`--backup-dir`, `--pg-dump`, `--pg-restore`, `--mapping` and `--report`.
The default backup/mapping directory is ignored
`backend/uploads/payroll-test-data`, with private permissions. Keep backups,
workbooks, code mappings and reports out of Git and shared previews.

Restart the backend after importing. Check active employee counts, generated
codes, calendar method, OT base/rate and the absence of a leave attachment.
Salary setup issues remain visible until real amounts are supplied.

The older `db:import:employees` command remains available for empty databases
and retains source employee numbers; it does not perform this replacement.
