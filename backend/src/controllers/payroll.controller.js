import { z } from 'zod';
import { adhocCreateSchema, addMonths, COMPANIES, companyOf, exclusionSchema, firstOfMonth, formatYearMonth, istDate, lastOfMonth, markPaidSchema, PAYROLL_STEPS, yearMonth, ymOf } from '@ajpwer/shared';
import { audit, auditReq, who } from '../utils/audit.js';
import { can } from '../middleware/auth.js';
import { fromDbDate, n, toDbDate } from '../utils/dbDates.js';
import { AppError, notFound } from '../utils/errors.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { enqueue } from '../jobs/queue.js';
import { prisma } from '../config/db.js';
import { computeMonths } from '../services/attendance.service.js';
import { onboardingView } from '../services/employee.service.js';
import { claimRun, releaseRun, computeIssues, getPeriod, heldBackList, ISSUE_LABELS, reopenStep, runPopulation, submitStep, transition } from '../services/payroll.service.js';
import { buildReport, REPORTS, reportCSV, reportXLSX } from '../services/reports.service.js';
import { computeSettlementFor, upsertSettlement } from '../services/settlement.service.js';
import { randomUUID } from 'node:crypto';

const today = () => istDate(new Date());

const ymParam = (v) => yearMonth.parse(v);
/** `AJ` or `TP` to see one company; nothing for both. */
const companyParam = (v) => (v ? z.enum(COMPANIES.map((c) => c.key)).parse(v) : undefined);

function periodOut(p) {
  return {
    id: p.id,
    period_ym: p.period_ym,
    label: formatYearMonth(p.period_ym),
    state: p.state,
    steps_submitted: p.steps_submitted,
    step_log: p.step_log,
    steps: PAYROLL_STEPS.map((s) => ({ ...s, submitted: p.steps_submitted.includes(s.n), open: s.n === 1 || p.steps_submitted.includes(s.n - 1) })),
    running: !!p.running_job_id,
    running_job_id: p.running_job_id,
    run_at: p.run_at,
    run_by: p.run_by,
    locked_at: p.locked_at,
    paid_at: p.paid_at,
    payment_ref: p.payment_ref,
    statutory_rates_id: p.statutory_rates_id,
    settlement_ids: p.settlement_ids,
    totals: p.totals,
  };
}

export const listPeriods = asyncHandler(async (_req, res) => {
  const rows = await prisma.payrollPeriod.findMany({ orderBy: { period_ym: 'desc' }, take: 60 });
  const current = ymOf(today());
  // Payroll covers the full calendar month and is processed early the next month.
  const suggested = addMonths(current, -1);
  res.json({ data: rows.map(periodOut), meta: { current, suggested } });
});

export const getPeriodDetail = asyncHandler(async (req, res) => {
  const p = await getPeriod(prisma, ymParam(req.params.ym));
  res.json({ data: periodOut(p) });
});

// ─── Step 1: attendance ─────────────────────────────────────────────────────
export const getAttendanceStep = asyncHandler(async (req, res) => {
  const ym = ymParam(req.params.ym);
  const p = await getPeriod(prisma, ym);
  const pop = await runPopulation(prisma, ym, p.id, p.settlement_ids);
  const people = [...pop.included, ...pop.leaversOpen];
  const months = await computeMonths(prisma, people, ym);
  const rows = people.map((e) => {
    const m = months.get(e.id).result;
    const t = m.totals;
    return {
      employee: { id: e.id, code: e.code, name: e.name, department: e.department },
      in_run: pop.included.some((x) => x.id === e.id),
      present: t.present,
      half_day: t.half_day,
      absent: t.absent,
      leave: t.leave_paid + t.leave_unpaid,
      leave_days: t.leave_days,
      auto_leave_days: t.auto_leave_days,
      off_days: t.weekly_off + t.holidays,
      off_days_worked: t.off_days_worked,
      ot_min: t.ot_min,
      late_days: t.late_days,
      early_out_days: t.early_out_days,
      paid_days: t.paid_days,
      lop_days: t.lop_days,
      lop_in_window: t.lop_in_window,
      partial: t.partial,
      overridden_days: t.overridden_days,
      needs_look: m.days.filter((d) => d.status === 'MISSING_PUNCH' || d.status === 'SHORT').map((d) => ({ date: d.date, status: d.status, worked_min: d.worked_min })),
    };
  });
  rows.sort((a, b) => a.employee.name.localeCompare(b.employee.name));
  const shortlist = rows.flatMap((r) => r.needs_look.map((d) => ({ employee: r.employee, ...d })));
  res.json({ data: { rows, shortlist }, meta: { total: rows.length, nextCursor: null } });
});

// ─── Step 2: joiners and exits ──────────────────────────────────────────────
export const getJoinersStep = asyncHandler(async (req, res) => {
  const ym = ymParam(req.params.ym);
  const first = toDbDate(firstOfMonth(ym));
  const last = toDbDate(lastOfMonth(ym));
  const p = await getPeriod(prisma, ym);
  const [joiners, leavers, leavingLater, pipeline] = await Promise.all([
    prisma.employee.findMany({
      where: { deleted_at: null, joined_on: { gte: first, lte: last } },
      include: { onboarding_tasks: true, department: { select: { name: true } } },
      orderBy: { joined_on: 'asc' },
    }),
    // Leavers whose last day is this month, and leavers from earlier months whose F&F is processed here.
    prisma.employee.findMany({
      where: {
        deleted_at: null,
        status: { in: ['NOTICE', 'EXITED'] },
        OR: [{ last_day: { gte: first, lte: last } }, ...(p.settlement_ids.length ? [{ settlements: { some: { id: { in: p.settlement_ids } } } }] : [])],
      },
      include: { department: { select: { name: true } } },
    }),
    prisma.employee.findMany({ where: { deleted_at: null, status: 'NOTICE', last_day: { gt: last } }, include: { department: { select: { name: true } } } }),
    prisma.employee.findMany({ where: { deleted_at: null, status: { in: ['OFFER', 'ACCEPTED', 'ONBOARDING'] } }, include: { department: { select: { name: true } } } }),
  ]);
  const dim = Number(lastOfMonth(ym).slice(8));
  const leaverRows = [];
  for (const l of leavers) {
    const s = await prisma.settlement.findFirst({ where: { employee_id: l.id, deleted_at: null }, orderBy: { created_at: 'desc' } });
    let computed = null;
    try {
      computed = (await computeSettlementFor(prisma, l.id)).result;
    } catch (err) {
      computed = { error: err instanceof Error ? err.message : 'Could not compute' };
    }
    leaverRows.push({
      employee: { id: l.id, code: l.code, name: l.name, department: l.department.name, status: l.status },
      last_day: fromDbDate(l.last_day),
      settlement_id: s?.id ?? null,
      settlement_state: s?.state ?? null,
      included: s ? p.settlement_ids.includes(s.id) : false,
      paid_separately: s?.paid_separately ?? null,
      settlement: computed,
    });
  }
  res.json({
    data: {
      joiners: joiners.map((j) => {
        const days = dim - Number(fromDbDate(j.joined_on).slice(8)) + 1;
        return {
          employee: { id: j.id, code: j.code, name: j.name, department: j.department.name, status: j.status },
          joined_on: fromDbDate(j.joined_on),
          days_in_month: days,
          proration: `${days} of ${dim} days — paid by the part-month rule`,
          onboarding: onboardingView(j.onboarding_tasks),
          excluded: j.status !== 'ACTIVE' && j.status !== 'NOTICE',
          joined_after_run: p.run_at ? j.created_at > p.run_at : false,
        };
      }),
      leavers: leaverRows,
      leaving_later: leavingLater.map((x) => ({ employee: { id: x.id, code: x.code, name: x.name, department: x.department.name }, last_day: fromDbDate(x.last_day), note: 'Paid a normal month' })),
      pipeline: pipeline.map((x) => ({ employee: { id: x.id, code: x.code, name: x.name, department: x.department.name, status: x.status }, note: 'Excluded — nobody is paid before activation' })),
    },
  });
});

/** Tick or untick a settlement for this run. */
export const includeSettlement = asyncHandler(async (req, res) => {
  const b = z.object({ period_ym: yearMonth, include: z.boolean() }).strict().parse(req.body);
  const s = await prisma.settlement.findUnique({ where: { id: req.params.id }, include: { employee: true } });
  if (!s) throw notFound('That settlement');
  if (s.state === 'PAID') throw new AppError('CONFLICT', 'This settlement has already been paid.', 409);
  const p = await getPeriod(prisma, b.period_ym);
  if (p.state !== 'DRAFT') throw new AppError('PERIOD_LOCKED', `${formatYearMonth(b.period_ym)} has been run. Take it back to its steps first.`, 409);
  if (p.steps_submitted.includes(4)) throw new AppError('PERIOD_LOCKED', 'Step 4 (F&F) is submitted. Reopen it to change which settlements go out.', 409);
  if (b.include && fromDbDate(s.last_day) > lastOfMonth(b.period_ym)) throw new AppError('VALIDATION', 'A settlement goes out with the run for the month the last day falls in, or later.', 422);
  await upsertSettlement(prisma, s.employee_id);
  const ids = new Set(p.settlement_ids);
  if (b.include) ids.add(s.id);
  else ids.delete(s.id);
  await prisma.$transaction(async (tx) => {
    await tx.payrollPeriod.update({ where: { id: p.id }, data: { settlement_ids: [...ids] } });
    // Ticked here, it is paid through this payroll's bank file.
    await tx.settlement.update({ where: { id: s.id }, data: { state: b.include ? 'INCLUDED' : 'OPEN', period_id: b.include ? p.id : null, paid_separately: null } });
    await audit(tx, {
      ...who(req),
      action: b.include ? 'settlement.include' : 'settlement.exclude',
      entity_type: 'settlement',
      entity_id: s.id,
      detail: { employee_id: s.employee_id, period: b.period_ym },
    });
  });
  res.json({ data: { included: b.include } });
});

// ─── Step 3: issues and hold-backs ──────────────────────────────────────────
export const getIssues = asyncHandler(async (req, res) => {
  const ym = ymParam(req.params.ym);
  const { issues } = await computeIssues(prisma, ym);
  const p = await getPeriod(prisma, ym);
  const held = await prisma.payrollExclusion.findMany({ where: { period_id: p.id, deleted_at: null }, include: { employee: { select: { id: true, code: true, name: true } } } });
  const kinds = [...new Set(issues.map((i) => i.kind))].map((k) => ({
    kind: k,
    label: ISSUE_LABELS[k] ?? k,
    severity: issues.find((i) => i.kind === k).severity,
    count: issues.filter((i) => i.kind === k).length,
  }));
  kinds.sort((a, b) => (a.severity === b.severity ? b.count - a.count : a.severity === 'BLOCKING' ? -1 : 1));
  res.json({ data: { issues, kinds, held_back: held.map((h) => ({ employee: h.employee, reason: h.reason, since: h.created_at })) } });
});

export const excludeEmployee = asyncHandler(async (req, res) => {
  const ym = ymParam(req.params.ym);
  const body = z.union([exclusionSchema, z.object({ employee_ids: z.array(z.string().uuid()).min(1), reason: z.string().min(3) }).strict()]).parse(req.body);
  const ids = 'employee_ids' in body ? body.employee_ids : [body.employee_id];
  const p = await getPeriod(prisma, ym);
  if (p.state !== 'DRAFT') throw new AppError('PERIOD_LOCKED', `${formatYearMonth(ym)} has been run. Take it back to its steps first.`, 409);
  const { actor, ip } = who(req);
  await prisma.$transaction(async (tx) => {
    for (const id of ids) {
      await tx.payrollExclusion.upsert({
        where: { period_id_employee_id: { period_id: p.id, employee_id: id } },
        update: { reason: body.reason, deleted_at: null, resolved_at: null },
        create: { period_id: p.id, employee_id: id, reason: body.reason, created_by: actor },
      });
      await audit(tx, { actor, ip, action: 'payroll.hold_back', entity_type: 'employee', entity_id: id, detail: { period: ym, reason: body.reason } });
    }
  });
  res.json({ data: { held: ids.length } });
});

export const removeExclusion = asyncHandler(async (req, res) => {
  const ym = ymParam(req.params.ym);
  const p = await getPeriod(prisma, ym);
  if (p.state !== 'DRAFT') throw new AppError('PERIOD_LOCKED', `${formatYearMonth(ym)} has been run. Take it back to its steps first.`, 409);
  await prisma.payrollExclusion.updateMany({ where: { period_id: p.id, employee_id: req.params.employeeId }, data: { deleted_at: new Date() } });
  await auditReq(req, { action: 'payroll.include', entity_type: 'employee', entity_id: req.params.employeeId, detail: { period: ym } });
  res.json({ data: { ok: true } });
});

export const listHeldBack = asyncHandler(async (_req, res) => {
  res.json({ data: await heldBackList(prisma) });
});

// ─── Step gates ─────────────────────────────────────────────────────────────
export const submitPayrollStep = asyncHandler(async (req, res) => {
  const { actor, ip } = who(req);
  const p = await submitStep(ymParam(req.params.ym), Number(req.params.n), actor, ip);
  res.json({ data: periodOut(p) });
});

export const reopenPayrollStep = asyncHandler(async (req, res) => {
  const { actor, ip } = who(req);
  const p = await reopenStep(ymParam(req.params.ym), Number(req.params.n), actor, ip);
  res.json({ data: periodOut(p) });
});

// ─── Step 4: adhoc ──────────────────────────────────────────────────────────

/** Who an adhoc item reaches this month: working some day of it, in the group it names. */
function targetWhere(item, ym) {
  const last = toDbDate(lastOfMonth(ym));
  const first = toDbDate(firstOfMonth(ym));
  const base = { deleted_at: null, status: { in: ['ACTIVE', 'NOTICE'] }, joined_on: { lte: last }, OR: [{ last_day: null }, { last_day: { gte: first } }] };
  if (item.target_type === 'ALL') return base;
  if (item.target_type === 'EMPLOYEE') return { ...base, id: { in: item.target_ids } };
  if (item.target_type === 'PAY_GROUP') return { ...base, pay_group_id: { in: item.target_ids } };
  return { ...base, department_id: { in: item.target_ids } };
}

async function resolveTargets(item, ym) {
  return prisma.employee.count({ where: targetWhere(item, ym) });
}

/** The people an adhoc item goes to, as it stands now (it is resolved again when the payroll is generated). */
export const getAdhocPeople = asyncHandler(async (req, res) => {
  const i = await prisma.adhocItem.findUnique({ where: { id: req.params.id } });
  if (!i || i.deleted_at) throw notFound('That adhoc item');
  const people = await prisma.employee.findMany({
    where: targetWhere(i, i.period_ym),
    select: { id: true, code: true, name: true, department: { select: { name: true } }, pay_group: { select: { name: true } } },
    orderBy: { name: 'asc' },
  });
  res.json({ data: people.map((p) => ({ id: p.id, code: p.code, name: p.name, department: p.department?.name ?? null, pay_group: p.pay_group?.name ?? null })) });
});

export const listAdhoc = asyncHandler(async (req, res) => {
  const ym = yearMonth.parse(req.query.period ?? addMonths(ymOf(today()), -1));
  const items = await prisma.adhocItem.findMany({ where: { period_ym: ym, deleted_at: null }, orderBy: { created_at: 'asc' } });
  const out = [];
  for (const i of items) {
    const people = await resolveTargets(i, ym);
    out.push({ ...i, amount: n(i.amount), people, total: n(i.amount) * people });
  }
  res.json({ data: out, meta: { total: out.length, nextCursor: null, note: 'Targets resolve at run time: someone who moves group before the run is paid by where they are then.' } });
});

async function assertAdhocOpen(ym) {
  const p = await getPeriod(prisma, ym);
  if (p.state !== 'DRAFT') throw new AppError('PERIOD_LOCKED', `${formatYearMonth(ym)} has been run. Take it back to its steps first.`, 409);
  if (p.steps_submitted.includes(5)) throw new AppError('PERIOD_LOCKED', 'Step 5 (adhoc) is submitted. Reopen it to change adhoc items.', 409);
}

export const createAdhoc = asyncHandler(async (req, res) => {
  const b = adhocCreateSchema.parse(req.body);
  await assertAdhocOpen(b.period_ym);
  const { actor, ip } = who(req);
  const item = await prisma.$transaction(async (tx) => {
    const i = await tx.adhocItem.create({ data: { ...b, amount: BigInt(b.amount), created_by: actor } });
    await audit(tx, { actor, ip, action: 'adhoc.create', entity_type: 'adhoc_item', entity_id: i.id, detail: b });
    return i;
  });
  res.status(201).json({ data: { ...item, amount: n(item.amount) } });
});

export const deleteAdhoc = asyncHandler(async (req, res) => {
  const i = await prisma.adhocItem.findUnique({ where: { id: req.params.id } });
  if (!i || i.deleted_at) throw notFound('That adhoc item');
  await assertAdhocOpen(i.period_ym);
  await prisma.adhocItem.update({ where: { id: i.id }, data: { deleted_at: new Date() } });
  await auditReq(req, { action: 'adhoc.delete', entity_type: 'adhoc_item', entity_id: i.id, detail: { name: i.name, amount: n(i.amount) } });
  res.json({ data: { ok: true } });
});

// ─── Step 5: preview and run ────────────────────────────────────────────────
export const previewRun = asyncHandler(async (req, res) => {
  const ym = ymParam(req.params.ym);
  const { run, population } = await computeIssues(prisma, ym);
  const t = run.payslips.reduce((a, p) => ({ gross: a.gross + p.result.gross, net: a.net + p.result.net, ctc: a.ctc + p.result.ctc_month, employer: a.employer + p.result.employer_total }), {
    gross: 0,
    net: 0,
    ctc: 0,
    employer: 0,
  });
  const onHold = run.payslips.filter((p) => p.hold);
  res.json({
    data: {
      headcount: run.payslips.length,
      ...t,
      held_back: population.excluded.length,
      // Calculated and kept out of the bank file until released.
      on_hold: onHold.length,
      on_hold_net: onHold.reduce((a, p) => a + p.result.net, 0),
      released_held: run.payslips.reduce((a, p) => a + (p.result.held_released ?? 0), 0),
      settlements: population.settlingIds.size,
      errors: run.errors,
    },
  });
});

/**
 * The month at a glance for the payroll overview, for both companies and each one: from the
 * payslips once generated, otherwise worked out live as an estimate.
 */
export const getSummary = asyncHandler(async (req, res) => {
  const ym = ymParam(req.params.ym);
  const p = await getPeriod(prisma, ym);
  const blank = () => ({ headcount: 0, gross: 0, net: 0, deductions: 0, employer: 0, on_hold: 0, on_hold_net: 0 });
  const out = { all: blank(), ...Object.fromEntries(COMPANIES.map((c) => [c.key, blank()])) };
  const add = (code, r) => {
    for (const k of ['all', companyOf(code)]) {
      const t = out[k];
      t.headcount++;
      t.gross += r.gross;
      t.net += r.net;
      t.deductions += r.deductions;
      t.employer += r.employer;
      if (r.hold) {
        t.on_hold++;
        t.on_hold_net += r.net;
      }
    }
  };
  let errors = 0;
  if (p.state !== 'DRAFT') {
    const slips = await prisma.payslip.findMany({
      where: { period_id: p.id },
      select: { gross: true, net: true, total_deductions: true, employer_total: true, meta: true, employee: { select: { code: true } } },
    });
    for (const s of slips) add(s.employee.code, { gross: n(s.gross), net: n(s.net), deductions: n(s.total_deductions), employer: n(s.employer_total), hold: !!s.meta?.held });
  } else {
    const { run } = await computeIssues(prisma, ym);
    for (const x of run.payslips) add(x.employee.code, { gross: x.result.gross, net: x.result.net, deductions: x.result.total_deductions, employer: x.result.employer_total, hold: !!x.hold });
    errors = run.errors.length;
  }
  res.json({ data: { period_ym: ym, state: p.state, source: p.state === 'DRAFT' ? 'estimate' : 'payslips', errors, ...out } });
});

/**
 * Step 4: every F&F this month's payroll can settle — leavers whose last day is in this
 * month or earlier and whose F&F is still open, and those already processed into this month.
 */
export const getFnfStep = asyncHandler(async (req, res) => {
  const ym = ymParam(req.params.ym);
  const p = await getPeriod(prisma, ym);
  const last = toDbDate(lastOfMonth(ym));
  const leavers = await prisma.employee.findMany({
    where: {
      deleted_at: null,
      OR: [
        { status: 'NOTICE', last_day: { lte: last } },
        ...(p.settlement_ids.length ? [{ settlements: { some: { id: { in: p.settlement_ids } } } }] : []),
      ],
    },
    include: { department: { select: { name: true } } },
    orderBy: { last_day: 'asc' },
  });
  const closed = p.state !== 'DRAFT' ? `${formatYearMonth(ym)} payroll has been generated` : p.steps_submitted.includes(4) ? 'The F&F step is submitted' : null;
  const rows = [];
  for (const l of leavers) {
    const s = await prisma.settlement.findFirst({ where: { employee_id: l.id, deleted_at: null }, orderBy: { created_at: 'desc' }, include: { period: { select: { period_ym: true } } } });
    if (s?.state === 'PAID' && !p.settlement_ids.includes(s.id)) continue;
    let result = null;
    let checklist = [];
    let error = null;
    try {
      ({ result, checklist } = await computeSettlementFor(prisma, l.id));
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not work it out';
    }
    const elsewhere = s?.state === 'INCLUDED' && s.period && s.period.period_ym !== ym ? s.period.period_ym : null;
    const open = checklist.filter((t) => t.required && !t.done_at);
    rows.push({
      employee: { id: l.id, code: l.code, name: l.name, department: l.department.name, status: l.status },
      last_day: fromDbDate(l.last_day),
      exit_reason: l.exit_reason,
      settlement_id: s?.id ?? null,
      mode: s && p.settlement_ids.includes(s.id) ? (s.paid_separately ? 'SEPARATE' : 'PAYROLL') : 'LATER',
      paid_separately: s?.paid_separately ?? null,
      processed_elsewhere: elsewhere,
      checklist_open: open.map((t) => t.label),
      blocking: (result?.clearance ?? []).filter((c) => c.severity === 'BLOCKING' && c.code !== 'ATTENDANCE_NOT_SUBMITTED').map((c) => c.message),
      total_earnings: result?.total_earnings ?? null,
      total_deductions: result?.total_deductions ?? null,
      net: result?.net ?? null,
      error,
    });
  }
  res.json({ data: { rows, closed } });
});

/** Queued; returns a job id. A second concurrent run is rejected, not queued. */
export const startRun = asyncHandler(async (req, res) => {
  const ym = ymParam(req.params.ym);
  const jobId = randomUUID();
  await claimRun(ym, jobId);
  const { actor } = who(req);
  try {
    await enqueue('payroll.run', { ym, actor }, actor, jobId);
  } catch (err) {
    await releaseRun(ym);
    throw err;
  }
  res.status(202).json({ data: { job_id: jobId } });
});

export const getJob = asyncHandler(async (req, res) => {
  const j = await prisma.job.findUnique({ where: { id: req.params.id } });
  if (!j) throw notFound('That job');
  res.json({ data: j });
});

// ─── State transitions ──────────────────────────────────────────────────────

/** Move a payroll month between states: back to its steps, lock, unlock, or unmark paid. Every move is audited. */
export const transitionPeriod = (t) =>
  asyncHandler(async (req, res) => {
    const { actor, ip } = who(req);
    const p = await transition(ymParam(req.params.ym), t, actor, ip);
    res.json({ data: periodOut(p) });
  });

export const markPaid = asyncHandler(async (req, res) => {
  const b = markPaidSchema.parse(req.body);
  const { actor, ip } = who(req);
  const clash = await prisma.payrollPeriod.findFirst({ where: { payment_ref: b.payment_ref, period_ym: { not: ymParam(req.params.ym) } } });
  if (clash) throw new AppError('CONFLICT', `Payment reference ${b.payment_ref} is already used by ${formatYearMonth(clash.period_ym)}.`, 409, 'payment_ref');
  const p = await transition(ymParam(req.params.ym), 'mark_paid', actor, ip, { payment_ref: b.payment_ref });
  res.json({ data: periodOut(p) });
});

// ─── Reports and payslips (from the snapshot) ───────────────────────────────
export const listReports = asyncHandler(async (_req, res) => {
  res.json({ data: REPORTS });
});

export const getReport = asyncHandler(async (req, res) => {
  const ym = ymParam(req.params.ym);
  const key = req.params.name;
  if (!REPORTS.some((r) => r.key === key)) throw notFound('That report');
  const format = req.query.format || 'json';
  const wantsPii = format !== 'json' && can(req, 'pii.read');
  const company = companyParam(req.query.company);
  const report = await buildReport(prisma, ym, key, { pii: wantsPii, company });
  if (report.pii && wantsPii) await auditReq(req, { action: 'pii.read', entity_type: 'report', entity_id: null, detail: { report: key, period: ym, rows: report.rows.length } });
  if (format === 'json') {
    const q = req.query.q?.toLowerCase();
    const rows = q
      ? report.rows.filter(
          (r) =>
            String(r.name ?? '')
              .toLowerCase()
              .includes(q) ||
            String(r.code ?? '')
              .toLowerCase()
              .includes(q),
        )
      : report.rows;
    return res.json({ data: { ...report, rows }, meta: { total: rows.length, nextCursor: null } });
  }
  if (!can(req, 'reports.export')) throw new AppError('FORBIDDEN', 'Exporting reports needs the export permission.', 403);
  const q = req.query.q?.toLowerCase();
  const filtered = q
    ? {
        ...report,
        rows: report.rows.filter(
          (r) =>
            String(r.name ?? '')
              .toLowerCase()
              .includes(q) ||
            String(r.code ?? '')
              .toLowerCase()
              .includes(q),
        ),
      }
    : report;
  const suffix = `${company ? `-${company.toLowerCase()}` : ''}${q ? `-${q.replace(/[^a-z0-9]+/g, '-')}` : ''}`;
  await auditReq(req, { action: 'export.report', entity_type: 'report', detail: { report: key, period: ym, format, rows: filtered.rows.length } });
  if (format === 'xlsx') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="payroll-${key}-${ym}${suffix}.xlsx"`);
    return res.send(await reportXLSX(filtered));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="payroll-${key}-${ym}${suffix}.csv"`);
  res.send(reportCSV(filtered));
});

export const getPayslip = asyncHandler(async (req, res) => {
  const ym = ymParam(req.params.ym);
  const p = await prisma.payrollPeriod.findUnique({ where: { period_ym: ym } });
  if (!p) throw notFound('That payroll month');
  const slip = await prisma.payslip.findUnique({
    where: { period_id_employee_id: { period_id: p.id, employee_id: req.params.employeeId } },
    include: { lines: { orderBy: { seq: 'asc' } } },
  });
  if (!slip) throw notFound('A payslip for this person in this month');
  const company = await prisma.company.findFirst();
  const m = slip.meta;
  // Never ship ciphertext to the browser.
  const safeMeta = { ...m, bank: { last4: m.bank?.last4, ifsc: m.bank?.ifsc, name: m.bank?.name }, ids: { uan: m.ids?.uan, esi_number: m.ids?.esi_number, has_pan: !!m.ids?.pan_enc } };
  res.json({
    data: {
      ...slip,
      meta: safeMeta,
      paid_days: Number(slip.paid_days),
      lop_days: Number(slip.lop_days),
      period: { period_ym: ym, label: formatYearMonth(ym), state: p.state },
      company,
    },
  });
});
