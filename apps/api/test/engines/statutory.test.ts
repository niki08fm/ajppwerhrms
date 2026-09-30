import { describe, expect, it } from 'vitest';
import { assemblePayslip, compareRegimes, computeAnnualTax, computePf, computePt, esiEligibility, expandStructure, hraExemption } from '../../src/engines';
import { NEW_REGIME, NO_DECL, OLD_REGIME, payslipInput, PF_ON, PT_SLABS, R, RATES, STANDARD_STRUCTURE } from './fixtures';

const tax = (gross: number) => computeAnnualTax({ gross: R(gross), basic: 0, hra: 0 }, NO_DECL, NEW_REGIME);

describe('§20.10 Marginal relief', () => {
  it('₹12,75,000 income → tax ₹0 (taxable ₹12,00,000 is fully rebated)', () => {
    const t = tax(1275000);
    expect(t.taxable).toBe(R(1200000));
    expect(t.total).toBe(0);
  });

  it('₹12,90,000 income → ₹15,600, not ₹62,250 + cess', () => {
    const t = tax(1290000);
    expect(t.slab_tax).toBe(R(62250));
    expect(t.marginal_relief).toBe(R(47250));
    expect(t.total).toBe(R(15600));
  });

  it('relief tapers out: above the break-even the full slab tax applies with no relief', () => {
    // Taxable ₹13,25,000: slab tax ₹78,750 is below the ₹1,25,000 excess, so no relief.
    const t = tax(1400000);
    expect(t.marginal_relief).toBe(0);
    expect(t.total).toBe(R(81900));
  });

  it('₹13,20,000 income is still inside the relief band (taxable ₹12,45,000, excess ₹45,000)', () => {
    // Recorded because the spec text lists ₹13,20,000 as "no relief"; the statutory formula gives relief there.
    const t = tax(1320000);
    expect(t.marginal_relief).toBe(R(21750));
    expect(t.total).toBe(R(46800));
  });
});

describe('§20.11 Regime comparison', () => {
  it('old regime with ₹1.5 lakh 80C and ₹22,000 rent is worse off than new, by the exact annual difference', () => {
    const s = expandStructure(STANDARD_STRUCTURE, R(100000));
    const income = { gross: s.gross * 12, basic: s.basic * 12, hra: s.hra * 12 };
    const decl = { decl_80c: R(150000), decl_80d: 0, decl_rent_monthly: R(22000), decl_metro: false };
    const c = compareRegimes(income, decl, { NEW: NEW_REGIME, OLD: OLD_REGIME });
    expect(c.cheaper).toBe('NEW');
    expect(c.difference).toBe(c.old.total - c.new.total);
    expect(c.old.deduction_80c).toBe(R(150000));
    expect(c.old.hra_exemption).toBeGreaterThan(0);
    expect(c.new.hra_exemption).toBe(0);
    expect(c.sentence).toMatch(/new regime is cheaper/);
  });
});

describe('§20.12 HRA exemption', () => {
  it('equals the minimum of the three statutory limbs, computed annually', () => {
    const income = { gross: 0, basic: R(300000), hra: R(120000) };
    // limbs: HRA 1,20,000 · rent 12×15,000 − 10% basic = 1,50,000 · 40% basic = 1,20,000
    expect(hraExemption(income, { ...NO_DECL, decl_rent_monthly: R(15000) })).toBe(R(120000));
    // rent limb binds: 12×8,000 − 30,000 = 66,000
    expect(hraExemption(income, { ...NO_DECL, decl_rent_monthly: R(8000) })).toBe(R(66000));
    // metro: 50% basic = 1,50,000 but HRA received 1,20,000 binds
    expect(hraExemption(income, { ...NO_DECL, decl_rent_monthly: R(20000), decl_metro: true })).toBe(R(120000));
  });
});

describe('§20.13 PF ceiling', () => {
  it('restrict-to-ceiling on: PF wage never exceeds ₹15,000 however high basic goes', () => {
    for (const basic of [15000, 20000, 50000, 200000]) {
      expect(computePf(R(basic), PF_ON, RATES.pf).pf_wage).toBe(R(15000));
    }
  });
  it('restrict-to-ceiling off: PF wage follows actual wages', () => {
    const r = computePf(R(40000), { ...PF_ON, pf_restrict_to_ceiling: false }, RATES.pf);
    expect(r.pf_wage).toBe(R(40000));
    expect(r.employee).toBe(R(4800));
  });
  it('the maximum contribution caps the rupees after the percentage', () => {
    const r = computePf(R(80000), { ...PF_ON, pf_restrict_to_ceiling: false }, { ...RATES.pf, max_contribution: R(6000) });
    expect(r.employee).toBe(R(6000));
  });
});

describe('§20.14 Allowances stay out of the PF base', () => {
  it('adding a ₹10,000 allowance leaves every PF figure unchanged', () => {
    const withAllowance = [
      ...STANDARD_STRUCTURE.slice(0, 3),
      { seq: 5, name: 'Site allowance', calc_type: 'FIXED' as const, calc_value: R(10000), frequency: 'MONTHLY' as const, pay_month: null, is_taxable: true, counts_as_wages: false },
      STANDARD_STRUCTURE[3],
    ];
    const a = expandStructure(STANDARD_STRUCTURE, R(40000));
    const b = expandStructure(withAllowance, R(40000));
    expect(computePf(b.pf_base, PF_ON, RATES.pf)).toEqual(computePf(a.pf_base, PF_ON, RATES.pf));
  });
  it('basic ₹20,000 gives a PF wage of ₹15,000 with restrict on, ₹20,000 with it off', () => {
    expect(computePf(R(20000), PF_ON, RATES.pf).pf_wage).toBe(R(15000));
    expect(computePf(R(20000), { ...PF_ON, pf_restrict_to_ceiling: false }, RATES.pf).pf_wage).toBe(R(20000));
  });
});

describe('§20.15 ESI contribution period', () => {
  it('eligible in April, crosses the ceiling in July, still contributes through September', () => {
    const april = esiEligibility({ esi_enabled: true, date: '2026-04-30', fixed_gross_at_block_start: R(20000), esi_locked_until: null }, RATES.esi);
    expect(april.applicable).toBe(true);
    expect(april.esi_locked_until).toBe('2026-09-30');

    const july = esiEligibility({ esi_enabled: true, date: '2026-07-31', fixed_gross_at_block_start: R(20000), esi_locked_until: april.esi_locked_until }, RATES.esi);
    expect(july.applicable).toBe(true);
    const sept = esiEligibility({ esi_enabled: true, date: '2026-09-30', fixed_gross_at_block_start: R(20000), esi_locked_until: april.esi_locked_until }, RATES.esi);
    expect(sept.applicable).toBe(true);

    // October: a new block; the raise now counts.
    const october = esiEligibility({ esi_enabled: true, date: '2026-10-31', fixed_gross_at_block_start: R(25000), esi_locked_until: april.esi_locked_until }, RATES.esi);
    expect(october.applicable).toBe(false);
  });

  it('someone above the ceiling in April is not pulled in mid-block by a pay cut', () => {
    const june = esiEligibility({ esi_enabled: true, date: '2026-06-30', fixed_gross_at_block_start: R(23000), esi_locked_until: null }, RATES.esi);
    expect(june.applicable).toBe(false);
  });

  it('contribution is on earned gross, rounded up', () => {
    const p = assemblePayslip(
      payslipInput({
        monthly_gross: R(20000),
        attendance: { ...payslipInput().attendance, paid_days: 20, lop_days: 10 },
        statutory: { ...PF_ON, esi_applicable: true, pt_applicable: true, pt_state: 'Andhra Pradesh' },
      }),
    );
    const esi = p.lines.find((l) => l.code === 'ESI')!;
    expect(esi.amount % 100).toBe(0);
    expect(esi.amount).toBe(Math.ceil((p.statutory_gross * 0.0075) / 100) * 100);
  });
});

describe('§20.16 Professional tax', () => {
  const pt = (state: string, gender: 'MALE' | 'FEMALE', gross: number, month = 9) =>
    computePt({ pt_applicable: true, pt_state: state, gender, gross: R(gross), month }, PT_SLABS).amount;

  it('Maharashtra: a woman at ₹22,000 pays nil where a man pays ₹200', () => {
    expect(pt('Maharashtra', 'FEMALE', 22000)).toBe(0);
    expect(pt('Maharashtra', 'MALE', 22000)).toBe(R(200));
  });
  it('Karnataka: ₹300 in February, ₹200 otherwise', () => {
    expect(pt('Karnataka', 'MALE', 30000, 2)).toBe(R(300));
    expect(pt('Karnataka', 'MALE', 30000, 3)).toBe(R(200));
  });
  it('Delhi pays nil at any salary', () => {
    for (const g of [10000, 50000, 500000]) expect(pt('Delhi', 'MALE', g)).toBe(0);
  });
  it('Andhra Pradesh and Telangana slabs', () => {
    expect(pt('Andhra Pradesh', 'MALE', 15000)).toBe(0);
    expect(pt('Andhra Pradesh', 'MALE', 15001)).toBe(R(150));
    expect(pt('Telangana', 'FEMALE', 20001)).toBe(R(200));
  });
  it('an exemption switches it off; below the first slab is nil, not an exemption', () => {
    expect(computePt({ pt_applicable: false, pt_state: 'Telangana', gender: 'MALE', gross: R(50000), month: 9 }, PT_SLABS).basis).toBe('EXEMPT');
    expect(computePt({ pt_applicable: true, pt_state: 'Telangana', gender: 'MALE', gross: R(9000), month: 9 }, PT_SLABS).basis).toBe('NIL_SLAB');
  });
  it('two people in the same crew in different PT states are charged differently', () => {
    const ap = assemblePayslip(payslipInput({ statutory: { ...PF_ON, esi_applicable: false, pt_applicable: true, pt_state: 'Andhra Pradesh' } }));
    const ka = assemblePayslip(payslipInput({ statutory: { ...PF_ON, esi_applicable: false, pt_applicable: true, pt_state: 'Karnataka' } }));
    expect(ap.lines.find((l) => l.code === 'PT')!.amount).toBe(R(200));
    expect(ka.lines.find((l) => l.code === 'PT')).toBeUndefined();
  });
});

describe('TDS', () => {
  it('a taxable one-off adds its incremental tax in the month paid', () => {
    const base = payslipInput({ monthly_gross: R(150000) });
    const a = assemblePayslip(base);
    const b = assemblePayslip({ ...base, adhoc: [{ id: 'b', kind: 'EARNING', name: 'Bonus', amount: R(100000), is_taxable: true }] });
    expect(b.tds.incremental).toBeGreaterThan(0);
    expect(b.tds.regular).toBe(a.tds.regular);
  });
});
