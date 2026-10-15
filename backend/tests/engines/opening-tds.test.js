import { describe, expect, it } from 'vitest';
import { assemblePayslip } from '../../src/calculations/index.js';
import { payslipInput, R } from './fixtures.js';

/** Basic 50% of gross, HRA 25% of gross, Special Allowance the balance; all taxable. */
const STRUCTURE = [
  { seq: 1, name: 'Basic', calc_type: 'PCT_GROSS', calc_value: 50, frequency: 'MONTHLY', pay_month: null, is_taxable: true, counts_as_wages: true },
  { seq: 2, name: 'HRA', calc_type: 'PCT_GROSS', calc_value: 25, frequency: 'MONTHLY', pay_month: null, is_taxable: true, counts_as_wages: false },
  { seq: 3, name: 'Special Allowance', calc_type: 'BALANCE', calc_value: 0, frequency: 'MONTHLY', pay_month: null, is_taxable: true, counts_as_wages: false },
];
const DIRECTOR = R(383000);

/** A month of a director on ₹3,83,000 (new regime): the year's tax at that salary is ₹9,73,752. */
function tdsFor(ym, history, overrides = {}) {
  const base = payslipInput({ ym, components: STRUCTURE, monthly_gross: DIRECTOR, ...overrides });
  const r = assemblePayslip({ ...base, tax: { ...base.tax, months_in_fy: 12, history } });
  return r;
}
const tdsLine = (r) => r.lines.find((l) => l.code === 'TDS')?.amount ?? 0;
const history = (h) => ({ opening_tds: null, earlier_months: 0, earlier_taxable: 0, run_months: 0, run_taxable: 0, run_tds: 0, remaining_months: 12, ...h });

describe('TDS deducted before AJPWER (Section 192)', () => {
  it('October after go-live: the year’s tax less April–September TDS, over the six months left', () => {
    const r = tdsFor('2026-10', history({ opening_tds: R(486876), earlier_months: 6, earlier_taxable: DIRECTOR * 6, remaining_months: 6 }));
    expect(r.tds.annual).toBe(R(973752));
    expect(tdsLine(r)).toBe(R(81146));
    expect(r.tds).toMatchObject({ opening_tds: R(486876), deducted_before: R(486876), remaining_months: 6 });
  });

  it('too little deducted before go-live: the shortfall is spread over the months left', () => {
    const r = tdsFor('2026-10', history({ opening_tds: 0, earlier_months: 6, earlier_taxable: DIRECTOR * 6, remaining_months: 6 }));
    expect(tdsLine(r)).toBe(R(162292));
  });

  it('more deducted before go-live than the year’s tax: nothing more is deducted', () => {
    const r = tdsFor('2026-10', history({ opening_tds: R(1000000), earlier_months: 6, earlier_taxable: DIRECTOR * 6, remaining_months: 6 }));
    expect(tdsLine(r)).toBe(0);
    expect(r.tds.regular).toBe(0);
  });

  it('counts the TDS on AJPWER payslips already run this year', () => {
    const r = tdsFor('2026-11', history({ opening_tds: R(486876), earlier_months: 6, earlier_taxable: DIRECTOR * 6, run_months: 1, run_taxable: DIRECTOR, run_tds: R(81146), remaining_months: 5 }));
    expect(tdsLine(r)).toBe(R(81146));
    expect(r.tds.deducted_before).toBe(R(568022));
  });

  it('an increment after go-live raises the year’s tax and the rest is trued up over the months left', () => {
    // Apr–Oct at ₹3,83,000, Nov–Mar at ₹4,50,000: income ₹49,31,000, tax ₹10,78,272.
    const r = tdsFor('2026-11',
      history({ opening_tds: R(486876), earlier_months: 6, earlier_taxable: DIRECTOR * 6, run_months: 1, run_taxable: DIRECTOR, run_tds: R(81146), remaining_months: 5 }),
      { monthly_gross: R(450000) });
    expect(r.tds.annual).toBe(R(1078272));
    expect(tdsLine(r)).toBe(R(102050));
  });

  it('with nothing entered and no AJPWER payslips yet, TDS is exactly what it was', () => {
    const without = tdsFor('2026-10', undefined);
    const nothing = tdsFor('2026-10', history({ earlier_months: 6, earlier_taxable: DIRECTOR * 6, remaining_months: 6 }));
    expect(tdsLine(nothing)).toBe(tdsLine(without));
    expect(tdsLine(without)).toBe(R(81146));
  });

  it('with nothing entered, months before go-live count as deducted at the even rate', () => {
    // Earlier at ₹3,83,000; now ₹4,50,000 with one AJPWER month run. Nothing is entered for Apr–Sep.
    const r = tdsFor('2026-11',
      history({ earlier_months: 6, earlier_taxable: DIRECTOR * 6, run_months: 1, run_taxable: DIRECTOR, run_tds: R(81146), remaining_months: 5 }),
      { monthly_gross: R(450000) });
    // Assumed for Apr–Sep: 6 × (₹10,78,272 ÷ 12 = ₹89,856) = ₹5,39,136.
    expect(r.tds.deducted_before).toBe(R(539136) + R(81146));
    expect(tdsLine(r)).toBe(R(91598));
  });
});
