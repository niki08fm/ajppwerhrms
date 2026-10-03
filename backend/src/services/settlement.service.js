import { lastOfMonth, ymOf } from '@ajpwer/shared';
import { baseMonthly, computeSettlement, expandStructure, pickPolicy } from '../calculations/index.js';
import { fromDbDate, n } from '../utils/dbDates.js';
import { AppError } from '../utils/errors.js';
import { computeMonths } from './attendance.service.js';
import { currentSettlement, exitChecklist } from './exit.service.js';
import { computePayslip } from './payslip.service.js';
import { payContext } from './payroll.service.js';
import { payGroupRules, salaryOn, structureComponents } from './rules.service.js';
import { ctcBasisOf } from './salary.service.js';

/**
 * Full and final settlement, computed live while the person is leaving and frozen
 * when paid with a payroll run (or that run records it as paid separately).
 */
export async function computeSettlementFor(db, employeeId, opts = {}) {
  const e = await db.employee.findUniqueOrThrow({ where: { id: employeeId }, include: { statutory: true, identity: true } });
  const lastDay = fromDbDate(e.last_day);
  if (!lastDay) throw new AppError('VALIDATION', `${e.name} has no last working day recorded. Record the resignation first.`, 409);
  const ym = ymOf(lastDay);
  const salary = await salaryOn(db, e.id, lastDay);
  if (!salary) throw new AppError('VALIDATION', `${e.name} has no salary on their last day.`, 409);
  const components = await structureComponents(db, salary.structure_id);
  const ctx = await payContext(db, ym);
  if (!e.statutory) throw new AppError('VALIDATION', `${e.name} (${e.code}) has no statutory setup.`, 409);
  const full = expandStructure(components, salary.monthly_gross, ctcBasisOf(salary, components, e.statutory, ctx.rates));
  // Gratuity follows the pay group's gratuity policy in force on the last day.
  const gratuityRules = pickPolicy((await payGroupRules(db, e.pay_group_id)).policies, 'GRATUITY', lastDay)?.rules ?? null;

  // The checklist, HR's adjustments so far, and how it is paid.
  const checklist = await exitChecklist(db, e.id);
  const stored = await currentSettlement(db, e.id);
  const adjustments = stored?.adjustments ?? {};
  const paidSeparately = opts.paidSeparately ?? !!stored?.paid_separately;
  // Salary held and not yet paid goes with the F&F.
  const held = await db.heldPay.findMany({ where: { employee_id: e.id, state: 'HELD' }, include: { hold: { select: { reason: true } } }, orderBy: { period_ym: 'asc' } });

  const months = await computeMonths(db, [e], ym);
  const payslip = await computePayslip(db, e, ym, months.get(e.id), ctx, null);
  const statutoryCodes = ['PF', 'VPF', 'ESI', 'PT', 'TDS'];
  const statutoryLines = payslip.result.lines.filter((l) => l.kind === 'DEDUCTION' && statutoryCodes.includes(l.code));

  // Leave left after the final month, for each type its policy pays out on exit.
  const leavePayout = (months.get(e.id).result.leave?.types ?? [])
    .filter((t) => t.on_exit === 'ENCASH' && t.closing > 0)
    .map((t) => ({ code: t.code, name: t.name, days: t.closing, wages: baseMonthly(t.encash_base, full), base: t.encash_base, divisor: t.encash_divisor }));

  const [loans, advances, period] = await Promise.all([
    db.loan.findMany({ where: { employee_id: e.id, status: 'ACTIVE', deleted_at: null } }),
    db.advance.findMany({ where: { employee_id: e.id, status: 'ACTIVE', deleted_at: null } }),
    db.payrollPeriod.findUnique({ where: { period_ym: ym } }),
  ]);
  const submitted = opts.attendanceSubmitted ?? (!!period && (period.steps_submitted.includes(1) || period.state !== 'DRAFT'));

  const result = computeSettlement({
    employee: {
      joined_on: fromDbDate(e.joined_on),
      last_day: lastDay,
      has_bank_account: !!(e.identity?.bank_account_enc && e.identity.bank_ifsc),
    },
    monthly_gross: salary.monthly_gross,
    gratuity_rules: gratuityRules,
    gratuity_wages: gratuityRules ? baseMonthly(gratuityRules.base, full) : 0,
    final_month: {
      gross: payslip.result.gross,
      reimbursements: payslip.result.reimbursements,
      statutory: statutoryLines.reduce((s, l) => s + l.amount, 0),
      statutory_lines: statutoryLines.map((l) => ({ code: l.code, name: l.name, amount: l.amount })),
    },
    final_month_attendance_submitted: submitted,
    leave_payout: leavePayout,
    exit_reason: e.exit_reason ?? 'RESIGNATION',
    held_pay: held.map((h) => ({ id: h.id, period_ym: h.period_ym, amount: n(h.amount), reason: h.hold.reason })),
    paid_separately: paidSeparately,
    adjustments,
    checklist_open: checklist.filter((t) => t.required && !t.done_at),
    pending_reimbursements: 0,
    loans_outstanding: loans.map((l) => ({ id: l.id, label: l.loan_type, amount: n(l.principal) - n(l.recovered) })),
    advances_outstanding: advances.map((a) => ({ id: a.id, label: a.reason, amount: n(a.amount) - n(a.recovered) })),
  });
  return { result, ym, last_day: lastDay, checklist, adjustments, held };
}

/** Create or refresh the open settlement row for someone leaving. */
export async function upsertSettlement(db, employeeId) {
  const { result, last_day } = await computeSettlementFor(db, employeeId);
  const existing = await db.settlement.findFirst({ where: { employee_id: employeeId, deleted_at: null, state: { not: 'PAID' } } });
  // HR's adjustments live on the row and are never overwritten here.
  const data = {
    last_day: new Date(`${last_day}T00:00:00Z`),
    earnings: JSON.parse(JSON.stringify(result.earnings)),
    deductions: JSON.parse(JSON.stringify(result.deductions)),
    total_earnings: BigInt(result.total_earnings),
    total_deductions: BigInt(result.total_deductions),
    net: BigInt(result.net),
    clearance: JSON.parse(JSON.stringify(result.clearance)),
  };
  if (existing) return db.settlement.update({ where: { id: existing.id }, data });
  return db.settlement.create({ data: { employee_id: employeeId, ...data } });
}

export const monthOfLastDay = (d) => lastOfMonth(ymOf(d));
