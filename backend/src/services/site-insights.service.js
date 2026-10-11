import { addDays, addMonths, dayName, diffDays, firstOfMonth, formatLongDate, isoDate, istDate, lastOfMonth, monthDates, ymOf } from '@ajpwer/shared';
import { computeDay, resolvePolicies, shiftEndOnWorkDate } from '../calculations/index.js';
import { allocateSiteWages, recordedSiteIntervals } from '../calculations/attendance/site-wages.js';
import { fromDbDate, n, toDbDate } from '../utils/dbDates.js';
import { AppError, notFound } from '../utils/errors.js';
import { computeMonths, toEnginePunch } from './attendance.service.js';
import { computePayslip } from './payslip.service.js';
import { payContext } from './payroll.service.js';
import { holidaysBetween, payGroupRulesCache } from './rules.service.js';
import { currentSitePeople } from './site-workspace.service.js';
import { env } from '../config/env.js';

const punchSelect = { id: true, employee_id: true, punched_at: true, work_date: true, direction: true, site_id: true, method: true };
const earningKinds = new Set(['COMPONENT', 'YEARLY', 'OT', 'OFFDAY', 'LEAVE', 'ADHOC']);
const sum = (rows, key) => rows.reduce((total, r) => total + (r[key] ?? 0), 0);
const emptyDay = (date) => ({ date, punched_in: 0, signed_out: 0, late_in: 0, early_out: 0, worked_min: 0, ot_min: 0, open_punches: 0 });
const emptyCost = () => ({ normal_wages: 0, ot_wages: 0, other_wages: 0, total_wages: 0, paid_ot_min: 0, ot_min: 0, worked_min: 0 });

export function insightPeriod(query = {}, now = new Date()) {
  const date = istDate(now);
  const from = isoDate.parse(query.from ?? firstOfMonth(ymOf(date)));
  const to = isoDate.parse(query.to ?? date);
  if (to < from) throw new AppError('VALIDATION', 'The end date must be on or after the start date.', 422, 'to');
  if (diffDays(from, to) + 1 > 366) throw new AppError('VALIDATION', 'Choose a period of up to 366 days.', 422, 'to');
  return { from, to };
}

/**
 * HR's site view combines live headcount and recorded attendance with optional
 * wage analytics. Payroll permissions are checked by the caller before any
 * salary/payroll queries. Every wage allocation uses complete payroll months,
 * then slices by the requested inclusive work dates and selected site.
 */
export async function siteInsights(db, siteId, { from, to, financial = false, now = new Date() }) {
  const date = istDate(now);
  const site = await db.site.findFirst({ where: { id: siteId, deleted_at: null },
    select: { id: true, code: true, name: true, state: true, address: true, is_active: true, login: true,
      login_enabled: true, last_login_at: true, last_seen_at: true, created_on: true, project_id: true,
      lat: true, lng: true, radius_m: true, project: { select: { id: true, code: true, name: true } } } });
  if (!site) throw notFound('That site');
  const fullFrom = firstOfMonth(ymOf(from));
  const fullTo = lastOfMonth(ymOf(to));
  const window = [{ work_date: { gte: toDbDate(fullFrom), lte: toDbDate(fullTo) } }, { work_date: toDbDate(date) }];
  const [own, onSite, holidays] = await Promise.all([
    db.punch.findMany({ where: { site_id: siteId, OR: window, punched_at: { lte: now } }, select: punchSelect,
      orderBy: [{ punched_at: 'asc' }, { id: 'asc' }] }),
    currentSitePeople(db, siteId, now),
    holidaysBetween(db, fullFrom < date ? fullFrom : date, fullTo > date ? fullTo : date),
  ]);
  const ids = [...new Set(own.map((p) => p.employee_id))];
  const [employees, punches] = ids.length ? await Promise.all([
    db.employee.findMany({ where: { id: { in: ids } }, include: { department: true, ...(financial ? { statutory: true } : {}) } }),
    db.punch.findMany({ where: { employee_id: { in: ids }, OR: window, punched_at: { lte: now } }, select: punchSelect,
      orderBy: [{ punched_at: 'asc' }, { id: 'asc' }] }),
  ]) : [[], []];
  const employeeBy = new Map(employees.map((e) => [e.id, e]));
  const ownBy = new Map();
  const allBy = new Map();
  const group = (map, p) => {
    const key = `${p.employee_id}:${fromDbDate(p.work_date)}`;
    const list = map.get(key) ?? [];
    list.push(p);
    map.set(key, list);
  };
  own.forEach((p) => group(ownBy, p));
  punches.forEach((p) => group(allBy, p));
  const rulesFor = payGroupRulesCache(db);
  const intervalBy = new Map();
  const rawOtDays = new Map();
  const attendanceBy = new Map();
  const currentIds = new Set(onSite.map((p) => `${p.id}:${p.work_date}`));
  for (const [key, wholeDay] of allBy) {
    const employeeId = wholeDay[0].employee_id;
    const e = employeeBy.get(employeeId);
    if (!e) continue;
    const workDate = fromDbDate(wholeDay[0].work_date);
    const rules = await rulesFor(e.pay_group_id);
    const input = { date: workDate, joined_on: fromDbDate(e.joined_on), last_day: fromDbDate(e.last_day),
      is_holiday: holidays.has(workDate), is_weekly_off: rules.weekly_off.includes(dayName(workDate)),
      punches: wholeDay.map(toEnginePunch), policies: resolvePolicies(rules.policies, workDate),
      shift_start_min: rules.shift.start_min, shift_end_min: shiftEndOnWorkDate(rules.shift), shift_break_min: rules.shift.break_min };
    const day = computeDay(input);
    const intervals = recordedSiteIntervals(day, input);
    const monthKey = `${employeeId}:${ymOf(workDate)}`;
    const otDays = rawOtDays.get(monthKey) ?? new Map();
    otDays.set(workDate, day.ot_min);
    rawOtDays.set(monthKey, otDays);
    const monthRows = intervalBy.get(monthKey) ?? [];
    monthRows.push(...intervals);
    intervalBy.set(monthKey, monthRows);
    const here = ownBy.get(key);
    if (!here) continue;
    const ins = here.filter((p) => p.direction === 'IN');
    const outs = here.filter((p) => p.direction === 'OUT');
    const firstIn = wholeDay.find((p) => p.direction === 'IN');
    const last = wholeDay.at(-1);
    const hereIntervals = intervals.filter((r) => r.site_id === siteId);
    const row = attendanceBy.get(workDate) ?? emptyDay(workDate);
    row.punched_in += ins.length > 0 ? 1 : 0;
    row.signed_out += outs.length > 0 && !currentIds.has(key) ? 1 : 0;
    row.late_in += firstIn?.site_id === siteId && day.late_min > 0 ? 1 : 0;
    row.early_out += last?.direction === 'OUT' && last.site_id === siteId && day.early_min > 0 ? 1 : 0;
    row.worked_min += sum(hereIntervals, 'worked_min');
    row.ot_min += sum(hereIntervals, 'ot_min');
    row.open_punches += day.pairs.filter((p) => !p.out && p.site_id === siteId).length;
    attendanceBy.set(workDate, row);
  }
  const attendance = [];
  for (let d = from; d <= to; d = addDays(d, 1)) attendance.push({ ...(attendanceBy.get(d) ?? emptyDay(d)), is_future: d > date });
  const today = { ...(attendanceBy.get(date) ?? emptyDay(date)), on_site_now: onSite.length };
  const departments = new Map();
  for (const p of onSite) {
    const d = departments.get(p.department_id) ?? { id: p.department_id, name: p.department, colour: p.colour, count: 0 };
    d.count++;
    departments.set(d.id, d);
  }
  const periodPeople = new Set(own.filter((p) => fromDbDate(p.work_date) >= from && fromDbDate(p.work_date) <= to && p.direction === 'IN').map((p) => p.employee_id));
  const { last_seen_at: lastSeen, ...publicSite } = site;
  const data = { site: { ...publicSite, lat: Number(site.lat), lng: Number(site.lng), created_on: fromDbDate(site.created_on),
    tablet_signed_in: !!site.login_enabled && !!site.is_active && !!lastSeen && now.getTime() - lastSeen.getTime() < env.SITE_SESSION_HOURS * 3600_000 }, date, today, on_site_now: onSite,
    departments: [...departments.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)), attendance,
    period: { from, to, people: periodPeople.size, person_days: sum(attendance, 'punched_in'),
      worked_min: sum(attendance, 'worked_min'), ot_min: sum(attendance, 'ot_min'), open_punches: sum(attendance, 'open_punches') }, costs: null };
  if (!financial) return data;

  const costs = { ...emptyCost(), source: 'estimate', attribution: 'estimated', departments: [], trend: attendance.map((r) => ({ date: r.date, ...emptyCost() })),
    months: [], uncosted_people: 0, uncosted_min: 0, unallocated_wages: 0, unallocated_scope: 'related_payroll_months',
    note: 'Wages before employee deductions; employer contributions and reimbursements are excluded. Normal pay uses paid dates (recorded normal minutes for old payroll snapshots); overtime follows qualifying intervals and the monthly cap. Other wages include off-day pay, bonuses and leave payouts. Site attribution is estimated; recorded payroll amounts stay frozen. Unallocated wages cover related whole payroll months and are not added to this site total.' };
  const overrides = ids.length ? await db.attendanceOverride.findMany({ where: { employee_id: { in: ids }, deleted_at: null,
    work_date: { gte: toDbDate(fullFrom), lte: toDbDate(fullTo) } }, select: { employee_id: true, work_date: true, ot_min: true } }) : [];
  for (const o of overrides) {
    const d = fromDbDate(o.work_date);
    const key = `${o.employee_id}:${ymOf(d)}`;
    const days = rawOtDays.get(key) ?? new Map();
    days.set(d, o.ot_min);
    rawOtDays.set(key, days);
  }
  const trend = new Map(costs.trend.map((r) => [r.date, r]));
  const deptCosts = new Map();
  const uncosted = new Set();
  for (let ym = ymOf(from); ym <= ymOf(to); ym = addMonths(ym, 1)) {
    const selected = employees.filter((e) => (intervalBy.get(`${e.id}:${ym}`) ?? []).some((r) => r.site_id === siteId && r.date >= from && r.date <= to) || own.some((p) => p.employee_id === e.id && p.direction === 'IN' && ymOf(fromDbDate(p.work_date)) === ym && fromDbDate(p.work_date) >= from && fromDbDate(p.work_date) <= to));
    if (!selected.length) continue;
    const period = await db.payrollPeriod.findUnique({ where: { period_ym: ym } });
    const frozen = !!period && period.state !== 'DRAFT';
    costs.months.push({ month: ym, source: frozen ? 'snapshot' : 'estimate', state: period?.state ?? 'DRAFT' });
    let slips = new Map();
    let months = new Map();
    let ctx;
    if (frozen) {
      const rows = await db.payslip.findMany({ where: { period_id: period.id, employee_id: { in: selected.map((e) => e.id) }, deleted_at: null }, include: { lines: { where: { deleted_at: null }, orderBy: { seq: 'asc' } } } });
      slips = new Map(rows.map((s) => [s.employee_id, s]));
    } else {
      months = await computeMonths(db, selected, ym, { rulesFor, today: date });
      try { ctx = await payContext(db, ym); } catch (error) {
        if (!(error instanceof AppError)) throw error;
        // Missing payroll setup must not hide the site's attendance. Those
        // people remain visibly uncosted instead of being reported as free.
      }
    }
    for (const e of selected) {
      const rows = intervalBy.get(`${e.id}:${ym}`) ?? [];
      let slip;
      let department = e.department;
      let paidDays = null;
      let otDays = [...(rawOtDays.get(`${e.id}:${ym}`) ?? new Map())].map(([date, ot_min]) => ({ date, ot_min }));
      if (frozen) {
        const s = slips.get(e.id);
        if (s && (!s.meta?.final_month_ym || s.meta.final_month_ym === ym)) {
          slip = { lines: s.lines.map((l) => ({ ...l, amount: n(l.amount) })), ot: s.meta?.ot ?? null };
          department = s.meta?.department ?? department;
        }
      } else if (ctx) {
        try {
          const m = months.get(e.id);
          slip = (await computePayslip(db, e, ym, m, ctx, null)).result;
          paidDays = m.result.days;
          otDays = m.result.days;
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
        }
      }
      if (!slip) {
        uncosted.add(e.id);
        costs.uncosted_min += sum(rows.filter((r) => r.site_id === siteId && r.date >= from && r.date <= to), 'worked_min');
        continue;
      }
      const normal = sum(slip.lines.filter((l) => l.kind === 'COMPONENT'), 'amount');
      const ot = sum(slip.lines.filter((l) => l.kind === 'OT'), 'amount');
      const other = sum(slip.lines.filter((l) => earningKinds.has(l.kind) && !['COMPONENT', 'OT'].includes(l.kind)), 'amount');
      const datedOther = slip.lines.filter((l) => l.kind === 'OFFDAY').map((l) => ({
        date: monthDates(ym).find((d) => l.name.includes(`worked ${formatLongDate(d)} —`)), amount: l.amount,
      })).filter((l) => l.date);
      const allocated = allocateSiteWages({ rows, normal_wages: normal, ot_wages: ot, other_wages: other,
        paid_ot_min: slip.ot?.paid_min ?? 0, paid_days: paidDays, ot_days: otDays, dated_other: datedOther });
      costs.unallocated_wages += allocated.unallocated_wages;
      for (const row of allocated.rows) {
        if (row.site_id !== siteId || row.date < from || row.date > to) continue;
        const departmentId = department.id ?? e.department_id;
        const dept = deptCosts.get(departmentId) ?? { id: departmentId, name: department.name, colour: department.colour ?? e.department.colour,
          ...emptyCost(), people: new Set() };
        dept.people.add(e.id);
        const t = trend.get(row.date);
        for (const key of Object.keys(emptyCost())) {
          costs[key] += row[key] ?? 0;
          dept[key] += row[key] ?? 0;
          t[key] += row[key] ?? 0;
        }
        deptCosts.set(departmentId, dept);
      }
    }
  }
  const sources = new Set(costs.months.map((m) => m.source));
  costs.source = sources.size > 1 ? 'mixed' : sources.values().next().value ?? 'estimate';
  costs.uncosted_people = uncosted.size;
  costs.departments = [...deptCosts.values()].map((d) => ({ ...d, people: d.people.size })).sort((a, b) => b.total_wages - a.total_wages || a.name.localeCompare(b.name));
  data.costs = costs;
  return data;
}
