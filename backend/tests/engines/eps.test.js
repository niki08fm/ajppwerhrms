import { describe, expect, it } from 'vitest';
import { assemblePayslip, computePf, ctcForGross, salaryPreview, solveGrossFromCtc } from '../../src/calculations/index.js';
import { NEW_REGIME, NO_DECL, payslipInput, PF_ON, PT_SLABS, R, RATES, STANDARD_STRUCTURE } from './fixtures.js';

describe('Employee EPS choice', () => {
  it('keeps EPS enabled for an existing employee whose choice is not recorded', () => {
    const legacy = computePf(R(25000), PF_ON, RATES.pf);
    const enabled = computePf(R(25000), { ...PF_ON, eps_enabled: true }, RATES.pf);
    expect(legacy).toEqual(enabled);
    expect(legacy.eps).toBe(R(1250));
    expect(legacy.employer_epf).toBe(R(550));
  });

  it('moves the entire employer contribution to EPF without changing employee PF, VPF or challan charges', () => {
    const choice = { ...PF_ON, pf_restrict_to_ceiling: false, vpf_pct: 2 };
    const enabled = computePf(R(25000), { ...choice, eps_enabled: true }, RATES.pf);
    const disabled = computePf(R(25000), { ...choice, eps_enabled: false }, RATES.pf);
    expect(disabled).toEqual({ ...enabled, eps_wage: 0, eps: 0, employer_epf: enabled.employer_total });
    expect(disabled.employee).toBe(R(3000));
    expect(disabled.employer_epf).toBe(R(3000));
    expect(disabled.vpf).toBe(R(500));
  });

  it.each([true, false])('PF off suppresses pension and every PF contribution even when EPS is %s', (eps_enabled) => {
    const result = computePf(R(25000), { ...PF_ON, pf_enabled: false, eps_enabled, vpf_pct: 2 }, RATES.pf);
    expect(Object.values(result).every((value) => value === 0)).toBe(true);
  });

  it('records zero EPS wage and contributions when there is no earned PF wage', () => {
    for (const wage of [0, -100]) {
      const result = computePf(wage, { ...PF_ON, eps_enabled: true }, RATES.pf);
      expect(Object.values(result).every((value) => value === 0)).toBe(true);
    }
  });

  it('keeps EPS capped and reconciles the employer shares at low and unrestricted wages', () => {
    for (const wage of [1, 2500, 15000, 15001, 40000, 80000]) {
      for (const eps_enabled of [true, false]) {
        const result = computePf(R(wage), { ...PF_ON, pf_restrict_to_ceiling: false, eps_enabled }, RATES.pf);
        expect(result.eps + result.employer_epf).toBe(result.employer_total);
        expect(result.eps_wage).toBe(eps_enabled ? Math.min(R(wage), R(15000)) : 0);
        expect(result.eps).toBeLessThanOrEqual(R(1250));
        expect(result.eps).toBeLessThanOrEqual(result.employer_total);
        expect(result.employer_epf).toBeGreaterThanOrEqual(0);
      }
    }
    // A configured employer rate below the pension rate cannot create a negative EPF share.
    const lowEmployer = computePf(R(15000), { ...PF_ON, eps_enabled: true }, { ...RATES.pf, employer_pct: 5 });
    expect(lowEmployer.eps).toBe(R(750));
    expect(lowEmployer.employer_epf).toBe(0);
  });

  it('does not change annual CTC or its solved gross when EPS is toggled', () => {
    const ctx = { components: STANDARD_STRUCTURE, pf: { ...PF_ON, eps_enabled: true }, esi_enabled: true, rates: RATES };
    const disabled = { ...ctx, pf: { ...ctx.pf, eps_enabled: false } };
    for (const gross of [20000, 21000, 25000, 40000]) {
      const enabledCost = ctcForGross(R(gross), ctx);
      expect(ctcForGross(R(gross), disabled)).toEqual(enabledCost);
      expect(solveGrossFromCtc(enabledCost.annual_ctc, disabled)).toEqual(solveGrossFromCtc(enabledCost.annual_ctc, ctx));
    }
  });

  it('salary previews show the changed EPF split with the same take-home, ESI and CTC', () => {
    const input = {
      mode: 'GROSS', amount: R(20000), components: STANDARD_STRUCTURE,
      pf: { ...PF_ON, eps_enabled: true }, esi_enabled: true, rates: RATES,
      pt: { pt_applicable: true, pt_state: 'Andhra Pradesh', gender: 'MALE' },
      pt_slabs: PT_SLABS, regime: NEW_REGIME, declarations: NO_DECL,
    };
    const enabled = salaryPreview(input);
    const disabled = salaryPreview({ ...input, pf: { ...input.pf, eps_enabled: false } });
    expect(disabled).toEqual({
      ...enabled,
      pf: { ...enabled.pf, eps_wage: 0, eps: 0, employer_epf: enabled.pf.employer_total },
    });
  });

  it('payroll payslips retain their totals after LOP while sending the full employer PF to EPF', () => {
    const input = payslipInput();
    input.attendance = { ...input.attendance, paid_days: 20, lop_days: 10 };
    input.statutory = { ...input.statutory, eps_enabled: true, esi_applicable: true };
    const enabled = assemblePayslip(input);
    const disabled = assemblePayslip({ ...input, statutory: { ...input.statutory, eps_enabled: false } });
    const amount = (result, code) => result.lines.find((line) => line.code === code)?.amount ?? 0;
    expect(amount(disabled, 'ER_EPS')).toBe(0);
    expect(amount(disabled, 'ER_EPF')).toBe(amount(enabled, 'ER_EPF') + amount(enabled, 'ER_EPS'));
    for (const field of ['gross', 'net', 'total_deductions', 'employee_statutory', 'employer_total', 'ctc_month', 'pf_wage', 'esi_wage']) {
      expect(disabled[field]).toBe(enabled[field]);
    }
    for (const code of ['PF', 'VPF', 'ESI', 'ER_ESI', 'PT', 'TDS']) {
      expect(amount(disabled, code)).toBe(amount(enabled, code));
    }
    expect(disabled.pf_charges).toEqual(enabled.pf_charges);
  });
});
