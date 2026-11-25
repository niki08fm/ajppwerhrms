import { addMonths, companyOf, financialYearStart, formatYearMonth, istDate, lastOfMonth, ymOf } from '@ajpwer/shared';
import { fromDbDate, n, toDbDate } from '../utils/dbDates.js';
import { AppError } from '../utils/errors.js';

/*
 * The analysis center: a financial year of saved payroll, month by month, by department, by
 * site and for the workforce. Figures come from each month's payslips; nothing is estimated.
 *
 *  - Normal wages: the salary earned (monthly and yearly components).
 *  - OT wages: overtime pay. Other earnings: off-day work, leave encashment, one-time earnings.
 *  - Cost to company (CTC): gross pay plus the employer's PF and ESI.
 *  - Sites come from punches: a person's month is split across sites by the days worked at
 *    each; a month with no punches is "No site".
 */

export const NO_SITE = { id: 'none', name: 'No site (no punches)' };

export function fyMonths(fy) {
  return Array.from({ length: 12 }, (_, i) => addMonths(`${fy}-04`, i));
}

const sumLines = (s, test) => s.lines.reduce((a, l) => a + (test(l) ? n(l.amount) : 0), 0);

/** One fact per payslip: the money, the hours and who it was for. */
function factOf(s) {
  const m = s.meta;
  const erEsi = sumLines(s, (l) => l.code === 'ER_ESI');
  const employer = n(s.employer_total);
  return {
    ym: s.period.period_ym,
    employee_id: s.employee_id,
    code: m.employee.code,
    name: m.employee.name,
    gender: m.employee.gender,
    department: { id: m.department?.id ?? null, name: m.department?.name ?? 'No department' },
    normal: sumLines(s, (l) => l.kind === 'COMPONENT' || l.kind === 'YEARLY'),
    ot: sumLines(s, (l) => l.kind === 'OT'),
    other: sumLines(s, (l) => ['OFFDAY', 'LEAVE', 'ADHOC'].includes(l.kind)),
    gross: n(s.gross),
    employer,
    er_esi: erEsi,
    er_pf: employer - erEsi,
    ctc: n(s.gross) + employer,
    net: n(s.net),
    pf_ee: sumLines(s, (l) => l.code === 'PF' || l.code === 'VPF'),
    esi_ee: sumLines(s, (l) => l.code === 'ESI'),
    pt: sumLines(s, (l) => l.code === 'PT'),
    tds: sumLines(s, (l) => l.code === 'TDS'),
    ot_min: m.ot?.paid_min ?? 0,
  };
}

const MONEY = ['normal', 'ot', 'other', 'gross', 'employer', 'er_esi', 'er_pf', 'ctc', 'net', 'pf_ee', 'esi_ee', 'pt', 'tds'];
const zero = () => ({ ...Object.fromEntries(MONEY.map((k) => [k, 0])), ot_min: 0, people: new Set() });
const add = (into, f, share = 1) => {
  for (const k of MONEY) into[k] += Math.round(f[k] * share);
  into.ot_min += f.ot_min * share;
  into.people.add(f.employee_id);
};
const out = (x) => {
  const { people, ot_min, ...rest } = x;
  return { ...rest, people: people.size, ot_hours: Math.round((ot_min / 60) * 10) / 10 };
};

/** Days worked at each site per person and month, from punch-ins. */
export async function siteDays(db, from, to) {
  if (!db.punch) return new Map();
  const rows = await db.punch.groupBy({
    by: ['employee_id', 'site_id', 'work_date'],
    where: { direction: 'IN', work_date: { gte: toDbDate(from), lte: toDbDate(to) } },
  });
  const map = new Map(); // `${employee}:${ym}` -> Map(site -> days)
  for (const r of rows) {
    const key = `${r.employee_id}:${ymOf(fromDbDate(r.work_date))}`;
    const m = map.get(key) ?? new Map();
    m.set(r.site_id, (m.get(r.site_id) ?? 0) + 1);
    map.set(key, m);
  }
  return map;
}

/** Each fact's share at each site: by days worked there that month. */
export function sharesOf(days, f) {
  const m = days.get(`${f.employee_id}:${f.ym}`);
  if (!m || !m.size) return [[NO_SITE.id, 1]];
  const total = [...m.values()].reduce((a, d) => a + d, 0);
  return [...m].map(([site, d]) => [site, d / total]);
}

/** The financial years that have payroll, newest first; with the current one. */
export async function analysisYears(db) {
  const periods = await db.payrollPeriod.findMany({ where: { deleted_at: null, state: { not: 'DRAFT' } }, select: { period_ym: true } });
  const now = financialYearStart(ymOf(istDate(new Date())));
  return [...new Set([now, ...periods.map((p) => financialYearStart(p.period_ym))])].sort((a, b) => b - a);
}

/**
 * The year's analysis. Filters: `company` (AJ/TP), `department_id`, `site_id`. With a site,
 * each person's month counts the share of days they worked at that site.
 */
export async function buildAnalysis(db, { fy, company, department_id: departmentId, site_id: siteId } = {}) {
  const years = await analysisYears(db);
  const year = fy ? Number(fy) : years[0];
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new AppError('VALIDATION', 'Choose a financial year.', 422, 'fy');
  const months = fyMonths(year);
  const from = `${months[0]}-01`;
  const to = lastOfMonth(months.at(-1));
  const [periods, departments, sites] = await Promise.all([
    db.payrollPeriod.findMany({ where: { period_ym: { in: months }, deleted_at: null, state: { not: 'DRAFT' } }, select: { id: true, period_ym: true, state: true } }),
    db.department.findMany({ where: { deleted_at: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    db.site.findMany({ where: { deleted_at: null }, select: { id: true, code: true, name: true }, orderBy: { name: 'asc' } }),
  ]);
  const slips = periods.length
    ? await db.payslip.findMany({ where: { period_id: { in: periods.map((p) => p.id) } }, include: { lines: true, period: { select: { period_ym: true } } } })
    : [];
  const days = await siteDays(db, from, to);
  let facts = slips.map(factOf);
  if (company) facts = facts.filter((f) => companyOf(f.code) === company);
  if (departmentId) facts = facts.filter((f) => f.department.id === departmentId);

  const siteName = new Map([...sites.map((s) => [s.id, s.name]), [NO_SITE.id, NO_SITE.name]]);
  const byMonth = new Map(months.map((ym) => [ym, zero()]));
  const byDept = new Map();
  const bySite = new Map();
  const byPerson = new Map();
  for (const f of facts) {
    const shares = sharesOf(days, f);
    const share = siteId ? shares.find(([s]) => s === siteId)?.[1] ?? 0 : 1;
    if (share <= 0) continue;
    add(byMonth.get(f.ym), f, share);
    const d = byDept.get(f.department.name) ?? { id: f.department.id, name: f.department.name, ...zero() };
    add(d, f, share);
    byDept.set(f.department.name, d);
    for (const [site, s] of shares) {
      if (siteId && site !== siteId) continue;
      const row = bySite.get(site) ?? { id: site, name: siteName.get(site) ?? 'Unknown site', ...zero() };
      add(row, f, s);
      bySite.set(site, row);
    }
    const p = byPerson.get(f.employee_id) ?? { employee_id: f.employee_id, code: f.code, name: f.name, department: f.department.name, ...zero() };
    add(p, f, share);
    byPerson.set(f.employee_id, p);
  }

  // Workforce: joiners and exits by month (by joining and last-day dates), headcount paid.
  const range = { gte: toDbDate(from), lte: toDbDate(to) };
  const people = await db.employee.findMany({
    where: { deleted_at: null, OR: [{ joined_on: range }, { last_day: range }] },
    select: { id: true, code: true, joined_on: true, last_day: true, department_id: true, gender: true },
  });
  const atSite = (id) => !siteId || [...days.keys()].some((k) => k.startsWith(`${id}:`) && days.get(k).has(siteId));
  const inScope = people.filter((e) => (!company || companyOf(e.code) === company) && (!departmentId || e.department_id === departmentId) && atSite(e.id));
  const count = (field, ym) => inScope.filter((e) => e[field] && ymOf(fromDbDate(e[field])) === ym).length;

  const state = new Map(periods.map((p) => [p.period_ym, p.state]));
  const monthRows = months.map((ym) => {
    const m = out(byMonth.get(ym));
    return { ym, label: formatYearMonth(ym), short: formatYearMonth(ym).slice(0, 3), state: state.get(ym) ?? null, ...m, headcount: m.people, joiners: count('joined_on', ym), exits: count('last_day', ym) };
  });
  const run = monthRows.filter((m) => m.state);
  const total = Object.fromEntries(MONEY.map((k) => [k, monthRows.reduce((a, m) => a + m[k], 0)]));
  total.ot_hours = Math.round(monthRows.reduce((a, m) => a + m.ot_hours, 0) * 10) / 10;
  total.joiners = monthRows.reduce((a, m) => a + m.joiners, 0);
  total.exits = monthRows.reduce((a, m) => a + m.exits, 0);
  total.people = new Set(facts.filter((f) => !siteId || sharesOf(days, f).some(([s]) => s === siteId)).map((f) => f.employee_id)).size;
  const avgHeadcount = run.length ? run.reduce((a, m) => a + m.headcount, 0) / run.length : 0;
  total.avg_headcount = Math.round(avgHeadcount * 10) / 10;
  total.attrition_pct = avgHeadcount ? Math.round((total.exits / avgHeadcount) * 1000) / 10 : 0;

  // Gender of the people paid in the latest month run.
  const latest = run.at(-1)?.ym;
  const latestPeople = new Map(facts.filter((f) => f.ym === latest).map((f) => [f.employee_id, f]));
  const gender = [...latestPeople.values()].reduce((acc, f) => ({ ...acc, [f.gender ?? 'OTHER']: (acc[f.gender ?? 'OTHER'] ?? 0) + 1 }), {});

  return {
    fy: year,
    label: `FY ${year}-${String(year + 1).slice(2)}`,
    years,
    filters: { departments, sites, company: company ?? null, department_id: departmentId ?? null, site_id: siteId ?? null },
    months_run: run.length,
    provisional: run.filter((m) => m.state === 'RUN').map((m) => m.ym),
    months: monthRows,
    totals: total,
    departments: [...byDept.values()].map(out).sort((a, b) => b.ctc - a.ctc),
    sites: [...bySite.values()].map(out).sort((a, b) => b.ctc - a.ctc),
    top_ot: [...byPerson.values()].map(out).filter((p) => p.ot_hours > 0).sort((a, b) => b.ot_hours - a.ot_hours).slice(0, 10),
    workforce: {
      latest_month: latest ?? null,
      gender: Object.entries(gender).map(([key, value]) => ({ key, label: key === 'MALE' ? 'Men' : key === 'FEMALE' ? 'Women' : 'Other', value })),
    },
  };
}
