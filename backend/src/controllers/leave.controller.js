import { z } from 'zod';
import { formatYearMonth, istDate, leaveAdjustmentSchema, leaveCreateSchema, leaveDecideSchema, uuid, ymOf } from '@ajpwer/shared';
import { hasBalance, pickPolicy } from '../calculations/index.js';
import { audit, who } from '../utils/audit.js';
import { fromDbDate, toDbDate } from '../utils/dbDates.js';
import { AppError, notFound } from '../utils/errors.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { filterOne, filterValues, keysetOrder, keysetWhere, page, parseList } from '../utils/list.js';
import { prisma } from '../config/db.js';
import { attendanceFrozen } from '../services/attendance.service.js';
import { leaveBalancesFor, leaveCheck, leaveTypesInUse } from '../services/leave.service.js';
import { payGroupRules } from '../services/rules.service.js';

const today = () => istDate(new Date());

async function mustLoadEmployee(id) {
  const e = await prisma.employee.findFirst({ where: { id, deleted_at: null } });
  if (!e) throw notFound('That person');
  return e;
}

const SORTS = [
  { key: 'from', field: 'from_date', type: 'date' },
  { key: 'created', field: 'created_at', type: 'date' },
];

export const listLeave = asyncHandler(async (req, res) => {
  const p = parseList(req, SORTS, '-from');
  const and = [{ deleted_at: null }];
  const type = filterValues(p.filter, 'type');
  if (type.length) and.push({ leave_type: { in: type } });
  const status = filterValues(p.filter, 'status');
  if (status.length) and.push({ status: { in: status } });
  const from = filterOne(p.filter, 'from');
  if (from) and.push({ to_date: { gte: toDbDate(from) } });
  const to = filterOne(p.filter, 'to');
  if (to) and.push({ from_date: { lte: toDbDate(to) } });
  const dept = filterValues(p.filter, 'dept');
  if (dept.length) and.push({ employee: { department_id: { in: dept } } });
  const emp = filterOne(p.filter, 'employee');
  if (emp) and.push({ employee_id: emp });
  if (p.q) and.push({ employee: { OR: [{ name: { contains: p.q, mode: 'insensitive' } }, { code: { contains: p.q, mode: 'insensitive' } }] } });
  const where = { AND: and };
  const [rows, total, types] = await Promise.all([
    prisma.leaveRequest.findMany({
      where: { AND: [where, keysetWhere(p) ?? {}] },
      orderBy: keysetOrder(p),
      take: p.limit + 1,
      include: { employee: { select: { id: true, code: true, name: true, department: { select: { name: true } } } } },
    }),
    prisma.leaveRequest.count({ where }),
    leaveTypesInUse(prisma, today()),
  ]);
  const nameOf = (code) => types.find((t) => t.code === code)?.name ?? code;
  res.json(page(rows, p, total, (r) => ({ ...r, leave_name: nameOf(r.leave_type), days: Number(r.days), from_date: fromDbDate(r.from_date), to_date: fromDbDate(r.to_date) })));
});

/** What recording this leave would do — checked before saving, so HR sees it first. */
export const previewLeave = asyncHandler(async (req, res) => {
  const b = leaveCreateSchema.parse(req.body);
  const e = await mustLoadEmployee(b.employee_id);
  const c = await leaveCheck(prisma, e, b);
  res.json({ data: { errors: c.errors, warnings: c.warnings, working_days: c.working_days, balance: c.balance, type: c.type ? { code: c.type.code, name: c.type.name, paid: c.type.paid } : null } });
});

export const createLeave = asyncHandler(async (req, res) => {
  const b = leaveCreateSchema.parse(req.body);
  const e = await mustLoadEmployee(b.employee_id);
  const c = await leaveCheck(prisma, e, b);
  if (c.errors.length) throw new AppError('VALIDATION', c.errors.join(' '), 422, 'leave_type');
  const overlap = await prisma.leaveRequest.findFirst({
    where: { employee_id: b.employee_id, deleted_at: null, status: { in: ['PENDING', 'APPROVED'] }, from_date: { lte: toDbDate(b.to_date) }, to_date: { gte: toDbDate(b.from_date) } },
  });
  if (overlap) throw new AppError('CONFLICT', `This overlaps a ${overlap.status.toLowerCase()} request from ${fromDbDate(overlap.from_date)} to ${fromDbDate(overlap.to_date)}.`, 409);
  const { actor, ip } = who(req);
  const r = await prisma.$transaction(async (tx) => {
    // The days are the working days the range covers (or half of a single day).
    const created = await tx.leaveRequest.create({
      data: { employee_id: b.employee_id, leave_type: b.leave_type, from_date: toDbDate(b.from_date), to_date: toDbDate(b.to_date), days: c.working_days, reason: b.reason ?? null },
    });
    await audit(tx, { actor, ip, action: 'leave.request', entity_type: 'leave_request', entity_id: created.id, detail: { ...b, days: c.working_days, warnings: c.warnings } });
    return created;
  });
  res.status(201).json({ data: { ...r, days: Number(r.days) }, warnings: c.warnings });
});

async function decide(id, decision, note, actor, ip) {
  const r = await prisma.leaveRequest.findUnique({ where: { id } });
  if (!r) throw notFound('That leave request');
  const frozen = await attendanceFrozen(prisma, ymOf(fromDbDate(r.from_date)));
  if (frozen.frozen && (decision === 'APPROVE' || r.status === 'APPROVED')) throw new AppError('ATTENDANCE_FROZEN', frozen.reason, 409);
  if (decision !== 'CANCEL' && r.status !== 'PENDING') throw new AppError('CONFLICT', `This request is already ${r.status.toLowerCase()}.`, 409);
  const status = decision === 'APPROVE' ? 'APPROVED' : decision === 'REJECT' ? 'REJECTED' : 'CANCELLED';
  return prisma.$transaction(async (tx) => {
    const u = await tx.leaveRequest.update({ where: { id }, data: { status, decided_by: actor, decided_at: new Date(), decision_note: note ?? null } });
    await audit(tx, { actor, ip, action: `leave.${status.toLowerCase()}`, entity_type: 'leave_request', entity_id: id, detail: { employee_id: r.employee_id, from: r.status, to: status, note } });
    return u;
  });
}

export const decideLeave = asyncHandler(async (req, res) => {
  const b = leaveDecideSchema.parse(req.body);
  const { actor, ip } = who(req);
  res.json({ data: await decide(req.params.id, b.decision, b.note, actor, ip) });
});

export const bulkDecideLeave = asyncHandler(async (req, res) => {
  const b = z
    .object({ ids: z.array(z.string().uuid()).min(1).max(500), decision: z.enum(['APPROVE', 'REJECT']), note: z.string().max(500).optional() })
    .strict()
    .parse(req.body);
  const { actor, ip } = who(req);
  const results = [];
  for (const id of b.ids) {
    try {
      await decide(id, b.decision, b.note, actor, ip);
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, message: err instanceof Error ? err.message : 'failed' });
    }
  }
  res.json({ data: { applied: results.filter((r) => r.ok).length, results } });
});

/**
 * Balances for everyone (or one department), worked out month by month from the leave
 * policy, recorded leave, attendance and HR's adjustments.
 */
export const getBalances = asyncHandler(async (req, res) => {
  const asOf = req.query.date || today();
  const dept = req.query.dept;
  const q = req.query.q?.trim();
  const people = await prisma.employee.findMany({
    where: {
      deleted_at: null,
      status: { in: ['ACTIVE', 'NOTICE'] },
      ...(dept ? { department_id: dept } : {}),
      ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { code: { contains: q, mode: 'insensitive' } }] } : {}),
    },
    select: { id: true, code: true, name: true, joined_on: true, last_day: true, pay_group_id: true },
    orderBy: { name: 'asc' },
    take: 200,
  });
  const balances = await leaveBalancesFor(prisma, people, asOf);
  const rows = people.map((p) => ({ employee: { id: p.id, code: p.code, name: p.name }, ...balances.get(p.id) }));
  res.json({ data: rows, meta: { total: rows.length, nextCursor: null, date: asOf } });
});

/** The leave types a person can be given now, with what is left of each; or every type in use. */
export const listLeaveTypes = asyncHandler(async (req, res) => {
  const id = req.query.employee_id;
  if (!id) return res.json({ data: await leaveTypesInUse(prisma, today()) });
  const e = await mustLoadEmployee(uuid.parse(id));
  const rules = await payGroupRules(prisma, e.pay_group_id);
  const pol = pickPolicy(rules.policies, 'LEAVE', today());
  const balances = (await leaveBalancesFor(prisma, [e], today())).get(e.id);
  const data = (pol?.rules?.types ?? [])
    .filter((t) => t.active && (t.gender === 'ALL' || t.gender === e.gender))
    .map((t) => ({ ...t, balance: hasBalance(t) ? (balances?.types.find((x) => x.code === t.code)?.balance ?? 0) : null }));
  res.json({ data, meta: { pay_group: rules.name, year_start_month: pol?.rules?.year_start_month ?? null } });
});

/** A month that is locked keeps its leave; an adjustment has to be dated in a later one. */
async function assertMonthOpen(date) {
  const p = await prisma.payrollPeriod.findUnique({ where: { period_ym: ymOf(date) } });
  if (p && (p.state === 'LOCKED' || p.state === 'PAID')) {
    throw new AppError('PERIOD_LOCKED', `${formatYearMonth(ymOf(date))} is ${p.state.toLowerCase()} and keeps its leave balances. Date the adjustment in a month that is still open.`, 409, 'date');
  }
}

export const listAdjustments = asyncHandler(async (req, res) => {
  const id = uuid.parse(req.query.employee_id);
  const rows = await prisma.leaveAdjustment.findMany({ where: { employee_id: id, deleted_at: null }, orderBy: [{ date: 'desc' }, { created_at: 'desc' }] });
  res.json({ data: rows.map((r) => ({ ...r, date: fromDbDate(r.date), days: Number(r.days) })) });
});

/** HR adds days to a balance or takes them away: an opening balance, or a correction. */
export const createAdjustment = asyncHandler(async (req, res) => {
  const b = leaveAdjustmentSchema.parse(req.body);
  const e = await mustLoadEmployee(b.employee_id);
  const rules = await payGroupRules(prisma, e.pay_group_id);
  const type = pickPolicy(rules.policies, 'LEAVE', b.date)?.rules?.types.find((t) => t.code === b.leave_type);
  if (!type || !hasBalance(type)) throw new AppError('VALIDATION', `${b.leave_type} has no balance in ${rules.name}'s leave policy on ${b.date}.`, 422, 'leave_type');
  await assertMonthOpen(b.date);
  const { actor, ip } = who(req);
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.leaveAdjustment.create({
      data: { employee_id: e.id, leave_type: b.leave_type, date: toDbDate(b.date), days: b.days, reason: b.reason.trim(), created_by: actor },
    });
    await audit(tx, { actor, ip, action: 'leave.adjust', entity_type: 'leave_adjustment', entity_id: created.id, detail: { ...b } });
    return created;
  });
  res.status(201).json({ data: { ...row, date: fromDbDate(row.date), days: Number(row.days) } });
});

export const deleteAdjustment = asyncHandler(async (req, res) => {
  const a = await prisma.leaveAdjustment.findFirst({ where: { id: req.params.id, deleted_at: null } });
  if (!a) throw notFound('That adjustment');
  await assertMonthOpen(fromDbDate(a.date));
  const { actor, ip } = who(req);
  await prisma.$transaction(async (tx) => {
    await tx.leaveAdjustment.update({ where: { id: a.id }, data: { deleted_at: new Date() } });
    await audit(tx, { actor, ip, action: 'leave.adjust.remove', entity_type: 'leave_adjustment', entity_id: a.id, detail: { employee_id: a.employee_id, leave_type: a.leave_type, date: fromDbDate(a.date), days: Number(a.days) } });
  });
  res.json({ data: { ok: true } });
});
