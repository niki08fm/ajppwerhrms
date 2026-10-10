import { addDays, dayName, firstOfMonth, istDate, lastOfMonth, monthDates } from '@ajpwer/shared';
import { computeDay, OVERNIGHT_MAX_GAP_MIN, pairPunches, resolvePolicies, shiftEndOnWorkDate } from '../calculations/index.js';
import { fromDbDate, toDbDate } from '../utils/dbDates.js';
import { toEnginePunch } from './attendance.service.js';
import { holidaysBetween, payGroupRulesCache } from './rules.service.js';

const personSelect = {
  id: true, code: true, name: true, designation: true, pay_group_id: true,
  joined_on: true, last_day: true,
  department: { select: { id: true, name: true, colour: true } },
};
const punchSelect = { id: true, employee_id: true, punched_at: true, work_date: true, direction: true, site_id: true, method: true };
const time = (p) => p?.punched_at.toISOString() ?? null;

/** The global latest punch determines presence, but only this site's result leaves the service. */
export async function currentSitePeople(db, siteId, now = new Date()) {
  const latest = await db.$queryRaw`
    WITH latest AS (
      SELECT DISTINCT ON (p.employee_id) p.employee_id, p.site_id, p.direction, p.punched_at, p.work_date
      FROM punch p
      WHERE p.work_date >= ${toDbDate(addDays(istDate(now), -1))}::date
        AND p.punched_at <= ${now} AND p.punched_at >= ${new Date(now.getTime() - OVERNIGHT_MAX_GAP_MIN * 60_000)}
      ORDER BY p.employee_id, p.punched_at DESC, p.created_at DESC, p.id DESC
    )
    SELECT e.id, e.name, e.code, e.designation, d.id AS department_id,
      d.name AS department, d.colour, l.punched_at AS since, l.work_date
    FROM latest l JOIN employee e ON e.id = l.employee_id JOIN department d ON d.id = e.department_id
    WHERE l.site_id = ${siteId}::uuid AND l.direction = 'IN'
      AND e.deleted_at IS NULL AND e.status IN ('ACTIVE', 'NOTICE')
    ORDER BY e.name, e.id`;
  return latest.map((r) => ({ ...r, since: r.since.toISOString(), work_date: fromDbDate(r.work_date) }));
}

/**
 * Registers show recorded attendance here, not an invented site roster. Pairing
 * uses the employee's day internally so an OUT elsewhere can close an IN here;
 * other sites' names, times, attendance and payroll context never leave this API.
 */
async function periodRows(db, siteId, from, to, now) {
  const own = await db.punch.findMany({
    where: { site_id: siteId, work_date: { gte: toDbDate(from), lte: toDbDate(to) }, punched_at: { lte: now } },
    select: punchSelect, orderBy: [{ punched_at: 'asc' }, { id: 'asc' }],
  });
  const ids = [...new Set(own.map((p) => p.employee_id))];
  if (!ids.length) return [];
  const [employees, all, holidays, present] = await Promise.all([
    db.employee.findMany({ where: { id: { in: ids }, deleted_at: null }, select: personSelect, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
    db.punch.findMany({ where: { employee_id: { in: ids }, work_date: { gte: toDbDate(from), lte: toDbDate(to) }, punched_at: { lte: now } }, select: punchSelect, orderBy: [{ punched_at: 'asc' }, { id: 'asc' }] }),
    holidaysBetween(db, from, to),
    currentSitePeople(db, siteId, now),
  ]);
  const current = new Map(present.map((e) => [e.id, e.work_date]));
  const rulesFor = payGroupRulesCache(db);
  const ownBy = new Map();
  const allBy = new Map();
  const group = (map, p) => {
    const key = `${p.employee_id}:${fromDbDate(p.work_date)}`;
    const rows = map.get(key) ?? [];
    rows.push(p);
    map.set(key, rows);
  };
  own.forEach((p) => group(ownBy, p));
  all.forEach((p) => group(allBy, p));
  const rows = [];
  for (const e of employees) {
    const rules = await rulesFor(e.pay_group_id);
    for (let date = from; date <= to; date = addDays(date, 1)) {
      const key = `${e.id}:${date}`;
      const punches = ownBy.get(key);
      if (!punches) continue;
      const wholeDay = allBy.get(key) ?? punches;
      const policies = resolvePolicies(rules.policies, date);
      const engine = wholeDay.map(toEnginePunch);
      const day = computeDay({ date, joined_on: fromDbDate(e.joined_on), last_day: fromDbDate(e.last_day),
        is_holiday: holidays.has(date), is_weekly_off: rules.weekly_off.includes(dayName(date)),
        punches: engine, policies, shift_start_min: rules.shift.start_min,
        shift_end_min: shiftEndOnWorkDate(rules.shift), shift_break_min: rules.shift.break_min });
      const paired = pairPunches(engine);
      const herePairs = paired.pairs.filter((p) => p.site_id === siteId);
      const ins = punches.filter((p) => p.direction === 'IN');
      const outs = punches.filter((p) => p.direction === 'OUT');
      const firstDayIn = wholeDay.find((p) => p.direction === 'IN');
      const lastDayPunch = wholeDay.at(-1);
      // An overnight IN remains open on its original work date after midnight.
      // A fresh IN today must not make yesterday's already closed row look open.
      const onSite = current.get(e.id) === date;
      const incomplete = herePairs.some((p) => !p.out) || paired.orphan_outs.some((p) => p.site_id === siteId);
      rows.push({ id: e.id, code: e.code, name: e.name, designation: e.designation, department: e.department.name,
        department_id: e.department.id, date,
        first_in: time(ins[0]), last_out: time(outs.at(-1)), punches_in: ins.length, punches_out: outs.length,
        on_site_now: onSite, worked_min: herePairs.reduce((sum, p) => sum + p.minutes, 0),
        // Moving to another site mid-shift is neither a late start nor an early departure from work.
        late_min: firstDayIn?.site_id === siteId ? day.late_min : 0,
        early_min: !onSite && lastDayPunch?.direction === 'OUT' && lastDayPunch.site_id === siteId ? day.early_min : 0,
        status: onSite ? 'ON_SITE' : !ins.length ? 'OUT_ONLY' : incomplete ? 'MISSING_PUNCH' : 'SIGNED_OUT',
      });
    }
  }
  return rows;
}

export async function siteDayRegister(db, siteId, date, now = new Date()) {
  return periodRows(db, siteId, date, date, now);
}

export async function siteMonthRegister(db, siteId, ym, now = new Date()) {
  const dates = monthDates(ym);
  const attendance = await periodRows(db, siteId, firstOfMonth(ym), lastOfMonth(ym), now);
  const rowsBy = new Map();
  for (const r of attendance) {
    let row = rowsBy.get(r.id);
    if (!row) {
      row = { id: r.id, code: r.code, name: r.name, department: r.department, designation: r.designation,
        punched_days: 0, worked_min: 0, days: dates.map((date) => ({ date, punched_in: false, signed_out: false, in: null, out: null, worked_min: 0 })) };
      rowsBy.set(r.id, row);
    }
    const d = row.days.find((x) => x.date === r.date);
    Object.assign(d, { punched_in: r.punches_in > 0, signed_out: r.punches_out > 0, in: r.first_in, out: r.last_out, worked_min: r.worked_min });
    row.punched_days += r.punches_in > 0 ? 1 : 0;
    row.worked_min += r.worked_min;
  }
  return { rows: [...rowsBy.values()], days: dates.map((date) => {
    const day = attendance.filter((r) => r.date === date);
    return { date, punched_in: day.filter((r) => r.punches_in > 0).length,
      signed_out: day.filter((r) => r.punches_out > 0).length, is_future: date > istDate(now) };
  }) };
}

export async function siteSummary(db, siteId, now = new Date()) {
  const date = istDate(now);
  const [rows, onSite] = await Promise.all([siteDayRegister(db, siteId, date, now), currentSitePeople(db, siteId, now)]);
  const mix = new Map();
  for (const p of onSite) {
    const d = mix.get(p.department_id) ?? { id: p.department_id, name: p.department, colour: p.colour, count: 0 };
    d.count += 1;
    mix.set(p.department_id, d);
  }
  const counts = { punched_in_today: rows.filter((r) => r.punches_in > 0).length,
    on_site_now: onSite.length, late_in: rows.filter((r) => r.late_min > 0).length,
    signed_out: rows.filter((r) => r.punches_out > 0 && !r.on_site_now).length,
    early_out: rows.filter((r) => r.early_min > 0).length };
  return { date, counts, punched_in_today: counts.punched_in_today, on_site_now: onSite,
    departments: [...mix.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}
