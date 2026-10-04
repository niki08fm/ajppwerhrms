import { addDays, addMonths, dayName, daysInMonth, firstOfMonth, isoDate, istDate, lastOfMonth, yearMonth, ymOf } from '@ajpwer/shared';
import { fromDbDate, n, toDbDate } from '../utils/dbDates.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { prisma } from '../config/db.js';
import { computeMonths } from '../services/attendance.service.js';
import { dayRegister } from '../services/register.service.js';
import { heldBackList } from '../services/payroll.service.js';
import { holidaysBetween } from '../services/rules.service.js';
import { inView, isExpected, liveFigures, minutesNow, VIEWS } from '../services/dayview.service.js';
import { KINDS, WINDOW_DAYS, waitingItems } from '../services/approvals.service.js';

const today = () => istDate(new Date());

/** Small in-memory cache: the dashboard reads cached aggregates, never a full recompute per load. */
const cache = new Map();

async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  return v;
}

// Each card is its own endpoint so one failing card never blanks the rest.
export const getToday = asyncHandler(async (_req, res) => {
  const date = today();
  const data = await cached(`today:${date}`, 30_000, async () => {
    const rows = await dayRegister(prisma, date, undefined, date);
    const count = (s) => rows.filter((r) => s.includes(r.day.status)).length;
    const working = rows.filter((r) => !['WEEKLY_OFF', 'HOLIDAY', 'NOT_JOINED', 'EXITED'].includes(r.day.status));
    return {
      date,
      headcount: rows.filter((r) => r.day.status !== 'NOT_JOINED' && r.day.status !== 'EXITED').length,
      present: count(['PRESENT', 'HALF_DAY', 'SHORT', 'MISSING_PUNCH', 'HOLIDAY_WORKED', 'OFF_WORKED']),
      absent: count(['ABSENT']),
      late: rows.filter((r) => r.day.late_min > 0).length,
      early: rows.filter((r) => r.day.early_min > 0).length,
      on_leave: count(['ON_LEAVE']),
      off: count(['WEEKLY_OFF', 'HOLIDAY']),
      ot_min: rows.reduce((a, r) => a + r.day.ot_min, 0),
      on_site_now: rows.filter((r) => r.open_now).length,
      missing_punch: rows.filter((r) => r.day.status === 'MISSING_PUNCH' && !r.open_now).length,
      expected: working.length,
    };
  });
  res.json({ data });
});

/**
 * Late logins and early punch-outs on a day, for HR to follow up. Late is past the grace
 * period; early is out before the day was done (shift end, or a standard day after a late
 * arrival). Neither is deducted.
 */
export const getPunctuality = asyncHandler(async (req, res) => {
  const date = isoDate.parse(req.query.date ?? today());
  const data = await cached(`punctuality:${date}`, 30_000, async () => {
    const rows = await dayRegister(prisma, date, undefined, today());
    const person = (r) => ({ id: r.employee.id, code: r.employee.code, name: r.employee.name, department: r.employee.department.name });
    return {
      date,
      late: rows
        .filter((r) => r.day.late_min > 0)
        .map((r) => ({ employee: person(r), in_min: r.in_min, late_min: r.day.late_min, due_out_min: r.day.due_out_min, open_now: r.open_now }))
        .sort((a, b) => b.late_min - a.late_min),
      early: rows
        .filter((r) => r.day.early_min > 0)
        .map((r) => ({ employee: person(r), out_min: r.out_min, early_min: r.day.early_min, due_out_min: r.day.due_out_min, worked_min: r.day.worked_min, status: r.day.status }))
        .sort((a, b) => b.early_min - a.early_min),
    };
  });
  res.json({ data });
});

export const getTrend = asyncHandler(async (req, res) => {
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
});

export const getMatrix = asyncHandler(async (_req, res) => {
  const date = today();
  const rows = await prisma.$queryRaw`
      SELECT d.name AS department, s.name AS site, s.id::text AS site_id, COUNT(DISTINCT p.employee_id) AS people
      FROM punch p JOIN employee e ON e.id = p.employee_id JOIN department d ON d.id = e.department_id JOIN site s ON s.id = p.site_id
      WHERE p.work_date = ${toDbDate(date)}::date GROUP BY d.name, s.name, s.id ORDER BY d.name, s.name`;
  res.json({ data: rows.map((r) => ({ department: r.department, site: r.site, site_id: r.site_id, people: Number(r.people) })) });
});

export const getStatusMix = asyncHandler(async (_req, res) => {
  const ym = ymOf(today());
  const data = await cached(`mix:${ym}`, 5 * 60_000, async () => {
    const employees = await prisma.employee.findMany({
      where: { deleted_at: null, status: { in: ['ACTIVE', 'NOTICE', 'EXITED'] }, joined_on: { lte: toDbDate(today()) }, OR: [{ last_day: null }, { last_day: { gte: toDbDate(firstOfMonth(ym)) } }] },
      select: { id: true, joined_on: true, last_day: true, pay_group_id: true },
    });
    const months = await computeMonths(prisma, employees, ym);
    const mix = {};
    const upto = today();
    for (const m of months.values()) for (const d of m.result.days) if (d.date <= upto && d.status !== 'NOT_JOINED' && d.status !== 'EXITED') mix[d.status] = (mix[d.status] ?? 0) + 1;
    return { month: ym, mix };
  });
  res.json({ data });
});

export const getNetByMonth = asyncHandler(async (_req, res) => {
  const rows = await prisma.payrollPeriod.findMany({ where: { state: { not: 'DRAFT' } }, orderBy: { period_ym: 'asc' }, take: 24 });
  res.json({ data: rows.map((r) => ({ period_ym: r.period_ym, state: r.state, ...(r.totals ?? {}) })) });
});

export const getPeople = asyncHandler(async (_req, res) => {
  const [pipeline, leavers, held, pendingFace, pendingLeave, expiring, holds, unpaidHeld, waitingNow] = await Promise.all([
    prisma.employee.groupBy({ by: ['status'], _count: true, where: { deleted_at: null } }),
    prisma.employee.findMany({ where: { deleted_at: null, status: 'NOTICE' }, select: { id: true, code: true, name: true, last_day: true }, orderBy: { last_day: 'asc' }, take: 10 }),
    heldBackList(prisma),
    prisma.faceException.count({ where: { status: 'PENDING' } }),
    prisma.leaveRequest.count({ where: { status: 'PENDING', deleted_at: null } }),
    prisma.document.count({ where: { deleted_at: null, expires_on: { lte: toDbDate(addDays(today(), 30)) }, employee: { status: { in: ['ACTIVE', 'NOTICE'] } } } }),
    prisma.salaryHold.findMany({ where: { released_at: null, deleted_at: null }, select: { employee: { select: { id: true, name: true } } } }),
    prisma.heldPay.aggregate({ where: { state: 'HELD' }, _sum: { amount: true }, _count: true }),
    waitingItems(prisma, today()),
  ]);
  res.json({
    data: {
      pipeline: Object.fromEntries(pipeline.map((p) => [p.status, p._count])),
      leavers: leavers.map((l) => ({ ...l, last_day: fromDbDate(l.last_day) })),
      held_back: held,
      // Salaries on hold now, and held salary not yet released.
      held_salaries: { people: holds.map((h) => h.employee), unpaid_months: unpaidHeld._count, unpaid: Number(unpaidHeld._sum.amount ?? 0n) },
      // `total` is everything on the Approvals screen, the number the sidebar shows.
      approvals: { face: pendingFace, leave: pendingLeave, total: waitingNow.length },
      documents_expiring: expiring,
    },
  });
});

/** Trends across months, from snapshots and cached aggregates. */
export const getAnalytics = asyncHandler(async (_req, res) => {
  const date = today();
  const [aggs, periods] = await Promise.all([
    prisma.dailyAggregate.findMany({ where: { site_id: null, date: { gte: toDbDate(addDays(date, -59)) } }, orderBy: { date: 'asc' } }),
    prisma.payrollPeriod.findMany({ where: { state: { not: 'DRAFT' } }, orderBy: { period_ym: 'asc' }, take: 24 }),
  ]);
  const months = [];
  for (const p of periods) {
    const slips = await prisma.payslip.findMany({
      where: { period_id: p.id },
      select: {
        employee_id: true,
        gross: true,
        net: true,
        ctc_month: true,
        lop_days: true,
        paid_days: true,
        meta: true,
        lines: { where: { OR: [{ kind: 'OT' }, { code: 'TDS' }] }, select: { kind: true, code: true, amount: true } },
      },
    });
    const meta = (s) => s.meta;
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
});

// ─── Today screen (redesign) ─────────────────────────────────────────────────

const first = (name) => name.split(/\s+/)[0];

/** The register of one date, cached briefly: Today and its counts read the same rows. */
function registerOf(date) {
  return cached(`register:${date}:${today()}`, 20_000, () => dayRegister(prisma, date, undefined, today()));
}

/**
 * Everything the Today screen draws for one date, in one call: each person's day in a
 * compact form (the screen counts and groups them), the sites, the site moves of the day
 * and what waits on HR. Works for any past date too — then nobody is "on site now" and
 * the 2 AM auto punch-out shows as "no punch-out".
 */
export const getOverview = asyncHandler(async (req, res) => {
  const now = today();
  const date = isoDate.parse(req.query.date ?? now);
  const isToday = date === now;
  const nowMin = isToday ? minutesNow(date) : null;

  const [rows, sites, departments, moves, waitingNow, holds, heldBack] = await Promise.all([
    registerOf(date),
    prisma.site.findMany({ where: { deleted_at: null }, select: { id: true, code: true, name: true, is_active: true }, orderBy: { name: 'asc' } }),
    prisma.department.findMany({ where: { deleted_at: null }, select: { id: true, name: true, colour: true }, orderBy: { name: 'asc' } }),
    prisma.siteChange.findMany({ where: { work_date: toDbDate(date) }, orderBy: { left_at: 'asc' } }),
    waitingItems(prisma, now),
    prisma.salaryHold.findMany({ where: { released_at: null, deleted_at: null }, select: { employee_id: true, created_at: true } }),
    heldBackList(prisma),
  ]);

  const people = rows
    .filter((r) => r.day.status !== 'NOT_JOINED' && r.day.status !== 'EXITED')
    .map((r) => {
      const live = liveFigures(r, nowMin ?? 0);
      return {
        id: r.employee.id,
        code: r.employee.code,
        name: r.employee.name,
        dept_id: r.employee.department.id,
        status: r.day.status,
        sites: r.day.sites,
        in_min: r.in_min,
        out_min: r.out_min,
        worked_min: live.worked_min,
        late_min: r.day.late_min,
        early_min: r.open_now ? 0 : r.day.early_min,
        ot_min: live.ot_min,
        open_now: r.open_now,
        corrected: !!r.override,
        views: VIEWS.filter((v) => inView(v, r, live)),
        expected: isExpected(r),
      };
    });

  // Names for the people on today's moves and on hold.
  const ids = [...new Set([...holds.map((h) => h.employee_id), ...moves.map((m) => m.employee_id)].filter(Boolean))];
  const named = new Map((await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, code: true } })).map((e) => [e.id, e]));
  const nameOf = (id) => named.get(id)?.name ?? people.find((p) => p.id === id)?.name ?? null;

  // What waits on HR: the same list the Approvals screen shows, counted by kind.
  const LABELS = { face: 'Face checks', miss: 'Missing punch-outs', short: 'Short days', move: 'Site changes', leave: 'Leave requests' };
  const item = (key, label, list, to, at) => ({ key, label, n: list.length, names: list.map((x) => x.name).filter(Boolean).slice(0, 6), employee_ids: list.map((x) => x.id).filter(Boolean), to, oldest_at: at ?? null });
  const waiting = [
    ...KINDS.map((k) => {
      const of = waitingNow.filter((w) => w.kind === k);
      return item(k, LABELS[k], of.map((w) => ({ id: w.employee?.id, name: w.employee?.name ?? 'Unknown face' })), `/approvals?kind=${k}`, of[of.length - 1]?.at);
    }),
    item('hold', 'Salaries on hold', holds.map((h) => ({ id: h.employee_id, name: nameOf(h.employee_id) })), '/held-salaries', null),
    item('heldback', 'Left out of payroll', heldBack.map((h) => ({ id: h.employee.id, name: h.employee.name })), '/payroll', null),
  ].filter((w) => w.n > 0);

  const KIND_WORD = { face: 'face check', miss: 'missing punch-out', short: 'short day', move: 'site change', leave: 'leave request' };
  const last = waitingNow[waitingNow.length - 1];
  const oldest = last ? { label: KIND_WORD[last.kind], name: last.employee?.name ?? 'Unknown face', at: last.at } : null;

  // The shift most people are on, for the arrivals chart.
  const mode = (xs) => {
    const c = new Map();
    for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
    return [...c.entries()].sort((p, q) => q[1] - p[1])[0]?.[0] ?? null;
  };
  const shift = { start_min: mode(rows.map((r) => r.context.shift_start_min)) ?? 540, grace_min: mode(rows.map((r) => r.context.grace_min)) ?? 10, standard_min: mode(rows.map((r) => r.context.standard_min)) ?? 540 };

  res.json({
    data: {
      date,
      today: now,
      is_today: isToday,
      shift,
      now_min: nowMin,
      sites: sites.filter((s) => s.is_active || people.some((p) => p.sites.includes(s.id))),
      departments,
      people,
      moves: moves.map((m) => ({ id: m.id, employee_id: m.employee_id, name: nameOf(m.employee_id), from_site_id: m.from_site_id, to_site_id: m.to_site_id, travel_min: m.hr_travel_min ?? m.travel_min, status: m.status })),
      waiting,
      waiting_total: waiting.filter((w) => !['hold', 'heldback'].includes(w.key)).reduce((a, w) => a + w.n, 0),
      oldest: oldest && { ...oldest, hours: Math.max(0, Math.round((Date.now() - new Date(oldest.at).getTime()) / 3_600_000)) },
    },
  });
});

/**
 * Everything waiting on HR (face checks, missing punch-outs, short days, site changes,
 * leave) as one list, with the sites and departments to filter it by. `fresh=1` skips the
 * few-second cache, for the reload right after a decision.
 */
export const getApprovals = asyncHandler(async (req, res) => {
  const now = today();
  const [items, sites, departments] = await Promise.all([
    waitingItems(prisma, now, { fresh: req.query.fresh === '1' }),
    prisma.site.findMany({ where: { deleted_at: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.department.findMany({ where: { deleted_at: null }, select: { id: true, name: true, colour: true }, orderBy: { name: 'asc' } }),
  ]);
  res.json({ data: { today: now, window_days: WINDOW_DAYS, items, sites, departments } });
});

/**
 * A month for the day picker and the month chart: for each day, the share of staff who
 * came in and how many punched at each site; Sundays/weekly offs and holidays marked.
 */
export const getMonth = asyncHandler(async (req, res) => {
  const now = today();
  const ym = yearMonth.parse(req.query.ym ?? ymOf(now));
  const data = await cached(`month:${ym}:${now}`, 5 * 60_000, async () => {
    const from = firstOfMonth(ym);
    const to = lastOfMonth(ym);
    const [aggs, holidays, groups] = await Promise.all([
      prisma.dailyAggregate.findMany({ where: { date: { gte: toDbDate(from), lte: toDbDate(to) } } }),
      holidaysBetween(prisma, from, to),
      prisma.payGroup.findMany({ where: { deleted_at: null }, select: { weekly_off: true } }),
    ]);
    // A day is "off" when every pay group has it off (or it is a company holiday).
    const offDays = groups.length ? groups.map((g) => g.weekly_off).reduce((a, b) => a.filter((x) => b.includes(x))) : [];
    const days = [];
    for (let i = 0; i < daysInMonth(ym); i++) {
      const d = addDays(from, i);
      const company = aggs.find((a) => a.site_id === null && fromDbDate(a.date) === d);
      const bySite = {};
      for (const a of aggs) if (a.site_id && fromDbDate(a.date) === d) bySite[a.site_id] = a.present;
      days.push({
        date: d,
        future: d > now,
        off: holidays.has(d) || offDays.includes(dayName(d)),
        holiday: holidays.get(d) ?? null,
        present: company?.present ?? 0,
        headcount: company?.headcount ?? 0,
        rate: company && company.headcount ? Math.round((company.present / company.headcount) * 1000) / 10 : null,
        sites: bySite,
      });
    }
    return { ym, days };
  });
  res.json({ data });
});
