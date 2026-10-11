/** Attendance reporting is separate from payroll's full-month financial totals. */
const OUT = new Set(['NOT_JOINED', 'EXITED']);
const OFF = new Set(['WEEKLY_OFF', 'HOLIDAY', 'OFF_WORKED', 'HOLIDAY_WORKED']);
const COMPLETED_WORK = new Set(['PRESENT', 'HALF_DAY', 'SHORT']);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const nonnegative = (n) => Math.max(0, Number(n) || 0);
const employed = (d) => !OUT.has(d.status);
const working = (d) => d.shift_kind ? d.shift_kind === 'WORKING' : !OFF.has(d.status);

/** Corrections settle the old physical punch issue without erasing its audit flags. */
export function hasMissingPunch(day) {
  if (day.overridden) return day.status === 'MISSING_PUNCH';
  return day.status === 'MISSING_PUNCH' || (day.flags ?? []).some((f) => ['UNMATCHED_IN', 'ORPHAN_OUT', 'AUTO_OUT', 'AUTO_PUNCH', 'AUTOPUNCHED'].includes(f));
}

/**
 * An approved half-day absence needs only the remaining half shift. A correction
 * stands for the day as worked and supersedes the old leave/punch classification.
 */
export function requiredShiftMinutes(day) {
  if (!employed(day) || !working(day)) return 0;
  if (!COMPLETED_WORK.has(day.baseline_status ?? day.status)) return 0;
  const standard = nonnegative(day.standard_min ?? day.required_shift_min);
  const portion = !day.overridden && day.applied && Number(day.applied.portion) < 1 ? nonnegative(day.applied.portion) : 0;
  return Math.round(standard * (1 - Math.min(1, portion)));
}

/**
 * The month's "Late minutes": completed work below the required shift, independent
 * of arrival lateness or payment tolerance. Missing punches need correction first;
 * an unknown out time must not manufacture a full shift of shortfall.
 */
export function shiftShortfall(day) {
  if (!employed(day) || !working(day) || hasMissingPunch(day) || !COMPLETED_WORK.has(day.baseline_status ?? day.status)) return 0;
  return Math.max(0, requiredShiftMinutes(day) - nonnegative(day.worked_min));
}

/**
 * Summarise effective employee days after corrections and leave allocation. Future
 * and non-employed dates are excluded when `today` is supplied. Present/absence
 * are work-day equivalents before leave covers the absence; final LOP uses the
 * settled day value and includes unpaid/sandwiched off days, just as payroll does.
 */
export function attendanceSummary(days, { today } = {}) {
  const actual = days.filter((d) => (!today || d.date <= today) && employed(d));
  const scheduled = actual.filter(working);
  const sum = (rows, fn) => round2(rows.reduce((total, d) => total + nonnegative(fn(d)), 0));
  const workValue = (d) => {
    const status = d.baseline_status ?? d.status;
    if (status === 'ON_LEAVE' || status === 'ABSENT' || status === 'SHORT') return 0;
    // Stored baseline avoids counting paid/automatic leave as attendance.
    return Math.max(0, Math.min(1, nonnegative(d.work_day_value ?? d.day_value) - (d.work_day_value === undefined ? nonnegative(d.leave_days) : 0)));
  };
  const paidLeave = (d) => Math.max(0, nonnegative(d.leave_days) - nonnegative(d.auto_leave));
  const paid = sum(actual, (d) => d.day_value);
  const present = sum(scheduled, workValue);
  const absent = sum(scheduled, (d) => 1 - workValue(d));
  const minutes = sum(scheduled, shiftShortfall);
  const appliedPaid = sum(scheduled, paidLeave);
  return {
    as_of: actual.at(-1)?.date ?? null,
    days: actual.length,
    working_days: scheduled.length,
    present_days: present,
    absent_days: absent,
    raw_absent_days: absent,
    paid_leave_days: appliedPaid,
    applied_paid_leave: appliedPaid,
    auto_leave_days: sum(scheduled, (d) => d.auto_leave),
    unpaid_leave_days: sum(scheduled, (d) => d.applied ? Math.max(0, Math.min(nonnegative(d.applied.portion ?? 1), 1 - workValue(d)) - nonnegative(d.leave_days)) : 0),
    paid_days: paid,
    lop_days: round2(Math.max(0, actual.length - paid)),
    ot_min: sum(actual, (d) => OFF.has(d.status) ? 0 : d.ot_min),
    worked_min: sum(actual, (d) => d.worked_min),
    late_minutes: minutes,
    shift_shortfall_min: minutes,
    missing_punch: actual.filter(hasMissingPunch).length,
    corrected: actual.filter((d) => d.overridden).length,
  };
}
