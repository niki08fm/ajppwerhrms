import { firstOfMonth, formatYearMonth, GENERATE_STEP, LAST_REVIEW_STEP, lastOfMonth, ymOf } from '@ajpwer/shared';
import { solveGrossFromCtc } from '../calculations/index.js';
import { audit } from '../utils/audit.js';
import { fromDbDate, n, toDbDate } from '../utils/dbDates.js';
import { AppError } from '../utils/errors.js';
import { prisma } from '../config/db.js';
import { computeMonths } from './attendance.service.js';
import { computePayslip, loadRecoveries } from './payslip.service.js';
import { ptSlabs, ratesOn, regimesOn, structureComponents } from './rules.service.js';
import { computeSettlementFor } from './settlement.service.js';

export const employeeInclude = {
  statutory: true,
  identity: true,
  department: { select: { id: true, name: true } },
  pay_group: { select: { id: true, name: true } },
};

/** Load (or create) the period row. */
export async function getPeriod(db, ym) {
  const existing = await db.payrollPeriod.findUnique({ where: { period_ym: ym } });
  if (existing) return existing;
  return db.payrollPeriod.upsert({ where: { period_ym: ym }, update: {}, create: { period_ym: ym } });
}

export async function payContext(db, ym, ratesId) {
  const monthEnd = lastOfMonth(ym);
  const [rates, slabs, regimes, adhoc] = await Promise.all([
    ratesId ? import('./rules.service.js').then((m) => m.ratesById(db, ratesId)) : ratesOn(db, monthEnd),
    ptSlabs(db),
    regimesOn(db, monthEnd),
    db.adhocItem.findMany({ where: { period_ym: ym, deleted_at: null } }),
  ]);
  return { rates, pt_slabs: slabs, regimes, adhoc };
}

/**
 * Who the run covers. Nobody is paid before activation: OFFER, ACCEPTED and
 * ONBOARDING never appear. Leavers whose last day falls in the month appear only
 * if their F&F is processed in this run; a leaver from an earlier month whose F&F
 * is processed here appears too, with their final month (`final_ym`). People left
 * out of the run are removed.
 */
export async function runPopulation(db, ym, periodId, settlementIds) {
  const first = toDbDate(firstOfMonth(ym));
  const last = toDbDate(lastOfMonth(ym));
  const [candidates, exclusions, settlements] = await Promise.all([
    db.employee.findMany({
      where: {
        deleted_at: null,
        status: { in: ['ACTIVE', 'NOTICE', 'EXITED'] },
        joined_on: { lte: last },
        OR: [{ last_day: null }, { last_day: { gte: first } }, ...(settlementIds.length ? [{ settlements: { some: { id: { in: settlementIds } } } }] : [])],
      },
      include: employeeInclude,
      orderBy: { code: 'asc' },
    }),
    db.payrollExclusion.findMany({ where: { period_id: periodId, deleted_at: null } }),
    settlementIds.length ? db.settlement.findMany({ where: { id: { in: settlementIds } } }) : Promise.resolve([]),
  ]);
  const excluded = new Set(exclusions.map((x) => x.employee_id));
  const settlingIds = new Set(settlements.map((s) => s.employee_id));
  const included = [];
  const leaversOpen = [];
  for (const e of candidates) {
    if (excluded.has(e.id)) continue;
    const lastDay = fromDbDate(e.last_day);
    const leavesThisMonth = lastDay !== null && lastDay <= lastOfMonth(ym);
    if (e.status === 'EXITED' && !settlingIds.has(e.id)) continue;
    if (leavesThisMonth && !settlingIds.has(e.id)) {
      leaversOpen.push(e);
      continue;
    }
    // A leaver from an earlier month is paid their final month here, with the F&F.
    included.push(lastDay !== null && lastDay < firstOfMonth(ym) ? { ...e, final_ym: ymOf(lastDay) } : e);
  }
  return { included, excluded: exclusions, leaversOpen, settlingIds };
}

export function toPayslipEmployee(e) {
  return {
    id: e.id,
    code: e.code,
    name: e.name,
    gender: e.gender,
    joined_on: e.joined_on,
    last_day: e.last_day,
    status: e.status,
    department_id: e.department_id,
    pay_group_id: e.pay_group_id,
    statutory: e.statutory,
  };
}

/**
 * Held salary released into this month: its own lines, adding to net pay only. It was
 * taxed and counted as wages in the month it was earned, so it is neither again.
 */
function addReleasedHeld(result, rows) {
  let seq = result.lines.reduce((m, l) => Math.max(m, l.seq), 0);
  for (const h of rows) {
    const amount = n(h.amount);
    result.lines.push({ seq: ++seq, kind: 'HELD', code: `HELD:${h.period_ym}`, name: `Held salary for ${formatYearMonth(h.period_ym)}`, full_amount: amount, amount, is_taxable: false, counts_as_wages: false });
    result.net += amount;
    result.held_released = (result.held_released ?? 0) + amount;
  }
}

/**
 * Compute every payslip for a month from live data without writing anything. A salary hold
 * standing this month marks the payslip held: calculated as usual, kept out of the bank file.
 */
export async function computeRun(db, ym, employees, ctx, settlingIds, onProgress) {
  const regular = employees.filter((e) => !e.final_ym);
  const ids = employees.map((e) => e.id);
  const months = await computeMonths(db, regular, ym);
  const recoveries = await loadRecoveries(
    db,
    regular.map((e) => e.id),
    ym,
  );
  // A leaver from an earlier month: their final month, worked out for that month as the F&F does.
  const finals = new Map();
  for (const e of employees.filter((x) => x.final_ym)) {
    finals.set(e.id, { month: (await computeMonths(db, [e], e.final_ym)).get(e.id), ctx: await payContext(db, e.final_ym) });
  }
  const [holds, queued] = await Promise.all([
    db.salaryHold.findMany({ where: { employee_id: { in: ids }, deleted_at: null, released_at: null, from_ym: { lte: ym } } }),
    db.heldPay.findMany({ where: { employee_id: { in: ids }, state: 'QUEUED', pay_ym: ym } }),
  ]);
  const payslips = [];
  const errors = [];
  let done = 0;
  for (const e of employees) {
    try {
      const settling = settlingIds.has(e.id);
      const fin = finals.get(e.id);
      // A settling leaver's loans and advances are recovered in full by the settlement, not by EMI.
      const rec = settling ? null : (recoveries.get(e.id) ?? null);
      const p = fin ? await computePayslip(db, toPayslipEmployee(e), e.final_ym, fin.month, fin.ctx, null) : await computePayslip(db, toPayslipEmployee(e), ym, months.get(e.id), ctx, rec);
      // The F&F pays a leaver; a hold ends when it is processed.
      const hold = settling ? null : (holds.find((h) => h.employee_id === e.id) ?? null);
      // Held salary released into this month is paid as its own line — not while this month is held, nor for a leaver whose F&F pays it.
      const release = hold || settling ? [] : queued.filter((q) => q.employee_id === e.id);
      if (release.length) addReleasedHeld(p.result, release);
      payslips.push({ ...p, employee: e, hold, final_ym: e.final_ym ?? null, released: release });
    } catch (err) {
      errors.push({ employee_id: e.id, code: e.code, name: e.name, message: err instanceof Error ? err.message : String(err) });
    }
    done++;
    if (onProgress) await onProgress(done, employees.length);
  }
  return { payslips, errors };
}

// ─── Issues (step 3) ────────────────────────────────────────────────────────

export const ISSUE_LABELS = {
  NO_BANK: 'No bank account',
  NEGATIVE_NET: 'Negative net pay',
  NOT_EMPLOYED: 'Not employed this month',
  COMPUTE_FAILED: 'Payslip could not be computed',
  NO_PAN: 'Missing PAN',
  NO_UAN: 'Missing UAN',
  NO_AADHAAR: 'Missing Aadhaar',
  NO_FACE: 'Face not enrolled',
  EXPIRED_DOCS: 'Expired documents',
  MANY_ABSENCES: 'Many absences',
  CTC_ESI_BAND: 'CTC in the ESI band',
  OT_OVER_CAP: 'Overtime over the monthly cap',
  NO_POLICY: 'No attendance policy on some days',
  HELD_NOT_PAID: 'Released held salary not paid',
};

export async function computeIssues(db, ym) {
  const period = await getPeriod(db, ym);
  const population = await runPopulation(db, ym, period.id, period.settlement_ids);
  const ctx = await payContext(db, ym);
  const run = await computeRun(db, ym, population.included, ctx, population.settlingIds);
  const ids = population.included.map((e) => e.id);
  const [faces, expired] = await Promise.all([
    db.employeeFace.groupBy({ by: ['employee_id'], where: { employee_id: { in: ids }, deleted_at: null } }),
    db.document.findMany({ where: { employee_id: { in: ids }, deleted_at: null, expires_on: { lt: toDbDate(lastOfMonth(ym)) } }, select: { employee_id: true, doc_type: true } }),
  ]);
  const hasFace = new Set(faces.map((f) => f.employee_id));
  const ctxForBand = run.payslips.some((p) => p.salary.mode === 'CTC') ? await payContext(db, ym) : null;
  const issues = [];
  const add = (e, kind, severity, message, fix_tab) => issues.push({ kind, severity, employee_id: e.id, code: e.code, name: e.name, message, fix_tab });

  for (const err of run.errors) {
    issues.push({ kind: 'COMPUTE_FAILED', severity: 'BLOCKING', employee_id: err.employee_id, code: err.code, name: err.name, message: err.message, fix_tab: 'pay' });
  }
  const first = firstOfMonth(ym);
  const last = lastOfMonth(ym);
  const heldIds = new Set(run.payslips.filter((p) => p.hold).map((p) => p.employee.id));
  for (const e of population.included) {
    const idn = e.identity;
    if (!idn?.bank_account_enc || !idn.bank_ifsc) {
      if (heldIds.has(e.id)) add(e, 'NO_BANK', 'WARNING', 'No bank account on file. The salary is on hold, so nothing is transferred until it is released.', 'overview');
      else add(e, 'NO_BANK', 'BLOCKING', 'No bank account on file — the salary cannot be transferred. Add one, or hold the salary.', 'overview');
    }
    const joined = fromDbDate(e.joined_on);
    const lastDay = fromDbDate(e.last_day);
    // A leaver from an earlier month is here for their F&F, not for this month's work.
    if (joined > last || (lastDay && lastDay < first && !e.final_ym)) add(e, 'NOT_EMPLOYED', 'BLOCKING', 'Not employed on any day of this month.', 'overview');
    if (!idn?.pan_enc) add(e, 'NO_PAN', 'WARNING', 'No PAN — TDS may need to be deducted at a higher rate.', 'overview');
    if (e.statutory?.pf_enabled && !idn?.uan) add(e, 'NO_UAN', 'WARNING', 'PF is on but there is no UAN for the ECR.', 'overview');
    if (!idn?.aadhaar_enc) add(e, 'NO_AADHAAR', 'WARNING', 'No Aadhaar on file.', 'overview');
    if (!hasFace.has(e.id)) add(e, 'NO_FACE', 'WARNING', 'Face not enrolled — this person cannot punch at a site.', 'onboarding');
    const exp = expired.filter((d) => d.employee_id === e.id);
    if (exp.length) add(e, 'EXPIRED_DOCS', 'WARNING', `Expired: ${exp.map((d) => d.doc_type).join(', ')}.`, 'documents');
  }
  // Held salary released into this month that this run cannot pay stays released, unpaid, until HR changes it.
  const paidHere = new Set(run.payslips.flatMap((p) => p.released.map((h) => h.id)));
  const stranded = await db.heldPay.findMany({ where: { state: 'QUEUED', pay_ym: ym }, include: { employee: { select: { id: true, code: true, name: true } } } });
  for (const h of stranded) {
    if (paidHere.has(h.id)) continue;
    add(h.employee, 'HELD_NOT_PAID', 'WARNING', `Held salary for ${formatYearMonth(h.period_ym)} is released into this month but cannot be paid here (left out, on hold again, or paid with the F&F). Mark it paid separately on Held salaries, or release it into another month.`, 'pay');
  }
  for (const p of run.payslips) {
    const e = p.employee;
    if (p.result.net < 0) add(e, 'NEGATIVE_NET', 'BLOCKING', `Net pay would be −₹${Math.round(-p.result.net / 100).toLocaleString('en-IN')}.`, 'loans');
    const absences = p.result.lop_days;
    if (absences > 3 && !fromDbDate(e.last_day)) add(e, 'MANY_ABSENCES', 'WARNING', `${absences} days loss of pay this month.`, 'attendance');
    if (p.result.flags.includes('OT_OVER_CAP')) add(e, 'OT_OVER_CAP', 'WARNING', `${Math.round((p.result.ot?.excess_min ?? 0) / 60)} hours of overtime above the cap are unpaid.`, 'attendance');
    if (p.salary.mode === 'CTC' && e.statutory?.esi_enabled && ctxForBand) {
      const components = await structureComponents(db, p.salary.structure_id);
      const ctx = ctxForBand;
      const sol = solveGrossFromCtc(p.salary.amount, {
        components,
        pf: { pf_enabled: e.statutory.pf_enabled, pf_restrict_to_ceiling: e.statutory.pf_restrict_to_ceiling, vpf_pct: Number(e.statutory.vpf_pct) },
        esi_enabled: true,
        rates: { pf: ctx.rates.pf, esi: ctx.rates.esi },
      });
      if (sol.ambiguous) add(e, 'CTC_ESI_BAND', 'WARNING', 'The agreed CTC has two valid grosses either side of the ESI ceiling.', 'pay');
    }
  }
  return { issues, run, population };
}

// ─── Step gates ─────────────────────────────────────────────────────────────

export async function submitStep(ym, step, actor, ip) {
  return prisma.$transaction(
    async (tx) => {
      const period = await getPeriod(tx, ym);
      await tx.$queryRaw`SELECT id FROM payroll_period WHERE id = ${period.id}::uuid FOR UPDATE`;
      if (period.state !== 'DRAFT') throw new AppError('PERIOD_LOCKED', `${formatYearMonth(ym)} has been run. Take it back to its steps to change them.`, 409);
      if (step < 1 || step > LAST_REVIEW_STEP) throw new AppError('VALIDATION', `Steps 1 to ${LAST_REVIEW_STEP} are submitted; step ${GENERATE_STEP} is generating the payroll.`, 422);
      for (let s = 1; s < step; s++) {
        if (!period.steps_submitted.includes(s)) throw new AppError('STEP_NOT_SUBMITTED', `Submit step ${s} first.`, 409);
      }
      if (step === 4) {
        // A ticked settlement with a blocking clearance issue stops the step.
        for (const sid of period.settlement_ids) {
          const s = await tx.settlement.findUnique({ where: { id: sid }, include: { employee: true } });
          if (!s) continue;
          const fresh = await computeSettlementFor(tx, s.employee_id, { attendanceSubmitted: true });
          const blocking = fresh.result.clearance.filter((c) => c.severity === 'BLOCKING');
          if (blocking.length) {
            throw new AppError('BLOCKING_ISSUES', `${s.employee.name}'s settlement cannot go out: ${blocking.map((b) => b.message).join('; ')}. Untick it or fix it.`, 409);
          }
        }
      }
      if (step === 3) {
        const { issues } = await computeIssues(tx, ym);
        const blocking = issues.filter((i) => i.severity === 'BLOCKING');
        if (blocking.length) {
          throw new AppError(
            'BLOCKING_ISSUES',
            `${blocking.length} blocking issue${blocking.length > 1 ? 's' : ''} stand. Fix each one or hold the person back from this run.`,
            409,
            null,
            blocking.slice(0, 50),
          );
        }
      }
      const steps = [...new Set([...period.steps_submitted, step])].sort();
      const log = [...(period.step_log ?? []), { step, action: 'submit', by: actor, at: new Date().toISOString() }];
      const updated = await tx.payrollPeriod.update({ where: { id: period.id }, data: { steps_submitted: steps, step_log: log } });
      await audit(tx, { actor, ip, action: 'payroll.step.submit', entity_type: 'payroll_period', entity_id: period.id, detail: { ym, step } });
      return updated;
    },
    { timeout: 120_000 },
  );
}

/** Reopening a step clears it and every later step; earlier steps stay submitted. */
export async function reopenStep(ym, step, actor, ip) {
  return prisma.$transaction(async (tx) => {
    const period = await getPeriod(tx, ym);
    if (period.state !== 'DRAFT') throw new AppError('PERIOD_LOCKED', `${formatYearMonth(ym)} has been run. Take it back to its steps first.`, 409);
    const steps = period.steps_submitted.filter((s) => s < step);
    const log = [...(period.step_log ?? []), { step, action: 'reopen', by: actor, at: new Date().toISOString() }];
    const updated = await tx.payrollPeriod.update({ where: { id: period.id }, data: { steps_submitted: steps, step_log: log } });
    await audit(tx, { actor, ip, action: 'payroll.step.reopen', entity_type: 'payroll_period', entity_id: period.id, detail: { ym, step, cleared: period.steps_submitted.filter((s) => s >= step) } });
    return updated;
  });
}

// ─── The run ────────────────────────────────────────────────────────────────

/**
 * Claim the period for a run. Atomic: a second concurrent request finds the
 * claim taken and is rejected with a clear message rather than queued.
 */
export async function claimRun(ym, jobId) {
  const period = await getPeriod(prisma, ym);
  if (period.state === 'LOCKED' || period.state === 'PAID') {
    throw new AppError('PERIOD_LOCKED', `${formatYearMonth(ym)} is ${period.state.toLowerCase()}. Unlock it to rerun.`, 409);
  }
  for (let s = 1; s <= LAST_REVIEW_STEP; s++) {
    if (!period.steps_submitted.includes(s)) throw new AppError('STEP_NOT_SUBMITTED', `Submit step ${s} before generating the payroll.`, 409);
  }
  const claimed = await prisma.$executeRaw`
    UPDATE payroll_period SET running_job_id = ${jobId}::uuid
    WHERE period_ym = ${ym} AND running_job_id IS NULL AND state IN ('DRAFT', 'RUN')`;
  if (claimed === 0) {
    throw new AppError('RUN_IN_PROGRESS', `A payroll run for ${formatYearMonth(ym)} is already in progress. Wait for it to finish.`, 409);
  }
}

export async function releaseRun(ym) {
  await prisma.$executeRaw`UPDATE payroll_period SET running_job_id = NULL WHERE period_ym = ${ym}`;
}

function lineData(payslipId, l) {
  return {
    payslip_id: payslipId,
    seq: l.seq,
    kind: l.kind,
    code: l.code,
    name: l.name,
    full_amount: BigInt(l.full_amount),
    amount: BigInt(l.amount),
    is_taxable: l.is_taxable,
    counts_as_wages: l.counts_as_wages,
  };
}

/**
 * Compute every payslip and write the snapshot, as one transaction: either the
 * whole run commits or nothing does. The snapshot records the statutory rates
 * row and engine version used.
 */
export async function executeRun(ym, actor, onProgress) {
  return prisma.$transaction(
    async (tx) => {
      const [period] = await tx.$queryRaw`SELECT id FROM payroll_period WHERE period_ym = ${ym} FOR UPDATE`;
      const p = await tx.payrollPeriod.findUniqueOrThrow({ where: { id: period.id } });
      const ctx = await payContext(tx, ym);
      const population = await runPopulation(tx, ym, p.id, p.settlement_ids);
      const run = await computeRun(tx, ym, population.included, ctx, population.settlingIds, onProgress);
      if (run.errors.length) {
        throw new AppError(
          'BLOCKING_ISSUES',
          `${run.errors.length} payslip${run.errors.length > 1 ? 's' : ''} could not be computed: ${run.errors
            .slice(0, 3)
            .map((e) => `${e.code} — ${e.message}`)
            .join('; ')}`,
          409,
          null,
          run.errors,
        );
      }
      const negatives = run.payslips.filter((x) => x.result.net < 0 && !population.settlingIds.has(x.employee_id));
      if (negatives.length) {
        throw new AppError('BLOCKING_ISSUES', `${negatives.length} payslip${negatives.length > 1 ? 's have' : ' has'} negative net pay. Hold them back or fix them.`, 409);
      }

      // Rerun replaces the snapshot, and the held months it recorded.
      await tx.payslip.deleteMany({ where: { period_id: p.id } });
      await tx.heldPay.deleteMany({ where: { period_ym: ym, state: 'HELD' } });

      const computedAt = new Date();
      const totals = { headcount: 0, gross: 0, net: 0, employer: 0, ctc: 0, deductions: 0, reimbursements: 0, lop_days: 0, ot_amount: 0, held_count: 0, held_net: 0, held_released: 0 };
      for (const ps of run.payslips) {
        const e = ps.employee;
        const r = ps.result;
        const created = await tx.payslip.create({
          data: {
            period_id: p.id,
            employee_id: e.id,
            gross: BigInt(r.gross),
            salary_gross: BigInt(r.salary_gross),
            adhoc_earnings: BigInt(r.adhoc_earnings),
            total_deductions: BigInt(r.total_deductions),
            reimbursements: BigInt(r.reimbursements),
            net: BigInt(r.net),
            employer_total: BigInt(r.employer_total),
            ctc_month: BigInt(r.ctc_month),
            pf_wage: BigInt(r.pf_wage),
            esi_applicable: r.esi_applicable,
            paid_days: r.paid_days,
            lop_days: r.lop_days,
            divisor: r.divisor,
            computed_at: computedAt,
            engine_version: r.engine_version,
            meta: JSON.parse(
              JSON.stringify({
                employee: { code: e.code, name: e.name, designation: e.designation, gender: e.gender, joined_on: fromDbDate(e.joined_on), last_day: fromDbDate(e.last_day) },
                department: e.department,
                pay_group: e.pay_group,
                bank: { account_enc: e.identity?.bank_account_enc ?? null, last4: e.identity?.bank_last4 ?? null, ifsc: e.identity?.bank_ifsc ?? null, name: e.identity?.bank_name ?? null },
                ids: { pan_enc: e.identity?.pan_enc ?? null, uan: e.identity?.uan ?? null, esi_number: e.identity?.esi_number ?? null },
                salary: ps.salary,
                attendance: ps.attendance,
                // The month's leave: later months start from these balances once this month is locked.
                leave: ps.leave ?? null,
                lop_rule: r.lop_rule,
                lop_rule_text: r.lop_rule_text,
                ot: r.ot,
                tds: r.tds,
                pf_charges: r.pf_charges,
                regime: ps.regime,
                pt_state: ps.pt_state,
                pt_basis: r.pt_basis,
                esi: ps.esi,
                statutory_gross: r.statutory_gross,
                employee_statutory: r.employee_statutory,
                recovery: r.recovery,
                flags: r.flags,
                settling: population.settlingIds.has(e.id),
                // A leaver from an earlier month paid here with their F&F: this payslip is that final month.
                final_month_ym: ps.final_ym,
                // Calculated as usual and kept out of the bank file until HR releases it.
                held: ps.hold ? { hold_id: ps.hold.id, reason: ps.hold.reason, from_ym: ps.hold.from_ym } : null,
                months_in_fy: ps.months_in_fy,
              }),
            ),
          },
        });
        await tx.payslipLine.createMany({ data: r.lines.map((l) => lineData(created.id, l)) });
        if (ps.hold) {
          await tx.heldPay.create({ data: { hold_id: ps.hold.id, employee_id: e.id, period_ym: ym, amount: BigInt(r.net), state: 'HELD' } });
          totals.held_count++;
          totals.held_net += r.net;
        }
        totals.held_released += r.held_released ?? 0;

        // ESI: record the contribution-period decision.
        if (e.statutory && ps.esi.locked_until !== fromDbDate(e.statutory.esi_locked_until)) {
          await tx.employeeStatutory.update({ where: { employee_id: e.id }, data: { esi_locked_until: ps.esi.locked_until ? toDbDate(ps.esi.locked_until) : null } });
        }

        totals.headcount++;
        totals.gross += r.gross;
        totals.net += r.net;
        totals.employer += r.employer_total;
        totals.ctc += r.ctc_month;
        totals.deductions += r.total_deductions;
        totals.reimbursements += r.reimbursements;
        totals.lop_days += r.lop_days;
        totals.ot_amount += r.ot?.amount ?? 0;
      }

      const steps = [...new Set([...p.steps_submitted, GENERATE_STEP])].sort();
      const updated = await tx.payrollPeriod.update({
        where: { id: p.id },
        data: {
          state: 'RUN',
          run_at: computedAt,
          run_by: actor,
          statutory_rates_id: ctx.rates.id,
          steps_submitted: steps,
          totals: { ...totals, excluded: population.excluded.length, settlements: p.settlement_ids.length },
          running_job_id: null,
        },
      });
      await audit(tx, {
        actor,
        action: p.state === 'RUN' ? 'payroll.rerun' : 'payroll.run',
        entity_type: 'payroll_period',
        entity_id: p.id,
        detail: { ym, from: p.state, to: 'RUN', totals, statutory_rates_id: ctx.rates.id },
      });
      return { period: updated, totals };
    },
    { timeout: 300_000, maxWait: 10_000 },
  );
}

// ─── State transitions ──────────────────────────────────────────────────────

const ALLOWED = {
  back_to_steps: { from: 'RUN', to: 'DRAFT' },
  lock: { from: 'RUN', to: 'LOCKED' },
  unlock: { from: 'LOCKED', to: 'RUN' },
  mark_paid: { from: 'LOCKED', to: 'PAID' },
  unmark_paid: { from: 'PAID', to: 'LOCKED' },
};

export async function transition(ym, t, actor, ip, opts = {}) {
  return prisma.$transaction(async (tx) => {
    await getPeriod(tx, ym);
    const [row] = await tx.$queryRaw`SELECT id FROM payroll_period WHERE period_ym = ${ym} FOR UPDATE`;
    const p = await tx.payrollPeriod.findUniqueOrThrow({ where: { id: row.id } });
    if (p.running_job_id) throw new AppError('RUN_IN_PROGRESS', 'A run is in progress. Wait for it to finish.', 409);
    const rule = ALLOWED[t];
    if (t === 'mark_paid' && p.state === 'PAID' && opts.payment_ref && p.payment_ref === opts.payment_ref) {
      return p; // idempotent: a double submit does not produce two payment records
    }
    if (p.state !== rule.from) {
      throw new AppError('INVALID_TRANSITION', `${formatYearMonth(ym)} is ${p.state}; this action needs it to be ${rule.from}.`, 409);
    }
    const data = { state: rule.to };
    if (t === 'unlock') {
      // A held month already released or paid elsewhere cannot be run again: it would be paid twice.
      const moved = await tx.heldPay.count({ where: { period_ym: p.period_ym, state: { not: 'HELD' } } });
      if (moved) throw new AppError('CONFLICT', `Salary held in ${formatYearMonth(ym)} has been released or paid. Unlocking would let it be paid twice.`, 409);
    }
    if (t === 'back_to_steps') {
      await tx.payslip.deleteMany({ where: { period_id: p.id } });
      await tx.heldPay.deleteMany({ where: { period_ym: p.period_ym, state: 'HELD' } });
      data.steps_submitted = p.steps_submitted.filter((s) => s !== GENERATE_STEP);
      data.run_at = null;
      data.totals = null;
    }
    if (t === 'lock') data.locked_at = new Date();
    if (t === 'unlock') data.locked_at = null;
    if (t === 'mark_paid') {
      if (!opts.payment_ref) throw new AppError('VALIDATION', 'A payment reference is required.', 422, 'payment_ref');
      data.paid_at = new Date();
      data.payment_ref = opts.payment_ref;
      await applyPaid(tx, p.id, p.period_ym, p.settlement_ids, 1);
    }
    if (t === 'unmark_paid') {
      data.paid_at = null;
      data.payment_ref = null;
      await applyPaid(tx, p.id, p.period_ym, p.settlement_ids, -1);
    }
    const updated = await tx.payrollPeriod.update({ where: { id: p.id }, data });
    await audit(tx, {
      actor,
      ip,
      action: `payroll.${t}`,
      entity_type: 'payroll_period',
      entity_id: p.id,
      detail: { ym, from: p.state, to: rule.to, payment_ref: opts.payment_ref ?? p.payment_ref ?? undefined, loud: t === 'unmark_paid' ? 'The bank transfer had already been sent' : undefined },
    });
    return updated;
  });
}

/**
 * Marking paid applies recoveries to loans and advances, writes the capped
 * carry-forward into next month, freezes included settlements and exits their
 * employees. Unmarking reverses every one of those.
 */
async function applyPaid(tx, periodId, ym, settlementIds, sign) {
  const payslips = await tx.payslip.findMany({ where: { period_id: periodId }, select: { employee_id: true, meta: true } });
  const nextYm = (() => {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(Date.UTC(y, m, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  })();
  for (const ps of payslips) {
    const rec = ps.meta.recovery;
    if (!rec) continue;
    for (const it of rec.items) {
      if (!it.ref_id || it.recovered <= 0) continue;
      if (it.type === 'LOAN') {
        const loan = await tx.loan.findUnique({ where: { id: it.ref_id } });
        if (!loan) continue;
        const recovered = n(loan.recovered) + sign * it.recovered;
        await tx.loan.update({
          where: { id: loan.id },
          data: {
            recovered: BigInt(recovered),
            instalments_paid: loan.instalments_paid + sign,
            status: recovered >= n(loan.principal) ? 'CLOSED' : 'ACTIVE',
          },
        });
      }
      if (it.type === 'ADVANCE') {
        const adv = await tx.advance.findUnique({ where: { id: it.ref_id } });
        if (!adv) continue;
        const recovered = n(adv.recovered) + sign * it.recovered;
        await tx.advance.update({ where: { id: adv.id }, data: { recovered: BigInt(recovered), status: recovered >= n(adv.amount) ? 'CLOSED' : 'ACTIVE' } });
      }
    }
    if (sign === 1 && rec.carry_forward > 0) {
      await tx.recoveryCarry.upsert({
        where: { employee_id_period_ym: { employee_id: ps.employee_id, period_ym: nextYm } },
        update: { amount: BigInt(rec.carry_forward), deleted_at: null },
        create: { employee_id: ps.employee_id, period_ym: nextYm, amount: BigInt(rec.carry_forward) },
      });
    }
    if (sign === -1) {
      await tx.recoveryCarry.updateMany({ where: { employee_id: ps.employee_id, period_ym: nextYm }, data: { deleted_at: new Date() } });
    }
    // The carry taken this month is consumed.
    const carryItem = rec.items.find((i) => i.type === 'CARRY');
    if (carryItem && carryItem.recovered > 0) {
      await tx.recoveryCarry.updateMany({ where: { employee_id: ps.employee_id, period_ym: ym }, data: { deleted_at: sign === 1 ? new Date() : null } });
    }
  }
  // Held-back people paid in this run are resolved.
  if (sign === 1) {
    await tx.payrollExclusion.updateMany({
      where: { employee_id: { in: payslips.map((p) => p.employee_id) }, resolved_at: null, period_id: { not: periodId } },
      data: { resolved_at: new Date() },
    });
  }
  // Held salary released into this month is paid with it (and unpaid again if this is reversed).
  const heldLines = await tx.payslipLine.findMany({ where: { kind: 'HELD', payslip: { period_id: periodId } }, select: { code: true, payslip: { select: { employee_id: true } } } });
  for (const l of heldLines) {
    await tx.heldPay.updateMany({
      where: { employee_id: l.payslip.employee_id, period_ym: l.code.slice('HELD:'.length), pay_ym: ym, settlement_id: null, state: sign === 1 ? 'QUEUED' : 'PAID' },
      data: { state: sign === 1 ? 'PAID' : 'QUEUED' },
    });
  }
  for (const sid of settlementIds) {
    const s = await tx.settlement.findUnique({ where: { id: sid } });
    if (!s) continue;
    if (sign === 1) {
      await tx.settlement.update({ where: { id: sid }, data: { state: 'PAID', paid_at: new Date(), period_id: periodId } });
      // Held salary the F&F pays is paid with it — through this month's bank file, or separately.
      const months = (Array.isArray(s.earnings) ? s.earnings : []).filter((l) => l.code.startsWith('HELD:') && !l.excluded).map((l) => l.code.slice('HELD:'.length));
      if (months.length) {
        const sep = s.paid_separately;
        await tx.heldPay.updateMany({
          where: { employee_id: s.employee_id, period_ym: { in: months }, state: 'HELD' },
          data: { state: sep ? 'PAID_SEPARATELY' : 'PAID', settlement_id: s.id, pay_ym: ym, paid_on: sep ? new Date(`${sep.paid_on}T00:00:00Z`) : null, payment_ref: sep?.payment_ref ?? null },
        });
      }
      await tx.loan.updateMany({ where: { employee_id: s.employee_id, status: 'ACTIVE' }, data: { status: 'CLOSED' } });
      await tx.advance.updateMany({ where: { employee_id: s.employee_id, status: 'ACTIVE' }, data: { status: 'CLOSED' } });
      await tx.employee.update({ where: { id: s.employee_id }, data: { status: 'EXITED' } });
      // Delete the biometric on exit; keep the employment and payroll record.
      await tx.employeeFace.updateMany({ where: { employee_id: s.employee_id, deleted_at: null }, data: { deleted_at: new Date(), embedding: Buffer.alloc(0) } });
    } else {
      await tx.settlement.update({ where: { id: sid }, data: { state: 'INCLUDED', paid_at: null } });
      await tx.employee.update({ where: { id: s.employee_id }, data: { status: 'NOTICE' } });
      await tx.heldPay.updateMany({ where: { settlement_id: s.id }, data: { state: 'HELD', settlement_id: null, pay_ym: null, paid_on: null, payment_ref: null } });
    }
  }
}

/** Held back from a run and not yet paid in a later one — shown on the dashboard until resolved. */
export async function heldBackList(db) {
  const rows = await db.payrollExclusion.findMany({
    where: { resolved_at: null, deleted_at: null },
    include: { period: { select: { period_ym: true } }, employee: { select: { id: true, code: true, name: true } } },
    orderBy: { created_at: 'desc' },
  });
  return rows.map((r) => ({ id: r.id, employee: r.employee, period_ym: r.period.period_ym, reason: r.reason, since: r.created_at }));
}

export const periodDates = (ym) => ({ first: firstOfMonth(ym), last: lastOfMonth(ym) });
