# Attendance registers and corrections

Daily and monthly registers, and payroll's attendance step, open an attendance details drawer. The employee's month calendar comes first, followed by the total monthly Late minutes, selected-day details and correction form. Employee profiles use the shared editor inside their attendance workspace.

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
2. **Daily details for all employees**: employee names down the rows and dates across the columns, with IN, OUT and OT under each date. Final attendance totals appear after the dates. Excel shows the full month grid with employee names and date headers frozen while scrolling. PDF divides the dates into readable sections and finishes with attendance totals. Missing punches show `Missing` and are highlighted in amber.

The daily register offers its own selected-day report with day totals. Overnight OUT times include `(+1d)` where applicable. HR corrections supply the effective status/times; original punches remain available in the application.

Downloads require both `attendance.read` and `reports.export`, include all matching employees across pages, and follow the register's filters. In the monthly register, the site filter selects employees who punched at that site; their report still covers their whole month. Monthly headers show total final LOP, and the detailed grid ends with each employee's final attendance totals.
