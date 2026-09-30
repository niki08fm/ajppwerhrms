import { firstOfMonth, formatYearMonth, lastOfMonth } from '@ajpwer/shared';
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
 * if their settlement is ticked for this run. Held-back people are removed.
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
        OR: [{ last_day: null }, { last_day: { gte: first } }],
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
    included.push(e);
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

/** Compute every payslip for a month from live data without writing anything. */
export async function computeRun(db, ym, employees, ctx, settlingIds, onProgress) {
  const months = await computeMonths(db, employees, ym);
  const recoveries = await loadRecoveries(
    db,
    employees.map((e) => e.id),
    ym,
  );
  const payslips = [];
  const errors = [];
  let done = 0;
  for (const e of employees) {
    try {
      // A settling leaver's loans and advances are recovered in full by the settlement, not by EMI.
      const rec = settlingIds.has(e.id) ? null : (recoveries.get(e.id) ?? null);
      const p = await computePayslip(db, toPayslipEmployee(e), ym, months.get(e.id), ctx, rec);
      payslips.push({ ...p, employee: e });
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
  for (const e of population.included) {
    const idn = e.identity;
    if (!idn?.bank_account_enc || !idn.bank_ifsc) add(e, 'NO_BANK', 'BLOCKING', 'No bank account on file — the salary cannot be transferred.', 'overview');
    const joined = fromDbDate(e.joined_on);
    const lastDay = fromDbDate(e.last_day);
    if (joined > last || (lastDay && lastDay < first)) add(e, 'NOT_EMPLOYED', 'BLOCKING', 'Not employed on any day of this month.', 'overview');
    if (!idn?.pan_enc) add(e, 'NO_PAN', 'WARNING', 'No PAN — TDS may need to be deducted at a higher rate.', 'overview');
    if (e.statutory?.pf_enabled && !idn?.uan) add(e, 'NO_UAN', 'WARNING', 'PF is on but there is no UAN for the ECR.', 'overview');
    if (!idn?.aadhaar_enc) add(e, 'NO_AADHAAR', 'WARNING', 'No Aadhaar on file.', 'overview');
    if (!hasFace.has(e.id)) add(e, 'NO_FACE', 'WARNING', 'Face not enrolled — this person cannot punch at a site.', 'onboarding');
    const exp = expired.filter((d) => d.employee_id === e.id);
    if (exp.length) add(e, 'EXPIRED_DOCS', 'WARNING', `Expired: ${exp.map((d) => d.doc_type).join(', ')}.`, 'documents');
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
      if (step < 1 || step > 4) throw new AppError('VALIDATION', 'Steps 1 to 4 are submitted; step 5 is the run itself.', 422);
      for (let s = 1; s < step; s++) {
        if (!period.steps_submitted.includes(s)) throw new AppError('STEP_NOT_SUBMITTED', `Submit step ${s} first.`, 409);
      }
      if (step === 2) {
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
  for (const s of [1, 2, 3, 4]) {
    if (!period.steps_submitted.includes(s)) throw new AppError('STEP_NOT_SUBMITTED', `Submit step ${s} before running payroll.`, 409);
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

      // Rerun replaces the snapshot.
      await tx.payslip.deleteMany({ where: { period_id: p.id } });

      const computedAt = new Date();
      const totals = { headcount: 0, gross: 0, net: 0, employer: 0, ctc: 0, deductions: 0, reimbursements: 0, lop_days: 0, ot_amount: 0 };
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
                months_in_fy: ps.months_in_fy,
              }),
            ),
          },
        });
        await tx.payslipLine.createMany({ data: r.lines.map((l) => lineData(created.id, l)) });

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

      const steps = [...new Set([...p.steps_submitted, 5])].sort();
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
    if (t === 'back_to_steps') {
      await tx.payslip.deleteMany({ where: { period_id: p.id } });
      data.steps_submitted = p.steps_submitted.filter((s) => s !== 5);
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
  for (const sid of settlementIds) {
    const s = await tx.settlement.findUnique({ where: { id: sid } });
    if (!s) continue;
    if (sign === 1) {
      await tx.settlement.update({ where: { id: sid }, data: { state: 'PAID', paid_at: new Date(), period_id: periodId } });
      await tx.loan.updateMany({ where: { employee_id: s.employee_id, status: 'ACTIVE' }, data: { status: 'CLOSED' } });
      await tx.advance.updateMany({ where: { employee_id: s.employee_id, status: 'ACTIVE' }, data: { status: 'CLOSED' } });
      await tx.employee.update({ where: { id: s.employee_id }, data: { status: 'EXITED' } });
      // Delete the biometric on exit; keep the employment and payroll record.
      await tx.employeeFace.updateMany({ where: { employee_id: s.employee_id, deleted_at: null }, data: { deleted_at: new Date(), embedding: Buffer.alloc(0) } });
    } else {
      await tx.settlement.update({ where: { id: sid }, data: { state: 'INCLUDED', paid_at: null } });
      await tx.employee.update({ where: { id: s.employee_id }, data: { status: 'NOTICE' } });
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
