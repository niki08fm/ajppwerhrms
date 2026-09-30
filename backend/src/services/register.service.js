import { dayName } from '@ajpwer/shared';
import { computeDay, resolvePolicies } from '../calculations/index.js';
import { fromDbDate, toDbDate } from '../utils/dbDates.js';
import { toEnginePunch } from './attendance.service.js';
import { holidaysBetween, payGroupRulesCache } from './rules.service.js';
import { pickPolicy } from '../calculations/index.js';

/**
 * The attendance register for one date: everyone in employment, their punches
 * paired and classified, with any override layered on top.
 */
export async function dayRegister(db, date, employeeIds, today) {
  const d = toDbDate(date);
  const employees = await db.employee.findMany({
    where: {
      deleted_at: null,
      status: { in: ['ACTIVE', 'NOTICE', 'EXITED'] },
      joined_on: { lte: d },
      OR: [{ last_day: null }, { last_day: { gte: d } }],
      ...(employeeIds ? { id: { in: employeeIds } } : {}),
    },
    select: { id: true, code: true, name: true, designation: true, pay_group_id: true, joined_on: true, last_day: true, department: { select: { id: true, name: true } } },
    orderBy: { name: 'asc' },
  });
  const ids = employees.map((e) => e.id);
  const [punches, overrides, leaves, holidays] = await Promise.all([
    db.punch.findMany({ where: { employee_id: { in: ids }, work_date: d }, orderBy: { punched_at: 'asc' } }),
    db.attendanceOverride.findMany({ where: { employee_id: { in: ids }, work_date: d, deleted_at: null } }),
    db.leaveRequest.findMany({ where: { employee_id: { in: ids }, status: 'APPROVED', deleted_at: null, from_date: { lte: d }, to_date: { gte: d } } }),
    holidaysBetween(db, date, date),
  ]);
  const rulesFor = payGroupRulesCache(db);
  const rows = [];
  for (const e of employees) {
    const rules = await rulesFor(e.pay_group_id);
    const policies = resolvePolicies(rules.policies, date);
    const leave = leaves.find((l) => l.employee_id === e.id);
    const leavePolicy = pickPolicy(rules.policies, 'LEAVE', date)?.rules;
    const ep = punches.filter((p) => p.employee_id === e.id).map(toEnginePunch);
    const day = computeDay({
      date,
      joined_on: fromDbDate(e.joined_on),
      last_day: fromDbDate(e.last_day),
      is_holiday: holidays.has(date),
      is_weekly_off: rules.weekly_off.includes(dayName(date)),
      leave: leave ? { leave_type: leave.leave_type, paid: !!leavePolicy?.types.find((t) => t.code === leave.leave_type)?.paid } : null,
      punches: ep,
      policies,
      shift_start_min: rules.shift.start_min,
    });
    const computed = { status: day.status, day_value: day.day_value, worked_min: day.worked_min, ot_min: day.ot_min, late_min: day.late_min };
    const o = overrides.find((x) => x.employee_id === e.id);
    const eff = o ? { ...day, status: o.status, day_value: Number(o.day_value), worked_min: o.worked_min, ot_min: o.ot_min, late_min: o.late_min, flags: [...day.flags, 'OVERRIDDEN'] } : day;
    const ins = ep.filter((p) => p.direction === 'IN');
    const outs = ep.filter((p) => p.direction === 'OUT');
    rows.push({
      employee: { id: e.id, code: e.code, name: e.name, designation: e.designation, department: e.department, pay_group_id: e.pay_group_id },
      day: eff,
      computed,
      override: o ? { id: o.id, reason_code: o.reason_code, reason_text: o.reason_text, created_by: o.created_by, created_at: o.created_at } : null,
      in_min: ins.length ? day.first_punch_min : null,
      out_min: outs.length ? day.last_punch_min : null,
      open_now: date === today && ep.length > 0 && ep[ep.length - 1].direction === 'IN',
    });
  }
  return rows;
}
