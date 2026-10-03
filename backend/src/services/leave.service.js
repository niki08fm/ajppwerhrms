import { addDays, dayName, istDate, ymOf } from '@ajpwer/shared';
import { hasBalance, pickPolicy, usableFrom } from '../calculations/index.js';
import { fromDbDate, toDbDate } from '../utils/dbDates.js';
import { computeMonths } from './attendance.service.js';
import { holidaysBetween, payGroupRules } from './rules.service.js';

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * Where each person's leave stands on a date, for every type in their pay group's leave
 * policy: what the year opened with, what was earned and added by HR, what was taken
 * (recorded and automatic), what is left, and recorded leave still waiting for a decision.
 * Worked out month by month from the policy, recorded leave and attendance.
 */
export async function leaveBalancesFor(db, employees, asOf) {
  const out = new Map();
  if (!employees.length) return out;
  const ids = employees.map((e) => e.id);
  const [months, pending] = await Promise.all([
    computeMonths(db, employees, ymOf(asOf), { today: asOf }),
    db.leaveRequest.findMany({ where: { employee_id: { in: ids }, status: 'PENDING', deleted_at: null }, select: { employee_id: true, leave_type: true, days: true } }),
  ]);
  for (const e of employees) {
    const leave = months.get(e.id)?.result.leave ?? null;
    const waiting = (code) => round2(pending.filter((p) => p.employee_id === e.id && p.leave_type === code).reduce((s, p) => s + Number(p.days), 0));
    out.set(e.id, {
      year: leave?.year ?? null,
      types: (leave?.types ?? []).map((t) => ({ ...t, balance: t.closing, pending: waiting(t.code) })),
    });
  }
  return out;
}

export async function leaveBalances(db, employee, asOf) {
  return (await leaveBalancesFor(db, [employee], asOf)).get(employee.id);
}

/** Working days between two dates for someone's pay group: no weekly offs, no holidays. */
export async function workingDaysBetween(db, rules, from, to) {
  const holidays = await holidaysBetween(db, from, to);
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (!rules.weekly_off.includes(dayName(d)) && !holidays.has(d)) days.push(d);
  return days;
}

/**
 * Whether a person can take a leave type, and what recording it would do: the working
 * days it covers, the balance, and what may end up unpaid. HR records every kind of
 * leave; the engine settles the pay when the month is worked out.
 */
export async function leaveCheck(db, employee, b) {
  const rules = await payGroupRules(db, employee.pay_group_id);
  const pol = pickPolicy(rules.policies, 'LEAVE', b.from_date);
  const type = pol?.rules?.types.find((t) => t.code === b.leave_type) ?? null;
  const errors = [];
  if (!type) errors.push(`${b.leave_type} is not a leave type in ${rules.name}'s leave policy on ${b.from_date}.`);
  else {
    if (!type.active) errors.push(`${type.name} is switched off in ${rules.name}'s leave policy.`);
    if (type.gender !== 'ALL' && type.gender !== employee.gender) errors.push(`${type.name} is for ${type.gender === 'FEMALE' ? 'women' : 'men'} only.`);
    const joined = fromDbDate(employee.joined_on);
    const from = usableFrom(type, joined);
    if (b.from_date < from) errors.push(`${type.name} can be taken from ${from}, after ${type.min_service_months} months of service.`);
  }
  if (errors.length || !type) return { type, errors, warnings: [], working_days: 0, balance: null };

  const working = await workingDaysBetween(db, rules, b.from_date, b.to_date);
  const days = b.from_date === b.to_date && b.days < 1 ? b.days : working.length;
  const warnings = [];
  let balance = null;
  if (!type.paid) warnings.push(`${type.name} is unpaid: ${days} ${days === 1 ? 'day' : 'days'} of loss of pay. Paid leave is not used for it.`);
  else if (hasBalance(type)) {
    const now = await leaveBalances(db, employee, istDate(new Date()));
    balance = now?.types.find((t) => t.code === type.code)?.balance ?? 0;
    if (days > balance) {
      warnings.push(`Only ${balance} ${balance === 1 ? 'day' : 'days'} of ${type.name} left today. Days it cannot pay come out of paid leave, if any is left, and are unpaid after that.`);
    }
  } else if (type.allowance === 'PER_OCCASION' && days > type.per_occasion) {
    warnings.push(`${type.name} pays ${type.per_occasion} working days each time; the other ${days - type.per_occasion} come out of paid leave, if any is left, and are unpaid after that.`);
  }
  if (type.paid && type.monthly_max !== null) {
    const byMonth = {};
    for (const d of working) byMonth[ymOf(d)] = (byMonth[ymOf(d)] ?? 0) + 1;
    const over = Object.entries(byMonth).filter(([, n]) => n > type.monthly_max);
    if (over.length) warnings.push(`${type.name} pays at most ${type.monthly_max} days a month; ${over.map(([m, n]) => `${n} fall in ${m}`).join(', ')}.`);
  }
  if (!working.length) warnings.push('Every day in this range is a weekly off or a holiday, so no leave is taken.');
  return { type, errors, warnings, working_days: days, balance };
}

/** Every leave type across the pay groups' leave policies in force on a date, for names and filters. */
export async function leaveTypesInUse(db, date) {
  const rows = await db.policy.findMany({ where: { kind: 'LEAVE', deleted_at: null, valid_from: { lte: toDbDate(date) }, OR: [{ valid_to: null }, { valid_to: { gte: toDbDate(date) } }] } });
  const out = new Map();
  for (const r of rows) for (const t of r.rules?.types ?? []) if (!out.has(t.code)) out.set(t.code, { code: t.code, name: t.name, paid: t.paid });
  return [...out.values()];
}
