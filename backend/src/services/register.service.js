import { dayName, istMidnight } from '@ajpwer/shared';
import { computeDay, resolvePolicies, shiftEndOnWorkDate } from '../calculations/index.js';
import { fromDbDate, toDbDate } from '../utils/dbDates.js';
import { toEnginePunch, travelMinutes } from './attendance.service.js';
import { holidaysBetween, payGroupRulesCache } from './rules.service.js';
import { pickPolicy } from '../calculations/index.js';

/** HR's in and out as the day's only punches, so a corrected day is judged exactly as punches would be. */
function hrPunches(date, t) {
  const midnight = istMidnight(date).getTime();
  return [
    { id: 'hr-in', at: midnight + t.in_min * 60_000, work_date: date, direction: 'IN', site_id: null, method: 'HR' },
    { id: 'hr-out', at: midnight + t.out_min * 60_000, work_date: date, direction: 'OUT', site_id: null, method: 'HR' },
  ];
}

/**
 * The attendance register for one date: everyone in employment, their punches
 * paired and classified, with any override layered on top. With `opts.times`
 * ({ in_min, out_min }) the day is worked out from those times instead of the
 * punches, as HR's correction would make it.
 */
export async function dayRegister(db, date, employeeIds, today, opts = {}) {
  const d = toDbDate(date);
  const employees = await db.employee.findMany({
    where: {
      deleted_at: null,
      status: { in: ['ACTIVE', 'NOTICE', 'EXITED'] },
      joined_on: { lte: d },
      OR: [{ last_day: null }, { last_day: { gte: d } }],
      ...(employeeIds ? { id: { in: employeeIds } } : {}),
    },
    select: { id: true, code: true, name: true, designation: true, pay_group_id: true, joined_on: true, last_day: true, department: { select: { id: true, name: true, colour: true } } },
    orderBy: { name: 'asc' },
  });
  const ids = employees.map((e) => e.id);
  const [punches, overrides, leaves, holidays, travel] = await Promise.all([
    db.punch.findMany({ where: { employee_id: { in: ids }, work_date: d }, orderBy: { punched_at: 'asc' } }),
    db.attendanceOverride.findMany({ where: { employee_id: { in: ids }, work_date: d, deleted_at: null } }),
    db.leaveRequest.findMany({ where: { employee_id: { in: ids }, status: 'APPROVED', deleted_at: null, from_date: { lte: d }, to_date: { gte: d } } }),
    holidaysBetween(db, date, date),
    travelMinutes(db, ids, date, date),
  ]);
  const rulesFor = payGroupRulesCache(db);
  const rows = [];
  for (const e of employees) {
    const rules = await rulesFor(e.pay_group_id);
    const policies = resolvePolicies(rules.policies, date);
    const leave = leaves.find((l) => l.employee_id === e.id);
    const leavePolicy = pickPolicy(rules.policies, 'LEAVE', date)?.rules;
    const times = opts.times ?? null;
    const ep = times ? hrPunches(date, times) : punches.filter((p) => p.employee_id === e.id).map(toEnginePunch);
    const isHoliday = holidays.has(date);
    const isOff = rules.weekly_off.includes(dayName(date));
    const day = computeDay({
      date,
      joined_on: fromDbDate(e.joined_on),
      last_day: fromDbDate(e.last_day),
      is_holiday: isHoliday,
      is_weekly_off: isOff,
      // HR's times stand for the day as worked, whatever leave was recorded.
      leave: leave && !times
        ? {
            leave_type: leave.leave_type,
            paid: !!leavePolicy?.types.find((t) => t.code === leave.leave_type)?.paid,
            portion: fromDbDate(leave.from_date) === fromDbDate(leave.to_date) && Number(leave.days) < 1 ? 0.5 : 1,
            request_id: leave.id,
          }
        : null,
      punches: ep,
      travel_min: times ? 0 : (travel.get(e.id)?.[date] ?? 0),
      policies,
      shift_start_min: rules.shift.start_min,
      shift_end_min: shiftEndOnWorkDate(rules.shift),
      shift_break_min: rules.shift.break_min,
    });
    const computed = { status: day.status, day_value: day.day_value, worked_min: day.worked_min, ot_min: day.ot_min, late_min: day.late_min, early_min: day.early_min, due_out_min: day.due_out_min };
    const o = overrides.find((x) => x.employee_id === e.id);
    // A correction settles the day: it is no longer flagged as left early.
    const eff = o
      ? { ...day, status: o.status, day_value: Number(o.day_value), worked_min: o.worked_min, ot_min: o.ot_min, late_min: o.late_min, early_min: 0, flags: [...day.flags, 'OVERRIDDEN'] }
      : day;
    const ins = ep.filter((p) => p.direction === 'IN');
    const outs = ep.filter((p) => p.direction === 'OUT');
    const att = policies.attendance;
    rows.push({
      employee: { id: e.id, code: e.code, name: e.name, designation: e.designation, department: e.department, pay_group_id: e.pay_group_id },
      day: eff,
      computed,
      override: o ? { id: o.id, reason_code: o.reason_code, reason_text: o.reason_text, created_by: o.created_by, created_at: o.created_at, in_min: o.in_min, out_min: o.out_min } : null,
      // HR's times once the day is corrected by them; otherwise the first IN and last OUT.
      in_min: o && o.in_min !== null ? o.in_min : ins.length ? day.first_punch_min : null,
      out_min: o && o.out_min !== null ? o.out_min : outs.length ? day.last_punch_min : null,
      open_now: date === today && ep.length > 0 && ep[ep.length - 1].direction === 'IN',
      /** The rules the day is judged by, for HR correcting it */
      context: {
        kind: isHoliday ? 'HOLIDAY' : isOff ? 'WEEKLY_OFF' : 'WORKING',
        shift_start_min: rules.shift.start_min,
        shift_end_min: shiftEndOnWorkDate(rules.shift),
        grace_min: att.grace_min,
        standard_min: att.standard_min,
        half_day_upto_min: att.half_day_upto_min ?? null,
        ot: policies.overtime ? { after_min: policies.overtime.after_min, rounding_min: policies.overtime.rounding_min } : null,
        off_day_paid: !!(isHoliday ? policies.holiday_pay?.paid : policies.weekoff_pay?.paid),
      },
    });
  }
  return rows;
}
