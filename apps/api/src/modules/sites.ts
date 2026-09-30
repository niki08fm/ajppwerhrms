import { Router } from 'express';
import { addDays, firstOfMonth, isoDate, istDate, istMinuteOfDay, lastOfMonth, projectSchema, siteSchema, yearMonth, ymOf } from '@ajpwer/shared';
import { pairPunches, projectLabourCost, type EmployeeIntervals } from '../engines';
import { audit, who } from '../lib/audit';
import { hashPassword, requirePerm } from '../lib/auth';
import { generatePassword } from '../lib/crypto';
import { fromDbDate, n, toDbDate } from '../lib/db-dates';
import { ah, notFound } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { toEnginePunch, computeMonths } from '../services/attendance';
import { computePayslip, loadRecoveries } from '../services/payslip';
import { payContext } from '../services/payroll';

export const sitesRouter = Router();
const today = () => istDate(new Date());

function siteOut(s: { id: string; code: string; name: string; state: string; lat: unknown; lng: unknown; radius_m: number; project_id: string | null; login: string; is_active: boolean; created_on: Date }) {
  return { id: s.id, code: s.code, name: s.name, state: s.state, lat: Number(s.lat), lng: Number(s.lng), radius_m: s.radius_m, project_id: s.project_id, login: s.login, is_active: s.is_active, created_on: fromDbDate(s.created_on) };
}

/** "On site now" is derived: the person's most recent punch is an IN, at this site. */
async function onSiteNow(date: string) {
  const rows = await prisma.$queryRaw<{ employee_id: string; site_id: string; direction: string; punched_at: Date }[]>`
    SELECT DISTINCT ON (employee_id) employee_id, site_id, direction::text AS direction, punched_at
    FROM punch WHERE work_date >= ${toDbDate(addDays(date, -1))}::date
    ORDER BY employee_id, punched_at DESC`;
  return rows.filter((r) => r.direction === 'IN');
}

sitesRouter.get(
  '/sites',
  requirePerm('attendance.read'),
  ah(async (_req, res) => {
    const date = today();
    const [sites, punches, now, aggs] = await Promise.all([
      prisma.site.findMany({ where: { deleted_at: null }, include: { project: { select: { id: true, code: true, name: true } } }, orderBy: { name: 'asc' } }),
      prisma.punch.findMany({ where: { work_date: toDbDate(date) }, select: { id: true, employee_id: true, punched_at: true, work_date: true, direction: true, site_id: true, method: true }, orderBy: { punched_at: 'asc' } }),
      onSiteNow(date),
      prisma.dailyAggregate.findMany({ where: { site_id: { not: null }, date: { gte: toDbDate(addDays(date, -13)) } }, orderBy: { date: 'asc' } }),
    ]);
    const out = sites.map((s) => {
      const here = punches.filter((p) => p.site_id === s.id);
      const people = new Set(here.map((p) => p.employee_id));
      // Hours here: intervals whose IN was at this site, per person across the day.
      let minutes = 0;
      const byEmp = new Map<string, typeof punches>();
      for (const p of punches) byEmp.set(p.employee_id, [...(byEmp.get(p.employee_id) ?? []), p]);
      for (const id of people) minutes += pairPunches((byEmp.get(id) ?? []).map(toEnginePunch)).pairs.filter((x) => x.site_id === s.id).reduce((a, x) => a + x.minutes, 0);
      const spark = [];
      for (let i = 13; i >= 0; i--) {
        const d = addDays(date, -i);
        spark.push({ date: d, present: aggs.find((a) => a.site_id === s.id && fromDbDate(a.date) === d)?.present ?? 0 });
      }
      return {
        ...siteOut(s),
        project: s.project,
        today: { punched_in: people.size, on_site_now: now.filter((r) => r.site_id === s.id).length, worked_min: minutes, avg_min: people.size ? Math.round(minutes / people.size) : 0 },
        sparkline: spark,
      };
    });
    res.json({ data: out });
  }),
);

/** Creating a site generates the tablet login and password, shown once. */
sitesRouter.post(
  '/sites',
  requirePerm('sites.write'),
  ah(async (req, res) => {
    const b = siteSchema.parse(req.body);
    const password = generatePassword();
    const login = `site-${b.code.toLowerCase()}`;
    const { actor, ip } = who(req);
    const s = await prisma.$transaction(async (tx) => {
      const created = await tx.site.create({ data: { ...b, project_id: b.project_id ?? null, login, password_hash: await hashPassword(password) } });
      await audit(tx, { actor, ip, action: 'site.create', entity_type: 'site', entity_id: created.id, detail: { ...b, login } });
      return created;
    });
    res.status(201).json({ data: { ...siteOut(s), credentials: { login, password, note: 'Shown once. Reissue from the site screen if lost.' } } });
  }),
);

sitesRouter.patch(
  '/sites/:id',
  requirePerm('sites.write'),
  ah(async (req, res) => {
    const b = siteSchema.partial().strict().parse(req.body);
    const before = await prisma.site.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('That site');
    const s = await prisma.site.update({ where: { id: before.id }, data: b });
    await audit(prisma, { ...who(req), action: 'site.update', entity_type: 'site', entity_id: s.id, detail: { before: siteOut(before), after: b } });
    res.json({ data: siteOut(s) });
  }),
);

/** Rotation invalidates every existing tablet token for the site. */
sitesRouter.post(
  '/sites/:id/reissue-login',
  requirePerm('sites.write'),
  ah(async (req, res) => {
    const s = await prisma.site.findUnique({ where: { id: req.params.id } });
    if (!s) throw notFound('That site');
    const password = generatePassword();
    await prisma.site.update({ where: { id: s.id }, data: { password_hash: await hashPassword(password), token_version: { increment: 1 } } });
    await audit(prisma, { ...who(req), action: 'site.password_rotate', entity_type: 'site', entity_id: s.id });
    res.json({ data: { login: s.login, password, note: 'Shown once. Every tablet signed in to this site has been signed out.' } });
  }),
);

/** Everything a site screen needs, in one call. All derived from punches, none from membership. */
sitesRouter.get(
  '/sites/:id/day',
  requirePerm('attendance.read'),
  ah(async (req, res) => {
    const date = isoDate.parse(req.query.date ?? today());
    const site = await prisma.site.findUnique({ where: { id: req.params.id }, include: { project: { select: { id: true, code: true, name: true } } } });
    if (!site) throw notFound('That site');
    const from30 = addDays(date, -29);
    const from14 = addDays(date, -13);
    const [dayPunches, now, aggs, deptMix, moves] = await Promise.all([
      prisma.punch.findMany({
        where: { work_date: toDbDate(date) },
        include: { employee: { select: { id: true, code: true, name: true, department: { select: { name: true } } } }, site: { select: { id: true, code: true, name: true } } },
        orderBy: { punched_at: 'asc' },
      }),
      onSiteNow(date),
      prisma.dailyAggregate.findMany({ where: { site_id: site.id, date: { gte: toDbDate(from30), lte: toDbDate(date) } }, orderBy: { date: 'asc' } }),
      prisma.$queryRaw<{ department: string; person_days: bigint }[]>`
        SELECT d.name AS department, COUNT(DISTINCT (p.employee_id, p.work_date)) AS person_days
        FROM punch p JOIN employee e ON e.id = p.employee_id JOIN department d ON d.id = e.department_id
        WHERE p.site_id = ${site.id}::uuid AND p.work_date BETWEEN ${toDbDate(from30)}::date AND ${toDbDate(date)}::date
        GROUP BY d.name ORDER BY person_days DESC`,
      prisma.$queryRaw<{ other_site: string; other_name: string; people: bigint; days: bigint }[]>`
        SELECT o.site_id::text AS other_site, s.name AS other_name, COUNT(DISTINCT o.employee_id) AS people, COUNT(DISTINCT (o.employee_id, o.work_date)) AS days
        FROM (SELECT DISTINCT employee_id, work_date FROM punch WHERE site_id = ${site.id}::uuid AND work_date BETWEEN ${toDbDate(from14)}::date AND ${toDbDate(date)}::date) h
        JOIN punch o ON o.employee_id = h.employee_id AND o.work_date = h.work_date AND o.site_id <> ${site.id}::uuid
        JOIN site s ON s.id = o.site_id
        GROUP BY o.site_id, s.name ORDER BY days DESC`,
    ]);
    const here = dayPunches.filter((p) => p.site_id === site.id);
    const people = new Set(here.map((p) => p.employee_id));
    let minutes = 0;
    for (const id of people) {
      const all = dayPunches.filter((p) => p.employee_id === id).map(toEnginePunch);
      minutes += pairPunches(all).pairs.filter((x) => x.site_id === site.id).reduce((a, x) => a + x.minutes, 0);
    }
    const arrivals = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));
    const firstIn = new Map<string, Date>();
    for (const p of here) if (p.direction === 'IN' && !firstIn.has(p.employee_id)) firstIn.set(p.employee_id, p.punched_at);
    for (const at of firstIn.values()) arrivals[Math.floor(istMinuteOfDay(at) / 60)].count++;
    const series = [];
    for (let i = 29; i >= 0; i--) {
      const d = addDays(date, -i);
      series.push({ date: d, present: aggs.find((a) => fromDbDate(a.date) === d)?.present ?? 0 });
    }
    const nowHere = now.filter((r) => r.site_id === site.id);
    const nowPeople = await prisma.employee.findMany({ where: { id: { in: nowHere.map((x) => x.employee_id) } }, select: { id: true, code: true, name: true, designation: true } });
    res.json({
      data: {
        site: { ...siteOut(site), project: site.project },
        date,
        today: { punched_in: people.size, on_site_now: nowHere.length, worked_min: minutes, avg_min: people.size ? Math.round(minutes / people.size) : 0 },
        on_site_now: nowPeople.map((p) => ({ ...p, since: nowHere.find((x) => x.employee_id === p.id)?.punched_at })),
        people_per_day: series,
        department_mix: deptMix.map((d) => ({ department: d.department, person_days: Number(d.person_days) })),
        arrivals_by_hour: arrivals.filter((a) => a.hour >= 4 && a.hour <= 22),
        movement: moves.map((m) => ({ site_id: m.other_site, site_name: m.other_name, people: Number(m.people), days: Number(m.days) })),
        punches: here.map((p) => ({ id: p.id, employee: p.employee, direction: p.direction, punched_at: p.punched_at, method: p.method, match_score: p.match_score === null ? null : Number(p.match_score), distance_m: p.distance_m, flagged: p.flagged, flag_reason: p.flag_reason })),
      },
    });
  }),
);

/** The site network: circles sized by today's punch-ins, ringed by department mix; arrows for two-site days over 7 days. */
sitesRouter.get(
  '/sites-network',
  requirePerm('attendance.read'),
  ah(async (_req, res) => {
    const date = today();
    const from7 = addDays(date, -6);
    const [sites, todayRows, now, edges] = await Promise.all([
      prisma.site.findMany({ where: { deleted_at: null, is_active: true }, select: { id: true, code: true, name: true } }),
      prisma.$queryRaw<{ site_id: string; department: string; colour: string; people: bigint }[]>`
        SELECT p.site_id::text AS site_id, d.name AS department, d.colour, COUNT(DISTINCT p.employee_id) AS people
        FROM punch p JOIN employee e ON e.id = p.employee_id JOIN department d ON d.id = e.department_id
        WHERE p.work_date = ${toDbDate(date)}::date GROUP BY p.site_id, d.name, d.colour`,
      onSiteNow(date),
      prisma.$queryRaw<{ a: string; b: string; moves: bigint }[]>`
        WITH day_sites AS (
          SELECT employee_id, work_date, site_id, MIN(punched_at) AS first_at
          FROM punch WHERE work_date BETWEEN ${toDbDate(from7)}::date AND ${toDbDate(date)}::date
          GROUP BY employee_id, work_date, site_id
        )
        SELECT x.site_id::text AS a, y.site_id::text AS b, COUNT(*) AS moves
        FROM day_sites x JOIN day_sites y ON x.employee_id = y.employee_id AND x.work_date = y.work_date AND x.first_at < y.first_at
        GROUP BY x.site_id, y.site_id`,
    ]);
    res.json({
      data: {
        nodes: sites.map((s) => {
          const mix = todayRows.filter((r) => r.site_id === s.id).map((r) => ({ department: r.department, colour: r.colour, people: Number(r.people) }));
          return { ...s, punched_in: mix.reduce((a, m) => a + m.people, 0), on_site_now: now.filter((r) => r.site_id === s.id).length, mix };
        }),
        edges: edges.map((e) => ({ from: e.a, to: e.b, moves: Number(e.moves) })),
      },
    });
  }),
);

// ─── Projects ────────────────────────────────────────────────────────────────

sitesRouter.get(
  '/projects',
  requirePerm('setup.read'),
  ah(async (_req, res) => {
    const rows = await prisma.project.findMany({ where: { deleted_at: null }, include: { sites: { where: { deleted_at: null }, select: { id: true, code: true, name: true } } }, orderBy: { code: 'asc' } });
    res.json({ data: rows.map((p) => ({ ...p, started_on: fromDbDate(p.started_on) })) });
  }),
);

sitesRouter.post(
  '/projects',
  requirePerm('setup.write'),
  ah(async (req, res) => {
    const b = projectSchema.parse(req.body);
    const p = await prisma.project.create({
      data: { ...b, contract_value: BigInt(b.contract_value), budget_labour: BigInt(b.budget_labour), material_cost: BigInt(b.material_cost), other_cost: BigInt(b.other_cost), started_on: b.started_on ? toDbDate(b.started_on) : null },
    });
    await audit(prisma, { ...who(req), action: 'project.create', entity_type: 'project', entity_id: p.id, detail: b });
    res.status(201).json({ data: p });
  }),
);

sitesRouter.patch(
  '/projects/:id',
  requirePerm('setup.write'),
  ah(async (req, res) => {
    const b = projectSchema.partial().strict().parse(req.body);
    const data: Record<string, unknown> = { ...b };
    for (const k of ['contract_value', 'budget_labour', 'material_cost', 'other_cost'] as const) if (b[k] !== undefined) data[k] = BigInt(b[k]!);
    if (b.started_on !== undefined) data.started_on = b.started_on ? toDbDate(b.started_on) : null;
    const p = await prisma.project.update({ where: { id: req.params.id }, data });
    await audit(prisma, { ...who(req), action: 'project.update', entity_type: 'project', entity_id: p.id, detail: b });
    res.json({ data: p });
  }),
);

/**
 * Project labour cost, split by minutes. Cost per minute is a person's cost to
 * company for the month over their worked minutes — from the payroll snapshot
 * when the month has been run, otherwise from the live engine.
 */
sitesRouter.get(
  '/projects/labour-cost',
  requirePerm('payroll.read'),
  ah(async (req, res) => {
    const month = yearMonth.parse(req.query.month ?? ymOf(today()));
    const from = firstOfMonth(month);
    const to = lastOfMonth(month);
    const [projects, sites, punches, period] = await Promise.all([
      prisma.project.findMany({ where: { deleted_at: null } }),
      prisma.site.findMany({ select: { id: true, project_id: true } }),
      prisma.punch.findMany({ where: { work_date: { gte: toDbDate(from), lte: toDbDate(to) } }, select: { id: true, employee_id: true, punched_at: true, work_date: true, direction: true, site_id: true, method: true }, orderBy: { punched_at: 'asc' } }),
      prisma.payrollPeriod.findUnique({ where: { period_ym: month } }),
    ]);
    const siteProject = Object.fromEntries(sites.map((s) => [s.id, s.project_id]));
    const byEmpDay = new Map<string, typeof punches>();
    for (const p of punches) {
      const k = `${p.employee_id}|${fromDbDate(p.work_date)}`;
      byEmpDay.set(k, [...(byEmpDay.get(k) ?? []), p]);
    }
    const intervals = new Map<string, { site_id: string; minutes: number }[]>();
    for (const [k, list] of byEmpDay) {
      const emp = k.split('|')[0];
      const pairs = pairPunches(list.map(toEnginePunch)).pairs.filter((x) => x.out && x.minutes > 0).map((x) => ({ site_id: x.site_id, minutes: x.minutes }));
      intervals.set(emp, [...(intervals.get(emp) ?? []), ...pairs]);
    }
    const empIds = [...intervals.keys()];
    const ctc = new Map<string, number>();
    let source: 'snapshot' | 'live' = 'live';
    if (period && period.state !== 'DRAFT') {
      source = 'snapshot';
      const slips = await prisma.payslip.findMany({ where: { period_id: period.id, employee_id: { in: empIds } }, select: { employee_id: true, ctc_month: true } });
      for (const s of slips) ctc.set(s.employee_id, n(s.ctc_month));
    } else {
      const employees = await prisma.employee.findMany({ where: { id: { in: empIds } }, include: { statutory: true } });
      const months = await computeMonths(prisma, employees, month);
      const pctx = await payContext(prisma, month);
      const rec = await loadRecoveries(prisma, empIds, month);
      for (const e of employees) {
        try {
          const p = await computePayslip(prisma, e, month, months.get(e.id)!, pctx, rec.get(e.id) ?? null);
          ctc.set(e.id, p.result.ctc_month);
        } catch {
          // no salary: cannot be costed; reported as uncosted minutes
        }
      }
    }
    const input: EmployeeIntervals[] = empIds.filter((id) => ctc.has(id)).map((id) => ({ employee_id: id, ctc_month: ctc.get(id)!, intervals: intervals.get(id)! }));
    const rows = projectLabourCost(input, siteProject);
    const dim = Number(to.slice(8, 10));
    res.json({
      data: projects.map((p) => {
        const r = rows.find((x) => x.project_id === p.id);
        const cost = r?.cost ?? 0;
        const runRate = Math.round((cost * 365) / dim);
        return {
          id: p.id,
          code: p.code,
          name: p.name,
          client: p.client,
          contract_value: n(p.contract_value),
          budget_labour: n(p.budget_labour),
          material_cost: n(p.material_cost),
          other_cost: n(p.other_cost),
          minutes: r?.minutes ?? 0,
          people: r?.people ?? 0,
          labour_cost: cost,
          annual_run_rate: runRate,
          budget_used_pct: n(p.budget_labour) ? Math.round((runRate / n(p.budget_labour)) * 1000) / 10 : null,
          margin_at_rate: n(p.contract_value) - runRate - n(p.material_cost) - n(p.other_cost),
        };
      }),
      meta: {
        month,
        source,
        uncosted_people: empIds.length - input.length,
        caveat:
          "Cost per minute uses each person's cost to company for the month, including employer statutory. Overtime and off-day premiums are spread across all of that person's minutes, not attributed to the site where they happened.",
      },
    });
  }),
);

