import { addDays, dayName, firstOfMonth, lastOfMonth, monthDates } from '@ajpwer/shared';
import { computeDay, computeMonth, pickPolicy, resolvePolicies } from '../calculations/index.js';
import { fromDbDate, toDbDate } from '../utils/dbDates.js';
import { holidaysBetween, payGroupRulesCache } from './rules.service.js';

/** Days either side of a month examined so the sandwich rule can see across the boundary. */
const CONTEXT_DAYS = 7;

function leavePaidFor(rules, date, leaveType) {
  const p = pickPolicy(rules.policies, 'LEAVE', date);
  const t = p?.rules?.types.find((x) => x.code === leaveType);
  return t ? t.paid : false;
}

export function toEnginePunch(p) {
  return { id: p.id, at: p.punched_at.getTime(), work_date: fromDbDate(p.work_date), direction: p.direction, site_id: p.site_id, method: p.method };
}

/**
 * Effective attendance for a month, for many employees at once. Computed from the
 * ledger every time — derived, never stored as truth.
 */
export async function computeMonths(db, employees, ym) {
  const out = new Map();
  if (employees.length === 0) return out;
  const first = firstOfMonth(ym);
  const last = lastOfMonth(ym);
  const from = addDays(first, -CONTEXT_DAYS);
  const to = addDays(last, CONTEXT_DAYS);
  const ids = employees.map((e) => e.id);

  const [punches, overrides, leaves, holidays] = await Promise.all([
    db.punch.findMany({
      where: { employee_id: { in: ids }, work_date: { gte: toDbDate(from), lte: toDbDate(to) } },
      select: { id: true, employee_id: true, punched_at: true, work_date: true, direction: true, site_id: true, method: true },
      orderBy: { punched_at: 'asc' },
    }),
    db.attendanceOverride.findMany({
      where: { employee_id: { in: ids }, work_date: { gte: toDbDate(from), lte: toDbDate(to) }, deleted_at: null },
    }),
    db.leaveRequest.findMany({
      where: { employee_id: { in: ids }, status: 'APPROVED', deleted_at: null, from_date: { lte: toDbDate(to) }, to_date: { gte: toDbDate(from) } },
    }),
    holidaysBetween(db, from, to),
  ]);

  const punchesBy = new Map();
  for (const p of punches) {
    const m = punchesBy.get(p.employee_id) ?? {};
    const wd = fromDbDate(p.work_date);
    (m[wd] ??= []).push(toEnginePunch(p));
    punchesBy.set(p.employee_id, m);
  }
  const overridesBy = new Map();
  for (const o of overrides) {
    const m = overridesBy.get(o.employee_id) ?? {};
    m[fromDbDate(o.work_date)] = { status: o.status, day_value: Number(o.day_value), worked_min: o.worked_min, ot_min: o.ot_min, late_min: o.late_min };
    overridesBy.set(o.employee_id, m);
  }

  const rulesFor = payGroupRulesCache(db);
  const dates = monthDates(ym);

  for (const e of employees) {
    const rules = await rulesFor(e.pay_group_id);
    const leaveByDate = {};
    for (const l of leaves.filter((x) => x.employee_id === e.id)) {
      for (let d = fromDbDate(l.from_date); d <= fromDbDate(l.to_date); d = addDays(d, 1)) {
        leaveByDate[d] = { leave_type: l.leave_type, paid: leavePaidFor(rules, d, l.leave_type) };
      }
    }
    const empPunches = punchesBy.get(e.id) ?? {};
    const empOverrides = overridesBy.get(e.id) ?? {};
    const joined = fromDbDate(e.joined_on);
    const lastDay = fromDbDate(e.last_day);
    const policiesByDate = {};

    const classify = (date) => {
      const policies = resolvePolicies(rules.policies, date);
      policiesByDate[date] = policies;
      return computeDay({
        date,
        joined_on: joined,
        last_day: lastDay,
        is_holiday: holidays.has(date),
        is_weekly_off: rules.weekly_off.includes(dayName(date)),
        leave: leaveByDate[date] ?? null,
        punches: empPunches[date] ?? [],
        policies,
        shift_start_min: rules.shift.start_min,
      });
    };
    const effStatus = (date) => empOverrides[date]?.status ?? classify(date).status;

    const days = dates.map(classify);
    const before = [];
    for (let i = 1; i <= CONTEXT_DAYS; i++) before.push(effStatus(addDays(first, -i)));
    const after = [];
    for (let i = 1; i <= CONTEXT_DAYS; i++) after.push(effStatus(addDays(last, i)));

    const overridesInMonth = {};
    for (const d of dates) if (empOverrides[d]) overridesInMonth[d] = empOverrides[d];

    const result = computeMonth({ ym, days, overrides: overridesInMonth, policiesByDate, before, after });
    out.set(e.id, { employee_id: e.id, result, rules, holidays });
  }
  return out;
}

export async function computeMonth1(db, employee, ym) {
  const m = await computeMonths(db, [employee], ym);
  return m.get(employee.id);
}

/** Is the month's attendance frozen (payroll step 1 submitted, or the period run/locked/paid)? */
export async function attendanceFrozen(db, ym) {
  const p = await db.payrollPeriod.findUnique({ where: { period_ym: ym } });
  if (!p) return { frozen: false, reason: null };
  if (p.state !== 'DRAFT') {
    return { frozen: true, reason: `Payroll for ${ym} is ${p.state.toLowerCase()}. Corrections open again if the run is taken back to its steps and step 1 is reopened.` };
  }
  if (p.steps_submitted.includes(1)) {
    return { frozen: true, reason: `Attendance for ${ym} was submitted in payroll step 1. Reopen step 1 in Run payroll to make corrections.` };
  }
  return { frozen: false, reason: null };
}
