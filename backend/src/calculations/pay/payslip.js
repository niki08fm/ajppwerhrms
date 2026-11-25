import { clampMin0, formatLongDate, pct } from '@ajpwer/shared';
import { computeEsi } from '../statutory/esi.js';
import { computePf, pfChallanCharges, pfEmployerCost } from '../statutory/pf.js';
import { computePt } from '../statutory/pt.js';
import { EMPTY_YTD, policyTds } from '../statutory/incomeTax.js';
import { encashAmount } from '../leave/index.js';
import { earnedAfterLop, LOP_RULE_TEXT } from './lop.js';
import { baseMonthly, describeRate, offDayExtra, overtimePay } from './overtime.js';
import { expandStructure } from './structure.js';
import { applyRecoveryCap } from './recovery.js';

/** Stored on every payslip. Bump when a computation changes so old months stay explainable. */
export const ENGINE_VERSION = '1.7.0';

/** Taxable yearly components due in the `count` months after `ym`: known income the projection includes. */
export function knownYearlyAhead(yearly, ym, count) {
  let month = Number(ym.slice(5, 7));
  let total = 0;
  for (let i = 0; i < count; i++) {
    month = month === 12 ? 1 : month + 1;
    for (const y of yearly) if (y.is_taxable && y.pay_month === month && y.amount > 0) total += y.amount;
  }
  return total;
}

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
  let esiBaseEarned = 0;
  let taxableRegular = 0;
  let taxableEarned = 0;
  // The full month's wages, before loss of pay: the fixed salary a register shows beside what was earned.
  let fixedGross = 0;
  let pfBaseFixed = 0;
  let esiBaseFixed = 0;
  for (const c of full.monthly) {
    const earned = earnedAfterLop(c.amount, input.divisor, rule, att.lop_days, att.paid_days);
    componentsEarned += earned;
    fixedGross += c.amount;
    if (c.counts_as_wages) {
      pfBaseEarned += earned;
      pfBaseFixed += c.amount;
    }
    if (c.counts_as_esi_wages !== false) {
      esiBaseEarned += earned;
      esiBaseFixed += c.amount;
    }
    if (c.is_taxable) {
      taxableRegular += c.amount;
      taxableEarned += earned;
    }
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

  // 3. Overtime. Each day's minutes are paid under the overtime policy version in force
  // that day: one line per version when a new version starts mid-month. The monthly cap
  // counts minutes already paid this month under earlier versions.
  let otAmount = 0;
  let ot = null;
  const segments = input.overtime_segments?.length
    ? input.overtime_segments.filter((g) => g.rules && g.ot_min > 0)
    : input.overtime_rules && att.ot_min > 0 ? [{ rules: input.overtime_rules, ot_min: att.ot_min }] : [];
  if (segments.length) {
    let paidSoFar = 0;
    const parts = [];
    for (const g of segments) {
      const cap = g.rules.monthly_cap_min === null || g.rules.monthly_cap_min === undefined ? null : clampMin0(g.rules.monthly_cap_min - paidSoFar);
      const o = overtimePay(g.ot_min, { ...g.rules, monthly_cap_min: cap }, full, input.divisor);
      paidSoFar += o.paid_min;
      parts.push({ ...o, minutes: g.ot_min, rules: g.rules, from: g.from ?? null, to: g.to ?? null });
    }
    const last = parts.at(-1);
    otAmount = parts.reduce((a, o) => a + o.amount, 0);
    ot = {
      minutes: parts.reduce((a, o) => a + o.minutes, 0),
      paid_min: paidSoFar,
      excess_min: parts.reduce((a, o) => a + o.excess_min, 0),
      hourly: last.hourly,
      amount: otAmount,
      hours_per_day: last.rules.hours_per_day,
      multiplier: last.multiplier,
      daily_capped_min: att.ot_capped_min ?? 0,
      ...(parts.length > 1 ? { segments: parts.map((o) => ({ from: o.from, to: o.to, minutes: o.minutes, paid_min: o.paid_min, multiplier: o.multiplier, hourly: o.hourly, amount: o.amount })) } : {}),
    };
    if (ot.excess_min > 0) flags.push('OT_OVER_CAP');
    for (const o of parts) {
      if (o.amount <= 0 && parts.length > 1) continue;
      const h = Math.floor(o.paid_min / 60);
      const m = o.paid_min % 60;
      const span = parts.length > 1 && o.from ? ` (${formatLongDate(o.from)} – ${formatLongDate(o.to)})` : '';
      push({
        kind: 'OT',
        code: 'OT',
        name: `Overtime ${h}h${m ? ` ${m}m` : ''} at ${o.multiplier}×${span}`,
        full_amount: o.amount,
        amount: o.amount,
        is_taxable: true,
        counts_as_wages: false,
      });
    }
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
  // PT retains its salary earnings base. ESI uses the structure's selected
  // monthly earnings after LOP. OT inclusion is an explicit effective-dated
  // ESI setting; legacy rates retain the standard inclusion. Off-day pay stays included.
  const statutory_gross = componentsEarned + otAmount + offdayTotal;
  const esi_wage = esiBaseEarned + (input.rates.esi.include_overtime !== false ? otAmount : 0) + offdayTotal;

  // 7. Statutory deductions.
  const pf = computePf(pfBaseEarned, input.statutory, input.rates.pf);
  const esi = computeEsi(input.statutory.esi_applicable, esi_wage, input.rates.esi);
  const pt = computePt({ pt_applicable: input.statutory.pt_applicable, pt_state: input.statutory.pt_state, gender: input.employee.gender, gross: statutory_gross, month }, input.pt_slabs);
  // Income tax: the year's projected tax less TDS already deducted, spread over the
  // months left, plus the full extra tax on this month's one-offs (see incomeTax.js).
  const monthsLeft = Math.max(1, input.tax.months_left ?? input.tax.months_in_fy ?? 12);
  const fixedPf = computePf(pfBaseFixed, input.statutory, input.rates.pf);
  const lopShare = (amount) => earnedAfterLop(amount, input.divisor, rule, att.lop_days, att.paid_days);
  const tdsCalc = policyTds({
    month: {
      taxable: taxableEarned + yearlyTaxable,
      variable: otAmount + offdayTotal,
      one_off: adhocTaxable + leaveTotal,
      basic: lopShare(full.basic),
      hra: lopShare(full.hra),
      pf_80c: pf.employee + pf.vpf,
    },
    ahead: {
      taxable: taxableRegular,
      basic: full.basic,
      hra: full.hra,
      pf_80c: fixedPf.employee + fixedPf.vpf,
      known: knownYearlyAhead(full.yearly, input.ym, monthsLeft - 1),
    },
    monthsLeft,
    ytd: input.tax.ytd ?? EMPTY_YTD,
    previous: input.tax.previous ?? { income: 0, tds: 0 },
    decl: input.tax.declarations,
    regime: input.tax.regime,
    noPan: !!input.tax.no_pan,
  });
  // TDS never takes more than the month's pay after the other statutory deductions.
  // What it cannot take stays due, and the next month's calculation collects it.
  const available = clampMin0(gross - pf.employee - pf.vpf - esi.employee - pt.amount);
  const tds = Math.min(tdsCalc.total, available);
  if (tds < tdsCalc.total) flags.push('TDS_CAPPED');
  const incremental = Math.min(tdsCalc.incremental, tds);
  const regular = tds - incremental;

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

  // Employer contributions on the full month's wages: the fixed CTC, which loss of pay does not change.
  const fixedEmployerPf = pfEmployerCost(computePf(pfBaseFixed, input.statutory, input.rates.pf));
  const fixedEmployerEsi = computeEsi(input.statutory.esi_applicable, esiBaseFixed, input.rates.esi).employer;
  const fixed = { gross: fixedGross, employer_pf: fixedEmployerPf, employer_esi: fixedEmployerEsi, ctc: fixedGross + fixedEmployerPf + fixedEmployerEsi };

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
    esi_wage,
    employee_statutory,
    recoveries_total: recovery.total_recovered,
    adhoc_deductions,
    total_deductions,
    reimbursements,
    net,
    employer_total,
    ctc_month: salary_gross + employer_total,
    fixed,
    pf_charges: pfChallanCharges(pf),
    pf_wage: pf.pf_wage,
    eps_wage: pf.eps_wage,
    esi_applicable: esi.applicable,
    paid_days: att.paid_days,
    lop_days: att.lop_days,
    divisor: input.divisor,
    lop_rule: rule,
    lop_rule_text: LOP_RULE_TEXT[rule],
    ot,
    recovery,
    tds: {
      regular,
      incremental,
      annual: tdsCalc.annual,
      // What the policy asked for this month, before the cap at available pay.
      due_this_month: tdsCalc.total,
      projected_income: tdsCalc.projected_income,
      taxable_income: tdsCalc.taxable_income,
      tds_to_date: tdsCalc.tds_to_date,
      previous_income: tdsCalc.previous_income,
      previous_tds: tdsCalc.previous_tds,
      months_left: tdsCalc.months_left,
      variable_average: tdsCalc.variable_average,
      no_pan: tdsCalc.no_pan,
      estimated_months: tdsCalc.estimated_months,
      regime: input.tax.regime.code,
      income: tdsCalc.income,
    },
    // What this month adds to the year-to-date tax figures of later months.
    tax_ytd: {
      taxable: taxableEarned + yearlyTaxable + otAmount + offdayTotal + adhocTaxable + leaveTotal,
      basic: lopShare(full.basic),
      hra: lopShare(full.hra),
      pf_80c: pf.employee + pf.vpf,
      variable: otAmount + offdayTotal,
    },
    pt_basis: pt.basis,
    flags,
    engine_version: ENGINE_VERSION,
  };
}
