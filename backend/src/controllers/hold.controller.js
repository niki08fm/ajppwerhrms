import { addMonths, formatYearMonth, istDate, salaryHoldSchema, salaryReleaseSchema, ymOf } from '@ajpwer/shared';
import { audit, who } from '../utils/audit.js';
import { fromDbDate, n } from '../utils/dbDates.js';
import { AppError, notFound } from '../utils/errors.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { prisma } from '../config/db.js';
import { assertSettlementEditable, currentSettlement } from '../services/exit.service.js';
import { upsertSettlement } from '../services/settlement.service.js';

/**
 * Salary holds. A held month is calculated as usual — payslip, PF, ESI, TDS — and kept out
 * of the bank file. HR releases it into a later month's payroll (paid in that bank file),
 * or records it as paid separately (never in a bank file). Each held month is paid once.
 */

const holdInclude = {
  employee: { select: { id: true, code: true, name: true, status: true, last_day: true, department: { select: { name: true } } } },
  held_pay: { orderBy: { period_ym: 'asc' } },
};

const unpaidStates = ['HELD', 'QUEUED'];

function holdView(h) {
  const months = h.held_pay.map((p) => ({
    id: p.id,
    period_ym: p.period_ym,
    amount: n(p.amount),
    state: p.state,
    pay_ym: p.pay_ym,
    paid_on: fromDbDate(p.paid_on),
    payment_ref: p.payment_ref,
    released_at: p.released_at,
    released_by: p.released_by,
    with_settlement: !!p.settlement_id,
  }));
  return {
    id: h.id,
    employee: { ...h.employee, last_day: fromDbDate(h.employee.last_day) },
    from_ym: h.from_ym,
    reason: h.reason,
    created_by: h.created_by,
    created_at: h.created_at,
    released_at: h.released_at,
    released_by: h.released_by,
    release_note: h.release_note,
    months,
    unpaid: months.filter((m) => unpaidStates.includes(m.state)).reduce((a, m) => a + m.amount, 0),
  };
}

/** The next three payroll months not yet run: a hold starts in one, a release pays in one. */
async function openMonths() {
  const latest = await prisma.payrollPeriod.findFirst({ where: { state: { not: 'DRAFT' } }, orderBy: { period_ym: 'desc' } });
  const start = latest ? addMonths(latest.period_ym, 1) : ymOf(istDate(new Date()));
  return [0, 1, 2].map((i) => addMonths(start, i));
}

async function loadPerson(id) {
  const e = await prisma.employee.findFirst({ where: { id, deleted_at: null } });
  if (!e) throw notFound('That person');
  return e;
}

const standingHold = (employeeId) => prisma.salaryHold.findFirst({ where: { employee_id: employeeId, released_at: null, deleted_at: null } });

/** Everyone whose salary is or was held: what is held, what is released, and what is paid. */
export const listHeldSalaries = asyncHandler(async (_req, res) => {
  const holds = (await prisma.salaryHold.findMany({ where: { deleted_at: null }, include: holdInclude, orderBy: { created_at: 'desc' }, take: 300 })).map(holdView);
  const unpaid = holds.flatMap((h) => h.months.filter((m) => unpaidStates.includes(m.state)));
  res.json({
    data: {
      holds,
      totals: { standing: holds.filter((h) => !h.released_at).length, unpaid_months: unpaid.length, unpaid: unpaid.reduce((a, m) => a + m.amount, 0) },
      open_months: await openMonths(),
      run_months: (await prisma.payrollPeriod.findMany({ where: { state: 'RUN' }, select: { period_ym: true } })).map((p) => p.period_ym),
    },
  });
});

/** One person's holds, for their profile. */
export const getHold = asyncHandler(async (req, res) => {
  const e = await loadPerson(req.params.id);
  const holds = (await prisma.salaryHold.findMany({ where: { employee_id: e.id, deleted_at: null }, include: holdInclude, orderBy: { created_at: 'desc' } })).map(holdView);
  const runMonths = await prisma.payrollPeriod.findMany({ where: { state: 'RUN' }, select: { period_ym: true } });
  res.json({
    data: {
      current: holds.find((h) => !h.released_at) ?? null,
      history: holds.filter((h) => h.released_at),
      unpaid: holds.reduce((a, h) => a + h.unpaid, 0),
      open_months: await openMonths(),
      // A held month run but not locked can be paid in that month itself.
      run_months: runMonths.map((p) => p.period_ym),
    },
  });
});

/** Hold someone's salary from a payroll month not yet run, until HR releases it. */
export const placeHold = asyncHandler(async (req, res) => {
  const b = salaryHoldSchema.parse(req.body);
  const e = await loadPerson(req.params.id);
  if (e.status !== 'ACTIVE' && e.status !== 'NOTICE') throw new AppError('INVALID_TRANSITION', `Only the salary of someone active or leaving can be held; ${e.name} is ${e.status.toLowerCase()}.`, 409);
  const standing = await standingHold(e.id);
  if (standing) throw new AppError('CONFLICT', `${e.name}'s salary is already on hold from ${formatYearMonth(standing.from_ym)}.`, 409);
  const s = await currentSettlement(prisma, e.id);
  if (s?.state === 'INCLUDED') throw new AppError('CONFLICT', 'Their F&F is processed and pays them in full. Take it back first to hold their salary.', 409);
  const p = await prisma.payrollPeriod.findUnique({ where: { period_ym: b.from_ym } });
  if (p && p.state !== 'DRAFT') {
    throw new AppError('PERIOD_LOCKED', `${formatYearMonth(b.from_ym)} payroll has been run. Hold from a later month, or take ${formatYearMonth(b.from_ym)} back to its steps first.`, 409, 'from_ym');
  }
  const lastDay = fromDbDate(e.last_day);
  if (lastDay && b.from_ym > ymOf(lastDay)) throw new AppError('VALIDATION', `Their last day is ${lastDay}, before ${formatYearMonth(b.from_ym)}.`, 422, 'from_ym');
  const { actor, ip } = who(req);
  const hold = await prisma.$transaction(async (tx) => {
    const h = await tx.salaryHold.create({ data: { employee_id: e.id, from_ym: b.from_ym, reason: b.reason, created_by: actor } });
    await audit(tx, { actor, ip, action: 'salary.hold', entity_type: 'employee', entity_id: e.id, detail: { from_ym: b.from_ym, reason: b.reason } });
    return h;
  });
  res.status(201).json({ data: { id: hold.id, from_ym: hold.from_ym } });
});

/**
 * Release a held salary. Into payroll: each held month is paid in the chosen month's payroll,
 * as its own line in the bank file — or, for a month run and not yet locked, in that month
 * itself. Paid separately: recorded with its date and reference, and never in a bank file.
 * The hold ends either way; later months are paid as usual.
 */
export const releaseHold = asyncHandler(async (req, res) => {
  const b = salaryReleaseSchema.parse(req.body);
  const e = await loadPerson(req.params.id);
  const [rows, standing, s] = await Promise.all([
    prisma.heldPay.findMany({ where: { employee_id: e.id, state: 'HELD' }, orderBy: { period_ym: 'asc' } }),
    standingHold(e.id),
    currentSettlement(prisma, e.id),
  ]);
  if (!rows.length && !standing) throw new AppError('CONFLICT', 'Nothing is held.', 409);
  if (!rows.length) throw new AppError('CONFLICT', 'No month has been held yet. Stop the hold instead.', 409);
  const fnf = s?.state === 'INCLUDED';
  if (fnf && b.mode === 'PAYROLL') throw new AppError('CONFLICT', 'Their F&F is processed, and held salary goes with it. Record it as paid separately, or leave it with the F&F.', 409);
  if (fnf) await assertSettlementEditable(prisma, s);
  const periods = await prisma.payrollPeriod.findMany({ where: { period_ym: { in: [...new Set([...rows.map((r) => r.period_ym), ...(b.mode === 'PAYROLL' ? [b.pay_ym] : [])])] } } });
  const stateOf = (ym) => periods.find((p) => p.period_ym === ym)?.state ?? 'DRAFT';
  // Decide each month before writing anything.
  const plan = rows.map((r) => {
    const held = stateOf(r.period_ym);
    const name = formatYearMonth(r.period_ym);
    if (b.mode === 'PAYROLL' && b.pay_ym === r.period_ym) {
      if (held !== 'RUN') throw new AppError('VALIDATION', `${name} payroll is ${held === 'DRAFT' ? 'not run' : 'locked'}, so its held salary is paid in a later month.`, 422, 'pay_ym');
      return { r, action: 'UNHOLD' };
    }
    if (held === 'RUN') throw new AppError('PERIOD_LOCKED', `${name} payroll is run but not locked. Release it into ${name} itself to pay it there, or lock ${name} first.`, 409);
    if (b.mode === 'SEPARATE') return { r, action: 'SEPARATE' };
    if (b.pay_ym <= r.period_ym) throw new AppError('VALIDATION', `Salary held in ${name} is paid in a later month's payroll.`, 422, 'pay_ym');
    if (stateOf(b.pay_ym) !== 'DRAFT') throw new AppError('PERIOD_LOCKED', `${formatYearMonth(b.pay_ym)} payroll has been run. Choose a later month.`, 409, 'pay_ym');
    return { r, action: 'QUEUE' };
  });
  const { actor, ip } = who(req);
  const stamp = { released_by: actor, released_at: new Date() };
  await prisma.$transaction(async (tx) => {
    for (const { r, action } of plan) {
      if (action === 'UNHOLD') {
        // Run but not locked: the payslip simply stops being held and goes in that month's bank file.
        const p = periods.find((x) => x.period_ym === r.period_ym);
        const slip = await tx.payslip.findFirst({ where: { period_id: p.id, employee_id: e.id } });
        if (slip) await tx.payslip.update({ where: { id: slip.id }, data: { meta: { ...slip.meta, held: null } } });
        await tx.heldPay.delete({ where: { id: r.id } });
        const t = p.totals ?? {};
        await tx.payrollPeriod.update({ where: { id: p.id }, data: { totals: { ...t, held_count: Math.max(0, (t.held_count ?? 1) - 1), held_net: Math.max(0, (t.held_net ?? 0) - n(r.amount)) } } });
      } else if (action === 'QUEUE') {
        await tx.heldPay.update({ where: { id: r.id }, data: { state: 'QUEUED', pay_ym: b.pay_ym, ...stamp } });
      } else {
        await tx.heldPay.update({ where: { id: r.id }, data: { state: 'PAID_SEPARATELY', paid_on: new Date(`${b.paid_on}T00:00:00Z`), payment_ref: b.payment_ref, ...stamp } });
      }
    }
    await tx.salaryHold.updateMany({
      where: { employee_id: e.id, released_at: null, deleted_at: null },
      data: { released_at: stamp.released_at, released_by: actor, release_note: b.note ?? (b.mode === 'PAYROLL' ? `Paid in ${formatYearMonth(b.pay_ym)} payroll` : `Paid separately, ${b.payment_ref}`) },
    });
    await audit(tx, {
      actor,
      ip,
      action: 'salary.release',
      entity_type: 'employee',
      entity_id: e.id,
      detail: { ...b, months: plan.map(({ r, action }) => ({ period_ym: r.period_ym, amount: n(r.amount), action })) },
    });
  });
  // The F&F no longer pays what was paid separately.
  if (fnf) await upsertSettlement(prisma, e.id);
  res.json({ data: { released: plan.length } });
});

/** Stop a hold that has not held any month yet. */
export const stopHold = asyncHandler(async (req, res) => {
  const e = await loadPerson(req.params.id);
  const standing = await standingHold(e.id);
  if (!standing) throw new AppError('CONFLICT', 'Nothing is held.', 409);
  const held = await prisma.heldPay.count({ where: { hold_id: standing.id } });
  if (held) throw new AppError('CONFLICT', 'This hold has held salary already. Release it instead, to say how it is paid.', 409);
  const { actor, ip } = who(req);
  await prisma.$transaction(async (tx) => {
    await tx.salaryHold.update({ where: { id: standing.id }, data: { released_at: new Date(), released_by: actor, release_note: 'Stopped before any month was held' } });
    await audit(tx, { actor, ip, action: 'salary.hold_stop', entity_type: 'employee', entity_id: e.id, detail: { from_ym: standing.from_ym } });
  });
  res.json({ data: { stopped: true } });
});
