import { describe, expect, it } from 'vitest';
import { ctcForGross, expandStructure, salaryPreview, solveGrossFromCtc, validateStructure } from '../../src/calculations/index.js';
import { NEW_REGIME, NO_DECL, PF_ON, PT_SLABS, R, RATES, STANDARD_STRUCTURE } from './fixtures.js';

const selected = (names, components = STANDARD_STRUCTURE) => components.map((c) => ({ ...c, counts_as_esi_wages: names.includes(c.name) }));
const ctx = (components, overrides = {}) => ({ components, pf: PF_ON, esi_enabled: true, rates: { pf: RATES.pf, esi: RATES.esi }, ...overrides });
const preview = (components, overrides = {}) => salaryPreview({ ...ctx(components), mode: 'GROSS', amount: R(24000),
  pt: { pt_applicable: true, pt_state: 'Andhra Pradesh', gender: 'MALE' },
  pt_slabs: PT_SLABS, regime: NEW_REGIME, declarations: NO_DECL, ...overrides });

describe('Salary structure ESI wage components', () => {
  it('retains all monthly earnings for legacy structures, independently from PF selection', () => {
    const old = expandStructure(STANDARD_STRUCTURE, R(24000));
    const explicit = expandStructure(selected(STANDARD_STRUCTURE.map((c) => c.name)), R(24000));
    expect(old.esi_base).toBe(R(24000));
    expect(old.pf_base).toBe(R(12000));
    expect(explicit.esi_base).toBe(old.esi_base);
    expect(ctcForGross(R(21000), ctx(STANDARD_STRUCTURE))).toEqual(ctcForGross(R(21000), ctx(selected(STANDARD_STRUCTURE.map((c) => c.name)))));
  });

  it('selects Basic, HRA and DA without altering earning amounts or PF wage', () => {
    const withDa = [...STANDARD_STRUCTURE, { ...STANDARD_STRUCTURE[1], seq: 5, name: 'DA', calc_value: 10 }];
    const components = selected(['Basic', 'HRA', 'DA'], withDa);
    const s = expandStructure(components, R(24000));
    expect(s.esi_base).toBe(R(12000 + 4800 + 1200));
    expect(s.gross).toBe(R(24000));
    expect(s.pf_base).toBe(R(12000));
    expect(s.monthly.map((c) => c.amount)).toEqual(expandStructure(withDa, R(24000)).monthly.map((c) => c.amount));
    const p = preview(components);
    expect(p).toMatchObject({ gross: R(24000), esi_wage: R(18000), esi_within_ceiling: true, esi_eligible_gross: R(24000),
      esi_eligible_wage: R(18000), esi: { applicable: true, wage: R(18000), employer: R(585), employee: R(135) } });
  });

  it('always excludes yearly payouts from the recurring ESI wage, even if a legacy or explicit flag is true', () => {
    const components = [...selected(['Basic']), { ...STANDARD_STRUCTURE[2], seq: 9, name: 'Annual bonus',
      frequency: 'YEARLY', pay_month: 10, calc_value: R(12000), counts_as_esi_wages: true }];
    expect(expandStructure(components, R(24000))).toMatchObject({ esi_base: R(12000), yearly_total: R(12000) });
    expect(preview(components).ctc.employer_esi).toBe(R(390));
  });

  it('uses the selected wage for gross-mode eligibility and contributions', () => {
    const components = selected(['Basic']);
    expect(preview(components, { amount: R(40000) })).toMatchObject({ gross: R(40000), esi_wage: R(20000),
      esi_within_ceiling: true, ctc: { employer_esi: R(650) }, esi: { employee: R(150) } });
    expect(preview(components, { amount: R(42001) })).toMatchObject({ esi_within_ceiling: false, esi_eligible_gross: null,
      ctc: { employer_esi: 0 }, esi: { employee: 0 } });
  });

  it('keeps capped selected earnings eligible above the gross ceiling, including CTC round trips', () => {
    const components = selected(['Basic'], STANDARD_STRUCTURE.map((c) => c.name === 'Basic' ? { ...c, max_amount: R(15000) } : c));
    const cost = ctcForGross(R(100000), ctx(components));
    expect(cost).toMatchObject({ gross: R(100000), esi_wage: R(15000), employer_esi: R(488), esi_applies: true });
    const p = preview(components, { mode: 'CTC', amount: cost.annual_ctc });
    expect(p).toMatchObject({ gross: R(100000), esi_within_ceiling: true, esi_wage: R(15000), solution: { approximate: false, ambiguous: false } });
  });

  it('locates the shifted ESI cliff at the selected wage and retains both valid CTC choices', () => {
    const components = selected(['Basic', 'HRA']); // 70% of gross; ₹30,000 gross means ₹21,000 ESI wage.
    const context = ctx(components);
    const cost = ctcForGross(R(30000), context);
    expect(cost.esi_wage).toBe(R(21000));
    expect(cost.annual_ctc).toBe(R(389796));
    const solved = solveGrossFromCtc(cost.annual_ctc, context);
    expect(solved).toMatchObject({ gross: R(30000), ambiguous: true, approximate: false,
      breakdown: { esi_applies: true, esi_wage: R(21000), employer_esi: R(683) },
      alternative: { gross: R(30683), breakdown: { esi_applies: false, employer_esi: 0 } } });
    expect(preview(components, { mode: 'CTC', amount: cost.annual_ctc, chosen_gross: solved.alternative.gross })).toMatchObject({
      esi_within_ceiling: false, esi_eligible_gross: R(30000), esi_eligible_wage: R(21000), ctc: { employer_esi: 0 } });
  });

  it('never reduces the entered target or creates eligibility through rounding just above the shifted cliff', () => {
    const components = selected(['Basic', 'HRA']);
    for (const delta of [1, R(9), R(12)]) {
      const p = preview(components, { mode: 'CTC', amount: R(389796) + delta });
      expect(p.solution.approximate).toBe(false);
      expect(p.solution.ambiguous).toBe(false);
      expect(p.esi_eligible_gross).toBeNull();
      expect(p.esi_within_ceiling).toBe(false);
      expect(p.ctc.annual_ctc).toBeGreaterThanOrEqual(R(389796) + delta);
    }
  });

  it('keeps a disabled ESI choice separate from the informational selected-wage alternative', () => {
    const components = selected(['Basic']);
    const cost = ctcForGross(R(24000), ctx(components));
    const p = preview(components, { mode: 'CTC', amount: cost.annual_ctc, esi_enabled: false });
    expect(p).toMatchObject({ esi_eligible_gross: R(24000), esi_eligible_wage: R(12000), ctc: { employer_esi: 0 }, esi: { employee: 0 } });
    expect(p.gross).toBeGreaterThan(R(24000));
  });

  it('expands % of CTC selected wages from the stable actual CTC basis and keeps a saved salary unchanged', () => {
    const components = selected(['Basic', 'HRA'], [
      { ...STANDARD_STRUCTURE[0], calc_type: 'PCT_CTC', calc_value: 40, max_amount: R(12000) },
      STANDARD_STRUCTURE[1], STANDARD_STRUCTURE[3],
    ]);
    const cost = ctcForGross(R(45000), ctx(components));
    const p = preview(components, { mode: 'CTC', amount: cost.annual_ctc });
    expect(p.gross).toBe(R(45000));
    expect(p.esi_wage).toBe(R(16800));
    expect(p.ctc.ctc_basis).toBe(p.ctc.annual_ctc);
    expect(p.solution.approximate).toBe(false);
    const saved = preview(components, { mode: 'CTC', amount: p.ctc.annual_ctc, saved_gross: p.gross });
    expect(saved.structure).toEqual(p.structure);
    expect(saved.ctc).toEqual(p.ctc);
  });

  it('finds uncapped % of CTC wage fixed points on both sides of the selected-wage ceiling', () => {
    const components = selected(['Basic', 'HRA'], [
      { ...STANDARD_STRUCTURE[0], calc_type: 'PCT_CTC', calc_value: 40 },
      STANDARD_STRUCTURE[1], STANDARD_STRUCTURE[3],
    ]);
    const context = ctx(components);
    for (const gross of [R(15000), R(24000), R(30000), R(45000)]) {
      const cost = ctcForGross(gross, context, undefined, undefined, { round_annual_up: true });
      expect(cost.ctc_basis).toBe(cost.annual_ctc);
      const p = preview(components, { mode: 'CTC', amount: cost.annual_ctc, chosen_gross: gross });
      expect(p.gross).toBe(gross);
      expect(p.solution.approximate).toBe(false);
      expect(p.ctc.ctc_basis).toBe(p.ctc.annual_ctc);
      expect(p.esi_wage).toBe(p.structure.basic + p.structure.hra);
      expect(p.esi.applicable).toBe(p.esi_wage <= RATES.esi.ceiling);
    }
  });

  it('solves a selected remainder independently from PF-counted earnings and component rounding', () => {
    const components = selected(['Special Allowance'], [
      { ...STANDARD_STRUCTURE[0], calc_value: 20 },
      { ...STANDARD_STRUCTURE[1], calc_type: 'PCT_CTC', calc_value: 12.6, counts_as_wages: true },
      { ...STANDARD_STRUCTURE[3], seq: 3 },
    ]);
    const context = ctx(components);
    let checked = 0;
    for (const gross of [R(19025), R(26000), R(38000), R(52000)]) {
      const cost = ctcForGross(gross, context);
      // Only stable fixed points are salary agreements; an unresolved cycle
      // remains informational and must never be accepted as an exact target.
      if (cost.ctc_basis !== cost.annual_ctc) continue;
      checked++;
      const solved = solveGrossFromCtc(cost.annual_ctc, context);
      expect(solved.approximate).toBe(false);
      expect([solved.gross, solved.alternative?.gross]).toContain(gross);
      expect(solved.breakdown.annual_ctc).toBeGreaterThanOrEqual(cost.annual_ctc);
      expect(solved.breakdown.esi_applies).toBe(solved.breakdown.esi_wage <= RATES.esi.ceiling);
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it('does not let an over-budget selected component fake a matching salary agreement', () => {
    const components = selected(['Basic'], [{ ...STANDARD_STRUCTURE[0], calc_type: 'FIXED', calc_value: R(40000) }, STANDARD_STRUCTURE[3]]);
    const p = preview(components, { mode: 'CTC', amount: R(275316) });
    expect(p.solution.approximate).toBe(true);
    expect(p.esi_eligible_gross).toBeNull();
  });

  it('supports an empty selected wage without contributions and explains it in validation', () => {
    const components = selected([]);
    const p = preview(components);
    expect(p).toMatchObject({ esi_wage: 0, esi: { employer: 0, employee: 0 }, ctc: { employer_esi: 0 } });
    expect(validateStructure(components, R(24000)).warnings).toContain('No monthly components are included in ESI wages.');
    expect(solveGrossFromCtc(p.ctc.annual_ctc, ctx(components))).toMatchObject({ gross: R(24000), ambiguous: false, approximate: false });
  });
});
