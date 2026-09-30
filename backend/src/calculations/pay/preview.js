import { computeEsi } from '../statutory/esi.js';
import { computePf } from '../statutory/pf.js';
import { computePt } from '../statutory/pt.js';
import { computeAnnualTax } from '../statutory/incomeTax.js';
import { ctcForGross, solveGrossFromCtc } from './ctc.js';
import { expandStructure } from './structure.js';

/** Everything the offer, profile and revision screens show about a salary, at full pay. */
export function salaryPreview(input) {
  const ctx = { components: input.components, pf: input.pf, esi_enabled: input.esi_enabled, rates: input.rates };
  let gross;
  let solution = null;
  if (input.mode === 'CTC') {
    solution = solveGrossFromCtc(input.amount, ctx);
    gross = solution.gross;
    if (input.chosen_gross !== undefined) {
      const allowed = [solution.gross, solution.alternative?.gross].filter((g) => g !== undefined);
      if (allowed.includes(input.chosen_gross)) gross = input.chosen_gross;
    }
  } else {
    gross = input.amount;
  }
  // On a CTC agreement, "% of CTC" components run on the agreed figure; on gross, on the CTC it works out to.
  const ctc = ctcForGross(gross, ctx, undefined, input.mode === 'CTC' ? input.amount : undefined);
  const structure = expandStructure(input.components, gross, ctc.ctc_basis);
  const pf = computePf(structure.pf_base, input.pf, input.rates.pf);
  const esi_within_ceiling = gross <= input.rates.esi.ceiling;
  const esi = computeEsi(input.esi_enabled && esi_within_ceiling, gross, input.rates.esi);
  const month = input.month ?? 4;
  const pt = computePt({ ...input.pt, gross, month: month === 2 ? 3 : month }, input.pt_slabs);
  const pt_february = computePt({ ...input.pt, gross, month: 2 }, input.pt_slabs);
  const taxableMonthly = structure.monthly.filter((c) => c.is_taxable).reduce((s, c) => s + c.amount, 0);
  const taxableYearly = structure.yearly.filter((c) => c.is_taxable).reduce((s, c) => s + c.amount, 0);
  const tax = computeAnnualTax({ gross: taxableMonthly * 12 + taxableYearly, basic: structure.basic * 12, hra: structure.hra * 12 }, input.declarations, input.regime);
  const tds_monthly = Math.round(tax.total / 12 / 100) * 100;
  const employee_statutory = pf.employee + pf.vpf + esi.employee + pt.amount + tds_monthly;
  const employer_statutory = ctc.employer_pf + ctc.employer_esi;
  return {
    gross,
    structure,
    ctc,
    solution,
    pf,
    esi,
    esi_within_ceiling,
    pt,
    pt_february,
    tds_monthly,
    annual_tax: tax.total,
    employee_statutory,
    employer_statutory,
    take_home: gross - employee_statutory,
  };
}
