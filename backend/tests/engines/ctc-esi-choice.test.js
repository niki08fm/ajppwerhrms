import { describe, expect, it } from 'vitest';
import { AJPWER_RATES } from '@ajpwer/shared';
import { assemblePayslip, ctcForGross, salaryPreview, solveGrossFromCtc } from '../../src/calculations/index.js';
import { NEW_REGIME, NO_DECL, payslipInput, PF_ON, PT_SLABS, R, RATES, STANDARD_STRUCTURE } from './fixtures.js';

const ctx = { components: STANDARD_STRUCTURE, pf: PF_ON, esi_enabled: true, rates: { pf: RATES.pf, esi: RATES.esi } };
const input = (overrides = {}) => ({
  ...ctx, mode: 'CTC', amount: R(275316),
  pt: { pt_applicable: true, pt_state: 'Andhra Pradesh', gender: 'MALE' },
  pt_slabs: PT_SLABS, regime: NEW_REGIME, declarations: NO_DECL, month: 10,
  ...overrides,
});

describe('Eligible ESI is the first CTC preview option', () => {
  it('rounds the monthly salary for ₹275,325 and calculates ₹275,328 CTC without forcing ESI', () => {
    const preview = salaryPreview(input({ amount: R(275325) }));
    expect(preview).toMatchObject({ gross: R(21645), esi_within_ceiling: false, esi_eligible_gross: null,
      solution: { ambiguous: false, approximate: false, alternative: null },
      ctc: { employer_pf: R(1299), employer_esi: 0, monthly_cost: R(22944), annual_ctc: R(275328) },
    });
    expect(ctcForGross(preview.gross, ctx).annual_ctc).toBe(R(275328));
    expect(preview.ctc).not.toHaveProperty('rounding_difference');
  });

  it('keeps both rounded whole-rupee choices when the original target fits the eligible branch', () => {
    const solution = solveGrossFromCtc(R(275313), ctx);
    expect(solution).toMatchObject({ gross: R(21000), ambiguous: true, approximate: false,
      breakdown: { annual_ctc: R(275316), employer_esi: R(683) },
      alternative: { gross: R(21644), breakdown: { annual_ctc: R(275316), employer_esi: 0 } },
    });
    expect(salaryPreview(input({ amount: R(275313), chosen_gross: R(21644) })).gross).toBe(R(21644));
  });

  it('never uses even a one-paise annual reduction to force eligibility at the ESI ceiling', () => {
    for (const esi_enabled of [true, false]) {
      const preview = salaryPreview(input({ amount: R(275316) + 1, esi_enabled }));
      expect(preview.solution).toMatchObject({ gross: R(21645), approximate: false, ambiguous: false, alternative: null });
      expect(preview.ctc.annual_ctc).toBe(R(275328));
      expect(preview.esi_eligible_gross).toBeNull();
    }
  });

  it('rounds upward to the nearest whole rupee even without employer PF or ESI', () => {
    const preview = salaryPreview(input({ amount: R(275325), pf: { ...PF_ON, pf_enabled: false }, esi_enabled: false }));
    expect(preview).toMatchObject({ gross: R(22944), ctc: { employer_pf: 0, employer_esi: 0, annual_ctc: R(275328) }, solution: { approximate: false } });
  });

  it('rounds upward for an annual target between whole-rupee salary candidates', () => {
    expect(salaryPreview(input({ amount: R(275322) }))).toMatchObject({ gross: R(21645), ctc: { annual_ctc: R(275328) } });
  });

  it('rounds the screenshot target upward and keeps the resulting salary above the ESI ceiling', () => {
    expect(salaryPreview(input({ amount: R(276578) }))).toMatchObject({ gross: R(21744), esi_eligible_gross: null,
      ctc: { employer_pf: R(1305), employer_esi: 0, annual_ctc: R(276588) }, solution: { approximate: false },
    });
  });

  it('rounds editable gross paise upward while retaining a historical saved gross exactly', () => {
    expect(salaryPreview(input({ mode: 'GROSS', amount: R(21644.25) })).gross).toBe(R(21645));
    expect(salaryPreview(input({ mode: 'GROSS', amount: R(21644.25), saved_gross: R(21644.25) })).gross).toBe(R(21644.25));
  });

  it('allows the actual neighboring statutory cost step even when it exceeds ₹24 a year', () => {
    const components = [{ ...STANDARD_STRUCTURE[0], calc_value: 10 }, { ...STANDARD_STRUCTURE[3], seq: 2 }];
    const preview = salaryPreview(input({ components, amount: R(58992.01) }));
    expect(preview).toMatchObject({ gross: R(4708), ctc: { annual_ctc: R(59028) },
      solution: { approximate: false, rounding_limit: R(36) },
    });
    expect(ctcForGross(R(4707), { ...ctx, components }).annual_ctc).toBe(R(58992));
  });

  it('validates a selected without-ESI choice against that choice’s own upward cost step', () => {
    const preview = salaryPreview(input({ amount: R(267216.01), chosen_gross: R(21009),
      rates: { pf: AJPWER_RATES.pf, esi: AJPWER_RATES.esi } }));
    expect(preview).toMatchObject({ gross: R(21009), ctc: { annual_ctc: R(267240), employer_esi: 0 },
      solution: { approximate: false, ambiguous: true, rounding_limit: R(12), alternative: { rounding_limit: R(24) } },
    });
  });

  it('selects a canonical upward CTC instead of a lower normalized percentage-of-CTC result', () => {
    const components = [{ ...STANDARD_STRUCTURE[0], calc_type: 'PCT_CTC', calc_value: 40 }, { ...STANDARD_STRUCTURE[3], seq: 2 }];
    const preview = salaryPreview(input({ components, amount: R(37873.65), esi_enabled: false,
      rates: { pf: AJPWER_RATES.pf, esi: AJPWER_RATES.esi } }));
    expect(preview).toMatchObject({ gross: R(3006), ctc: { ctc_basis: R(37896), annual_ctc: R(37896) }, solution: { approximate: false } });
    const saved = salaryPreview(input({ components, amount: preview.ctc.annual_ctc, saved_gross: preview.gross, esi_enabled: false,
      rates: { pf: AJPWER_RATES.pf, esi: AJPWER_RATES.esi } }));
    expect(saved.structure).toEqual(preview.structure);
    expect(saved.ctc).toEqual(preview.ctc);
  });

  it('keeps a yearly-paise flat salary valid and reports the same rounded annual cost after saving', () => {
    const components = [{ ...STANDARD_STRUCTURE[0], calc_type: 'FIXED', calc_value: R(22000) },
      { ...STANDARD_STRUCTURE[3], seq: 2 },
      { ...STANDARD_STRUCTURE[2], seq: 3, name: 'Bonus', calc_value: 25, frequency: 'YEARLY', pay_month: 4 }];
    const overrides = { components, esi_enabled: false, rates: { pf: AJPWER_RATES.pf, esi: AJPWER_RATES.esi } };
    const preview = salaryPreview(input({ ...overrides, amount: R(295680.25) }));
    expect(preview).toMatchObject({ gross: R(22000), ctc: { raw_annual_ctc: R(295680.25), annual_ctc: R(295681) }, solution: { approximate: false } });
    const saved = salaryPreview(input({ ...overrides, amount: preview.ctc.annual_ctc, saved_gross: preview.gross }));
    expect(saved.ctc.annual_ctc).toBe(preview.ctc.annual_ctc);
  });

  it('rounds gross-mode annual display without changing the component basis used by payroll', () => {
    const components = [{ ...STANDARD_STRUCTURE[0], calc_type: 'PCT_CTC', calc_value: 40 },
      { ...STANDARD_STRUCTURE[3], seq: 2 },
      { ...STANDARD_STRUCTURE[2], seq: 3, name: 'Bonus', calc_value: 374, frequency: 'YEARLY', pay_month: 4 }];
    const rates = { pf: AJPWER_RATES.pf, esi: AJPWER_RATES.esi };
    const overrides = { components, mode: 'GROSS', amount: R(1081), esi_enabled: false, rates };
    const preview = salaryPreview(input(overrides));
    const basis = ctcForGross(preview.gross, { ...ctx, components, esi_enabled: false, rates });
    expect(preview.ctc).toMatchObject({ ctc_basis: R(13623.74), raw_annual_ctc: R(13623.74), annual_ctc: R(13624), employer_pf: R(54) });
    expect(preview.ctc.ctc_basis).toBe(basis.annual_ctc);
    expect(salaryPreview(input({ ...overrides, saved_gross: preview.gross })).structure).toEqual(preview.structure);
    const payroll = assemblePayslip(payslipInput({ components, monthly_gross: preview.gross, annual_ctc: basis.annual_ctc,
      rates: { ...rates, recovery_cap_pct: 40 } }));
    expect(payroll.employer_total).toBe(R(54));
  });

  it('requires the expanded gross to match the proposed gross, excluding a fixed salary above the ESI ceiling', () => {
    const components = [
      { ...STANDARD_STRUCTURE[0], calc_type: 'FIXED', calc_value: R(22000) },
      { ...STANDARD_STRUCTURE[3], seq: 2 },
    ];
    const preview = salaryPreview(input({ components, amount: R(288036) }));
    expect(preview).toMatchObject({ gross: R(22203), esi_within_ceiling: false, esi_eligible_gross: null,
      solution: { approximate: false, ambiguous: false }, ctc: { employer_esi: 0 },
    });
    const belowFloor = salaryPreview(input({ components, amount: R(275316) }));
    expect(belowFloor.solution.approximate).toBe(true);
    expect(belowFloor.esi_eligible_gross).toBeNull();
  });

  it('normalizes the CTC basis for new percentage-of-CTC agreements while preserving saved bases', () => {
    const components = [
      { ...STANDARD_STRUCTURE[0], calc_type: 'PCT_CTC', calc_value: 40 },
      { ...STANDARD_STRUCTURE[3], seq: 2 },
    ];
    const preview = salaryPreview(input({ components, amount: R(600009) }));
    expect(preview.gross % 100).toBe(0);
    expect(preview.ctc.ctc_basis).toBe(preview.ctc.annual_ctc);
    expect(preview.structure.basic).toBe(Math.round(preview.ctc.annual_ctc * 0.4 / 12));
    const saved = salaryPreview(input({ components, amount: R(600009), saved_gross: preview.gross }));
    expect(saved.ctc.ctc_basis).toBe(R(600009));
  });

  it('chooses the lowest stable upward salary when the lower salary cycles between component bases', () => {
    const components = [STANDARD_STRUCTURE[0], { ...STANDARD_STRUCTURE[1], calc_type: 'PCT_CTC', calc_value: 30 },
      { ...STANDARD_STRUCTURE[3], seq: 3, counts_as_wages: true }];
    const preview = salaryPreview(input({ components, amount: R(246792), esi_enabled: false, rates: { pf: AJPWER_RATES.pf, esi: AJPWER_RATES.esi } }));
    const cycled = ctcForGross(R(19024), { ...ctx, components, esi_enabled: false, rates: { pf: AJPWER_RATES.pf, esi: AJPWER_RATES.esi } });
    expect(cycled.ctc_basis).not.toBe(cycled.annual_ctc);
    expect(preview.gross).toBe(R(19025));
    expect(preview.ctc).toMatchObject({ ctc_basis: R(246816), annual_ctc: R(246816) });
    expect(preview.solution.approximate).toBe(false);
  });

  it('excludes an unstable eligible branch and selects the stable without-ESI salary', () => {
    const components = [{ ...STANDARD_STRUCTURE[0], calc_value: 20 },
      { ...STANDARD_STRUCTURE[1], calc_type: 'PCT_CTC', calc_value: 12.6 },
      { ...STANDARD_STRUCTURE[3], seq: 3, counts_as_wages: true }];
    const rates = { pf: AJPWER_RATES.pf, esi: AJPWER_RATES.esi };
    const preview = salaryPreview(input({ components, amount: R(286104), rates }));
    const invalidEligible = ctcForGross(R(21000), { ...ctx, components, rates }, true, undefined, { round_annual_up: true });
    expect(invalidEligible.ctc_basis).not.toBe(invalidEligible.annual_ctc);
    expect(preview).toMatchObject({ gross: R(21609), esi_eligible_gross: null,
      ctc: { annual_ctc: R(286104), employer_esi: 0, ctc_basis: R(286104) },
      solution: { approximate: false, ambiguous: false, alternative: null },
    });
  });

  it('a stable normalized agreement produces the same saved preview, component basis and payroll contributions', () => {
    const components = [STANDARD_STRUCTURE[0], { ...STANDARD_STRUCTURE[1], calc_type: 'PCT_CTC', calc_value: 30 },
      { ...STANDARD_STRUCTURE[3], seq: 3, counts_as_wages: true }];
    const rates = { pf: AJPWER_RATES.pf, esi: AJPWER_RATES.esi };
    const preview = salaryPreview(input({ components, amount: R(246804), esi_enabled: false, rates }));
    expect(preview.solution.approximate).toBe(false);
    expect(preview.ctc.ctc_basis).toBe(preview.ctc.annual_ctc);
    const saved = salaryPreview(input({ components, amount: preview.ctc.annual_ctc, saved_gross: preview.gross, esi_enabled: false, rates }));
    expect(saved.structure).toEqual(preview.structure);
    expect(saved.ctc).toEqual(preview.ctc);
    const payroll = assemblePayslip(payslipInput({ components, monthly_gross: preview.gross, annual_ctc: preview.ctc.annual_ctc, rates: { ...rates, recovery_cap_pct: 40 } }));
    expect(payroll.gross).toBe(preview.gross);
    expect(payroll.employer_total).toBe(preview.ctc.employer_pf);
  });

  it('reproduces ₹275,316 with gross ₹21,000 and employer PF plus ESI, retaining the without-ESI choice', () => {
    const result = solveGrossFromCtc(R(275316), ctx);
    expect(result).toMatchObject({ gross: R(21000), ambiguous: true, approximate: false,
      breakdown: { employer_pf: R(1260), employer_esi: R(683), esi_applies: true, annual_ctc: R(275316) },
      alternative: { gross: R(21644), breakdown: { employer_pf: R(1299), employer_esi: 0, esi_applies: false, annual_ctc: R(275316) } },
    });
  });

  it('round trips a gross at the ceiling to the same CTC and back to the same default gross', () => {
    const cost = ctcForGross(R(21000), ctx);
    expect(cost.annual_ctc).toBe(R(275316));
    expect(solveGrossFromCtc(cost.annual_ctc, ctx).gross).toBe(R(21000));
  });

  it('honors an explicit without-ESI choice while retaining the eligible alternative as information', () => {
    const preview = salaryPreview(input({ chosen_gross: R(21644) }));
    expect(preview).toMatchObject({ gross: R(21644), esi_within_ceiling: false, esi_eligible_gross: R(21000),
      ctc: { employer_esi: 0, annual_ctc: R(275316) }, esi: { employee: 0, employer: 0 },
    });
  });

  it('does not enable ESI when disabled, but still reports the valid ESI-included CTC candidate', () => {
    const preview = salaryPreview(input({ esi_enabled: false }));
    expect(preview).toMatchObject({ gross: R(21644), esi_within_ceiling: false, esi_eligible_gross: R(21000),
      solution: { ambiguous: false, alternative: null }, ctc: { employer_esi: 0 }, esi: { employee: 0, employer: 0 },
    });
  });

  it('falls back to without ESI when no eligible candidate reproduces the CTC', () => {
    const preview = salaryPreview(input({ amount: R(400000) }));
    expect(preview.gross).toBeGreaterThan(RATES.esi.ceiling);
    expect(preview).toMatchObject({ esi_eligible_gross: null, esi_within_ceiling: false,
      solution: { ambiguous: false, approximate: false }, ctc: { employer_esi: 0, annual_ctc: R(400008) },
    });
  });

  it('keeps the unique ESI option below the two-choice band', () => {
    const cost = ctcForGross(R(18000), ctx);
    const preview = salaryPreview(input({ amount: cost.annual_ctc }));
    expect(preview).toMatchObject({ gross: R(18000), esi_eligible_gross: R(18000),
      solution: { ambiguous: false, approximate: false }, ctc: { esi_applies: true },
    });
  });

  it('deducts employee contributions from take-home only, not ESI eligibility wages or CTC', () => {
    const preview = salaryPreview(input());
    expect(preview.gross).toBe(R(21000));
    expect(preview.esi_within_ceiling).toBe(true);
    expect(preview.pf.employee).toBe(R(1260));
    expect(preview.esi.employee).toBe(R(158));
    expect(preview.ctc.monthly_cost).toBe(R(21000 + 1260 + 683));
    expect(preview.take_home).toBe(preview.gross - preview.pf.employee - preview.esi.employee - preview.pt.amount - preview.tds_monthly);
    // A higher actual gross stays ineligible even when deductions take net pay below the ceiling.
    const above = salaryPreview(input({ mode: 'GROSS', amount: R(21644) }));
    expect(above.take_home).toBeLessThan(RATES.esi.ceiling);
    expect(above).toMatchObject({ esi_within_ceiling: false, esi_eligible_gross: null, esi: { employee: 0 } });
  });

  it('reports gross-mode eligibility without turning on a disabled ESI flag', () => {
    expect(salaryPreview(input({ mode: 'GROSS', amount: R(21000), esi_enabled: false }))).toMatchObject({
      gross: R(21000), esi_within_ceiling: true, esi_eligible_gross: R(21000), esi: { employee: 0, employer: 0 },
    });
  });

  it('preserves trusted saved gross after a statutory flag changes, without accepting an invalid editable choice', () => {
    const actual = salaryPreview(input({ esi_enabled: false, saved_gross: R(21000) }));
    expect(actual).toMatchObject({ gross: R(21000), esi_within_ceiling: true, ctc: { employer_esi: 0 } });
    expect(salaryPreview(input({ esi_enabled: false, chosen_gross: R(21000) })).gross).toBe(R(21644));
    expect(salaryPreview(input({ chosen_gross: R(19000) })).gross).toBe(R(21000));
  });
});
