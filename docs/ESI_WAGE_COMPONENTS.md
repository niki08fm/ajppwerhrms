# ESI wage components

Under Setup → Salary structures, the **ESI wage** column selects the monthly
earnings included in ESI wages. It is independent of the **PF wage** and
**Taxable** selections. Basic, HRA, DA, custom monthly earnings and Special
Allowance can each be selected. Selections should reflect the applicable ESI
wage rules; an earning's taxability does not decide whether it is an ESI wage.

The sample salary breakup shows the selected ESI wage. Creating a structure
saves the selections, and duplicating a structure preserves them. Structures
remain immutable: use Duplicate and edit, then assign the new structure on an
employee's salary revision to change an existing agreement's selections.

## Calculations

- Eligibility uses the sum of selected fixed monthly earnings against the
  configured ESI ceiling. Employee PF and ESI deductions do not reduce this wage.
- Both ESI contributions use selected earned monthly components after LOP.
  Overtime and off-day pay remain included, as in the existing payroll engine.
- Gross salary, PF, PT, yearly payout handling and income tax retain their own
  calculations. Yearly components remain excluded from recurring ESI wages.
- CTC includes employer ESI on the selected wage when ESI applies. The CTC solver
  checks the selected wage on each candidate salary, preserving upward rupee
  rounding and the explicit choice where both ESI and non-ESI salaries are valid.
  It does not reduce an entered target to create eligibility.
- Contribution-period eligibility uses the salary structure effective at the
  period's start, or joining date for a new employee. Existing paid coverage
  continues through the period. Current contributions use current earned wages.
- No selected monthly earnings produces zero regular ESI wages and a validation
  warning. Overtime and off-day wages still count when coverage applies.

For example, at monthly gross ₹24,000, Basic of ₹12,000 and HRA of ₹4,800
produce ESI wages of ₹16,800 when those are the selected earnings. At the
configured 0.75%/3.25% rates, employee ESI is ₹126 and employer ESI is ₹546.
Selecting components does not change the ₹24,000 gross.

## Stored data and upgrading

`salary_component.counts_as_esi_wages` defaults to true for existing monthly
components; the migration excludes existing yearly rows. Older API clients
omitting the field keep that default. Yearly flags are normalized to false.

New payslips record earned `esi_wage` in their snapshot, under engine version
1.5.0. ESI reports use this snapshot and fall back to the historical
`statutory_gross` for older payslips. Frozen payroll is not recalculated.

After pulling the branch, run from the repository root:

```bash
npm run build
npm run db:migrate
```

Restart the backend and frontend. This deploys the additive migration; no data
reset or reseed is required.
