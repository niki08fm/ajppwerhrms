# ESI contribution wages and overtime

ESI eligibility and contribution wages are separate calculations. Standard ESI treatment
excludes overtime from the eligibility ceiling test but includes it in contribution wages.
The standard/legacy calculation is preserved. Confirm any exclusion with your payroll
adviser before statutory filing.

For the explicitly requested exclusion, HR can open **Setup → Statutory rules → Publish
new rates**, choose an effective date and set **Overtime in ESI contributions → Exclude
overtime**. This stores `esi.include_overtime=false` in the effective-dated statutory
rates. Old rate rows without this property continue to include OT. No database migration
is required. Employee-specific ESI eligibility and the salary structure's selected ESI
components continue to apply.

With exclusion selected, paid OT remains in earnings, tax calculations and net pay, but
is removed from both employee and employer ESI contribution wages. Selected normal
monthly earnings still reduce for LOP. Off-day work pay retains its existing treatment;
it is not ordinary working-day OT. PF and PT are unchanged.

For example, selected normal ESI wages of ₹20,000 and OT earnings of ₹2,000 produce ESI
employee contribution ₹150 and employer contribution ₹650 with exclusion. Standard
inclusion gives ₹165 and ₹715. Both retain the full ₹2,000 OT earning.

Publish a rate effective for the intended payroll month, then preview/recompute that
unlocked payroll. Previously saved payslips are not rewritten by publishing a setting;
locked/paid payroll retains its saved figures and rate version.

## Deploy

Vercel must deploy the updated branch. On AWS:

```sh
cd /opt/ajpwer
git pull --ff-only origin feature/clean-hrms-experience
sudo systemctl restart ajpwer-api
```

No seed, reset or migration is needed. Merely deploying the code does not enable OT
exclusion; HR must explicitly publish the selected setting.
