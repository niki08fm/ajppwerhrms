import { lastOfMonth, ymOf } from '@ajpwer/shared';
import { computeSettlement, expandStructure } from '../calculations/index.js';
import { fromDbDate, n } from '../utils/dbDates.js';
import { AppError } from '../utils/errors.js';
import { computeMonths } from './attendance.service.js';
import { leaveBalances } from './leave.service.js';
import { computePayslip } from './payslip.service.js';
import { payContext } from './payroll.service.js';
import { salaryOn, structureComponents } from './rules.service.js';
import { ctcBasisOf } from './salary.service.js';

/**
 * Full and final settlement, computed live while the person is on notice and
 * frozen when paid with a payroll run.
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

  const months = await computeMonths(db, [e], ym);
  const payslip = await computePayslip(db, e, ym, months.get(e.id), ctx, null);
  const statutoryCodes = ['PF', 'VPF', 'ESI', 'PT', 'TDS'];
  const statutoryLines = payslip.result.lines.filter((l) => l.kind === 'DEDUCTION' && statutoryCodes.includes(l.code));

  const balances = await leaveBalances(db, e, lastDay);
  const encashable = balances.filter((b) => b.encashable).reduce((s, b) => s + Math.max(0, b.balance), 0);

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
      notice_days: e.notice_days,
      notice_served_days: e.notice_served_days ?? e.notice_days,
      has_bank_account: !!(e.identity?.bank_account_enc && e.identity.bank_ifsc),
    },
    monthly_gross: salary.monthly_gross,
    last_basic: full.basic,
    final_month: {
      gross: payslip.result.gross,
      reimbursements: payslip.result.reimbursements,
      statutory: statutoryLines.reduce((s, l) => s + l.amount, 0),
      statutory_lines: statutoryLines.map((l) => ({ code: l.code, name: l.name, amount: l.amount })),
    },
    final_month_attendance_submitted: submitted,
    encashable_leave_days: Math.round(encashable * 100) / 100,
    pending_reimbursements: 0,
    loans_outstanding: loans.map((l) => ({ id: l.id, label: l.loan_type, amount: n(l.principal) - n(l.recovered) })),
    advances_outstanding: advances.map((a) => ({ id: a.id, label: a.reason, amount: n(a.amount) - n(a.recovered) })),
    gratuity_rates: ctx.rates.gratuity,
  });
  return { result, ym, last_day: lastDay };
}

/** Create or refresh the open settlement row for someone on notice. */
export async function upsertSettlement(db, employeeId) {
  const { result, last_day } = await computeSettlementFor(db, employeeId);
  const existing = await db.settlement.findFirst({ where: { employee_id: employeeId, deleted_at: null, state: { not: 'PAID' } } });
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
