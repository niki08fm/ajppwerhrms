# TDS deducted before AJPWER

Under a person's **Tax** tab, **TDS deducted before AJPWER** records the income tax
deducted in the current financial year before their payroll ran in AJPWER — by a
previous employer, or by the company before AJPWER went live. Enter one total per
financial year. Clearing it removes the figure; saving 0 records that nothing was
deducted. Changes are audit-logged; exited profiles are read-only.

## Monthly TDS (Section 192)

Each payroll month works out the whole year:

- **Income for the year**: months before AJPWER at the salary then on record, AJPWER
  payslips already run at their actual taxable pay, and this month to March at the
  current salary.
- **Tax for the year** on that income: the regime's slabs, standard deduction, rebate,
  marginal relief and cess.
- **Already deducted**: the figure entered here plus the TDS on AJPWER payslips run
  this year.
- **This month's TDS** = (tax for the year − already deducted) ÷ months left, including
  this one, rounded to the rupee. Taxable one-offs add their own tax in the month they
  are paid, as before. If more was deducted than the year's tax, TDS is nil; the excess
  is the employee's refund when they file.

With nothing entered and no AJPWER payslip yet this year, TDS is unchanged: the year's
tax spread evenly over the months employed. With nothing entered but AJPWER months
run, months before AJPWER count as deducted at that even rate.

Example: AJPWER goes live in October on ₹3,83,000 a month (new regime). Tax for the
year is ₹9,73,752; ₹4,86,876 was deducted April–September. October TDS is
(₹9,73,752 − ₹4,86,876) ÷ 6 = ₹81,146. A later increment raises the year's tax and the
months left absorb the difference.

## Payroll review

Step 3 warns (not blocking) about anyone with months of this financial year before
AJPWER and nothing entered, linking to the Tax tab.

## Not included

A previous employer's salary is not recorded, so a mid-year joiner's slab is worked out
on AJPWER salary only. Surcharge above ₹50 lakh is not built.
