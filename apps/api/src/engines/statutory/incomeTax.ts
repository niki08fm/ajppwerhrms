import { clampMin0, divRound, LIMIT_80C, LIMIT_80D, pct, roundRupee, type Paise, type TaxRegime } from '@ajpwer/shared';

/*
 * Income tax — deliberately NOT built:
 *
 *  1. Surcharge on income above ₹50 lakh. No AJPWER employee is near it today.
 *     It MUST be added here before anyone crosses ₹50 lakh.
 *  2. Quarterly true-up of TDS against what has already been deducted. Monthly
 *     TDS below is a projection that assumes salary continues unchanged and
 *     spreads tax evenly. Add the true-up before the first year-end filing.
 */

export interface TaxDeclarations {
  decl_80c: Paise;
  decl_80d: Paise;
  decl_rent_monthly: Paise;
  decl_metro: boolean;
}

export interface TaxIncome {
  /** Annual gross taxable salary (taxable components + taxable one-offs) */
  gross: Paise;
  /** Annual basic, for the HRA exemption */
  basic: Paise;
  /** Annual HRA received */
  hra: Paise;
}

export interface TaxBand {
  from: Paise;
  to: Paise | null;
  rate: number;
  taxable_in_band: Paise;
  tax: Paise;
}

export interface TaxWorking {
  regime: TaxRegime['code'];
  gross: Paise;
  std_deduction: Paise;
  hra_exemption: Paise;
  deduction_80c: Paise;
  deduction_80d: Paise;
  taxable: Paise;
  bands: TaxBand[];
  slab_tax: Paise;
  rebate: Paise;
  marginal_relief: Paise;
  tax_after_rebate: Paise;
  cess: Paise;
  total: Paise;
}

/** Tax on a taxable figure by slab, before rebate and cess. */
export function slabTax(taxable: Paise, regime: TaxRegime): { bands: TaxBand[]; tax: Paise } {
  const slabs = [...regime.slabs].sort((a, b) => (a.upto_amount ?? Infinity) - (b.upto_amount ?? Infinity));
  const bands: TaxBand[] = [];
  let lower = 0;
  let tax = 0;
  for (const s of slabs) {
    const upper = s.upto_amount;
    const inBand = clampMin0(Math.min(taxable, upper ?? Math.max(taxable, lower)) - lower);
    const t = pct(inBand, s.rate);
    bands.push({ from: lower, to: upper, rate: s.rate, taxable_in_band: inBand, tax: t });
    tax += t;
    if (upper === null) break;
    lower = upper;
  }
  return { bands, tax };
}

/** HRA exemption, old regime only, all figures annual. */
export function hraExemption(income: TaxIncome, decl: TaxDeclarations): Paise {
  if (income.hra <= 0 || decl.decl_rent_monthly <= 0) return 0;
  const rentLessTenPct = clampMin0(decl.decl_rent_monthly * 12 - pct(income.basic, 10));
  const kBasic = pct(income.basic, decl.decl_metro ? 50 : 40);
  return Math.min(income.hra, rentLessTenPct, kBasic);
}

export function computeAnnualTax(income: TaxIncome, decl: TaxDeclarations, regime: TaxRegime): TaxWorking {
  const std = Math.min(regime.std_deduction, income.gross);
  const hra_exemption = regime.allows_hra ? hraExemption(income, decl) : 0;
  const deduction_80c = regime.allows_80c ? Math.min(decl.decl_80c, LIMIT_80C) : 0;
  const deduction_80d = regime.allows_80c ? Math.min(decl.decl_80d, LIMIT_80D) : 0;
  const taxable = clampMin0(income.gross - std - hra_exemption - deduction_80c - deduction_80d);

  const { bands, tax: slab_tax } = slabTax(taxable, regime);

  let rebate = 0;
  let marginal_relief = 0;
  if (taxable <= regime.rebate_limit) {
    rebate = regime.rebate_max === null ? slab_tax : Math.min(slab_tax, regime.rebate_max);
  } else if (regime.marginal_relief) {
    // Where taxable income exceeds the rebate limit, tax cannot exceed the excess.
    marginal_relief = clampMin0(slab_tax - (taxable - regime.rebate_limit));
  }
  const tax_after_rebate = clampMin0(slab_tax - rebate - marginal_relief);
  const cess = pct(tax_after_rebate, regime.cess_pct);
  const total = roundRupee(tax_after_rebate + cess);

  return {
    regime: regime.code,
    gross: income.gross,
    std_deduction: std,
    hra_exemption,
    deduction_80c,
    deduction_80d,
    taxable,
    bands,
    slab_tax,
    rebate,
    marginal_relief,
    tax_after_rebate,
    cess,
    total,
  };
}

export interface RegimeComparison {
  new: TaxWorking;
  old: TaxWorking;
  cheaper: 'NEW' | 'OLD' | 'EQUAL';
  /** How much more the dearer regime costs a year */
  difference: Paise;
  sentence: string;
}

export function compareRegimes(income: TaxIncome, decl: TaxDeclarations, regimes: { NEW: TaxRegime; OLD: TaxRegime }): RegimeComparison {
  const n = computeAnnualTax(income, decl, regimes.NEW);
  const o = computeAnnualTax(income, decl, regimes.OLD);
  const difference = Math.abs(n.total - o.total);
  const cheaper = n.total < o.total ? 'NEW' : o.total < n.total ? 'OLD' : 'EQUAL';
  const rupeesText = `₹${Math.round(difference / 100).toLocaleString('en-IN')}`;
  const sentence =
    cheaper === 'EQUAL'
      ? 'Both regimes come to the same tax this year.'
      : `The ${cheaper === 'NEW' ? 'new' : 'old'} regime is cheaper by ${rupeesText} a year.`;
  return { new: n, old: o, cheaper, difference, sentence };
}

/**
 * Monthly TDS: projected annual tax spread evenly, plus the incremental tax a
 * taxable one-off causes in the month it is paid:  Δ = tax(annual + one-off) − tax(annual).
 */
export function monthlyTds(
  projected: TaxIncome,
  oneOffTaxable: Paise,
  decl: TaxDeclarations,
  regime: TaxRegime,
): { regular: Paise; incremental: Paise; total: Paise; annual: Paise } {
  const base = computeAnnualTax(projected, decl, regime);
  const regular = roundRupee(divRound(base.total, 12));
  let incremental = 0;
  if (oneOffTaxable > 0) {
    const withOneOff = computeAnnualTax({ ...projected, gross: projected.gross + oneOffTaxable }, decl, regime);
    incremental = clampMin0(withOneOff.total - base.total);
  }
  return { regular, incremental, total: regular + incremental, annual: base.total };
}
