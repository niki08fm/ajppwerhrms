import { describe, expect, it } from 'vitest';
import { describeOvertimeBase, overtimeBaseMonthly, overtimeRulesSchema } from '@ajpwer/shared';
import { assemblePayslip, expandStructure, overtimePay, validateStructure } from '../../src/calculations/index.js';
import { fullMonthTotals, OVERTIME, payslipInput, R, STANDARD_STRUCTURE } from './fixtures.js';

const rules = { ...OVERTIME.rules, divisor: 25, monthly_cap_min: null };
const salary = { basic: R(12000), hra: R(4800), da: R(2000), gross: R(24000) };
const combinations = [
  ['basic'], ['hra'], ['da'], ['basic', 'hra'], ['basic', 'da'], ['hra', 'da'], ['basic', 'hra', 'da'],
];

describe('Overtime salary components', () => {
  it.each(combinations.map((components) => [components.join(' + '), components]))('pays on %s only', (_label, components) => {
    const r = overtimeRulesSchema.parse({ ...rules, base: 'COMPONENTS', components });
    const expectedBase = components.reduce((sum, key) => sum + salary[key], 0);
    const ot = overtimePay(60, r, salary, 26);
    expect(ot.base_monthly).toBe(expectedBase);
    expect(ot.hourly).toBe(expectedBase / 200); // 25 days × 8 hours
    expect(ot.amount).toBe(expectedBase / 100); // One hour at 2×
    expect(overtimeBaseMonthly(r, salary)).toBe(ot.base_monthly);
  });

  it.each([['BASIC', R(12000)], ['BASIC_HRA', R(16800)], ['GROSS', R(24000)]])('preserves the legacy %s base', (base, expectedBase) => {
    const r = overtimeRulesSchema.parse({ ...rules, base });
    expect(overtimePay(60, r, salary, 26).base_monthly).toBe(expectedBase);
    expect(overtimeBaseMonthly(r, salary)).toBe(expectedBase);
  });

  it('treats missing DA as zero and retains monthly caps and rounding', () => {
    const oldSalary = { basic: salary.basic, hra: salary.hra, gross: salary.gross };
    const r = { ...rules, base: 'COMPONENTS', components: ['basic', 'da'], monthly_cap_min: 90 };
    const ot = overtimePay(120, r, oldSalary, 26);
    expect(ot).toMatchObject({ base_monthly: R(12000), hourly: R(60), paid_min: 90, excess_min: 30, amount: R(180) });
    expect(overtimePay(60, { ...r, components: ['da'] }, oldSalary, 26).amount).toBe(0);
  });

  it('rejects missing, empty, duplicate or unsupported selections and combining gross with components', () => {
    for (const components of [undefined, [], ['basic', 'basic'], ['gross'], ['special']]) {
      expect(overtimeRulesSchema.safeParse({ ...rules, base: 'COMPONENTS', ...(components === undefined ? {} : { components }) }).success).toBe(false);
    }
    expect(overtimeRulesSchema.safeParse({ ...rules, base: 'GROSS', components: ['basic'] }).success).toBe(false);
    expect(overtimeRulesSchema.safeParse({ ...rules, base: 'BASIC_HRA', components: ['da'] }).success).toBe(false);
  });

  it('does not add gross or duplicate components a second time in the arithmetic', () => {
    expect(overtimePay(60, { ...rules, base: 'GROSS', components: ['basic', 'hra', 'da'] }, salary, 26).base_monthly).toBe(salary.gross);
    expect(overtimeBaseMonthly({ base: 'COMPONENTS', components: ['basic', 'basic'] }, salary)).toBe(salary.basic);
    expect(describeOvertimeBase({ base: 'COMPONENTS', components: ['basic', 'da'] })).toBe('Basic + DA');
  });
});

describe('DA in salary structures and payslips', () => {
  const daComponent = { seq: 5, name: 'DA', calc_type: 'FIXED', calc_value: R(2000), frequency: 'MONTHLY', pay_month: null, is_taxable: true, counts_as_wages: true };

  it('exposes only monthly DA and keeps structures without it unchanged', () => {
    expect(expandStructure(STANDARD_STRUCTURE, salary.gross).da).toBe(0);
    const withDa = expandStructure([...STANDARD_STRUCTURE, daComponent], salary.gross);
    expect(withDa.da).toBe(R(2000));
    expect(withDa.gross).toBe(salary.gross);
    expect(withDa.pf_base).toBe(R(14000));
    const namedAllowance = expandStructure([...STANDARD_STRUCTURE, { ...daComponent, name: 'Dearness Allowance' }], salary.gross);
    expect(namedAllowance.da).toBe(R(2000));
    const annual = expandStructure([...STANDARD_STRUCTURE, { ...daComponent, frequency: 'YEARLY', pay_month: 10 }], salary.gross);
    expect(annual.da).toBe(0);
  });

  it('a removable zero DA component leaves salary and PF amounts unchanged', () => {
    const original = expandStructure(STANDARD_STRUCTURE, salary.gross);
    const withZeroDa = expandStructure([...STANDARD_STRUCTURE, { ...daComponent, calc_value: 0 }], salary.gross);
    expect(withZeroDa).toMatchObject({ gross: original.gross, basic: original.basic, hra: original.hra, pf_base: original.pf_base, da: 0 });
    expect(withZeroDa.monthly.find((line) => line.name === 'Special Allowance').amount).toBe(original.monthly.find((line) => line.name === 'Special Allowance').amount);
  });

  it('rejects yearly-only Basic in new structures without changing legacy expansion', () => {
    const yearlyBasic = STANDARD_STRUCTURE.find((c) => c.name === 'Basic');
    const balance = STANDARD_STRUCTURE.find((c) => c.calc_type === 'BALANCE');
    const components = [
      { ...daComponent, seq: 1 },
      { ...yearlyBasic, seq: 2, frequency: 'YEARLY', pay_month: 10 },
      { ...balance, seq: 3 },
    ];
    expect(validateStructure(components, salary.gross).errors).toContain('A monthly component must be named Basic. PF, HRA and overtime need one.');
    expect(validateStructure([...STANDARD_STRUCTURE, daComponent], salary.gross).errors).toEqual([]);
    // Historic structures retain the documented first-monthly-component fallback.
    expect(expandStructure(components, salary.gross)).toMatchObject({ basic: R(2000), da: R(2000) });
  });

  it('carries selected Basic + DA amounts all the way through the payslip OT line', () => {
    const p = assemblePayslip(payslipInput({
      components: [...STANDARD_STRUCTURE, daComponent],
      divisor: 25,
      overtime_rules: { ...rules, base: 'COMPONENTS', components: ['basic', 'da'] },
      attendance: fullMonthTotals('2026-09', 30, { ot_min: 600 }),
    }));
    expect(p.ot).toMatchObject({ hourly: R(70), amount: R(1400), paid_min: 600 });
    expect(p.lines.find((line) => line.kind === 'OT').amount).toBe(R(1400));
    expect(p.salary_gross).toBe(R(25400));
  });
});
