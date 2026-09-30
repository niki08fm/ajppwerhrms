import {
  clampMin0,
  formatLongDate,
  pct,
  type AdhocKind,
  type EsiRates,
  type Gender,
  type Paise,
  type PayslipLineKind,
  type PfRates,
  type PtSlab,
  type TaxRegime,
} from '@ajpwer/shared';
import type { MonthTotals, OffDayWorkEntry } from '../attendance/types';
import type { OvertimeRules } from '@ajpwer/shared';
import { computeEsi } from '../statutory/esi';
import { computePf, pfEmployerCost, type PfChoice } from '../statutory/pf';
import { computePt } from '../statutory/pt';
import { monthlyTds, type TaxDeclarations } from '../statutory/incomeTax';
import { earnedAfterLop, LOP_RULE_TEXT, type LopRule } from './lop';
import { baseMonthly, describeRate, offDayExtra, overtimePay } from './overtime';
import { expandStructure, type ComponentDef } from './structure';
import { applyRecoveryCap, type RecoveryItem, type RecoveryResult } from './recovery';

/** Stored on every payslip. Bump when a computation changes so old months stay explainable. */
export const ENGINE_VERSION = '1.0.0';

export interface PayslipLine {
  seq: number;
  kind: PayslipLineKind;
  /** Machine code: component name, or PF / VPF / ESI / PT / TDS / LOAN / ADVANCE / ADHOC … */
  code: string;
  name: string;
  /** The full (contracted) amount before LOP, where meaningful */
  full_amount: Paise;
  amount: Paise;
  is_taxable: boolean;
  counts_as_wages: boolean;
}

export interface AdhocForEmployee {
  id: string;
  kind: AdhocKind;
  name: string;
  amount: Paise;
  is_taxable: boolean;
}

export interface PayslipInput {
  ym: string;
  employee: {
    id: string;
    gender: Gender;
  };
  /** Contracted monthly gross valid on the last day of the month */
  monthly_gross: Paise;
  components: ComponentDef[];
  attendance: MonthTotals;
  offday_work: OffDayWorkEntry[];
  divisor: number;
  overtime_rules: OvertimeRules | null;
  statutory: PfChoice & {
    esi_applicable: boolean;
    pt_applicable: boolean;
    pt_state: string;
  };
  rates: { pf: PfRates; esi: EsiRates; recovery_cap_pct: number };
  pt_slabs: PtSlab[];
  tax: {
    regime: TaxRegime;
    declarations: TaxDeclarations;
    /** Months of this financial year the person is employed, for spreading TDS */
    months_in_fy: number;
  };
  adhoc: AdhocForEmployee[];
  recoveries: RecoveryItem[];
}

export interface PayslipResult {
  lines: PayslipLine[];
  /** Block 1 total: components after LOP, yearly, overtime, off-day pay */
  salary_gross: Paise;
  adhoc_earnings: Paise;
  /** salary_gross + adhoc earnings — the gross of the assembly order */
  gross: Paise;
  /** What ESI and PT are computed on */
  statutory_gross: Paise;
  employee_statutory: Paise;
  recoveries_total: Paise;
  adhoc_deductions: Paise;
  total_deductions: Paise;
  reimbursements: Paise;
  net: Paise;
  employer_total: Paise;
  ctc_month: Paise;
  pf_wage: Paise;
  esi_applicable: boolean;
  paid_days: number;
  lop_days: number;
  divisor: number;
  lop_rule: LopRule;
  lop_rule_text: string;
  ot: { minutes: number; paid_min: number; excess_min: number; hourly: Paise; amount: Paise } | null;
  recovery: RecoveryResult;
  tds: { regular: Paise; incremental: Paise; annual: Paise };
  pt_basis: string;
  flags: string[];
  engine_version: string;
}

export class PayslipReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayslipReconciliationError';
  }
}

/** Assemble a payslip in the order the spec fixes. Pure: data in, data out. */
export function assemblePayslip(input: PayslipInput): PayslipResult {
  const lines: PayslipLine[] = [];
  let seq = 0;
  const push = (l: Omit<PayslipLine, 'seq'>) => lines.push({ ...l, seq: seq++ });
  const flags: string[] = [];

  const full = expandStructure(input.components, input.monthly_gross);
  if (full.over_budget) flags.push('STRUCTURE_OVER_BUDGET');
  const month = Number(input.ym.slice(5, 7));
  const att = input.attendance;
  const rule: LopRule = att.partial ? 'PART_MONTH' : 'FULL_MONTH';

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
  let ot: PayslipResult['ot'] = null;
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

  // 5. Adhoc earnings.
  let adhocEarnings = 0;
  let adhocTaxable = 0;
  for (const a of input.adhoc.filter((x) => x.kind === 'EARNING')) {
    adhocEarnings += a.amount;
    if (a.is_taxable) adhocTaxable += a.amount;
    push({ kind: 'ADHOC', code: `ADHOC:${a.id}`, name: a.name, full_amount: a.amount, amount: a.amount, is_taxable: a.is_taxable, counts_as_wages: false });
  }

  // 6. Gross.
  const salary_gross = componentsEarned + yearlyTotal + otAmount + offdayTotal;
  const gross = salary_gross + adhocEarnings;
  // ESI and PT are computed on salary earnings (components, overtime, off-day pay).
  // Whether a taxable bonus also counts here is an open question with AJPWER (spec §6).
  const statutory_gross = componentsEarned + otAmount + offdayTotal;

  // 7. Statutory deductions.
  const pf = computePf(pfBaseEarned, input.statutory, input.rates.pf);
  const esi = computeEsi(input.statutory.esi_applicable, statutory_gross, input.rates.esi);
  const pt = computePt(
    { pt_applicable: input.statutory.pt_applicable, pt_state: input.statutory.pt_state, gender: input.employee.gender, gross: statutory_gross, month },
    input.pt_slabs,
  );
  const monthsInFy = Math.max(1, input.tax.months_in_fy);
  const projected = {
    gross: taxableRegular * monthsInFy,
    basic: full.basic * monthsInFy,
    hra: full.hra * monthsInFy,
  };
  const oneOffTaxable = yearlyTaxable + adhocTaxable + otAmount + offdayTotal;
  const tdsCalc = monthlyTds(projected, oneOffTaxable, input.tax.declarations, input.tax.regime);
  // monthlyTds spreads over 12; re-spread over the months actually employed this year.
  const regular = Math.round(tdsCalc.annual / monthsInFy / 100) * 100;
  const tds = regular + tdsCalc.incremental;

  const statutoryLines: [string, string, Paise][] = [
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

  // Employer contributions — shown, not deducted.
  const employerLines: [string, string, Paise][] = [
    ['ER_EPF', 'Employer PF (EPF)', pf.employer_epf],
    ['ER_EPS', 'Employer pension (EPS)', pf.eps],
    ['ER_EDLI', 'EDLI', pf.edli],
    ['ER_ADMIN', 'PF admin charges', pf.admin],
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
  const earningLines = lines.filter((l) => ['COMPONENT', 'YEARLY', 'OT', 'OFFDAY', 'ADHOC'].includes(l.kind)).reduce((s, l) => s + l.amount, 0);
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
