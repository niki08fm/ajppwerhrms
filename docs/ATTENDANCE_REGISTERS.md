# Attendance registers and corrections

Employee profiles, daily and monthly attendance registers, and payroll's attendance step use the same inline attendance workspace. Select a person or date to see the month's calendar beside the selected day's details and correction form.

Corrections keep the original punches for audit. Editing requires `attendance.write`; locked or paid payroll and other existing freezes still prevent changes. Changing the selected employee or day resets the draft; background refreshes and rejected saves preserve unfinished input.

## Monthly figures

- **Working days**: scheduled working dates within employment, through today for the current month.
- **Present / absent days**: work-day equivalents before leave covers an absence. A worked half day contributes 0.5 to each.
- **Paid leave applied**: approved leave paid from the employee's balance. Automatic paid leave is shown separately in reports.
- **Final LOP**: unpaid day equivalents after applied and automatic paid leave, including unpaid off days under the employee's policies.
- **OT hours**: regular overtime; holiday and weekly-off work retain their existing separate payroll treatment.
- **Late minutes**: total shortfall from the required shift on completed working days. Two days of 8h 40m and 8h 45m against a 9-hour shift contribute 35 minutes. Arrival delay is separate. Missing punches need correction before their shortfall can be known; approved half-day leave reduces the required shift accordingly.

Future dates and dates before joining or after exit do not increase attendance totals. These reporting figures do not change payroll's full-month financial totals or attendance payment thresholds.

## Downloads

The monthly register offers two reports in Excel or PDF:

1. **Monthly summary**: one row per employee with working, present, absent and leave days, final LOP, missing punches, OT hours and late minutes.
2. **Daily details for all employees**: every date in the month for each employee, with IN/OUT, status, worked time, OT, final LOP, late minutes and month totals. Excel includes a summary sheet. Missing punches are highlighted in amber.

The daily register offers its own selected-day report with day totals. Overnight OUT times include `(+1d)` where applicable. HR corrections supply the effective status/times; original punches remain available in the application.

Downloads require both `attendance.read` and `reports.export`, include all matching employees across pages, and follow the register's filters. In the monthly register, the site filter selects employees who punched at that site; their report still covers their whole month. Monthly headers show total final LOP; detailed employee sections include that employee's month totals.
