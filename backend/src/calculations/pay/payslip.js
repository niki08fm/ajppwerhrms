import { clampMin0, formatLongDate, pct } from '@ajpwer/shared';
import { computeEsi } from '../statutory/esi.js';
import { computePf, pfChallanCharges, pfEmployerCost } from '../statutory/pf.js';
import { computePt } from '../statutory/pt.js';
import { monthlyTds } from '../statutory/incomeTax.js';
import { encashAmount } from '../leave/index.js';
import { earnedAfterLop, LOP_RULE_TEXT } from './lop.js';
import { baseMonthly, describeRate, offDayExtra, overtimePay } from './overtime.js';
import { expandStructure } from './structure.js';
import { applyRecoveryCap } from './recovery.js';

/** Stored on every payslip. Bump when a computation changes so old months stay explainable. */
export const ENGINE_VERSION = '1.4.0';

export class PayslipReconciliationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PayslipReconciliationError';
  }
}

/** Assemble a payslip in the order the spec fixes. Pure: data in, data out. */
export function assemblePayslip(input) {
  const lines = [];
  let seq = 0;
  const push = (l) => lines.push({ ...l, seq: seq++ });
  const flags = [];

  const full = expandStructure(input.components, input.monthly_gross, input.annual_ctc);
  if (full.over_budget) flags.push('STRUCTURE_OVER_BUDGET');
  const month = Number(input.ym.slice(5, 7));
  const att = input.attendance;
  const rule = att.partial ? 'PART_MONTH' : 'FULL_MONTH';

  // 1. Monthly components, less LOP.
  let componentsEarned = 0;
  let pfBaseEarned = 0;
  let taxableRegular = 0;
  for (const c of full.monthly) {
    const earned = earnedAfterLop(c.amount, input.divisor, rule, att.lop_days, att.paid_days);
    componentsEarned += earned;
    if (c.counts_as_wages) pfBaseEarned += earned;
    if (c.is_taxable) taxableRegular += c.amount;
    push({ kind: 'COMPONENT', code: c.name, name: c.name, full_amount: c.amount, amount: earned, is_taxable: c.is_taxable, counts_as_wages: c.counts_as_wages });
  }

  // 2. Yearly components due this month — not reduced by LOP.
  let yearlyTaxable = 0;
  let yearlyTotal = 0;
  for (const y of full.yearly) {
    if (y.pay_month !== month || y.amount <= 0) continue;
    yearlyTotal += y.amount;
    if (y.is_taxable) yearlyTaxable += y.amount;
    push({ kind: 'YEARLY', code: y.name, name: y.name, full_amount: y.amount, amount: y.amount, is_taxable: y.is_taxable, counts_as_wages: false });
  }

  // 3. Overtime.
  let otAmount = 0;
  let ot = null;
  if (input.overtime_rules && att.ot_min > 0) {
    const o = overtimePay(att.ot_min, input.overtime_rules, full, input.divisor);
    otAmount = o.amount;
    ot = { minutes: att.ot_min, paid_min: o.paid_min, excess_min: o.excess_min, hourly: o.hourly, amount: o.amount };
    if (o.excess_min > 0) flags.push('OT_OVER_CAP');
    const h = Math.floor(o.paid_min / 60);
    const m = o.paid_min % 60;
    push({
      kind: 'OT',
      code: 'OT',
      name: `Overtime ${h}h${m ? ` ${m}m` : ''} at ${input.overtime_rules.multiplier}×`,
      full_amount: o.amount,
      amount: o.amount,
      is_taxable: true,
      counts_as_wages: false,
    });
  }

  // 4. Off-day work pay — one line per day, named with the date.
  let offdayTotal = 0;
  for (const e of input.offday_work) {
    const base = baseMonthly(e.base, full);
    const amount = offDayExtra(e.rate_pct, e.day_paid, base, input.divisor);
    if (amount <= 0) continue;
    offdayTotal += amount;
    push({
      kind: 'OFFDAY',
      code: 'OFFDAY',
      name: `${e.kind === 'HOLIDAY' ? 'Holiday' : 'Weekly off'} worked ${formatLongDate(e.date)} — ${describeRate(e.rate_pct)}`,
      full_amount: amount,
      amount,
      is_taxable: true,
      counts_as_wages: false,
    });
  }

  // 4b. Leave paid out at the end of the leave year — one line per type.
  let leaveTotal = 0;
  for (const l of input.leave_encashment ?? []) {
    const amount = encashAmount(l.days, l.base, l.divisor, full);
    if (amount <= 0) continue;
    leaveTotal += amount;
    push({ kind: 'LEAVE', code: `LEAVE:${l.code}`, name: `Leave encashment — ${l.name}, ${l.days} days`, full_amount: amount, amount, is_taxable: true, counts_as_wages: false });
  }

  // 5. Adhoc earnings.
  let adhocEarnings = 0;
  let adhocTaxable = 0;
  for (const a of input.adhoc.filter((x) => x.kind === 'EARNING')) {
    adhocEarnings += a.amount;
    if (a.is_taxable) adhocTaxable += a.amount;
    push({ kind: 'ADHOC', code: `ADHOC:${a.id}`, name: a.name, full_amount: a.amount, amount: a.amount, is_taxable: a.is_taxable, counts_as_wages: false });
  }

  // 6. Gross.
  const salary_gross = componentsEarned + yearlyTotal + otAmount + offdayTotal + leaveTotal;
  const gross = salary_gross + adhocEarnings;
  // ESI and PT are computed on salary earnings (components, overtime, off-day pay).
  // Whether a taxable bonus also counts here is an open question with AJPWER (spec §6).
  const statutory_gross = componentsEarned + otAmount + offdayTotal;

  // 7. Statutory deductions.
  const pf = computePf(pfBaseEarned, input.statutory, input.rates.pf);
  const esi = computeEsi(input.statutory.esi_applicable, statutory_gross, input.rates.esi);
  const pt = computePt({ pt_applicable: input.statutory.pt_applicable, pt_state: input.statutory.pt_state, gender: input.employee.gender, gross: statutory_gross, month }, input.pt_slabs);
  const monthsInFy = Math.max(1, input.tax.months_in_fy);
  const projected = {
    gross: taxableRegular * monthsInFy,
    basic: full.basic * monthsInFy,
    hra: full.hra * monthsInFy,
  };
  const oneOffTaxable = yearlyTaxable + adhocTaxable + otAmount + offdayTotal + leaveTotal;
  const tdsCalc = monthlyTds(projected, oneOffTaxable, input.tax.declarations, input.tax.regime);
  // monthlyTds spreads over 12; re-spread over the months actually employed this year.
  const regular = Math.round(tdsCalc.annual / monthsInFy / 100) * 100;
  const tds = regular + tdsCalc.incremental;

  const statutoryLines = [
    ['PF', 'Provident fund', pf.employee],
    ['VPF', 'Voluntary PF', pf.vpf],
    ['ESI', 'ESI', esi.employee],
    ['PT', `Professional tax (${pt.state})`, pt.amount],
    ['TDS', 'Income tax (TDS)', tds],
  ];
  let employee_statutory = 0;
  for (const [code, name, amount] of statutoryLines) {
    if (amount <= 0) continue;
    employee_statutory += amount;
    push({ kind: 'DEDUCTION', code, name, full_amount: amount, amount, is_taxable: false, counts_as_wages: false });
  }

  // 8. Loan and advance recovery, capped at a share of gross minus statutory.
  const capBase = clampMin0(gross - employee_statutory);
  const recovery = applyRecoveryCap(input.recoveries, pct(capBase, input.rates.recovery_cap_pct, 'down'));
  for (const r of recovery.items) {
    if (r.recovered <= 0) continue;
    push({ kind: 'DEDUCTION', code: r.type, name: r.label, full_amount: r.due, amount: r.recovered, is_taxable: false, counts_as_wages: false });
  }

  // 9. Adhoc deductions.
  let adhoc_deductions = 0;
  for (const a of input.adhoc.filter((x) => x.kind === 'DEDUCTION')) {
    adhoc_deductions += a.amount;
    push({ kind: 'DEDUCTION', code: `ADHOC_DED:${a.id}`, name: a.name, full_amount: a.amount, amount: a.amount, is_taxable: false, counts_as_wages: false });
  }

  // Reimbursements: not gross, not taxable, added after deductions.
  let reimbursements = 0;
  for (const a of input.adhoc.filter((x) => x.kind === 'REIMBURSEMENT')) {
    reimbursements += a.amount;
    push({ kind: 'REIMBURSEMENT', code: `REIMB:${a.id}`, name: a.name, full_amount: a.amount, amount: a.amount, is_taxable: false, counts_as_wages: false });
  }

  // Company contributions — shown, not deducted: employer PF 12% (EPF + pension) and employer ESI when eligible.
  // EDLI and admin charges go to EPFO with the PF challan (pf_charges) and are not part of CTC.
  const employerLines = [
    ['ER_EPF', 'Employer PF (EPF)', pf.employer_epf],
    ['ER_EPS', 'Employer pension (EPS)', pf.eps],
    ['ER_ESI', 'Employer ESI', esi.employer],
  ];
  let employer_total = 0;
  for (const [code, name, amount] of employerLines) {
    if (amount <= 0) continue;
    employer_total += amount;
    push({ kind: 'EMPLOYER', code, name, full_amount: amount, amount, is_taxable: false, counts_as_wages: false });
  }
  if (employer_total !== pfEmployerCost(pf) + esi.employer) throw new PayslipReconciliationError('Employer contributions do not add up');

  // 10. Net.
  const total_deductions = employee_statutory + recovery.total_recovered + adhoc_deductions;
  const net = gross - total_deductions + reimbursements;
  if (net < 0) flags.push('NEGATIVE_NET');

  // Reconciliation — fail the run rather than write a payslip that does not add up.
  const earningLines = lines.filter((l) => ['COMPONENT', 'YEARLY', 'OT', 'OFFDAY', 'LEAVE', 'ADHOC'].includes(l.kind)).reduce((s, l) => s + l.amount, 0);
  if (earningLines !== gross) throw new PayslipReconciliationError(`Earning lines ${earningLines} ≠ gross ${gross}`);
  const dedLines = lines.filter((l) => l.kind === 'DEDUCTION').reduce((s, l) => s + l.amount, 0);
  if (dedLines !== total_deductions) throw new PayslipReconciliationError(`Deduction lines ${dedLines} ≠ total ${total_deductions}`);
  if (gross - total_deductions + reimbursements !== net) throw new PayslipReconciliationError('gross − deductions + reimbursements ≠ net');

  return {
    lines,
    salary_gross,
    adhoc_earnings: adhocEarnings,
    gross,
    statutory_gross,
    employee_statutory,
    recoveries_total: recovery.total_recovered,
    adhoc_deductions,
    total_deductions,
    reimbursements,
    net,
    employer_total,
    ctc_month: salary_gross + employer_total,
    pf_charges: pfChallanCharges(pf),
    pf_wage: pf.pf_wage,
    esi_applicable: esi.applicable,
    paid_days: att.paid_days,
    lop_days: att.lop_days,
    divisor: input.divisor,
    lop_rule: rule,
    lop_rule_text: LOP_RULE_TEXT[rule],
    ot,
    recovery,
    tds: { regular, incremental: tdsCalc.incremental, annual: tdsCalc.annual },
    pt_basis: pt.basis,
    flags,
    engine_version: ENGINE_VERSION,
  };
}
