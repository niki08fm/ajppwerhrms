import { z } from 'zod';
import { advanceCreateSchema, divRound, loanCreateSchema } from '@ajpwer/shared';
import { audit, who } from '../utils/audit.js';
import { fromDbDate, n, toDbDate } from '../utils/dbDates.js';
import { AppError, notFound } from '../utils/errors.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { filterValues } from '../utils/list.js';
import { prisma } from '../config/db.js';
import { assertSettlementEditable } from '../services/exit.service.js';
import { computeSettlementFor, upsertSettlement } from '../services/settlement.service.js';

// ─── Advances and loans ─────────────────────────────────────────────────────
export const listAdvancesAndLoans = asyncHandler(async (req, res) => {
  const status = filterValues(req.query.filter ?? {}, 'status');
  const q = req.query.q?.trim();
  const empWhere = q ? { employee: { OR: [{ name: { contains: q, mode: 'insensitive' } }, { code: { contains: q, mode: 'insensitive' } }] } } : {};
  const st = status.length ? { status: { in: status } } : {};
  const [loans, advances, carries] = await Promise.all([
    prisma.loan.findMany({ where: { deleted_at: null, ...st, ...empWhere }, include: { employee: { select: { id: true, code: true, name: true } } }, orderBy: { started_on: 'desc' } }),
    prisma.advance.findMany({ where: { deleted_at: null, ...st, ...empWhere }, include: { employee: { select: { id: true, code: true, name: true } } }, orderBy: { granted_on: 'desc' } }),
    prisma.recoveryCarry.findMany({ where: { deleted_at: null, amount: { gt: 0 } }, include: { employee: { select: { id: true, code: true, name: true } } }, orderBy: { period_ym: 'desc' } }),
  ]);
  const rows = [
    ...loans.map((l) => {
      const outstanding = n(l.principal) - n(l.recovered);
      const left = n(l.emi) > 0 ? Math.ceil(outstanding / n(l.emi)) : 0;
      return {
        id: l.id,
        type: 'LOAN',
        employee: l.employee,
        label: l.loan_type,
        amount: n(l.principal),
        instalment: n(l.emi),
        recovered: n(l.recovered),
        outstanding,
        instalments_paid: l.instalments_paid,
        instalments_left: left,
        started_on: fromDbDate(l.started_on),
        status: l.status,
      };
    }),
    ...advances.map((a) => {
      const outstanding = n(a.amount) - n(a.recovered);
      return {
        id: a.id,
        type: 'ADVANCE',
        employee: a.employee,
        label: a.reason,
        amount: n(a.amount),
        instalment: n(a.instalment),
        recovered: n(a.recovered),
        outstanding,
        instalments_paid: null,
        instalments_left: n(a.instalment) > 0 ? Math.ceil(outstanding / n(a.instalment)) : 0,
        started_on: fromDbDate(a.granted_on),
        status: a.status,
      };
    }),
  ];
  res.json({
    data: {
      rows,
      carries: carries.map((c) => ({ id: c.id, employee: c.employee, period_ym: c.period_ym, amount: n(c.amount) })),
      totals: { outstanding: rows.filter((r) => r.status === 'ACTIVE').reduce((a, r) => a + r.outstanding, 0), active: rows.filter((r) => r.status === 'ACTIVE').length },
    },
    meta: { total: rows.length, nextCursor: null },
  });
});

export const createAdvance = asyncHandler(async (req, res) => {
  const b = advanceCreateSchema.parse(req.body);
  if (b.instalment > b.amount) throw new AppError('VALIDATION', 'The instalment cannot exceed the advance.', 422, 'instalment');
  const { actor, ip } = who(req);
  const a = await prisma.$transaction(async (tx) => {
    const created = await tx.advance.create({
      data: { employee_id: b.employee_id, amount: BigInt(b.amount), reason: b.reason, granted_on: toDbDate(b.granted_on), instalment: BigInt(b.instalment), created_by: actor },
    });
    await audit(tx, { actor, ip, action: 'advance.grant', entity_type: 'employee', entity_id: b.employee_id, detail: { advance_id: created.id, ...b } });
    return created;
  });
  res.status(201).json({ data: { id: a.id } });
});

export const createLoan = asyncHandler(async (req, res) => {
  const b = loanCreateSchema.parse(req.body);
  const emi = divRound(b.principal, b.months, 'up');
  const { actor, ip } = who(req);
  const l = await prisma.$transaction(async (tx) => {
    const created = await tx.loan.create({
      data: { employee_id: b.employee_id, loan_type: b.loan_type, principal: BigInt(b.principal), months: b.months, emi: BigInt(emi), started_on: toDbDate(b.started_on), created_by: actor },
    });
    await audit(tx, { actor, ip, action: 'loan.grant', entity_type: 'employee', entity_id: b.employee_id, detail: { loan_id: created.id, ...b, emi } });
    return created;
  });
  res.status(201).json({ data: { id: l.id, emi } });
});

// ─── Exits and settlement ───────────────────────────────────────────────────
export const listSettlements = asyncHandler(async (_req, res) => {
  const people = await prisma.employee.findMany({
    where: { deleted_at: null, OR: [{ status: 'NOTICE' }, { status: 'EXITED', settlements: { some: { state: { not: 'PAID' } } } }] },
    include: { department: { select: { name: true } }, settlements: { where: { deleted_at: null }, orderBy: { created_at: 'desc' }, take: 1, include: { period: { select: { period_ym: true } } } } },
    orderBy: { last_day: 'asc' },
  });
  const rows = [];
  for (const p of people) {
    let live = null;
    try {
      live = (await computeSettlementFor(prisma, p.id)).result;
    } catch (err) {
      live = { error: err instanceof Error ? err.message : 'Could not compute' };
    }
    const s = p.settlements[0];
    rows.push({
      employee: { id: p.id, code: p.code, name: p.name, department: p.department.name, status: p.status },
      resigned_on: fromDbDate(p.resigned_on),
      last_day: fromDbDate(p.last_day),
      exit_reason: p.exit_reason,
      settlement: s ? { id: s.id, state: s.state, recoverable_decision: s.recoverable_decision, period_ym: s.period?.period_ym ?? null, paid_separately: s.paid_separately ?? null } : null,
      live,
    });
  }
  const paid = await prisma.settlement.findMany({
    where: { state: 'PAID' },
    include: { employee: { select: { id: true, code: true, name: true } }, period: { select: { period_ym: true } } },
    orderBy: { paid_at: 'desc' },
    take: 50,
  });
  res.json({
    data: {
      open: rows,
      paid: paid.map((s) => ({ id: s.id, employee: s.employee, last_day: fromDbDate(s.last_day), net: n(s.net), paid_at: s.paid_at, period_ym: s.period?.period_ym ?? null, paid_separately: s.paid_separately ?? null })),
      recoverable: rows.filter((r) => r.live && 'net' in r.live && r.live.net < 0).map((r) => ({ employee: r.employee, amount: -r.live.net, decision: r.settlement?.recoverable_decision ?? null })),
    },
  });
});

export const getSettlement = asyncHandler(async (req, res) => {
  const e = await prisma.employee.findUnique({
    where: { id: req.params.employeeId },
    select: { id: true, code: true, name: true, status: true, joined_on: true, last_day: true, exit_reason: true },
  });
  if (!e) throw notFound('That person');
  const stored = await prisma.settlement.findFirst({ where: { employee_id: e.id, deleted_at: null }, orderBy: { created_at: 'desc' }, include: { period: { select: { period_ym: true } } } });
  const employee = { ...e, joined_on: fromDbDate(e.joined_on), last_day: fromDbDate(e.last_day) };
  // Live while leaving, frozen once paid.
  if (stored?.state === 'PAID') {
    return res.json({
      data: {
        employee,
        frozen: true,
        period_ym: stored.period?.period_ym ?? null,
        paid_separately: stored.paid_separately ?? null,
        settlement: { ...stored, total_earnings: n(stored.total_earnings), total_deductions: n(stored.total_deductions), net: n(stored.net), last_day: fromDbDate(stored.last_day) },
      },
    });
  }
  // HR can change it until it is paid, and once processed only until step 2 of that payroll is submitted.
  let locked = e.status === 'NOTICE' ? null : 'Only the settlement of someone leaving can be changed.';
  if (!locked) {
    try {
      await assertSettlementEditable(prisma, stored);
    } catch (err) {
      locked = err.message;
    }
  }
  const { result, checklist, adjustments } = await computeSettlementFor(prisma, e.id);
  // The stored amounts follow the live ones until the payroll it is processed in moves past step 2.
  const s = locked && stored ? stored : await upsertSettlement(prisma, e.id);
  const period = s.period_id ? await prisma.payrollPeriod.findUnique({ where: { id: s.period_id }, select: { period_ym: true } }) : null;
  const company = await prisma.company.findFirst();
  res.json({
    data: {
      employee,
      frozen: false,
      settlement_id: s.id,
      state: s.state,
      recoverable_decision: s.recoverable_decision,
      period_ym: period?.period_ym ?? null,
      paid_separately: s.paid_separately ?? null,
      result,
      exit: { reason: e.exit_reason, checklist },
      adjustments,
      locked,
      company,
    },
  });
});

/** A negative settlement needs a deliberate decision: write it off, or pursue it. */
export const decideSettlement = asyncHandler(async (req, res) => {
  const b = z
    .object({ decision: z.enum(['WRITE_OFF', 'PURSUE']), note: z.string().min(8) })
    .strict()
    .parse(req.body);
  const s = await prisma.settlement.update({ where: { id: req.params.id }, data: { recoverable_decision: b.decision } });
  await audit(prisma, { ...who(req), action: 'settlement.recoverable_decision', entity_type: 'settlement', entity_id: s.id, detail: { employee_id: s.employee_id, ...b, net: n(s.net) } });
  res.json({ data: { ok: true } });
});
