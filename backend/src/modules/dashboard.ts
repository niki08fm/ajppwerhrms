import { Router } from 'express';
import { addDays, addMonths, firstOfMonth, istDate, ymOf, type DayStatus } from '@ajpwer/shared';
import { requirePerm } from '../lib/auth';
import { fromDbDate, n, toDbDate } from '../lib/db-dates';
import { ah } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { computeMonths } from '../services/attendance';
import { dayRegister } from '../services/register';
import { heldBackList } from '../services/payroll';

export const dashboardRouter = Router();
const today = () => istDate(new Date());

/** Small in-memory cache: the dashboard reads cached aggregates, never a full recompute per load. */
const cache = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v as T;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  return v;
}

// Each card is its own endpoint so one failing card never blanks the rest.

dashboardRouter.get(
  '/dashboard/today',
  requirePerm('attendance.read'),
  ah(async (_req, res) => {
    const date = today();
    const data = await cached(`today:${date}`, 30_000, async () => {
      const rows = await dayRegister(prisma, date, undefined, date);
      const count = (s: DayStatus[]) => rows.filter((r) => s.includes(r.day.status)).length;
      const working = rows.filter((r) => !['WEEKLY_OFF', 'HOLIDAY', 'NOT_JOINED', 'EXITED'].includes(r.day.status));
      return {
        date,
        headcount: rows.filter((r) => r.day.status !== 'NOT_JOINED' && r.day.status !== 'EXITED').length,
        present: count(['PRESENT', 'HALF_DAY', 'SHORT', 'MISSING_PUNCH', 'HOLIDAY_WORKED', 'OFF_WORKED']),
        absent: count(['ABSENT']),
        late: rows.filter((r) => r.day.late_min > 0).length,
        on_leave: count(['ON_LEAVE']),
        off: count(['WEEKLY_OFF', 'HOLIDAY']),
        ot_min: rows.reduce((a, r) => a + r.day.ot_min, 0),
        on_site_now: rows.filter((r) => r.open_now).length,
        missing_punch: rows.filter((r) => r.day.status === 'MISSING_PUNCH' && !r.open_now).length,
        expected: working.length,
      };
    });
    res.json({ data });
  }),
);

dashboardRouter.get(
  '/dashboard/trend',
  requirePerm('attendance.read'),
  ah(async (req, res) => {
    const days = Math.min(90, Number(req.query.days ?? 30));
    const date = today();
    const rows = await prisma.dailyAggregate.findMany({ where: { site_id: null, date: { gte: toDbDate(addDays(date, -(days - 1))), lte: toDbDate(date) } }, orderBy: { date: 'asc' } });
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = addDays(date, -i);
      const r = rows.find((x) => fromDbDate(x.date) === d);
      out.push({ date: d, present: r?.present ?? 0, headcount: r?.headcount ?? 0, rate: r && r.headcount ? Math.round((r.present / r.headcount) * 1000) / 10 : null, worked_min: r?.worked_min ?? 0 });
    }
    res.json({ data: out });
  }),
);

dashboardRouter.get(
  '/dashboard/matrix',
  requirePerm('attendance.read'),
  ah(async (_req, res) => {
    const date = today();
    const rows = await prisma.$queryRaw<{ department: string; site: string; site_id: string; people: bigint }[]>`
      SELECT d.name AS department, s.name AS site, s.id::text AS site_id, COUNT(DISTINCT p.employee_id) AS people
      FROM punch p JOIN employee e ON e.id = p.employee_id JOIN department d ON d.id = e.department_id JOIN site s ON s.id = p.site_id
      WHERE p.work_date = ${toDbDate(date)}::date GROUP BY d.name, s.name, s.id ORDER BY d.name, s.name`;
    res.json({ data: rows.map((r) => ({ department: r.department, site: r.site, site_id: r.site_id, people: Number(r.people) })) });
  }),
);

dashboardRouter.get(
  '/dashboard/status-mix',
  requirePerm('attendance.read'),
  ah(async (_req, res) => {
    const ym = ymOf(today());
    const data = await cached(`mix:${ym}`, 5 * 60_000, async () => {
      const employees = await prisma.employee.findMany({
        where: { deleted_at: null, status: { in: ['ACTIVE', 'NOTICE', 'EXITED'] }, joined_on: { lte: toDbDate(today()) }, OR: [{ last_day: null }, { last_day: { gte: toDbDate(firstOfMonth(ym)) } }] },
        select: { id: true, joined_on: true, last_day: true, pay_group_id: true },
      });
      const months = await computeMonths(prisma, employees, ym);
      const mix: Record<string, number> = {};
      const upto = today();
      for (const m of months.values()) for (const d of m.result.days) if (d.date <= upto && d.status !== 'NOT_JOINED' && d.status !== 'EXITED') mix[d.status] = (mix[d.status] ?? 0) + 1;
      return { month: ym, mix };
    });
    res.json({ data });
  }),
);

dashboardRouter.get(
  '/dashboard/net-by-month',
  requirePerm('payroll.read'),
  ah(async (_req, res) => {
    const rows = await prisma.payrollPeriod.findMany({ where: { state: { not: 'DRAFT' } }, orderBy: { period_ym: 'asc' }, take: 24 });
    res.json({ data: rows.map((r) => ({ period_ym: r.period_ym, state: r.state, ...((r.totals as Record<string, number>) ?? {}) })) });
  }),
);

dashboardRouter.get(
  '/dashboard/people',
  requirePerm('people.read'),
  ah(async (_req, res) => {
    const [pipeline, leavers, held, pendingFace, pendingLeave, expiring] = await Promise.all([
      prisma.employee.groupBy({ by: ['status'], _count: true, where: { deleted_at: null } }),
      prisma.employee.findMany({ where: { deleted_at: null, status: 'NOTICE' }, select: { id: true, code: true, name: true, last_day: true }, orderBy: { last_day: 'asc' }, take: 10 }),
      heldBackList(prisma),
      prisma.faceException.count({ where: { status: 'PENDING' } }),
      prisma.leaveRequest.count({ where: { status: 'PENDING', deleted_at: null } }),
      prisma.document.count({ where: { deleted_at: null, expires_on: { lte: toDbDate(addDays(today(), 30)) }, employee: { status: { in: ['ACTIVE', 'NOTICE'] } } } }),
    ]);
    res.json({
      data: {
        pipeline: Object.fromEntries(pipeline.map((p) => [p.status, p._count])),
        leavers: leavers.map((l) => ({ ...l, last_day: fromDbDate(l.last_day) })),
        held_back: held,
        approvals: { face: pendingFace, leave: pendingLeave },
        documents_expiring: expiring,
      },
    });
  }),
);

/** Trends across months, from snapshots and cached aggregates. */
dashboardRouter.get(
  '/analytics',
  requirePerm('payroll.read'),
  ah(async (_req, res) => {
    const date = today();
    const [aggs, periods] = await Promise.all([
      prisma.dailyAggregate.findMany({ where: { site_id: null, date: { gte: toDbDate(addDays(date, -59)) } }, orderBy: { date: 'asc' } }),
      prisma.payrollPeriod.findMany({ where: { state: { not: 'DRAFT' } }, orderBy: { period_ym: 'asc' }, take: 24 }),
    ]);
    const months = [];
    for (const p of periods) {
      const slips = await prisma.payslip.findMany({ where: { period_id: p.id }, select: { employee_id: true, gross: true, net: true, ctc_month: true, lop_days: true, paid_days: true, meta: true, lines: { where: { OR: [{ kind: 'OT' }, { code: 'TDS' }] }, select: { kind: true, code: true, amount: true } } } });
      const meta = (s: (typeof slips)[number]) => s.meta as { attendance?: { late_days?: number; ot_min?: number }; regime?: string };
      months.push({
        period_ym: p.period_ym,
        headcount: slips.length,
        gross: slips.reduce((a, s) => a + n(s.gross), 0),
        net: slips.reduce((a, s) => a + n(s.net), 0),
        ctc: slips.reduce((a, s) => a + n(s.ctc_month), 0),
        ot_amount: slips.reduce((a, s) => a + s.lines.filter((l) => l.kind === 'OT').reduce((b, l) => b + n(l.amount), 0), 0),
        ot_hours: Math.round(slips.reduce((a, s) => a + (meta(s).attendance?.ot_min ?? 0), 0) / 60),
        late_days: slips.reduce((a, s) => a + (meta(s).attendance?.late_days ?? 0), 0),
        lop_days: slips.reduce((a, s) => a + Number(s.lop_days), 0),
        tax_new: slips.filter((s) => meta(s).regime !== 'OLD').reduce((a, s) => a + s.lines.filter((l) => l.code === 'TDS').reduce((b, l) => b + n(l.amount), 0), 0),
        tax_old: slips.filter((s) => meta(s).regime === 'OLD').reduce((a, s) => a + s.lines.filter((l) => l.code === 'TDS').reduce((b, l) => b + n(l.amount), 0), 0),
        scatter: slips.map((s) => ({ paid_days: Number(s.paid_days), late_days: meta(s).attendance?.late_days ?? 0 })),
      });
    }
    const latest = months[months.length - 1];
    res.json({
      data: {
        attendance_rate: aggs.map((a) => ({ date: fromDbDate(a.date), rate: a.headcount ? Math.round((a.present / a.headcount) * 1000) / 10 : null })),
        months: months.map(({ scatter: _s, ...m }) => m),
        scatter: latest?.scatter ?? [],
        scatter_period: latest?.period_ym ?? null,
        range: { from: addMonths(ymOf(date), -23), to: ymOf(date) },
      },
    });
  }),
);
