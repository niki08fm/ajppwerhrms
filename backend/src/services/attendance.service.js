import { addDays, addMonths, dayName, firstOfMonth, istDate, lastOfMonth, maxDate, minDate, monthDates, ymOf } from '@ajpwer/shared';
import { computeDay, computeMonth, leaveYearOf, nextLeaveState, occasionPaidDates, pickPolicy, resolvePolicies, shiftEndOnWorkDate, usableFrom } from '../calculations/index.js';
import { fromDbDate, toDbDate } from '../utils/dbDates.js';
import { holidaysBetween, payGroupRulesCache } from './rules.service.js';

/** Days either side of a month examined so the sandwich rule can see across the boundary. */
const CONTEXT_DAYS = 7;

/** The leave type a request names, from the pay group's leave policy on a date. */
function leaveTypeOn(rules, date, code) {
  return pickPolicy(rules.policies, 'LEAVE', date)?.rules?.types.find((t) => t.code === code) ?? null;
}

/** The pay group's leave policy for a month: the one in force on its last day, or on the last day of employment. */
export function leavePolicyFor(rules, ym, lastDay) {
  const date = lastDay && lastDay < lastOfMonth(ym) ? lastDay : lastOfMonth(ym);
  return pickPolicy(rules.policies, 'LEAVE', date);
}

/**
 * Leave is tracked from the first payroll run in this system, or the first leave adjustment
 * HR enters (opening balances), whichever is earlier. Null until there is either.
 */
export async function leaveTrackingStart(db) {
  const [run, adj] = await Promise.all([
    db.payrollPeriod.findFirst({ where: { state: { not: 'DRAFT' } }, orderBy: { period_ym: 'asc' }, select: { period_ym: true } }),
    db.leaveAdjustment.findFirst({ where: { deleted_at: null }, orderBy: { date: 'asc' }, select: { date: true } }),
  ]);
  const months = [run?.period_ym, adj && ymOf(fromDbDate(adj.date))].filter(Boolean).sort();
  return months[0] ?? null;
}

export function toEnginePunch(p) {
  return { id: p.id, at: p.punched_at.getTime(), work_date: fromDbDate(p.work_date), direction: p.direction, site_id: p.site_id, method: p.method };
}

/** Travel minutes of a site change that count: HR's figure when set, else the counted trip. */
export function effectiveTravel(c) {
  return c.hr_travel_min ?? (c.status === 'COUNTED' ? (c.travel_min ?? 0) : 0);
}

/** employee id → { work date → travel minutes } between two dates (site changes, face v2). */
export async function travelMinutes(db, ids, from, to) {
  const rows = await db.siteChange.findMany({
    where: { employee_id: { in: ids }, work_date: { gte: toDbDate(from), lte: toDbDate(to) } },
    select: { employee_id: true, work_date: true, status: true, travel_min: true, hr_travel_min: true },
  });
  const out = new Map();
  for (const r of rows) {
    const min = effectiveTravel(r);
    if (!min) continue;
    const m = out.get(r.employee_id) ?? {};
    const d = fromDbDate(r.work_date);
    m[d] = (m[d] ?? 0) + min;
    out.set(r.employee_id, m);
  }
  return out;
}

/**
 * Every day of one month classified, for many employees at once, with overrides and
 * the days either side for the sandwich rule. Recorded leave is attached to its dates.
 */
async function classifyMonths(db, employees, ym, rulesFor) {
  const out = new Map();
  const first = firstOfMonth(ym);
  const last = lastOfMonth(ym);
  const from = addDays(first, -CONTEXT_DAYS);
  const to = addDays(last, CONTEXT_DAYS);
  const ids = employees.map((e) => e.id);

  const [punches, overrides, leaves, holidays, travel] = await Promise.all([
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
    travelMinutes(db, ids, from, to),
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
    m[fromDbDate(o.work_date)] = { status: o.status, day_value: Number(o.day_value), worked_min: o.worked_min, ot_min: o.ot_min, late_min: o.late_min, in_min: o.in_min, out_min: o.out_min };
    overridesBy.set(o.employee_id, m);
  }

  const dates = monthDates(ym);
  // A per-occasion leave pays its first working days; they can lie in other months, so look at the whole request.
  const spans = leaves.map((l) => [fromDbDate(l.from_date), fromDbDate(l.to_date)]);
  const allHolidays = spans.length ? await holidaysBetween(db, spans.reduce((a, s) => minDate(a, s[0]), from), spans.reduce((a, s) => maxDate(a, s[1]), to)) : holidays;

  for (const e of employees) {
    const rules = await rulesFor(e.pay_group_id);
    const working = (d) => !rules.weekly_off.includes(dayName(d)) && !allHolidays.has(d);
    const leaveByDate = {};
    for (const l of leaves.filter((x) => x.employee_id === e.id)) {
      const lFrom = fromDbDate(l.from_date);
      const lTo = fromDbDate(l.to_date);
      const type = leaveTypeOn(rules, lFrom, l.leave_type);
      const occasion = type?.allowance === 'PER_OCCASION' ? occasionPaidDates(lFrom, lTo, type.per_occasion ?? 0, working) : null;
      // Half a day only when a single day is recorded as half.
      const portion = lFrom === lTo && Number(l.days) < 1 ? 0.5 : 1;
      for (let d = lFrom; d <= lTo; d = addDays(d, 1)) {
        leaveByDate[d] = { leave_type: l.leave_type, paid: !!leaveTypeOn(rules, d, l.leave_type)?.paid, portion, request_id: l.id, occasion_paid: occasion ? occasion.has(d) : null };
      }
    }
    const empPunches = punchesBy.get(e.id) ?? {};
    const empTravel = travel.get(e.id) ?? {};
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
        travel_min: empTravel[date] ?? 0,
        policies,
        shift_start_min: rules.shift.start_min,
        shift_end_min: shiftEndOnWorkDate(rules.shift),
        shift_break_min: rules.shift.break_min,
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

    out.set(e.id, { input: { ym, days, overrides: overridesInMonth, policiesByDate, before, after }, rules, holidays });
  }
  return out;
}

/** HR's leave adjustments dated in a month: employee id → { leave type → days }. */
async function adjustmentsIn(db, ids, ym) {
  const rows = await db.leaveAdjustment.findMany({
    where: { employee_id: { in: ids }, deleted_at: null, date: { gte: toDbDate(firstOfMonth(ym)), lte: toDbDate(lastOfMonth(ym)) } },
    select: { employee_id: true, leave_type: true, days: true },
  });
  const out = new Map();
  for (const r of rows) {
    const m = out.get(r.employee_id) ?? {};
    m[r.leave_type] = Math.round(((m[r.leave_type] ?? 0) + Number(r.days)) * 100) / 100;
    out.set(r.employee_id, m);
  }
  return out;
}

const NOTHING_CARRIED = () => ({ opening: {}, earned_ytd: {}, year_opening: {}, ytd: {} });

/**
 * What a person brings into a leave year: the previous year's carry forward, from the
 * locked payslip of its last month or worked out again. Nothing when tracking starts
 * during the year (joining, or the first payroll run) — HR adjustments set those balances.
 */
async function yearOpening(db, plan, opts) {
  if (plan.trackStart !== plan.year.start) return NOTHING_CARRIED();
  const prevEnd = addMonths(plan.year.start, -1);
  if (!opts.systemStart || prevEnd < opts.systemStart || prevEnd < ymOf(plan.joined)) return NOTHING_CARRIED();
  const snap = await db.payslip.findFirst({
    where: { employee_id: plan.e.id, period: { period_ym: prevEnd, state: { in: ['LOCKED', 'PAID'] } } },
    select: { meta: true },
  });
  const prev = snap?.meta?.leave ?? (await computeMonths(db, [plan.e], prevEnd, opts)).get(plan.e.id)?.result.leave;
  const state = NOTHING_CARRIED();
  for (const r of prev?.types ?? []) {
    if (!r.carried) continue;
    state.opening[r.code] = r.carried;
    state.year_opening[r.code] = r.carried;
  }
  return state;
}

/**
 * Where each person's leave stands as a month starts. Leave runs month by month through the
 * leave year: a month in a locked payroll keeps the leave its payslip recorded, and every
 * later month is worked out again from attendance. Tracking starts at the leave year, the
 * person's joining, or when this system started tracking leave, whichever is latest.
 */
async function leavePlans(db, employees, ym, opts) {
  const plans = new Map();
  for (const e of employees) {
    const rules = await opts.rulesFor(e.pay_group_id);
    const joined = fromDbDate(e.joined_on);
    const lastDay = fromDbDate(e.last_day);
    const pol = leavePolicyFor(rules, ym, lastDay);
    if (!pol || ym < ymOf(joined) || (lastDay && ym > ymOf(lastDay))) continue;
    const year = leaveYearOf(ym, pol.rules.year_start_month);
    const system = opts.systemStart && opts.systemStart < ym ? opts.systemStart : ym;
    const trackStart = [year.start, ymOf(joined), system].sort().at(-1);
    plans.set(e.id, { e, rules, joined, lastDay, year, trackStart, walk: [], state: null });
  }
  if (!plans.size) return plans;
  const earliest = [...plans.values()].map((p) => p.trackStart).sort()[0];
  const locked = await db.payslip.findMany({
    where: { employee_id: { in: [...plans.keys()] }, period: { state: { in: ['LOCKED', 'PAID'] }, period_ym: { gte: earliest, lt: ym } } },
    select: { employee_id: true, meta: true, period: { select: { period_ym: true } } },
  });
  for (const p of plans.values()) {
    const anchor = locked
      .filter((s) => s.employee_id === p.e.id && s.period.period_ym >= p.trackStart && s.meta?.leave)
      .sort((a, b) => (a.period.period_ym < b.period.period_ym ? 1 : -1))[0];
    p.state = anchor ? nextLeaveState(anchor.meta.leave) : await yearOpening(db, p, opts);
    for (let m = anchor ? addMonths(anchor.period.period_ym, 1) : p.trackStart; m < ym; m = addMonths(m, 1)) p.walk.push(m);
  }
  return plans;
}

/** Everything the leave step of a month needs for one person. */
function leaveContext(plan, ym, adjustments, today) {
  const pol = leavePolicyFor(plan.rules, ym, plan.lastDay);
  if (!pol) return null;
  const year = leaveYearOf(ym, pol.rules.year_start_month);
  const types = pol.rules.types;
  const leaving = !!plan.lastDay && plan.lastDay <= lastOfMonth(ym);
  return {
    ym,
    year,
    types,
    ...plan.state,
    adjustments: adjustments ?? {},
    // A yearly type gives its days when the year starts, or when someone joins during it.
    grant_due: ym === plan.trackStart && (ym === year.start || ym === ymOf(plan.joined)),
    joined: plan.joined,
    last_day: plan.lastDay,
    // Someone leaving is settled by the exit rules, not the year-end ones.
    close_year: ym === year.end && !leaving,
    upto: today,
    usable_from: Object.fromEntries(types.map((t) => [t.code, usableFrom(t, plan.joined)])),
  };
}

/**
 * Effective attendance for a month, for many employees at once, with each person's
 * leave paid out of their balances. Computed from the ledger every time — derived,
 * never stored as truth. `today` stops absences that have not happened yet being
 * paid from leave.
 */
export async function computeMonths(db, employees, ym, options = {}) {
  const out = new Map();
  if (employees.length === 0) return out;
  const opts = {
    ...options,
    rulesFor: options.rulesFor ?? payGroupRulesCache(db),
    today: options.today ?? istDate(new Date()),
    systemStart: options.systemStart !== undefined ? options.systemStart : await leaveTrackingStart(db),
  };
  const plans = await leavePlans(db, employees, ym, opts);
  const earlier = [...new Set([...plans.values()].flatMap((p) => p.walk))].sort();
  for (const m of [...earlier, ym]) {
    const batch = m === ym ? employees : employees.filter((e) => plans.get(e.id)?.walk.includes(m));
    const [classified, adjustments] = await Promise.all([
      classifyMonths(db, batch, m, opts.rulesFor),
      adjustmentsIn(
        db,
        batch.map((e) => e.id),
        m,
      ),
    ]);
    for (const e of batch) {
      const c = classified.get(e.id);
      const plan = plans.get(e.id);
      const leave = plan ? leaveContext(plan, m, adjustments.get(e.id), opts.today) : null;
      const result = computeMonth({ ...c.input, leave });
      if (plan && result.leave) plan.state = nextLeaveState(result.leave);
      if (m === ym) out.set(e.id, { employee_id: e.id, result, rules: c.rules, holidays: c.holidays });
    }
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
    return { frozen: true, reason: `Attendance for ${ym} was submitted in payroll step 1. Reopen step 1 in Payroll to make corrections.` };
  }
  return { frozen: false, reason: null };
}
