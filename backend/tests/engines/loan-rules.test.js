import { describe, expect, it } from 'vitest';
import { describeLoanType, loanLimit, loanPlan } from '../../src/calculations/index.js';
import { R } from './fixtures.js';

const type = (t) => ({ name: 'Personal loan', kind: 'LOAN', active: true, max_gross_multiple: null, max_amount: null, max_instalments: 12, recovery_method: 'EQUAL_INSTALMENTS', recovery_pct: null, max_instalment_pct: null, min_service_months: 0, one_at_a_time: true, ...t });
const gross = R(30000);

describe('Loan and advance types', () => {
  it('the limit is the lower of the amount cap and the months of gross', () => {
    expect(loanLimit(type({ max_gross_multiple: 3 }), gross)).toBe(R(90000));
    expect(loanLimit(type({ max_gross_multiple: 3, max_amount: R(50000) }), gross)).toBe(R(50000));
    expect(loanLimit(type({}), gross)).toBeNull();
  });

  it('equal instalments: amount ÷ instalments chosen, within the maximum', () => {
    const p = loanPlan(type({ max_gross_multiple: 3 }), { amount: R(60000), gross, instalments: 12 });
    expect(p).toMatchObject({ limit: R(90000), instalment: R(5000), months: 12, errors: [] });
    expect(loanPlan(type({}), { amount: R(60000), gross, instalments: 13 }).errors[0]).toMatch(/at most 12 instalments/);
    expect(loanPlan(type({}), { amount: R(10000), gross, instalments: 3 })).toMatchObject({ instalment: R(3334), months: 3, last_instalment: R(3332) });
  });

  it('refuses more than the limit, too little service, or a second one at a time', () => {
    const errors = loanPlan(type({ max_gross_multiple: 2, min_service_months: 6 }), { amount: R(70000), gross, instalments: 10, service_months: 3, active_of_type: 1 }).errors;
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/at most ₹60,000/);
    expect(errors[1]).toMatch(/6 months of service/);
    expect(errors[2]).toMatch(/one at a time/i);
  });

  it('a percentage of gross each month, which must finish within the maximum instalments', () => {
    const t = type({ recovery_method: 'PCT_OF_GROSS', recovery_pct: 10, max_instalments: 10 });
    expect(loanPlan(t, { amount: R(25000), gross })).toMatchObject({ instalment: R(3000), months: 9, errors: [] });
    expect(loanPlan(t, { amount: R(40000), gross }).errors[0]).toMatch(/takes 14 months/);
  });

  it('a fixed monthly amount, capped as a share of gross', () => {
    const t = type({ kind: 'ADVANCE', name: 'Salary advance', recovery_method: 'FIXED_AMOUNT', max_instalments: 3, max_instalment_pct: 33, max_gross_multiple: 1 });
    expect(loanPlan(t, { amount: R(24000), gross, instalment: R(8000) })).toMatchObject({ instalment: R(8000), months: 3, errors: [] });
    expect(loanPlan(t, { amount: R(24000), gross, instalment: R(12000) }).errors[0]).toMatch(/more than 33% of gross/);
    expect(loanPlan(t, { amount: R(24000), gross, instalment: R(5000) }).errors[0]).toMatch(/takes 5 months/);
  });

  it('describes a type in words for the grant form', () => {
    expect(describeLoanType(type({ max_gross_multiple: 3, max_amount: R(100000), max_instalment_pct: 25, min_service_months: 6 }), gross))
      .toBe("Up to ₹90,000 (3 months' gross, at most ₹1,00,000) · at most 12 instalments · equal instalments · a month's instalment at most 25% of gross · after 6 months of service · one at a time");
  });
});
