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

describe('Overtime is never part of ESI wages', () => {
  const inputWithOT = () => payslipInput({
    statutory: covered, divisor: 30, overtime_rules: OVERTIME.rules,
    attendance: fullMonthTotals('2026-09', 30, { ot_min: 60 }),
  });
  it('pays OT in full but leaves it out of both ESI shares, whatever older rates rows say', () => {
    const input = inputWithOT();
    const p = assemblePayslip(input);
    expect(amount(p, 'OT')).toBeGreaterThan(0);
    expect(p.esi_wage).toBe(R(24000));
    expect(amount(p, 'ESI')).toBe(R(180));
    expect(amount(p, 'ER_ESI')).toBe(R(780));
    const legacy = assemblePayslip({ ...input, rates: { ...input.rates, esi: { ...input.rates.esi, include_overtime: true } } });
    expect(legacy).toEqual(p);
  });

  it('older rates rows still read', () => {
    const rates = { ceiling: R(21000), employee_pct: 0.75, employer_pct: 3.25 };
    expect(esiRatesSchema.parse(rates).include_overtime).toBe(false);
    expect(esiRatesSchema.parse({ ...rates, include_overtime: true }).include_overtime).toBe(true);
    expect(() => esiRatesSchema.parse({ ...rates, include_overtime: 'false' })).toThrow();
  });
});
