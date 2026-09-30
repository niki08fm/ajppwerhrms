import type { EsiRates, Gender, Paise, PfRates, PtSlab, SalaryMode, TaxRegime } from '@ajpwer/shared';
import { computeEsi } from '../statutory/esi';
import { computePf, type PfChoice } from '../statutory/pf';
import { computePt } from '../statutory/pt';
import { computeAnnualTax, type TaxDeclarations } from '../statutory/incomeTax';
import { ctcForGross, solveGrossFromCtc, type CtcBreakdown, type GrossSolution } from './ctc';
import { expandStructure, type ComponentDef, type ExpandedStructure } from './structure';

export interface SalaryPreviewInput {
  mode: SalaryMode;
  /** Annual for CTC, monthly for GROSS */
  amount: Paise;
  components: ComponentDef[];
  pf: PfChoice;
  esi_enabled: boolean;
  pt: { pt_applicable: boolean; pt_state: string; gender: Gender };
  rates: { pf: PfRates; esi: EsiRates };
  pt_slabs: PtSlab[];
  regime: TaxRegime;
  declarations: TaxDeclarations;
  /** When a CTC is ambiguous, the gross the user picked */
  chosen_gross?: Paise;
  /** 1–12, for the February PT figure */
  month?: number;
}

export interface SalaryPreview {
  gross: Paise;
  structure: ExpandedStructure;
  ctc: CtcBreakdown;
  solution: GrossSolution | null;
  pf: ReturnType<typeof computePf>;
  esi: ReturnType<typeof computeEsi>;
  esi_within_ceiling: boolean;
  pt: ReturnType<typeof computePt>;
  pt_february: ReturnType<typeof computePt>;
  tds_monthly: Paise;
  annual_tax: Paise;
  employee_statutory: Paise;
  employer_statutory: Paise;
  take_home: Paise;
}

/** Everything the offer, profile and revision screens show about a salary, at full pay. */
export function salaryPreview(input: SalaryPreviewInput): SalaryPreview {
  const ctx = { components: input.components, pf: input.pf, esi_enabled: input.esi_enabled, rates: input.rates };
  let gross: Paise;
  let solution: GrossSolution | null = null;
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
  const structure = expandStructure(input.components, gross);
  const ctc = ctcForGross(gross, ctx);
  const pf = computePf(structure.pf_base, input.pf, input.rates.pf);
  const esi_within_ceiling = gross <= input.rates.esi.ceiling;
  const esi = computeEsi(input.esi_enabled && esi_within_ceiling, gross, input.rates.esi);
  const month = input.month ?? 4;
  const pt = computePt({ ...input.pt, gross, month: month === 2 ? 3 : month }, input.pt_slabs);
  const pt_february = computePt({ ...input.pt, gross, month: 2 }, input.pt_slabs);
  const taxableMonthly = structure.monthly.filter((c) => c.is_taxable).reduce((s, c) => s + c.amount, 0);
  const taxableYearly = structure.yearly.filter((c) => c.is_taxable).reduce((s, c) => s + c.amount, 0);
  const tax = computeAnnualTax(
    { gross: taxableMonthly * 12 + taxableYearly, basic: structure.basic * 12, hra: structure.hra * 12 },
    input.declarations,
    input.regime,
  );
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
