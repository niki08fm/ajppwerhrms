import { lastOfMonth } from '@ajpwer/shared';

/**
 * The monthly register: one row per person, one cell per day, and the month's figures so far.
 * Built from computeMonths() — the same days payroll reads — so a cell, a payslip and the
 * person's profile never disagree. Days after today are left blank, and the figures count
 * only the days up to today (all of them, for a past month).
 */
const OUT = ['NOT_JOINED', 'EXITED'];
const OFF = ['WEEKLY_OFF', 'HOLIDAY', 'OFF_WORKED', 'HOLIDAY_WORKED'];
const WORKING = ['PRESENT', 'HALF_DAY', 'SHORT', 'MISSING_PUNCH'];
const round2 = (x) => Math.round(x * 100) / 100;

export function monthRows(employees, months, ym, today) {
  const cut = lastOfMonth(ym) < today ? lastOfMonth(ym) : today;
  return employees.map((e) => {
    const days = months.get(e.id)?.result.days ?? [];
    const sofar = days.filter((d) => d.date <= cut && !OUT.includes(d.status));
    const count = (s) => sofar.filter((d) => d.status === s).length;
    const paid = round2(sofar.reduce((a, d) => a + d.day_value, 0));
    return {
      employee: { id: e.id, code: e.code, name: e.name, department: e.department },
      days: days.map((d) =>
        d.date > cut
          ? { date: d.date, future: true }
          : {
              date: d.date,
              status: d.status,
              day_value: d.day_value,
              overridden: !!d.overridden,
              late_min: d.late_min ?? 0,
              early_min: d.early_min ?? 0,
              ot_min: OFF.includes(d.status) ? 0 : (d.ot_min ?? 0),
              leave_type: d.leave_type ?? null,
            },
      ),
      totals: {
        days: sofar.length,
        paid,
        lop: round2(Math.max(0, sofar.length - paid)),
        present: count('PRESENT'),
        half_day: count('HALF_DAY'),
        absent: count('ABSENT'),
        missing_punch: count('MISSING_PUNCH'),
        leave: count('ON_LEAVE'),
        late_days: sofar.filter((d) => d.late_min > 0 && WORKING.includes(d.status)).length,
        ot_min: sofar.reduce((a, d) => a + (OFF.includes(d.status) ? 0 : (d.ot_min ?? 0)), 0),
        corrected: sofar.filter((d) => d.overridden).length,
      },
    };
  });
}
