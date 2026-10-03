import { randomUUID } from 'node:crypto';
import { addMonths, exitTaskTickSchema, exitWithdrawSchema, EXIT_CHECKLIST, formatYearMonth, resignSchema, settlementAdjustSchema, settlementProcessSchema, ymOf } from '@ajpwer/shared';
import { audit, who } from '../utils/audit.js';
import { fromDbDate, n, toDbDate } from '../utils/dbDates.js';
import { AppError, notFound } from '../utils/errors.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { prisma } from '../config/db.js';
import { assertSettlementEditable, currentSettlement, exitChecklist } from '../services/exit.service.js';
import { getPeriod } from '../services/payroll.service.js';
import { computeSettlementFor, upsertSettlement } from '../services/settlement.service.js';

async function loadPerson(id) {
  const e = await prisma.employee.findFirst({ where: { id, deleted_at: null } });
  if (!e) throw notFound('That person');
  return e;
}

const leaving = (e) => {
  if (e.status !== 'NOTICE') throw new AppError('INVALID_TRANSITION', `${e.name} is not leaving${e.status === 'EXITED' ? ': they have exited and the exit is closed' : ''}.`, 409);
};

/** Why a month's payroll cannot take an F&F any more, or null if it can. */
function closedReason(p) {
  if (!p) return null;
  if (p.state !== 'DRAFT') return `${formatYearMonth(p.period_ym)} payroll has been run`;
  if (p.steps_submitted.includes(2)) return `${formatYearMonth(p.period_ym)} payroll is past step 2`;
  return null;
}

/**
 * Everything about someone's exit, on one screen: its details, the checklist with what is
 * ticked, the F&F and where it is processed, the months it can be processed in, and whether
 * the exit can still be changed.
 */
export const getExit = asyncHandler(async (req, res) => {
  const e = await loadPerson(req.params.id);
  const s = await currentSettlement(prisma, e.id);
  let locked = null;
  try {
    await assertSettlementEditable(prisma, s);
    if (s?.state === 'INCLUDED') locked = 'The F&F is processed. Take it back to change or withdraw the exit.';
  } catch (err) {
    locked = err.message;
  }
  const lastDay = fromDbDate(e.last_day);
  // The F&F goes in the payroll for the month of the last day, or one of the two after it.
  const months = lastDay ? [0, 1, 2].map((i) => addMonths(ymOf(lastDay), i)) : [];
  const periods = months.length ? await prisma.payrollPeriod.findMany({ where: { period_ym: { in: months } } }) : [];
  const period = s?.period_id ? await prisma.payrollPeriod.findUnique({ where: { id: s.period_id } }) : null;
  res.json({
    data: {
      status: e.status,
      resigned_on: fromDbDate(e.resigned_on),
      last_day: lastDay,
      exit_reason: e.exit_reason,
      checklist: e.last_day ? await exitChecklist(prisma, e.id) : EXIT_CHECKLIST.map((t) => ({ ...t, done_at: null, done_by: null, note: null })),
      settlement: s
        ? {
            id: s.id,
            state: s.state,
            net: n(s.net),
            period_ym: period?.period_ym ?? null,
            paid_separately: s.paid_separately ?? null,
            paid_at: s.paid_at,
            clearance: s.clearance,
          }
        : null,
      process_months: months.map((ym) => {
        const why = closedReason(periods.find((p) => p.period_ym === ym));
        return { ym, open: !why, reason: why };
      }),
      // Change or withdraw while leaving, until the F&F is processed.
      locked: e.status === 'NOTICE' ? locked : e.status === 'EXITED' ? 'The exit is closed: the F&F has been paid.' : null,
    },
  });
});

/** Change an exit while the person is leaving: its kind or dates. */
export const changeExit = asyncHandler(async (req, res) => {
  const b = resignSchema.parse(req.body);
  const e = await loadPerson(req.params.id);
  leaving(e);
  if (b.last_day < b.resigned_on) throw new AppError('VALIDATION', 'The last day cannot be before the date the exit was recorded.', 422, 'last_day');
  const s = await currentSettlement(prisma, e.id);
  await assertSettlementEditable(prisma, s);
  if (s?.state === 'INCLUDED') throw new AppError('CONFLICT', 'The F&F is processed. Take it back first.', 409);
  const before = { resigned_on: fromDbDate(e.resigned_on), last_day: fromDbDate(e.last_day), exit_reason: e.exit_reason };
  const after = { resigned_on: b.resigned_on, last_day: b.last_day, exit_reason: b.exit_reason };
  const { actor, ip } = who(req);
  await prisma.$transaction(async (tx) => {
    await tx.employee.update({ where: { id: e.id }, data: { resigned_on: toDbDate(b.resigned_on), last_day: toDbDate(b.last_day), exit_reason: b.exit_reason } });
    await audit(tx, { actor, ip, action: 'employee.exit_change', entity_type: 'employee', entity_id: e.id, detail: { before, after, note: b.note } });
  });
  await upsertSettlement(prisma, e.id);
  res.json({ data: after });
});

/** Take an exit back: the person is active again and the open settlement is set aside. */
export const withdrawExit = asyncHandler(async (req, res) => {
  const b = exitWithdrawSchema.parse(req.body);
  const e = await loadPerson(req.params.id);
  leaving(e);
  const s = await currentSettlement(prisma, e.id);
  await assertSettlementEditable(prisma, s);
  if (s?.state === 'INCLUDED') throw new AppError('CONFLICT', 'The F&F is processed. Take it back first.', 409);
  const { actor, ip } = who(req);
  await prisma.$transaction(async (tx) => {
    await tx.employee.update({ where: { id: e.id }, data: { status: 'ACTIVE', resigned_on: null, last_day: null, exit_reason: null } });
    await tx.settlement.updateMany({ where: { employee_id: e.id, deleted_at: null, state: 'OPEN' }, data: { deleted_at: new Date() } });
    await tx.exitTask.updateMany({ where: { employee_id: e.id, deleted_at: null }, data: { deleted_at: new Date() } });
    await audit(tx, {
      actor,
      ip,
      action: 'employee.exit_withdraw',
      entity_type: 'employee',
      entity_id: e.id,
      detail: { reason: b.reason, withdrawn: { resigned_on: fromDbDate(e.resigned_on), last_day: fromDbDate(e.last_day), exit_reason: e.exit_reason } },
    });
  });
  res.json({ data: { status: 'ACTIVE' } });
});

/** Tick an exit checklist task, or un-tick it. */
export const setExitTask = asyncHandler(async (req, res) => {
  const b = exitTaskTickSchema.parse(req.body);
  const e = await loadPerson(req.params.id);
  leaving(e);
  const task = EXIT_CHECKLIST.find((t) => t.code === req.params.code);
  if (!task) throw notFound('That checklist task');
  await assertSettlementEditable(prisma, await currentSettlement(prisma, e.id));
  const { actor, ip } = who(req);
  const data = { done_at: b.done ? new Date() : null, done_by: b.done ? actor : null, note: b.note ?? null, deleted_at: null };
  await prisma.$transaction(async (tx) => {
    await tx.exitTask.upsert({ where: { employee_id_task_code: { employee_id: e.id, task_code: task.code } }, update: data, create: { employee_id: e.id, task_code: task.code, ...data } });
    await audit(tx, { actor, ip, action: b.done ? 'exit.task_done' : 'exit.task_undone', entity_type: 'employee', entity_id: e.id, detail: { task: task.code, label: task.label, note: b.note } });
  });
  await upsertSettlement(prisma, e.id);
  res.json({ data: { code: task.code, ...data } });
});

/**
 * Process the F&F into a month's payroll. Paid through payroll, it goes out in that month's
 * bank file. Paid separately, it is recorded in that month's payroll — register, PF, ESI —
 * but never enters a bank file. Either way it is paid once: it sits in one month only, and
 * salary held and not yet paid goes with it.
 */
export const processSettlement = asyncHandler(async (req, res) => {
  const b = settlementProcessSchema.parse(req.body);
  const e = await loadPerson(req.params.id);
  leaving(e);
  const lastYm = ymOf(fromDbDate(e.last_day));
  if (b.period_ym < lastYm) throw new AppError('VALIDATION', `The F&F goes in the payroll for ${formatYearMonth(lastYm)}, the month of the last day, or a later one.`, 422, 'period_ym');
  const before = await currentSettlement(prisma, e.id);
  if (before?.state === 'PAID') throw new AppError('CONFLICT', 'This F&F has been paid.', 409);
  if (before?.state === 'INCLUDED') throw new AppError('CONFLICT', 'This F&F is already processed. Take it back first to change the month or how it is paid.', 409);
  const s = await upsertSettlement(prisma, e.id);
  const { result, checklist } = await computeSettlementFor(prisma, e.id, { paidSeparately: !!b.paid_separately });
  const open = checklist.filter((t) => t.required && !t.done_at);
  if (open.length) throw new AppError('BLOCKING_ISSUES', `Finish the exit checklist first: ${open.map((t) => t.label.toLowerCase()).join('; ')}.`, 409);
  const noBank = result.clearance.find((c) => c.code === 'NO_BANK' && c.severity === 'BLOCKING');
  if (noBank) throw new AppError('BLOCKING_ISSUES', noBank.message, 409);
  if (b.paid_separately && result.net < 0) throw new AppError('VALIDATION', 'The net is recoverable from the employee, so there is nothing to pay separately. Process it through payroll and record the decision.', 422);
  const p = await getPeriod(prisma, b.period_ym);
  const why = closedReason(p);
  if (why) throw new AppError('PERIOD_LOCKED', `${why}. Choose a later month, or reopen step 2 there.`, 409, 'period_ym');
  const { actor, ip } = who(req);
  await prisma.$transaction(async (tx) => {
    await tx.payrollPeriod.update({ where: { id: p.id }, data: { settlement_ids: [...new Set([...p.settlement_ids, s.id])] } });
    await tx.settlement.update({
      where: { id: s.id },
      data: { state: 'INCLUDED', period_id: p.id, paid_separately: b.paid_separately ? { ...b.paid_separately, by: actor, at: new Date().toISOString() } : null },
    });
    // Held salary released into a payroll not yet run comes back to go with the F&F instead.
    const queued = await tx.heldPay.findMany({ where: { employee_id: e.id, state: 'QUEUED' } });
    for (const h of queued) {
      const pay = await tx.payrollPeriod.findUnique({ where: { period_ym: h.pay_ym } });
      if (!pay || pay.state === 'DRAFT') await tx.heldPay.update({ where: { id: h.id }, data: { state: 'HELD', pay_ym: null, released_at: null, released_by: null } });
    }
    // The F&F settles everything: a hold still standing ends with it.
    await tx.salaryHold.updateMany({ where: { employee_id: e.id, released_at: null, deleted_at: null }, data: { released_at: new Date(), released_by: actor, release_note: 'Settled with the F&F' } });
    await audit(tx, {
      actor,
      ip,
      action: 'settlement.process',
      entity_type: 'settlement',
      entity_id: s.id,
      detail: { employee_id: e.id, period: b.period_ym, paid_separately: b.paid_separately ?? null, net: result.net },
    });
  });
  const fresh = await upsertSettlement(prisma, e.id);
  res.json({ data: { state: 'INCLUDED', period_ym: b.period_ym, paid_separately: b.paid_separately ?? null, net: n(fresh.net) } });
});

/** Take a processed F&F back out of its month, while that payroll is not past step 2. */
export const unprocessSettlement = asyncHandler(async (req, res) => {
  const e = await loadPerson(req.params.id);
  leaving(e);
  const s = await currentSettlement(prisma, e.id);
  if (!s || s.state !== 'INCLUDED') throw new AppError('CONFLICT', 'The F&F is not processed.', 409);
  await assertSettlementEditable(prisma, s);
  const { actor, ip } = who(req);
  await prisma.$transaction(async (tx) => {
    if (s.period_id) {
      const p = await tx.payrollPeriod.findUnique({ where: { id: s.period_id } });
      if (p) await tx.payrollPeriod.update({ where: { id: p.id }, data: { settlement_ids: p.settlement_ids.filter((x) => x !== s.id) } });
    }
    await tx.settlement.update({ where: { id: s.id }, data: { state: 'OPEN', period_id: null, paid_separately: null } });
    await audit(tx, { actor, ip, action: 'settlement.unprocess', entity_type: 'settlement', entity_id: s.id, detail: { employee_id: e.id } });
  });
  await upsertSettlement(prisma, e.id);
  res.json({ data: { state: 'OPEN' } });
});

/**
 * One change HR makes to a settlement: switch a line off or on, give a day-based line other
 * days, or add or remove HR's own line. Each needs a reason and is audited; the settlement is
 * worked out again with it.
 */
export const adjustSettlement = asyncHandler(async (req, res) => {
  const b = settlementAdjustSchema.parse(req.body);
  const e = await loadPerson(req.params.employeeId);
  leaving(e);
  // Checked before it is worked out again: a settlement past step 2 of its payroll is frozen.
  await assertSettlementEditable(prisma, await currentSettlement(prisma, e.id));
  const s = await upsertSettlement(prisma, e.id);
  const { result } = await computeSettlementFor(prisma, e.id);
  const line = 'code' in b ? [...result.earnings, ...result.deductions].find((l) => l.code === b.code) : null;
  const adj = { excluded: {}, days: {}, extra: [], ...(s.adjustments ?? {}) };
  const { actor, ip } = who(req);
  const stamp = { by: actor, at: new Date().toISOString() };
  switch (b.action) {
    case 'EXCLUDE':
      if (!line?.switchable) throw new AppError('VALIDATION', 'That line cannot be switched off.', 422, 'code');
      adj.excluded = { ...adj.excluded, [b.code]: { reason: b.reason, ...stamp } };
      break;
    case 'INCLUDE': {
      const { [b.code]: _, ...rest } = adj.excluded;
      adj.excluded = rest;
      break;
    }
    case 'SET_DAYS':
      if (!line || line.days === undefined) throw new AppError('VALIDATION', 'Only leave lines are counted in days.', 422, 'code');
      adj.days = { ...adj.days, [b.code]: { days: b.days, reason: b.reason, ...stamp } };
      break;
    case 'CLEAR_DAYS': {
      const { [b.code]: _, ...rest } = adj.days;
      adj.days = rest;
      break;
    }
    case 'ADD_LINE':
      adj.extra = [...adj.extra, { id: randomUUID().slice(0, 8), kind: b.kind, name: b.name, amount: b.amount, reason: b.reason, ...stamp }];
      break;
    case 'REMOVE_LINE':
      if (!adj.extra.some((x) => x.id === b.id)) throw notFound('That line');
      adj.extra = adj.extra.filter((x) => x.id !== b.id);
      break;
  }
  await prisma.$transaction(async (tx) => {
    await tx.settlement.update({ where: { id: s.id }, data: { adjustments: adj } });
    await audit(tx, { actor, ip, action: 'settlement.adjust', entity_type: 'settlement', entity_id: s.id, detail: { employee_id: e.id, ...b, net_before: result.net } });
  });
  const fresh = await upsertSettlement(prisma, e.id);
  res.json({ data: { net: n(fresh.net), adjustments: adj } });
});
