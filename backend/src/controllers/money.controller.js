import { z } from 'zod';
import { advanceCreateSchema, divRound, istDate, loanCreateSchema, loanPreviewSchema, loanTypeSchema } from '@ajpwer/shared';
import { describeLoanType, loanPlan, monthsFrom } from '../calculations/index.js';
import { salaryOn } from '../services/rules.service.js';
import { audit, who } from '../utils/audit.js';
import { fromDbDate, n, toDbDate } from '../utils/dbDates.js';
import { AppError, notFound } from '../utils/errors.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { filterValues } from '../utils/list.js';
import { prisma } from '../config/db.js';
import { assertSettlementEditable } from '../services/exit.service.js';
import { mapConcurrent } from '../utils/parallel.js';
import { lockAssignments } from '../services/master-data-lock.js';
import { computeSettlementFor, upsertSettlement } from '../services/settlement.service.js';

// ─── Advances and loans ─────────────────────────────────────────────────────
export const listAdvancesAndLoans = asyncHandler(async (req, res) => {
  const status = filterValues(req.query.filter ?? {}, 'status');
  const q = req.query.q?.trim();
  const empWhere = q ? { employee: { OR: [{ name: { contains: q, mode: 'insensitive' } }, { code: { contains: q, mode: 'insensitive' } }] } } : {};
  const st = status.length ? { status: { in: status } } : {};
  const [loans, advances, carries] = await Promise.all([
    prisma.loan.findMany({ where: { deleted_at: null, ...st, ...empWhere }, include: { employee: { select: { id: true, code: true, name: true } } }, orderBy: { started_on: 'desc' } }),
    prisma.advance.findMany({ where: { deleted_at: null, ...st, ...empWhere }, include: { employee: { select: { id: true, code: true, name: true } }, type: { select: { name: true } } }, orderBy: { granted_on: 'desc' } }),
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
        type_id: l.type_id,
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
        type_id: a.type_id,
        type_name: a.type?.name ?? null,
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

// ─── Loan and advance types ─────────────────────────────────────────────────

export const loanTypeView = (t) => ({
  id: t.id, name: t.name, kind: t.kind, active: t.active,
  max_gross_multiple: t.max_gross_multiple === null ? null : Number(t.max_gross_multiple),
  max_amount: t.max_amount === null ? null : n(t.max_amount),
  max_instalments: t.max_instalments, recovery_method: t.recovery_method,
  recovery_pct: t.recovery_pct === null ? null : Number(t.recovery_pct),
  max_instalment_pct: t.max_instalment_pct === null ? null : Number(t.max_instalment_pct),
  min_service_months: t.min_service_months, one_at_a_time: t.one_at_a_time,
});
const typeData = (b) => ({ ...b, max_amount: b.max_amount === null || b.max_amount === undefined ? b.max_amount : BigInt(b.max_amount), recovery_pct: b.recovery_method === 'PCT_OF_GROSS' ? b.recovery_pct : b.recovery_method ? null : b.recovery_pct });

export const listLoanTypes = asyncHandler(async (_req, res) => {
  const rows = await prisma.loanType.findMany({ where: { deleted_at: null }, orderBy: [{ kind: 'asc' }, { name: 'asc' }], include: { _count: { select: { loans: { where: { status: 'ACTIVE', deleted_at: null } }, advances: { where: { status: 'ACTIVE', deleted_at: null } } } } } });
  res.json({ data: rows.map((t) => ({ ...loanTypeView(t), description: describeLoanType(loanTypeView(t)), recovering: t._count.loans + t._count.advances })) });
});

export const createLoanType = asyncHandler(async (req, res) => {
  const b = loanTypeSchema.parse(req.body);
  const { actor, ip } = who(req);
  const t = await prisma.$transaction(async (tx) => {
    if (await tx.loanType.findFirst({ where: { deleted_at: null, name: { equals: b.name, mode: 'insensitive' } } })) throw new AppError('VALIDATION', 'A type with that name exists.', 422, 'name');
    const created = await tx.loanType.create({ data: { ...typeData(b), created_by: actor } });
    await audit(tx, { actor, ip, action: 'loan_type.create', entity_type: 'loan_type', entity_id: created.id, detail: b });
    return created;
  });
  res.status(201).json({ data: loanTypeView(t) });
});

/** Changing a type's limits affects new grants only; recovering loans keep the instalment fixed when granted. */
export const updateLoanType = asyncHandler(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const b = loanTypeSchema.innerType().partial().strict().parse(req.body);
  const { actor, ip } = who(req);
  const t = await prisma.$transaction(async (tx) => {
    const before = await tx.loanType.findFirst({ where: { id, deleted_at: null } });
    if (!before) throw notFound('That loan or advance type');
    if (b.kind && b.kind !== before.kind) throw new AppError('VALIDATION', 'A type cannot change between loan and advance. Create a new type instead.', 422, 'kind');
    const merged = { ...loanTypeView(before), ...b };
    if (merged.recovery_method === 'PCT_OF_GROSS' && !merged.recovery_pct) throw new AppError('VALIDATION', 'Set the percentage of gross recovered each month.', 422, 'recovery_pct');
    const updated = await tx.loanType.update({ where: { id }, data: typeData(b) });
    await audit(tx, { actor, ip, action: 'loan_type.update', entity_type: 'loan_type', entity_id: id, detail: { before: loanTypeView(before), after: b } });
    return updated;
  });
  res.json({ data: loanTypeView(t) });
});

/** A type in use is switched off instead; recovering loans and advances are never affected. */
export const deleteLoanType = asyncHandler(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { actor, ip } = who(req);
  await prisma.$transaction(async (tx) => {
    const t = await tx.loanType.findFirst({ where: { id, deleted_at: null } });
    if (!t) throw notFound('That loan or advance type');
    const used = (await tx.loan.count({ where: { type_id: id } })) + (await tx.advance.count({ where: { type_id: id } }));
    if (used) throw new AppError('CONFLICT', `${t.name} has been granted ${used} time${used === 1 ? '' : 's'}. Switch it off instead, so its records keep their type.`, 409);
    await tx.loanType.update({ where: { id }, data: { deleted_at: new Date() } });
    await audit(tx, { actor, ip, action: 'loan_type.delete', entity_type: 'loan_type', entity_id: id, detail: { name: t.name } });
  });
  res.json({ data: { id, deleted: true } });
});

/** The type's plan for one person: limit, instalment, months and every rule it breaks. */
async function planFor(db, b) {
  const t = await db.loanType.findFirst({ where: { id: b.type_id, deleted_at: null } });
  if (!t) throw notFound('That loan or advance type');
  const e = await db.employee.findFirst({ where: { id: b.employee_id, deleted_at: null }, select: { id: true, joined_on: true } });
  if (!e) throw notFound('That employee');
  const date = b.granted_on ?? istDate(new Date());
  const salary = await salaryOn(db, e.id, date);
  const gross = salary ? n(salary.monthly_gross) : 0;
  const joined = fromDbDate(e.joined_on);
  const service = joined ? Math.max(0, monthsFrom(joined.slice(0, 7), date.slice(0, 7)) - (Number(date.slice(8, 10)) < Number(joined.slice(8, 10)) ? 1 : 0)) : 0;
  const model = t.kind === 'LOAN' ? db.loan : db.advance;
  const active = await model.count({ where: { employee_id: e.id, type_id: t.id, status: 'ACTIVE', deleted_at: null } });
  const type = loanTypeView(t);
  const plan = loanPlan(type, { amount: b.amount, gross, instalments: b.instalments ?? null, instalment: b.instalment ?? null, service_months: service, active_of_type: active });
  return { type, plan: { ...plan, service_months: service, description: describeLoanType(type, gross) } };
}

export const previewLoan = asyncHandler(async (req, res) => {
  const b = loanPreviewSchema.parse(req.body);
  res.json({ data: (await planFor(prisma, b)).plan });
});

export const createAdvance = asyncHandler(async (req, res) => {
  const b = advanceCreateSchema.parse(req.body);
  if (!b.type_id && b.instalment > b.amount) throw new AppError('VALIDATION', 'The instalment cannot exceed the advance.', 422, 'instalment');
  const { actor, ip } = who(req);
  const a = await prisma.$transaction(async (tx) => {
    await lockAssignments(tx);
    if (!await tx.employee.findFirst({ where: { id: b.employee_id, deleted_at: null }, select: { id: true } })) throw notFound('That employee');
    let instalment = b.instalment;
    if (b.type_id) {
      await tx.$queryRaw`SELECT id FROM employee WHERE id = ${b.employee_id}::uuid FOR UPDATE`;
      const { type, plan } = await planFor(tx, { ...b, amount: b.amount });
      if (type.kind !== 'ADVANCE') throw new AppError('VALIDATION', `${type.name} is a loan type.`, 422, 'type_id');
      if (plan.errors.length) throw new AppError('LOAN_RULES', plan.errors.join(' '), 422, 'type_id', plan.errors);
      instalment = plan.instalment;
    }
    const created = await tx.advance.create({
      data: { employee_id: b.employee_id, amount: BigInt(b.amount), reason: b.reason, granted_on: toDbDate(b.granted_on), instalment: BigInt(instalment), type_id: b.type_id ?? null, created_by: actor },
    });
    await audit(tx, { actor, ip, action: 'advance.grant', entity_type: 'employee', entity_id: b.employee_id, detail: { advance_id: created.id, ...b, instalment } });
    return created;
  });
  res.status(201).json({ data: { id: a.id, instalment: n(a.instalment) } });
});

export const createLoan = asyncHandler(async (req, res) => {
  const b = loanCreateSchema.parse(req.body);
  const { actor, ip } = who(req);
  const l = await prisma.$transaction(async (tx) => {
    await lockAssignments(tx);
    if (!await tx.employee.findFirst({ where: { id: b.employee_id, deleted_at: null }, select: { id: true } })) throw notFound('That employee');
    let emi;
    let months = b.months;
    let label = b.loan_type;
    if (b.type_id) {
      await tx.$queryRaw`SELECT id FROM employee WHERE id = ${b.employee_id}::uuid FOR UPDATE`;
      const { type, plan } = await planFor(tx, { ...b, amount: b.principal, granted_on: b.started_on, instalments: b.months });
      if (type.kind !== 'LOAN') throw new AppError('VALIDATION', `${type.name} is an advance type.`, 422, 'type_id');
      if (plan.errors.length) throw new AppError('LOAN_RULES', plan.errors.join(' '), 422, 'type_id', plan.errors);
      emi = plan.instalment;
      months = plan.months;
      label = type.name;
    } else emi = divRound(b.principal, b.months, 'up');
    const created = await tx.loan.create({
      data: { employee_id: b.employee_id, loan_type: label, principal: BigInt(b.principal), months, emi: BigInt(emi), started_on: toDbDate(b.started_on), type_id: b.type_id ?? null, created_by: actor },
    });
    await audit(tx, { actor, ip, action: 'loan.grant', entity_type: 'employee', entity_id: b.employee_id, detail: { loan_id: created.id, ...b, emi, months } });
    return created;
  });
  res.status(201).json({ data: { id: l.id, emi: n(l.emi), months: l.months } });
});

// ─── Exits and settlement ───────────────────────────────────────────────────
export const listSettlements = asyncHandler(async (_req, res) => {
  const [people, paid] = await Promise.all([prisma.employee.findMany({
    where: { deleted_at: null, OR: [{ status: 'NOTICE' }, { status: 'EXITED', settlements: { some: { state: { not: 'PAID' } } } }] },
    include: { department: { select: { name: true } }, settlements: { where: { deleted_at: null }, orderBy: { created_at: 'desc' }, take: 1, include: { period: { select: { period_ym: true } } } } },
    orderBy: { last_day: 'asc' },
  }),
    prisma.settlement.findMany({
    where: { state: 'PAID' },
    include: { employee: { select: { id: true, code: true, name: true } }, period: { select: { period_ym: true } } },
    orderBy: { paid_at: 'desc' },
    take: 50,
  }),
  ]);
  const rows = await mapConcurrent(people, 4, async p => {
    let live = null;
    try {
      live = (await computeSettlementFor(prisma, p.id)).result;
    } catch (err) {
      live = { error: err instanceof Error ? err.message : 'Could not compute' };
    }
    const s = p.settlements[0];
    return {
      employee: { id: p.id, code: p.code, name: p.name, department: p.department.name, status: p.status },
      resigned_on: fromDbDate(p.resigned_on),
      last_day: fromDbDate(p.last_day),
      exit_reason: p.exit_reason,
      settlement: s ? { id: s.id, state: s.state, recoverable_decision: s.recoverable_decision, period_ym: s.period?.period_ym ?? null, paid_separately: s.paid_separately ?? null } : null,
      live,
    };
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
  // HR can change it until it is paid, and once processed only until the F&F step of that payroll is submitted.
  let locked = e.status === 'NOTICE' ? null : 'Only the settlement of someone leaving can be changed.';
  if (!locked) {
    try {
      await assertSettlementEditable(prisma, stored);
    } catch (err) {
      locked = err.message;
    }
  }
  const { result, checklist, adjustments } = await computeSettlementFor(prisma, e.id);
  // The stored amounts follow the live ones until the payroll it is processed in moves past its F&F step.
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
