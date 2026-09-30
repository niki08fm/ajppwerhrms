import { z } from 'zod';
import { istDate, leaveCreateSchema, leaveDecideSchema, ymOf } from '@ajpwer/shared';
import { pickPolicy } from '../calculations/index.js';
import { audit, who } from '../utils/audit.js';
import { fromDbDate, toDbDate } from '../utils/dbDates.js';
import { AppError, notFound } from '../utils/errors.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { filterOne, filterValues, keysetOrder, keysetWhere, page, parseList } from '../utils/list.js';
import { prisma } from '../config/db.js';
import { attendanceFrozen } from '../services/attendance.service.js';
import { leaveBalances } from '../services/leave.service.js';
import { payGroupRules } from '../services/rules.service.js';

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
  const [rows, total] = await Promise.all([
    prisma.leaveRequest.findMany({
      where: { AND: [where, keysetWhere(p) ?? {}] },
      orderBy: keysetOrder(p),
      take: p.limit + 1,
      include: { employee: { select: { id: true, code: true, name: true, department: { select: { name: true } } } } },
    }),
    prisma.leaveRequest.count({ where }),
  ]);
  res.json(page(rows, p, total, (r) => ({ ...r, days: Number(r.days), from_date: fromDbDate(r.from_date), to_date: fromDbDate(r.to_date) })));
});

export const createLeave = asyncHandler(async (req, res) => {
  const b = leaveCreateSchema.parse(req.body);
  const e = await prisma.employee.findFirst({ where: { id: b.employee_id, deleted_at: null } });
  if (!e) throw notFound('That person');
  const rules = await payGroupRules(prisma, e.pay_group_id);
  const pol = pickPolicy(rules.policies, 'LEAVE', b.from_date);
  const types = pol?.rules?.types ?? [];
  if (!types.some((t) => t.code === b.leave_type)) {
    throw new AppError('NO_POLICY_ATTACHED', `${b.leave_type} is not a leave type in ${rules.name}'s leave policy on ${b.from_date}.`, 422, 'leave_type');
  }
  const overlap = await prisma.leaveRequest.findFirst({
    where: { employee_id: b.employee_id, deleted_at: null, status: { in: ['PENDING', 'APPROVED'] }, from_date: { lte: toDbDate(b.to_date) }, to_date: { gte: toDbDate(b.from_date) } },
  });
  if (overlap) throw new AppError('CONFLICT', `This overlaps a ${overlap.status.toLowerCase()} request from ${fromDbDate(overlap.from_date)} to ${fromDbDate(overlap.to_date)}.`, 409);
  const { actor, ip } = who(req);
  const r = await prisma.$transaction(async (tx) => {
    const created = await tx.leaveRequest.create({
      data: { employee_id: b.employee_id, leave_type: b.leave_type, from_date: toDbDate(b.from_date), to_date: toDbDate(b.to_date), days: b.days, reason: b.reason ?? null },
    });
    await audit(tx, { actor, ip, action: 'leave.request', entity_type: 'leave_request', entity_id: created.id, detail: { ...b } });
    return created;
  });
  res.status(201).json({ data: r });
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

/** Balances per type for everyone (or one department), derived from policy and requests. */
export const getBalances = asyncHandler(async (req, res) => {
  const asOf = req.query.date || istDate(new Date());
  const dept = req.query.dept;
  const q = req.query.q?.trim();
  const people = await prisma.employee.findMany({
    where: {
      deleted_at: null,
      status: { in: ['ACTIVE', 'NOTICE'] },
      ...(dept ? { department_id: dept } : {}),
      ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { code: { contains: q, mode: 'insensitive' } }] } : {}),
    },
    select: { id: true, code: true, name: true, joined_on: true, pay_group_id: true },
    orderBy: { name: 'asc' },
    take: 200,
  });
  const rows = [];
  for (const p of people) rows.push({ employee: { id: p.id, code: p.code, name: p.name }, balances: await leaveBalances(prisma, p, asOf) });
  res.json({ data: rows, meta: { total: rows.length, nextCursor: null } });
});
