import { describe, expect, it } from 'vitest';
import { ctcForGross, salaryPreview, solveGrossFromCtc } from '../../src/calculations/index.js';
import { NEW_REGIME, NO_DECL, PF_ON, PT_SLABS, R, RATES, STANDARD_STRUCTURE } from './fixtures.js';

const ctx = { components: STANDARD_STRUCTURE, pf: PF_ON, esi_enabled: true, rates: { pf: RATES.pf, esi: RATES.esi } };
const input = (overrides = {}) => ({
  ...ctx, mode: 'CTC', amount: R(275316),
  pt: { pt_applicable: true, pt_state: 'Andhra Pradesh', gender: 'MALE' },
  pt_slabs: PT_SLABS, regime: NEW_REGIME, declarations: NO_DECL, month: 10,
  ...overrides,
});

describe('Eligible ESI is the first CTC preview option', () => {
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
      solution: { ambiguous: false, approximate: false }, ctc: { employer_esi: 0 },
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
