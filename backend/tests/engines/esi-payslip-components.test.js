import { describe, expect, it } from 'vitest';
import { esiRatesSchema, structureCreateSchema } from '@ajpwer/shared';
import { assemblePayslip } from '../../src/calculations/index.js';
import { fullMonthTotals, OVERTIME, payslipInput, R, STANDARD_STRUCTURE } from './fixtures.js';

const selected = STANDARD_STRUCTURE.map((c) => ({ ...c, counts_as_esi_wages: ['Basic', 'HRA'].includes(c.name) }));
const covered = { ...payslipInput().statutory, esi_applicable: true };
const amount = (result, code) => result.lines.find((line) => line.code === code)?.amount ?? 0;

describe('Selected ESI wages in payslips', () => {
  it('preserves legacy wages and excludes yearly and adhoc payouts', () => {
    const result = assemblePayslip(payslipInput({
      statutory: covered,
      components: [...STANDARD_STRUCTURE, { seq: 5, name: 'Annual bonus', calc_type: 'FIXED', calc_value: R(12000), frequency: 'YEARLY', pay_month: 9, is_taxable: true, counts_as_wages: false, counts_as_esi_wages: true }],
      adhoc: [{ id: 'bonus', kind: 'EARNING', name: 'Bonus', amount: R(5000), is_taxable: true }],
    }));
    expect(result.gross).toBe(R(41000));
    expect(result.esi_wage).toBe(result.statutory_gross);
    expect(result.esi_wage).toBe(R(24000));
    expect(amount(result, 'ESI')).toBe(R(180));
    expect(amount(result, 'ER_ESI')).toBe(R(780));
  });

});

describe('ESI component schema compatibility', () => {
  it('defaults legacy monthly rows and the inserted Special Allowance to included', () => {
    const structure = structureCreateSchema.parse({ name: 'Legacy', components: STANDARD_STRUCTURE.slice(0, 3) });
    expect(structure.components.every((c) => c.counts_as_esi_wages)).toBe(true);
    expect(structure.components.at(-1).name).toBe('Special Allowance');
  });

});

describe('Effective-dated OT contribution setting', () => {
  const inputWithOT = () => payslipInput({
    statutory: covered, divisor: 30, overtime_rules: OVERTIME.rules,
    attendance: fullMonthTotals('2026-09', 30, { ot_min: 60 }),
  });
  it('excludes OT from both ESI contributions only when explicitly configured, keeping OT earnings intact', () => {
    const input = inputWithOT();
    const standard = assemblePayslip(input);
    const excluded = assemblePayslip({ ...input, rates: { ...input.rates, esi: { ...input.rates.esi, include_overtime: false } } });
    expect(amount(excluded, 'OT')).toBeGreaterThan(0);
    expect(amount(excluded, 'OT')).toBe(amount(standard, 'OT'));
    expect(excluded.gross).toBe(standard.gross);
    expect(excluded.statutory_gross).toBe(standard.statutory_gross);
    expect(excluded.esi_wage).toBe(R(24000));
    expect(standard.esi_wage - excluded.esi_wage).toBe(amount(excluded, 'OT'));
    expect(amount(excluded, 'ESI')).toBe(R(180));
    expect(amount(excluded, 'ER_ESI')).toBe(R(780));
    expect(excluded.net - standard.net).toBe(amount(standard, 'ESI') - amount(excluded, 'ESI'));
    expect(amount(excluded, 'PF')).toBe(amount(standard, 'PF'));
    expect(amount(excluded, 'PT')).toBe(amount(standard, 'PT'));
  });
  it('explicit inclusion and legacy rates produce identical contributions', () => {
    const input = inputWithOT();
    expect(assemblePayslip({ ...input, rates: { ...input.rates, esi: { ...input.rates.esi, include_overtime: true } } })).toEqual(assemblePayslip(input));
  });
});


describe('ESI OT setting compatibility', () => {
  it('defaults existing rate rows to standard OT inclusion and preserves explicit exclusion', () => {
    const rates = { ceiling: R(21000), employee_pct: 0.75, employer_pct: 3.25 };
    expect(esiRatesSchema.parse(rates).include_overtime).toBe(true);
    expect(esiRatesSchema.parse({ ...rates, include_overtime: false }).include_overtime).toBe(false);
    expect(() => esiRatesSchema.parse({ ...rates, include_overtime: 'false' })).toThrow();
  });
});
