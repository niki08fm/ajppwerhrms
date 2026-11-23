# TDS on salary: how it is deducted and how to check it

Payroll deducts income tax (TDS) so that, by an employee's last month in the tax year, TDS equals the tax they owe on what they were actually paid. Every month it recalculates the year's tax and collects what is still due, spread over the months left. This follows the *AJPWER Income Tax (TDS on Salary) Policy*.

## The calculation, every month

For each person in a payroll run:

1. **Paid so far this tax year.** Add up the taxable pay on this tax year's earlier payslips (generated, locked or paid). Add pay recorded on the Tax card as *paid earlier this tax year outside this payroll* (a previous employer's Form 12B, or months before AJPWER Workforce).
2. **This month.** Taxable pay actually earned this month: salary after loss of pay, plus overtime, off-day pay, yearly components due this month, bonuses and ad-hoc earnings.
3. **The months ahead.** The current monthly salary × the months left after this one. Overtime and off-day pay are added at their year-to-date monthly average. Yearly components due later in the year are added.
4. **Earlier months with no record.** A month this tax year in which the person was employed but has no payslip here, and no earlier pay is recorded, is estimated at the current salary with nothing deducted. Payroll review warns about this (*Earlier months estimated for TDS*).
5. **Tax for the year.** Taxable income = projected income − standard deduction − (old regime) HRA exemption, 80C (declared + employee PF/VPF, up to ₹1,50,000) and 80D. Rounded to ₹10. Slab tax − rebate (or marginal relief, new regime) + 4% cess, rounded to ₹10. Without a PAN, where tax is due: at least 20% of taxable income.
6. **Still due.** Tax for the year − TDS already deducted this year (payslips + earlier pay recorded).
7. **This month's TDS** = still due ÷ months left (this month included), to the rupee, never below zero. One-offs (bonus, ad-hoc earnings, leave encashment) add their full extra tax in the month paid.

**Months left** run to March. Once a last working day is recorded, they run to that month, so the final month collects whatever is still due.

**Limits:**
- TDS never takes more than the month's pay after PF, ESI and PT. The shortfall stays due and later months collect it.
- Payroll never refunds TDS: if more was deducted than is owed, deduction stops and the employee claims the excess in their return.
- The regime holds for the tax year once its first payroll runs.
- Tax rates are read as at 1 April.

Each payslip stores this working in `meta.tds`: projected income, taxable income, tax for the year, TDS before, months left, estimated months.

## Checking it yourself

### Your own cases, without the database

```bash
npm run tds:check -- --all
```

This runs every case in `backend/scripts/tds-scenarios` through the real payslip engine, month by month. It then works out the tax owed with a separate calculator that shares no code with payroll. Each case ends with:

- `PASS`: TDS for the year equals the tax owed.
- `OVER`: more was deducted before a drop in income was known; payroll stops TDS and the employee claims the rest in their return.
- `SHORT` or `FAIL`: payroll did not deduct the right amount. Report it.

To test your own case, copy `template-your-case.json`, edit it, and run it:

```bash
npm run tds:check -- backend/scripts/tds-scenarios/my-case.json
```

| Field | Meaning |
| --- | --- |
| `regime` | `NEW` or `OLD` |
| `months[].month`, `gross` | Each month paid and its monthly gross (₹) |
| `months[].lop_days` | Days of loss of pay that month |
| `months[].overtime_hours` | Overtime hours (paid at 2× gross ÷ days in month ÷ 8 unless `overtime_rules` says otherwise) |
| `months[].bonus` | Taxable one-off paid that month (₹) |
| `pf` | Employee PF on (counts under 80C in the old regime) |
| `declarations` | Old regime: `80c`, `80d`, `rent_monthly`, `metro` |
| `previous` | Earlier this tax year outside this payroll: `income`, `tds` (₹) |
| `last_month`, `resignation_known_from` | A leaver's final month, and the month payroll learns of it |
| `no_pan` | `true` for no PAN on file |
| `expect_total_tds` | Optional: the total you expect; the check fails if TDS differs |

### A real employee, from the database

```bash
npm run tds:check -- --employee AJ0026
```

This shows each payslip this tax year: projected income, tax for the year, TDS before, months left and TDS. It checks that:

- every month started from exactly the TDS deducted before it;
- its tax for the year matches the independent calculation.

It then works out the **next month's** TDS live, step by step, from today's attendance and salary. Add `--fy 2025` for another tax year, or `--month 2026-11` for a different next month.

### In the app

1. Open the person → **Salary** → **Income tax**. Record earlier pay this tax year if any salary was paid outside this system.
2. In **Monthly payroll → Issues**, read the tax warnings:
   - *No previous-employer figures*
   - *Regime change waits for April*
   - *Earlier months estimated for TDS*
   - *TDS limited by low pay*
   - *TDS above the tax owed*
3. Generate the month and compare the payslip's **Income tax (TDS)** with the employee check above.
4. In March, the TDS report total for each person should equal their tax for the year.
