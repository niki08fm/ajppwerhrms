import { describe, expect, it } from 'vitest';
import { salaryComponentSchema } from '@ajpwer/shared';
import { assemblePayslip, expandStructure, salaryPreview, validateStructure } from '../../src/calculations/index.js';
import { fullMonthTotals, payslipInput, R, STANDARD_STRUCTURE } from './fixtures.js';

// A structure from before: only Basic was ticked as an ESI wage. That tick no longer matters.
const OLD_TICKS = STANDARD_STRUCTURE.map((c) => ({ ...c, counts_as_esi_wages: c.name === 'Basic' }));

describe('ESI wages are the whole monthly gross', () => {
  it('every monthly component counts, whatever the structure once ticked', () => {
    const s = expandStructure(OLD_TICKS, R(20000));
    expect(s.esi_base).toBe(s.gross);
    expect(s.esi_base).toBe(R(20000));
  });

  it('yearly payouts stay outside the monthly ESI wage', () => {
    const withBonus = [...STANDARD_STRUCTURE, { seq: 5, name: 'Bonus', calc_type: 'FIXED', calc_value: R(12000), frequency: 'YEARLY', pay_month: 10, is_taxable: true, counts_as_wages: false }];
    expect(expandStructure(withBonus, R(20000)).esi_base).toBe(R(20000));
  });

  it('a payslip deducts ESI on everything earned, loss of pay included', () => {
    const full = assemblePayslip(payslipInput({ components: OLD_TICKS, monthly_gross: R(20000), statutory: { ...payslipInput().statutory, esi_applicable: true } }));
    expect(full.esi_wage).toBe(R(20000));
    expect(full.lines.find((l) => l.code === 'ESI').amount).toBe(R(150)); // 0.75% of ₹20,000
    const lop = assemblePayslip(payslipInput({ components: OLD_TICKS, monthly_gross: R(20000), attendance: fullMonthTotals('2026-09', 30, { paid_days: 27, day_value_sum: 27, lop_days: 3, lop_in_window: 3, present: 27, absent: 3 }),
      statutory: { ...payslipInput().statutory, esi_applicable: true } }));
    expect(lop.esi_wage).toBe(lop.gross);
  });

  it('the structure has nothing to tick: saved components always count', () => {
    const parsed = salaryComponentSchema.parse({ seq: 3, name: 'Conveyance', pay_month: null, calc_type: 'FIXED', calc_value: R(1600), frequency: 'MONTHLY', is_taxable: true, counts_as_wages: false, counts_as_esi_wages: false });
    expect(parsed.counts_as_esi_wages).toBe(true);
    const { warnings } = validateStructure(OLD_TICKS.map((c) => ({ ...c, counts_as_esi_wages: false })), R(20000), 0);
    expect(warnings.join(' ')).not.toMatch(/ESI/);
  });

  it('the salary preview turns ESI on by gross alone', () => {
    const base = { mode: 'GROSS', components: STANDARD_STRUCTURE, pf: { pf_enabled: true, pf_restrict_to_ceiling: true, vpf_pct: 0 }, pt: { pt_applicable: false }, pt_slabs: [],
      rates: payslipInput().rates, declarations: {}, regime: payslipInput().tax.regime, esi_enabled: false };
    expect(salaryPreview({ ...base, amount: R(21000) })).toMatchObject({ esi_within_ceiling: true, esi: { employee: R(158) } });
    expect(salaryPreview({ ...base, amount: R(21001) })).toMatchObject({ esi_within_ceiling: false, esi: { employee: 0 } });
  });
});
