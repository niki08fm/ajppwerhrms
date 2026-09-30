import { describe, expect, it } from 'vitest';
import {
  applyRecoveryCap,
  assemblePayslip,
  calendarDivisor,
  ctcForGross,
  earnedAfterLop,
  expandStructure,
  overtimePay,
  runEmployeeMonth,
  solveGrossFromCtc,
  validateStructure,
  workingDaysInMonth,
  type ComponentDef,
  type CtcContext,
} from '../../src/engines';
import { mulDiv, type CalendarMethod } from '@ajpwer/shared';
import {
  ATTENDANCE,
  fullDay,
  fullMonthTotals,
  HOLIDAY_PAID,
  OVERTIME,
  payslipInput,
  PF_ON,
  R,
  RATES,
  SHIFT_START,
  STANDARD_STRUCTURE,
  WEEKOFF_PAID,
} from './fixtures';

const ctx: CtcContext = { components: STANDARD_STRUCTURE, pf: PF_ON, esi_enabled: true, rates: { pf: RATES.pf, esi: RATES.esi } };

describe('Salary structure expansion', () => {
  it('basic first, then the rest, balance takes the remainder', () => {
    const s = expandStructure(STANDARD_STRUCTURE, R(24000));
    expect(s.basic).toBe(R(12000));
    expect(s.hra).toBe(R(4800));
    expect(s.monthly.find((c) => c.name === 'Special allowance')!.amount).toBe(R(24000 - 12000 - 4800 - 1600));
    expect(s.gross).toBe(R(24000));
    expect(s.over_budget).toBe(false);
  });

  it('never produces a negative component; flags over_budget', () => {
    const s = expandStructure(STANDARD_STRUCTURE, R(3000));
    expect(s.monthly.every((c) => c.amount >= 0)).toBe(true);
    expect(s.over_budget).toBe(true);
    expect(validateStructure(STANDARD_STRUCTURE, R(3000)).warnings.join(' ')).toMatch(/exceed the sample gross/);
  });

  it('validation blocks a structure with no Basic or two balances', () => {
    const noBasic = STANDARD_STRUCTURE.map((c) => (c.name === 'Basic' ? { ...c, name: 'Base pay' } : c));
    expect(validateStructure(noBasic, R(24000)).errors[0]).toMatch(/Basic/);
    const twoBal = [...STANDARD_STRUCTURE, { ...STANDARD_STRUCTURE[3], seq: 9, name: 'Other' }];
    expect(validateStructure(twoBal, R(24000)).errors.join(' ')).toMatch(/More than one balance/);
  });

  it('yearly components are part of CTC but not monthly gross', () => {
    const withBonus: ComponentDef[] = [
      ...STANDARD_STRUCTURE,
      { seq: 10, name: 'Annual bonus', calc_type: 'FIXED', calc_value: R(12000), frequency: 'YEARLY', pay_month: 10, is_taxable: true, counts_as_wages: false },
    ];
    const s = expandStructure(withBonus, R(24000));
    expect(s.gross).toBe(R(24000));
    expect(s.yearly_total).toBe(R(12000));
    expect(ctcForGross(R(24000), { ...ctx, components: withBonus }).annual_ctc - ctcForGross(R(24000), ctx).annual_ctc).toBe(R(12000));
  });
});

describe('§20.1 Round trip gross → CTC → gross', () => {
  it('61 cases, zero failures, 5 flagged ambiguous', () => {
    let failures = 0;
    let ambiguous = 0;
    let cases = 0;
    for (let g = 15000; g <= 30000; g += 250) {
      cases++;
      const ctc = ctcForGross(R(g), ctx).annual_ctc;
      const sol = solveGrossFromCtc(ctc, ctx);
      const found = sol.gross === R(g) || sol.alternative?.gross === R(g);
      if (!found || sol.approximate) failures++;
      if (sol.ambiguous) ambiguous++;
    }
    expect(cases).toBe(61);
    expect(failures).toBe(0);
    expect(ambiguous).toBe(5);
  });

  it('with ESI disabled, one bisection over the whole range is correct', () => {
    const noEsi = { ...ctx, esi_enabled: false };
    for (let g = 15000; g <= 30000; g += 250) {
      const sol = solveGrossFromCtc(ctcForGross(R(g), noEsi).annual_ctc, noEsi);
      expect(sol.gross).toBe(R(g));
      expect(sol.ambiguous).toBe(false);
    }
  });
});

describe('§20.2 ESI cliff', () => {
  it('CTC at ₹21,000 is higher than at ₹21,001', () => {
    const at = ctcForGross(R(21000), ctx);
    const above = ctcForGross(R(21001), ctx);
    expect(at.esi_applies).toBe(true);
    expect(above.esi_applies).toBe(false);
    expect(at.annual_ctc).toBeGreaterThan(above.annual_ctc);
  });

  it('a CTC inside the band returns both candidate grosses and never picks silently', () => {
    const low = ctcForGross(R(21001), ctx).annual_ctc;
    const high = ctcForGross(R(21000), ctx).annual_ctc;
    const mid = Math.round((low + high) / 2 / 100) * 100;
    const sol = solveGrossFromCtc(mid, ctx);
    expect(sol.ambiguous).toBe(true);
    expect(sol.gross).toBeGreaterThan(RATES.esi.ceiling);
    expect(sol.alternative).not.toBeNull();
    expect(sol.alternative!.gross).toBeLessThanOrEqual(RATES.esi.ceiling);
    expect(sol.alternative!.breakdown.esi_applies).toBe(true);
  });
});

describe('§20.3 / §20.4 Payslips reconcile', () => {
  const scenarios = [
    payslipInput(),
    payslipInput({ attendance: fullMonthTotals('2026-09', 30, { paid_days: 27.5, lop_days: 2.5 }) }),
    payslipInput({
      overtime_rules: OVERTIME.rules,
      attendance: fullMonthTotals('2026-09', 30, { ot_min: 600 }),
      offday_work: [{ date: '2026-09-06', kind: 'WEEKLY_OFF', worked_min: 480, rate_pct: 200, base: 'GROSS', day_paid: true }],
      adhoc: [
        { id: 'a1', kind: 'EARNING', name: 'Diwali bonus', amount: R(5000), is_taxable: true },
        { id: 'a2', kind: 'REIMBURSEMENT', name: 'Travel', amount: R(1234.56), is_taxable: false },
        { id: 'a3', kind: 'DEDUCTION', name: 'Canteen', amount: R(300), is_taxable: false },
      ],
      statutory: { ...PF_ON, esi_applicable: true, pt_applicable: true, pt_state: 'Telangana' },
      monthly_gross: R(19999),
    }),
    payslipInput({ monthly_gross: R(95000), tax: { regime: payslipInput().tax.regime, declarations: payslipInput().tax.declarations, months_in_fy: 7 } }),
  ];

  it.each(scenarios.map((s, i) => [i, s]))('scenario %i: gross − deductions + reimbursements == net, in paise', (_i, input) => {
    const p = assemblePayslip(input);
    expect(p.gross - p.total_deductions + p.reimbursements).toBe(p.net);
    for (const l of p.lines) expect(Number.isInteger(l.amount)).toBe(true);
  });

  it.each(scenarios.map((s, i) => [i, s]))('scenario %i: component lines == gross − OT − off-day − adhoc', (_i, input) => {
    const p = assemblePayslip(input);
    const comp = p.lines.filter((l) => l.kind === 'COMPONENT' || l.kind === 'YEARLY').reduce((s, l) => s + l.amount, 0);
    const extra = p.lines.filter((l) => ['OT', 'OFFDAY', 'ADHOC'].includes(l.kind)).reduce((s, l) => s + l.amount, 0);
    expect(comp).toBe(p.gross - extra);
  });

  it('a reimbursement does not inflate PF, ESI or PT', () => {
    const base = payslipInput({ monthly_gross: R(18000), statutory: { ...PF_ON, esi_applicable: true, pt_applicable: true, pt_state: 'Andhra Pradesh' } });
    const a = assemblePayslip(base);
    const b = assemblePayslip({ ...base, adhoc: [{ id: 'r', kind: 'REIMBURSEMENT', name: 'Fuel', amount: R(5000), is_taxable: false }] });
    const pick = (p: typeof a, code: string) => p.lines.find((l) => l.code === code)?.amount ?? 0;
    for (const code of ['PF', 'ESI', 'PT', 'TDS']) expect(pick(b, code)).toBe(pick(a, code));
    expect(b.net - a.net).toBe(R(5000));
    expect(b.gross).toBe(a.gross);
  });

  it('PF uses only component earnings, never overtime or adhoc', () => {
    const base = payslipInput();
    const a = assemblePayslip(base);
    const b = assemblePayslip({
      ...base,
      overtime_rules: OVERTIME.rules,
      attendance: fullMonthTotals('2026-09', 30, { ot_min: 1200 }),
      adhoc: [{ id: 'x', kind: 'EARNING', name: 'Incentive', amount: R(8000), is_taxable: true }],
    });
    expect(b.pf_wage).toBe(a.pf_wage);
  });
});

describe('§20.5 Calendar methods', () => {
  it('four different LOP deductions, each equal to monthly ÷ divisor × lop_days', () => {
    const ym = '2026-08'; // 31 days, five Sundays, 15 August a holiday → working days 25
    const holidays = ['2026-08-15'];
    const working = workingDaysInMonth(ym, ['SUN'], holidays);
    expect(working).toBe(25);
    const methods: CalendarMethod[] = ['FIXED_26', 'FIXED_30', 'ACTUAL', 'WORKING'];
    const lop = 3;
    const deductions = methods.map((m) => {
      const divisor = calendarDivisor(m, ym, working);
      const p = assemblePayslip(
        payslipInput({ ym, divisor, attendance: fullMonthTotals(ym, 31, { paid_days: 28, lop_days: lop }) }),
      );
      const full = p.lines.filter((l) => l.kind === 'COMPONENT').reduce((s, l) => s + l.full_amount, 0);
      const earned = p.lines.filter((l) => l.kind === 'COMPONENT').reduce((s, l) => s + l.amount, 0);
      const deduction = full - earned;
      // Rounded per component line, so allow a paisa per component.
      expect(Math.abs(deduction - mulDiv(R(24000), lop, divisor))).toBeLessThanOrEqual(4);
      return deduction;
    });
    expect(new Set(deductions).size).toBe(4);
  });
});

describe('§20.6 Part month', () => {
  it('a joiner on the 20th of a 30-day month under FIXED_26 is paid the multiply-up figure', () => {
    const month = runEmployeeMonth({
      ym: '2026-09',
      joined_on: '2026-09-20',
      last_day: null,
      weekly_off: ['SUN'],
      holidays: [],
      shift_start_min: SHIFT_START,
      policies: [ATTENDANCE, WEEKOFF_PAID, HOLIDAY_PAID],
      punches: Object.fromEntries(
        ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-28', '2026-09-29', '2026-09-30'].map((d) => [d, fullDay(d)]),
      ),
      leave: {},
      overrides: {},
    });
    expect(month.totals.partial).toBe(true);
    expect(month.totals.paid_days).toBe(11); // 20th–30th, two Sundays paid
    expect(month.totals.lop_in_window).toBe(0);
    const p = assemblePayslip(payslipInput({ attendance: month.totals, divisor: 26 }));
    expect(p.lop_rule).toBe('PART_MONTH');
    const earned = p.lines.filter((l) => l.kind === 'COMPONENT').reduce((s, l) => s + l.amount, 0);
    expect(Math.abs(earned - mulDiv(R(24000), 11, 26))).toBeLessThanOrEqual(4);
    // Subtract-down would have paid full − full/26 × 19 — far less.
    const subtractDown = R(24000) - mulDiv(R(24000), 19, 26);
    expect(earned).toBeGreaterThan(subtractDown);
    expect(earned).toBeGreaterThan(0);
    expect(p.net).toBeGreaterThan(0);
  });

  it('pay is never negative and never above full', () => {
    expect(earnedAfterLop(R(24000), 26, 'FULL_MONTH', 30, 0)).toBe(0);
    expect(earnedAfterLop(R(24000), 26, 'PART_MONTH', 0, 30)).toBe(R(24000));
  });
});

describe('§20.7 Overtime base matters', () => {
  it('the spec worked example: basic + HRA ₹16,800 → ₹80.77 an hour, ten hours at 2× ≈ ₹1,615', () => {
    const s = expandStructure(STANDARD_STRUCTURE, R(24000));
    const o = overtimePay(600, { ...OVERTIME.rules, monthly_cap_min: null }, s, 26);
    expect(o.base_monthly).toBe(R(16800));
    expect(o.hourly).toBe(8077);
    expect(Math.round(o.amount / 100)).toBe(1615);
  });

  it('2× on basic + HRA pays more than 3× on basic for the same hours', () => {
    // Basic 40% and HRA 25% of gross: basic + HRA is 1.625 × basic, so 2× beats 3×.
    const structure: ComponentDef[] = [
      { ...STANDARD_STRUCTURE[0], calc_value: 40 },
      { ...STANDARD_STRUCTURE[1], calc_type: 'PCT_GROSS', calc_value: 25 },
      STANDARD_STRUCTURE[3],
    ];
    const s = expandStructure(structure, R(24000));
    const rules = { ...OVERTIME.rules, monthly_cap_min: null };
    const twoOnBh = overtimePay(420, { ...rules, multiplier: 2, base: 'BASIC_HRA' }, s, 26);
    const threeOnBasic = overtimePay(420, { ...rules, multiplier: 3, base: 'BASIC' }, s, 26);
    expect(twoOnBh.amount).toBeGreaterThan(threeOnBasic.amount);
  });
});

describe('§20.8 Overtime cap', () => {
  it('hours above the monthly cap are unpaid and reported, not silently dropped', () => {
    const p = assemblePayslip(
      payslipInput({ overtime_rules: { ...OVERTIME.rules, monthly_cap_min: 600 }, attendance: fullMonthTotals('2026-09', 30, { ot_min: 900 }) }),
    );
    expect(p.ot!.paid_min).toBe(600);
    expect(p.ot!.excess_min).toBe(300);
    expect(p.flags).toContain('OT_OVER_CAP');
  });
});

describe('§20.9 Recovery cap', () => {
  it('an EMI above the cap carries the excess forward, and the carry is taken first next month', () => {
    const p = assemblePayslip(
      payslipInput({
        monthly_gross: R(20000),
        recoveries: [{ type: 'LOAN', ref_id: 'L1', label: 'Loan EMI', due: R(15000) }],
      }),
    );
    const cap = p.recovery.cap;
    expect(p.recovery.total_recovered).toBe(cap);
    expect(p.recovery.carry_forward).toBe(R(15000) - cap);
    expect(p.net).toBeGreaterThan(0);

    const next = applyRecoveryCap(
      [
        { type: 'LOAN', ref_id: 'L1', label: 'Loan EMI', due: R(15000) },
        { type: 'CARRY', ref_id: null, label: 'Carried from last month', due: p.recovery.carry_forward },
      ],
      cap,
    );
    expect(next.items[0].type).toBe('CARRY');
    expect(next.items[0].recovered).toBe(Math.min(cap, p.recovery.carry_forward));
  });
});

describe('Weekly off / holiday pay flows into paid days', () => {
  it('a full month of work with paid Sundays has zero LOP', () => {
    const dates = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
    const month = runEmployeeMonth({
      ym: '2026-09',
      joined_on: '2025-01-01',
      last_day: null,
      weekly_off: ['SUN'],
      holidays: [],
      shift_start_min: SHIFT_START,
      policies: [ATTENDANCE, WEEKOFF_PAID],
      punches: Object.fromEntries(dates.filter((d) => new Date(d).getUTCDay() !== 0).map((d) => [d, fullDay(d)])),
      leave: {},
      overrides: {},
    });
    expect(month.totals.paid_days).toBe(30);
    expect(month.totals.lop_days).toBe(0);
  });
});
