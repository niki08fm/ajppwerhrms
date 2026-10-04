import { z } from 'zod';
import { addDays, bulkOverrideSchema, DAY_STATUS_LABELS, faceExceptionDecideSchema, firstOfMonth, formatMinutes, isoDate, istDate, lastOfMonth, monthDates, overrideCreateSchema, overridePreviewSchema, siteChangeReviewSchema, yearMonth, ymOf } from '@ajpwer/shared';
import { assignWorkDate, overrideDiffers, pickPolicy } from '../calculations/index.js';
import { audit, who } from '../utils/audit.js';
import { fromDbDate, toDbDate } from '../utils/dbDates.js';
import { AppError, notFound } from '../utils/errors.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { filterOne, filterValues, keysetOrder, keysetWhere, page, parseList, toCSV } from '../utils/list.js';
import { prisma } from '../config/db.js';
import { attendanceFrozen, computeMonths, effectiveTravel } from '../services/attendance.service.js';
import { computePayslip, loadRecoveries } from '../services/payslip.service.js';
import { payContext } from '../services/payroll.service.js';
import { dayRegister } from '../services/register.service.js';
import { inView, liveFigures, minutesNow, summarize, VIEWS } from '../services/dayview.service.js';
import { monthRows } from '../services/monthgrid.service.js';

const today = () => istDate(new Date());

// ─── Register: one day, everyone ─────────────────────────────────────────────
export const getRegister = asyncHandler(async (req, res) => {
  const date = isoDate.parse(req.query.date ?? today());
  const p = parseList(
    req,
    [
      { key: 'name', field: 'name', type: 'string' },
      { key: 'worked', field: 'worked', type: 'number' },
      { key: 'late', field: 'late', type: 'number' },
      { key: 'early', field: 'early', type: 'number' },
      { key: 'ot', field: 'ot', type: 'number' },
      { key: 'in', field: 'in', type: 'number' },
    ],
    'name',
  );
  const isToday = date === today();
  const nowMin = isToday ? minutesNow(date) : 0;
  let rows = (await dayRegister(prisma, date, undefined, today())).map((r) => ({ ...r, live: liveFigures(r, nowMin) }));
  const counts = {};
  for (const r of rows) counts[r.day.status] = (counts[r.day.status] ?? 0) + 1;

  // Filters are applied on the server, never in the browser. Scope first (department,
  // pay group, site), then the counts the filter chips show, then the rest.
  const dept = filterValues(p.filter, 'dept');
  if (dept.length) rows = rows.filter((r) => dept.includes(r.employee.department.id));
  const pg = filterValues(p.filter, 'pay_group');
  if (pg.length) rows = rows.filter((r) => pg.includes(r.employee.pay_group_id));
  const site = filterValues(p.filter, 'site');
  // Absence and leave belong to no site; with a site picked they are still counted company-wide, as on Today.
  const siteRows = site.length ? rows.filter((r) => r.day.sites.some((s) => site.includes(s))) : rows;
  const summary = summarize(siteRows, nowMin);
  if (site.length) {
    const all = summarize(rows, nowMin);
    summary.absent = all.absent;
    summary.leave = all.leave;
  }
  const view = filterOne(p.filter, 'view');
  if (view && !VIEWS.includes(view)) throw new AppError('VALIDATION', `Unknown view "${view}". Use one of: ${VIEWS.join(', ')}.`, 422, 'filter[view]');
  if (site.length && !(view === 'absent' || view === 'leave')) rows = siteRows;
  if (view) rows = rows.filter((r) => inView(view, r, r.live));
  const q = p.q?.toLowerCase();
  if (q) rows = rows.filter((r) => r.employee.name.toLowerCase().includes(q) || r.employee.code.toLowerCase().includes(q));
  const status = filterValues(p.filter, 'status');
  if (status.length) rows = rows.filter((r) => status.includes(r.day.status));
  if (filterOne(p.filter, 'corrected') === 'yes') rows = rows.filter((r) => r.override);
  if (filterOne(p.filter, 'late') === 'yes') rows = rows.filter((r) => r.day.late_min > 0);
  if (filterOne(p.filter, 'early') === 'yes') rows = rows.filter((r) => r.day.early_min > 0);
  if (filterOne(p.filter, 'ot') === 'yes') rows = rows.filter((r) => r.day.ot_min > 0);

  const key = (r) =>
    p.sort.key === 'name'
      ? r.employee.name.toLowerCase()
      : p.sort.key === 'worked'
        ? r.live.worked_min
        : p.sort.key === 'late'
          ? r.day.late_min
          : p.sort.key === 'early'
            ? r.day.early_min
            : p.sort.key === 'ot'
              ? r.live.ot_min
              : (r.in_min ?? 99999);
  rows.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    const c = ka < kb ? -1 : ka > kb ? 1 : a.employee.id.localeCompare(b.employee.id);
    return p.dir === 'desc' ? -c : c;
  });

  if (req.query.format === 'csv') {
    const sites = await prisma.site.findMany({ select: { id: true, code: true } });
    const code = (id) => sites.find((s) => s.id === id)?.code ?? id;
    const csv = toCSV(
      rows.map((r) => ({
        code: r.employee.code,
        name: r.employee.name,
        department: r.employee.department.name,
        status: DAY_STATUS_LABELS[r.day.status],
        in: r.in_min === null ? '' : `${String(Math.floor(r.in_min / 60)).padStart(2, '0')}:${String(r.in_min % 60).padStart(2, '0')}`,
        out: r.out_min === null ? '' : `${String(Math.floor(r.out_min / 60) % 24).padStart(2, '0')}:${String(r.out_min % 60).padStart(2, '0')}`,
        worked: formatMinutes(r.day.worked_min),
        late: r.day.late_min,
        early: r.day.early_min,
        ot: r.day.ot_min,
        sites: r.day.sites.map(code).join(' + '),
        corrected: r.override ? 'yes' : '',
      })),
      [
        { key: 'code', label: 'Employee code' },
        { key: 'name', label: 'Name' },
        { key: 'department', label: 'Department' },
        { key: 'status', label: 'Status' },
        { key: 'in', label: 'In' },
        { key: 'out', label: 'Out' },
        { key: 'worked', label: 'Worked' },
        { key: 'late', label: 'Late (min)' },
        { key: 'early', label: 'Left early (min)' },
        { key: 'ot', label: 'Overtime (min)' },
        { key: 'sites', label: 'Sites' },
        { key: 'corrected', label: 'Corrected' },
      ],
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="attendance-${date}.csv"`);
    return res.send(csv);
  }

  // Numbered pages (?page=3) or keyset over the computed, sorted rows.
  let start = 0;
  const pageNo = Number(req.query.page);
  if (Number.isInteger(pageNo) && pageNo > 1) start = Math.min((pageNo - 1) * p.limit, Math.max(0, Math.ceil(rows.length / p.limit) - 1) * p.limit);
  else if (p.cursor) {
    const idx = rows.findIndex((r) => r.employee.id === p.cursor.id);
    start = idx >= 0 ? idx + 1 : 0;
  }
  const slice = rows.slice(start, start + p.limit);
  const hasMore = start + p.limit < rows.length;
  const last = slice[slice.length - 1];
  const frozen = await attendanceFrozen(prisma, ymOf(date));
  res.json({
    data: slice,
    meta: {
      total: rows.length,
      nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ v: null, id: last.employee.id })).toString('base64url') : null,
      counts,
      summary,
      page: Math.floor(start / p.limit) + 1,
      pages: Math.max(1, Math.ceil(rows.length / p.limit)),
      limit: p.limit,
      is_today: isToday,
      now_min: isToday ? nowMin : null,
      date,
      frozen,
    },
  });
});

/**
 * The monthly register: everyone employed in the month, a cell per day and the month's
 * figures so far (paid days, loss of pay, late days, overtime). Filtering, search and
 * pages are done on the screen — a month for ~200 people is one small response.
 */
export const getMonthRegister = asyncHandler(async (req, res) => {
  const now = istDate(new Date());
  const ym = yearMonth.parse(req.query.ym ?? ymOf(now));
  const employees = await prisma.employee.findMany({
    where: {
      deleted_at: null,
      status: { in: ['ACTIVE', 'NOTICE', 'EXITED'] },
      joined_on: { lte: toDbDate(lastOfMonth(ym)) },
      OR: [{ last_day: null }, { last_day: { gte: toDbDate(firstOfMonth(ym)) } }],
    },
    select: { id: true, code: true, name: true, joined_on: true, last_day: true, pay_group_id: true, department: { select: { id: true, name: true, colour: true } } },
    orderBy: { name: 'asc' },
  });
  const months = await computeMonths(prisma, employees, ym);
  const frozen = await attendanceFrozen(prisma, ym);
  res.json({ data: { ym, today: now, dates: monthDates(ym), frozen, rows: monthRows(employees, months, ym, now) } });
});

/** Everything the correction drawer needs for one person-day: the punches, what they make the day, and the rules it is judged by. */
export const getDay = asyncHandler(async (req, res) => {
  const q = z.object({ employee_id: z.string().uuid(), date: isoDate }).parse(req.query);
  const [row] = await dayRegister(prisma, q.date, [q.employee_id]);
  const punches = await prisma.punch.findMany({
    where: { employee_id: q.employee_id, work_date: toDbDate(q.date) },
    include: { site: { select: { id: true, code: true, name: true } } },
    orderBy: { punched_at: 'asc' },
  });
  const override = await prisma.attendanceOverride.findUnique({ where: { employee_id_work_date: { employee_id: q.employee_id, work_date: toDbDate(q.date) } } });
  const frozen = await attendanceFrozen(prisma, ymOf(q.date));
  const employee = await prisma.employee.findUnique({ where: { id: q.employee_id }, select: { id: true, code: true, name: true, department: { select: { id: true, name: true, colour: true } } } });
  res.json({
    data: {
      employee,
      date: q.date,
      punches: punches.map((p) => ({ ...p, match_score: p.match_score === null ? null : Number(p.match_score), work_date: fromDbDate(p.work_date) })),
      computed: row
        ? {
            ...row.computed,
            flags: row.day.flags.filter((f) => f !== 'OVERRIDDEN'),
            sites: row.day.sites,
            pairs: row.day.pairs.length,
            break_min: row.day.break_min,
            first_punch_min: row.day.first_punch_min,
            last_punch_min: row.day.last_punch_min,
          }
        : null,
      not_in_employment: !row,
      override: override && !override.deleted_at ? { ...override, day_value: Number(override.day_value), work_date: fromDbDate(override.work_date) } : null,
      // The day's times as they stand: HR's once corrected by times, otherwise the first IN and last OUT.
      in_min: row?.in_min ?? null,
      out_min: row?.out_min ?? null,
      context: row?.context ?? null,
      frozen,
    },
  });
});

async function assertNotFrozen(date) {
  const f = await attendanceFrozen(prisma, ymOf(date));
  if (f.frozen) throw new AppError('ATTENDANCE_FROZEN', f.reason, 409);
}

/**
 * A day worked out from HR's times, by the same rules as punches. Given the out time, the
 * overtime follows. Given the overtime instead, the out time follows: the end of the day
 * (the shift end, or a full day after a late arrival) plus the overtime.
 */
async function dayFromTimes(db, employeeId, date, t) {
  let out = t.out_min;
  if (out === undefined) {
    // The end of the day depends only on the in time.
    const [probe] = await dayRegister(db, date, [employeeId], undefined, { times: { in_min: t.in_min, out_min: t.in_min + 1 } });
    if (!probe) throw new AppError('VALIDATION', 'This person was not employed on that date.', 422);
    if (probe.computed.due_out_min === null) throw new AppError('VALIDATION', 'There is no overtime on an off day: enter the out time instead.', 422, 'ot_min');
    out = probe.computed.due_out_min + (t.ot_min ?? 0);
  }
  if (out <= t.in_min) throw new AppError('VALIDATION', 'The out time must be after the in time.', 422, 'out_min');
  const [row] = await dayRegister(db, date, [employeeId], undefined, { times: { in_min: t.in_min, out_min: out } });
  if (!row) throw new AppError('VALIDATION', 'This person was not employed on that date.', 422);
  // Off days are paid as their policy says, worked or not; the hours worked are paid by the off-day work policy.
  const c = row.context.kind === 'WORKING' ? row.computed : { ...row.computed, day_value: row.context.off_day_paid ? 1 : 0, ot_min: 0 };
  return { row, values: { status: c.status, day_value: c.day_value, worked_min: c.worked_min, ot_min: c.ot_min, late_min: c.late_min }, early_min: c.early_min, due_out_min: c.due_out_min, in_min: t.in_min, out_min: out };
}

/**
 * A day HR marks instead of giving times. On a working day: a full day (with any overtime
 * entered directly), a half day, or absent. On an off day the mark says whether it was
 * worked; the off day itself is paid as its policy says.
 */
function markedDay(row, status, otMin) {
  const c = row.context;
  const full = c.standard_min;
  const worked = status === 'PRESENT' ? full : status === 'HALF_DAY' ? Math.round(full / 2) : 0;
  if (c.kind !== 'WORKING') {
    const offStatus = c.kind === 'HOLIDAY' ? (worked ? 'HOLIDAY_WORKED' : 'HOLIDAY') : worked ? 'OFF_WORKED' : 'WEEKLY_OFF';
    return { status: offStatus, day_value: c.off_day_paid ? 1 : 0, worked_min: worked, ot_min: 0, late_min: 0 };
  }
  return { status, day_value: status === 'PRESENT' ? 1 : status === 'HALF_DAY' ? 0.5 : 0, worked_min: worked, ot_min: status === 'PRESENT' ? otMin : 0, late_min: 0 };
}

async function writeOverride(tx, b, actor, ip) {
  const [row] = await dayRegister(tx, b.work_date, [b.employee_id]);
  if (!row) throw new AppError('VALIDATION', 'This person was not employed on that date.', 422);
  let proposed;
  let times = { in_min: null, out_min: null };
  if (b.mode === 'TIMES') {
    const r = await dayFromTimes(tx, b.employee_id, b.work_date, { in_min: b.in_min, out_min: b.out_min });
    proposed = r.values;
    times = { in_min: r.in_min, out_min: r.out_min };
  } else {
    if (b.ot_min > 0 && (b.status !== 'PRESENT' || row.context.kind !== 'WORKING')) throw new AppError('VALIDATION', 'Overtime goes with a full working day.', 422, 'ot_min');
    proposed = markedDay(row, b.status, b.ot_min);
  }
  // Compare against the day as it stands: a correction that changes nothing is noise in the audit trail.
  const current = row.override ? { status: row.day.status, day_value: row.day.day_value, worked_min: row.day.worked_min, ot_min: row.day.ot_min, late_min: row.day.late_min } : row.computed;
  const currentTimes = row.override ? { in_min: row.override.in_min, out_min: row.override.out_min } : { in_min: row.in_min, out_min: row.out_min };
  const timesChanged = b.mode === 'TIMES' && (currentTimes.in_min !== times.in_min || currentTimes.out_min !== times.out_min);
  if (!overrideDiffers(current, proposed) && !timesChanged) {
    throw new AppError('NO_CHANGE', 'Nothing differs from the day as it stands, so there is nothing to correct.', 422);
  }
  const data = {
    ...proposed,
    ...times,
    reason_code: 'OTHER',
    reason_text: b.reason_text.trim(),
    created_by: actor,
    computed_snapshot: JSON.parse(JSON.stringify({ ...row.computed, flags: row.day.flags, sites: row.day.sites, first_punch_min: row.day.first_punch_min, last_punch_min: row.day.last_punch_min })),
    deleted_at: null,
  };
  const o = await tx.attendanceOverride.upsert({
    where: { employee_id_work_date: { employee_id: b.employee_id, work_date: toDbDate(b.work_date) } },
    update: data,
    create: { employee_id: b.employee_id, work_date: toDbDate(b.work_date), ...data },
  });
  await audit(tx, {
    actor,
    ip,
    action: 'attendance.override',
    entity_type: 'attendance_override',
    entity_id: o.id,
    detail: { employee_id: b.employee_id, work_date: b.work_date, mode: b.mode, computed: row.computed, overridden: proposed, ...times, reason_text: b.reason_text },
  });
  return o;
}

export const createOverride = asyncHandler(async (req, res) => {
  const b = overrideCreateSchema.parse(req.body);
  await assertNotFrozen(b.work_date);
  const { actor, ip } = who(req);
  const o = await prisma.$transaction((tx) => writeOverride(tx, b, actor, ip));
  res.status(201).json({ data: { ...o, day_value: Number(o.day_value), work_date: fromDbDate(o.work_date) } });
});

/** What a day becomes with HR's times, before it is saved. */
export const previewOverride = asyncHandler(async (req, res) => {
  const b = overridePreviewSchema.parse(req.body);
  const r = await dayFromTimes(prisma, b.employee_id, b.work_date, b);
  res.json({ data: { ...r.values, early_min: r.early_min, due_out_min: r.due_out_min, in_min: r.in_min, out_min: r.out_min, kind: r.row.context.kind } });
});

/** The same mark with one reason, applied to many days. */
export const createBulkOverrides = asyncHandler(async (req, res) => {
  const b = bulkOverrideSchema.parse(req.body);
  for (const ym of new Set(b.items.map((i) => ymOf(i.work_date)))) await assertNotFrozen(`${ym}-01`);
  const { actor, ip } = who(req);
  const results = await prisma.$transaction(
    async (tx) => {
      const out = [];
      for (const it of b.items) {
        try {
          await writeOverride(tx, { mode: 'MARK', employee_id: it.employee_id, work_date: it.work_date, status: b.status, ot_min: b.ot_min, reason_text: b.reason_text }, actor, ip);
          out.push({ ...it, ok: true });
        } catch (err) {
          out.push({ ...it, ok: false, message: err instanceof Error ? err.message : 'failed' });
        }
      }
      return out;
    },
    { timeout: 120_000 },
  );
  res.json({ data: { applied: results.filter((r) => r.ok).length, results } });
});

/** Revert: removes the override entirely, restoring the computed values. */
export const revertOverride = asyncHandler(async (req, res) => {
  const o = await prisma.attendanceOverride.findUnique({ where: { id: req.params.id } });
  if (!o || o.deleted_at) throw notFound('That correction');
  await assertNotFrozen(fromDbDate(o.work_date));
  const { actor, ip } = who(req);
  await prisma.$transaction(async (tx) => {
    await tx.attendanceOverride.delete({ where: { id: o.id } });
    await audit(tx, {
      actor,
      ip,
      action: 'attendance.override.revert',
      entity_type: 'attendance_override',
      entity_id: o.id,
      detail: {
        employee_id: o.employee_id,
        work_date: fromDbDate(o.work_date),
        removed: { status: o.status, day_value: Number(o.day_value), worked_min: o.worked_min, ot_min: o.ot_min, late_min: o.late_min, in_min: o.in_min, out_min: o.out_min },
        restored: o.computed_snapshot,
      },
    });
  });
  res.json({ data: { reverted: true } });
});

// ─── Manual punch (admin, e.g. device down) ──────────────────────────────────
export const createManualPunch = asyncHandler(async (req, res) => {
  const b = z
    .object({ employee_id: z.string().uuid(), site_id: z.string().uuid(), direction: z.enum(['IN', 'OUT']), punched_at: z.string().datetime({ offset: true }), reason: z.string().min(8) })
    .strict()
    .parse(req.body);
  const at = new Date(b.punched_at);
  await assertNotFrozen(istDate(at));
  const last = await prisma.punch.findFirst({ where: { employee_id: b.employee_id, punched_at: { lt: at } }, orderBy: { punched_at: 'desc' } });
  const work_date = assignWorkDate(at, b.direction, last ? { direction: last.direction, work_date: fromDbDate(last.work_date), at: last.punched_at.getTime() } : null);
  const { actor, ip } = who(req);
  const p = await prisma.$transaction(async (tx) => {
    const created = await tx.punch.create({
      data: {
        employee_id: b.employee_id,
        site_id: b.site_id,
        direction: b.direction,
        punched_at: at,
        client_punched_at: at,
        work_date: toDbDate(work_date),
        method: 'MANUAL',
        device_id: `admin:${actor}`,
        flagged: true,
        flag_reason: b.reason,
      },
    });
    await audit(tx, { actor, ip, action: 'punch.manual', entity_type: 'punch', entity_id: created.id, detail: { employee_id: b.employee_id, work_date, direction: b.direction, reason: b.reason } });
    return created;
  });
  res.status(201).json({ data: p });
});

// ─── Punch log ───────────────────────────────────────────────────────────────

const PUNCH_SORTS = [{ key: 'time', field: 'punched_at', type: 'date' }];

export const listPunches = asyncHandler(async (req, res) => {
  const p = parseList(req, PUNCH_SORTS, '-time');
  const and = [];
  const from = filterOne(p.filter, 'from');
  const to = filterOne(p.filter, 'to');
  if (from) and.push({ work_date: { gte: toDbDate(from) } });
  if (to) and.push({ work_date: { lte: toDbDate(to) } });
  const site = filterValues(p.filter, 'site');
  if (site.length) and.push({ site_id: { in: site } });
  const emp = filterValues(p.filter, 'employee');
  if (emp.length) and.push({ employee_id: { in: emp } });
  const method = filterValues(p.filter, 'method');
  if (method.length) and.push({ method: { in: method } });
  if (filterOne(p.filter, 'flagged') === 'yes') and.push({ flagged: true });
  if (p.q) and.push({ employee: { OR: [{ name: { contains: p.q, mode: 'insensitive' } }, { code: { contains: p.q, mode: 'insensitive' } }] } });
  const where = { AND: and };
  const [rows, total] = await Promise.all([
    prisma.punch.findMany({
      where: { AND: [where, keysetWhere(p) ?? {}] },
      orderBy: keysetOrder(p),
      take: p.limit + 1,
      include: { employee: { select: { id: true, code: true, name: true } }, site: { select: { id: true, code: true, name: true } } },
    }),
    prisma.punch.count({ where }),
  ]);
  res.json(page(rows, p, total, (r) => ({ ...r, work_date: fromDbDate(r.work_date), match_score: r.match_score === null ? null : Number(r.match_score) })));
});

// ─── Overtime ────────────────────────────────────────────────────────────────
export const listOvertime = asyncHandler(async (req, res) => {
  const month = yearMonth.parse(req.query.month ?? ymOf(today()));
  const employees = await prisma.employee.findMany({
    where: {
      deleted_at: null,
      status: { in: ['ACTIVE', 'NOTICE', 'EXITED'] },
      joined_on: { lte: toDbDate(`${month}-28`) },
      OR: [{ last_day: null }, { last_day: { gte: toDbDate(`${month}-01`) } }],
    },
    include: { statutory: true, department: { select: { id: true, name: true } } },
  });
  const months = await computeMonths(prisma, employees, month);
  const withOt = employees.filter((e) => (months.get(e.id)?.result.totals.ot_min ?? 0) > 0 || (months.get(e.id)?.result.offday_work.length ?? 0) > 0);
  const ctx = await payContext(prisma, month);
  const rec = await loadRecoveries(
    prisma,
    withOt.map((e) => e.id),
    month,
  );
  const rows = [];
  for (const e of withOt) {
    const m = months.get(e.id);
    try {
      const ps = await computePayslip(prisma, e, month, m, ctx, rec.get(e.id) ?? null);
      const pol = pickPolicy(m.rules.policies, 'OVERTIME', `${month}-28`);
      const r = pol?.rules;
      rows.push({
        employee: { id: e.id, code: e.code, name: e.name, department: e.department },
        ot_min: m.result.totals.ot_min,
        paid_min: ps.result.ot?.paid_min ?? 0,
        excess_min: ps.result.ot?.excess_min ?? 0,
        hourly: ps.result.ot?.hourly ?? 0,
        multiplier: r?.multiplier ?? null,
        base: r?.base ?? null,
        policy: pol ? { name: pol.name, version: pol.version } : null,
        amount: ps.result.ot?.amount ?? 0,
        offday_days: m.result.offday_work.length,
        offday_amount: ps.result.lines.filter((l) => l.kind === 'OFFDAY').reduce((s, l) => s + l.amount, 0),
        over_cap: (ps.result.ot?.excess_min ?? 0) > 0,
      });
    } catch {
      // someone without a salary or statutory row: surfaced in payroll issues instead
    }
  }
  rows.sort((a, b) => b.amount + b.offday_amount - (a.amount + a.offday_amount));
  res.json({ data: rows, meta: { total: rows.length, nextCursor: null, month } });
});

// ─── Face exceptions (Approvals) ─────────────────────────────────────────────
export const listFaceExceptions = asyncHandler(async (req, res) => {
  const status = req.query.status || 'PENDING';
  const rows = await prisma.faceException.findMany({
    where: { status: status, deleted_at: null },
    include: { site: { select: { id: true, code: true, name: true } } },
    orderBy: { occurred_at: 'asc' },
    take: 200,
  });
  const ids = [...new Set(rows.flatMap((r) => [r.best_match_id, r.claimed_employee_id, r.decided_employee_id]).filter(Boolean))];
  const people = await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true, designation: true } });
  const person = (id) => (id ? (people.find((p) => p.id === id) ?? null) : null);
  res.json({
    data: rows.map((r) => ({
      ...r,
      score: r.score === null ? null : Number(r.score),
      best_match: person(r.best_match_id),
      claimed: person(r.claimed_employee_id),
      decided_employee: person(r.decided_employee_id),
      has_snapshot: !!r.snapshot_key,
      snapshot_key: undefined,
      crop_keys: undefined,
      crops: r.crop_keys?.length ?? 0,
    })),
    meta: { total: rows.length, nextCursor: null },
  });
});

/**
 * Approving writes the punch at the time of the attempt, not the time of the
 * decision — someone at the gate at 08:04 reviewed at 16:30 gets an 08:04 punch.
 */
export const decideFaceException = asyncHandler(async (req, res) => {
  const b = faceExceptionDecideSchema.parse(req.body);
  const fx = await prisma.faceException.findUnique({ where: { id: req.params.id } });
  if (!fx) throw notFound('That exception');
  if (fx.status !== 'PENDING') throw new AppError('CONFLICT', 'This exception has already been decided.', 409);
  const { actor, ip } = who(req);
  const result = await prisma.$transaction(async (tx) => {
    let punchId = null;
    if (b.decision === 'APPROVE') {
      const at = fx.occurred_at;
      const last = await tx.punch.findFirst({ where: { employee_id: b.employee_id, punched_at: { lt: at } }, orderBy: { punched_at: 'desc' } });
      const direction = b.direction ?? fx.direction ?? (!last || last.direction === 'OUT' ? 'IN' : 'OUT');
      const work_date = assignWorkDate(at, direction, last ? { direction: last.direction, work_date: fromDbDate(last.work_date), at: last.punched_at.getTime() } : null);
      const frozen = await attendanceFrozen(tx, ymOf(work_date));
      if (frozen.frozen) throw new AppError('ATTENDANCE_FROZEN', frozen.reason, 409);
      const p = await tx.punch.create({
        data: {
          employee_id: b.employee_id,
          site_id: fx.site_id,
          direction,
          punched_at: at,
          client_punched_at: at,
          work_date: toDbDate(work_date),
          method: 'EXCEPTION',
          match_score: fx.score,
          distance_m: fx.distance_m,
          device_id: `exception:${fx.id}`,
          source_ref: fx.id,
        },
      });
      punchId = p.id;
    }
    const updated = await tx.faceException.update({
      where: { id: fx.id },
      data: {
        status: b.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
        decided_by: actor,
        decided_at: new Date(),
        decision_reason: b.reason ?? null,
        decided_employee_id: b.employee_id ?? null,
        punch_id: punchId,
      },
    });
    await audit(tx, {
      actor,
      ip,
      action: `face_exception.${b.decision.toLowerCase()}`,
      entity_type: 'face_exception',
      entity_id: fx.id,
      detail: { employee_id: b.employee_id, reason: b.reason, punch_id: punchId, occurred_at: fx.occurred_at },
    });
    return updated;
  });
  res.json({ data: result });
});

// ─── Site changes (travel between sites, from the tablet's "Change site") ───────

/**
 * Every change of site, newest first; unreviewed ones are what HR is notified of.
 * Travel counts only when the person punched in at the named site the same day,
 * unless HR sets a figure — HR's figure is final either way.
 */
export const listSiteChanges = asyncHandler(async (req, res) => {
  const reviewed = req.query.reviewed;
  const where = { ...(reviewed === 'false' ? { reviewed_at: null, status: { not: 'PENDING' } } : {}), ...(reviewed === 'true' ? { reviewed_at: { not: null } } : {}) };
  const since = toDbDate(addDays(today(), -60));
  const rows = await prisma.siteChange.findMany({ where: { ...where, work_date: { gte: since } }, orderBy: { left_at: 'desc' }, take: 300 });
  const [people, sites] = await Promise.all([
    prisma.employee.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.employee_id))] } }, select: { id: true, code: true, name: true } }),
    prisma.site.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.from_site_id, r.to_site_id]))] } }, select: { id: true, name: true } }),
  ]);
  const site = (id) => sites.find((x) => x.id === id) ?? null;
  res.json({
    data: rows.map((r) => ({
      ...r,
      work_date: fromDbDate(r.work_date),
      employee: people.find((p) => p.id === r.employee_id) ?? null,
      from_site: site(r.from_site_id),
      to_site: site(r.to_site_id),
      effective_travel_min: effectiveTravel(r),
    })),
    meta: { unreviewed: await prisma.siteChange.count({ where: { reviewed_at: null, status: { not: 'PENDING' } } }) },
  });
});

/** HR sets (or confirms) the travel minutes for a site change. Refused once the month is frozen for payroll. */
export const reviewSiteChange = asyncHandler(async (req, res) => {
  const b = siteChangeReviewSchema.parse(req.body);
  const c = await prisma.siteChange.findUnique({ where: { id: req.params.id } });
  if (!c) throw notFound('That site change');
  const frozen = await attendanceFrozen(prisma, ymOf(fromDbDate(c.work_date)));
  if (frozen.frozen) throw new AppError('ATTENDANCE_FROZEN', frozen.reason, 409);
  const { actor, ip } = who(req);
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.siteChange.update({ where: { id: c.id }, data: { hr_travel_min: b.travel_min, reviewed_by: actor, reviewed_at: new Date(), review_reason: b.reason } });
    await audit(tx, { actor, ip, action: 'site_change.review', entity_type: 'site_change', entity_id: c.id, detail: { travel_min: { from: effectiveTravel(c), to: b.travel_min }, reason: b.reason } });
    return u;
  });
  res.json({ data: { ...updated, work_date: fromDbDate(updated.work_date), effective_travel_min: effectiveTravel(updated) } });
});

// ─── Punch attempts (tuning the face thresholds from real punches) ──────────

/** Every analysed upload in a date range as CSV — scores, live score, head turn, outcome. No images, no embeddings. */
export const exportPunchAttempts = asyncHandler(async (req, res) => {
  const from = isoDate.parse(req.query.from ?? addDays(today(), -13));
  const to = isoDate.parse(req.query.to ?? today());
  const rows = await prisma.punchAttempt.findMany({
    where: { created_at: { gte: new Date(`${from}T00:00:00+05:30`), lt: new Date(`${addDays(to, 1)}T00:00:00+05:30`) } },
    orderBy: { created_at: 'asc' },
    take: 200_000,
  });
  const [people, sites] = await Promise.all([
    prisma.employee.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.employee_id).filter(Boolean))] } }, select: { id: true, code: true } }),
    prisma.site.findMany({ select: { id: true, code: true } }),
  ]);
  const num = (v) => (v === null || v === undefined ? '' : Number(v));
  const data = rows.map((r) => ({
    at: r.created_at.toISOString(),
    site: sites.find((x) => x.id === r.site_id)?.code ?? r.site_id,
    session: r.session_id,
    request: r.request_id,
    purpose: r.purpose,
    outcome: r.outcome,
    resolution: r.resolution ?? '',
    counts_as_try: r.counts_as_try ? 'yes' : 'no',
    tries_after: r.tries_after,
    employee: people.find((p) => p.id === r.employee_id)?.code ?? '',
    score: num(r.score),
    second_score: num(r.second_score),
    margin: r.score !== null && r.second_score !== null ? (Number(r.score) - Number(r.second_score)).toFixed(4) : '',
    live_score: num(r.live_score),
    challenge: r.challenge ?? '',
    yaw_front: num(r.yaw_front),
    yaw_turn: num(r.yaw_turn),
    brightness: r.quality?.front?.brightness ?? '',
    sharpness: r.quality?.front?.sharpness ?? '',
    face_px: r.quality?.front?.face_px ?? '',
    service_ms: r.service_ms ?? '',
  }));
  const csv = toCSV(
    data,
    Object.keys(data[0] ?? { at: 0 }).map((k) => ({ key: k, label: k })),
  );
  await audit(prisma, { ...who(req), action: 'export.punch_attempts', entity_type: 'punch_attempt', detail: { from, to, rows: data.length } });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="punch-attempts-${from}-to-${to}.csv"`);
  res.send(csv);
});
