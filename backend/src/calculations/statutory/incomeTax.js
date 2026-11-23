import { clampMin0, LIMIT_80C, LIMIT_80D, pct, roundRupee } from '@ajpwer/shared';

/*
 * Income tax on salary, following the AJPWER Income Tax (TDS on Salary) Policy.
 *
 * Monthly TDS = (tax on the projected income for the year − TDS already deducted
 * this year) ÷ months left, plus the full extra tax a one-off causes in the month
 * it is paid. By the last month of employment, TDS deducted equals the year's tax.
 *
 * Deliberately NOT built: surcharge on income above ₹50 lakh. No AJPWER employee
 * is near it today. It MUST be added here before anyone crosses ₹50 lakh.
 */

/** Section 288B: taxable income and tax are rounded to the nearest ₹10 (1,000 paise). */
export function roundTen(p) {
  return Math.round(p / 1000) * 1000;
}

/** The no-PAN floor on salary TDS: the higher of the average rate or this rate. */
export const NO_PAN_RATE = 20;

/** Tax on a taxable figure by slab, before rebate and cess. */
export function slabTax(taxable, regime) {
  const slabs = [...regime.slabs].sort((a, b) => (a.upto_amount ?? Infinity) - (b.upto_amount ?? Infinity));
  const bands = [];
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

/**
 * HRA exemption, old regime only, all figures annual. Rent counts only for the
 * months employed (`income.rent_months`, twelve when not given).
 */
export function hraExemption(income, decl) {
  if (income.hra <= 0 || decl.decl_rent_monthly <= 0) return 0;
  const rentMonths = income.rent_months ?? 12;
  const rentLessTenPct = clampMin0(decl.decl_rent_monthly * rentMonths - pct(income.basic, 10));
  const kBasic = pct(income.basic, decl.decl_metro ? 50 : 40);
  return Math.min(income.hra, rentLessTenPct, kBasic);
}

/**
 * Annual tax on an income. `income.pf_80c` (employee PF and VPF for the year) counts
 * under 80C with the declared amount, within the one ₹1,50,000 limit.
 */
export function computeAnnualTax(income, decl, regime, opts = {}) {
  const std = Math.min(regime.std_deduction, income.gross);
  const hra_exemption = regime.allows_hra ? hraExemption(income, decl) : 0;
  const pf_80c = regime.allows_80c ? income.pf_80c ?? 0 : 0;
  const deduction_80c = regime.allows_80c ? Math.min(decl.decl_80c + pf_80c, LIMIT_80C) : 0;
  const allows80d = regime.allows_80d ?? regime.allows_80c;
  const deduction_80d = allows80d ? Math.min(decl.decl_80d, LIMIT_80D) : 0;
  const taxable = roundTen(clampMin0(income.gross - std - hra_exemption - deduction_80c - deduction_80d));

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
  let total = roundTen(tax_after_rebate + cess);
  // No PAN: where tax is due, the higher of the average rate or 20% of taxable income.
  let no_pan_floor = 0;
  if (opts.no_pan && total > 0) {
    no_pan_floor = roundTen(pct(taxable, NO_PAN_RATE));
    total = Math.max(total, no_pan_floor);
  }

  return {
    regime: regime.code,
    gross: income.gross,
    std_deduction: std,
    hra_exemption,
    deduction_80c,
    pf_80c: Math.min(pf_80c, deduction_80c),
    deduction_80d,
    taxable,
    bands,
    slab_tax,
    rebate,
    marginal_relief,
    tax_after_rebate,
    cess,
    no_pan_floor,
    total,
  };
}

export function compareRegimes(income, decl, regimes) {
  const n = computeAnnualTax(income, decl, regimes.NEW);
  const o = computeAnnualTax(income, decl, regimes.OLD);
  const difference = Math.abs(n.total - o.total);
  const cheaper = n.total < o.total ? 'NEW' : o.total < n.total ? 'OLD' : 'EQUAL';
  const rupeesText = `₹${Math.round(difference / 100).toLocaleString('en-IN')}`;
  const sentence = cheaper === 'EQUAL' ? 'Both regimes come to the same tax this year.' : `The ${cheaper === 'NEW' ? 'new' : 'old'} regime is cheaper by ${rupeesText} a year.`;
  return { new: n, old: o, cheaper, difference, sentence };
}

/** Year-to-date figures before this month: nothing paid yet. */
export const EMPTY_YTD = Object.freeze({ taxable: 0, tds: 0, basic: 0, hra: 0, pf_80c: 0, variable: 0, months: 0 });

/**
 * This month's TDS under the policy.
 *
 * `month` is this month's actual figures: `taxable` (taxable pay this month, after LOP,
 * excluding one-offs and variable pay), `variable` (overtime and off-day pay),
 * `one_off` (bonus, ad-hoc earnings, leave encashment), `basic`, `hra`, `pf_80c`.
 * `ahead` is the expected figures for each month after this one: `taxable` (the full
 * monthly salary), `basic`, `hra`, `pf_80c`, plus `known` (yearly components due in
 * those months). `ytd` holds what this company paid and deducted earlier this year;
 * `previous` the previous employer's income and TDS (Form 12B).
 */
export function policyTds({ month, ahead, monthsLeft, ytd = EMPTY_YTD, previous = { income: 0, tds: 0 }, decl, regime, noPan = false }) {
  const left = Math.max(1, monthsLeft);
  // Months employed earlier this year with no payroll on record are estimated at the
  // current salary, so their tax is still collected over the months left.
  const future = left - 1 + (ytd.missing ?? 0);
  // Recurring variable pay is projected forward at its average so far this year.
  const variableAverage = Math.round((ytd.variable + month.variable) / (ytd.months + 1));
  const projectedGross = previous.income + ytd.taxable + month.taxable + month.variable + future * (ahead.taxable + variableAverage) + (ahead.known ?? 0);
  const income = {
    gross: projectedGross,
    basic: ytd.basic + month.basic + future * ahead.basic,
    hra: ytd.hra + month.hra + future * ahead.hra,
    pf_80c: ytd.pf_80c + month.pf_80c + future * ahead.pf_80c,
    rent_months: ytd.months + 1 + future,
  };
  const opts = { no_pan: noPan };
  const base = computeAnnualTax(income, decl, regime, opts);
  const withOneOff = month.one_off > 0 ? computeAnnualTax({ ...income, gross: income.gross + month.one_off }, decl, regime, opts) : base;
  const due = clampMin0(base.total - ytd.tds - previous.tds);
  const regular = roundRupee(Math.round(due / left));
  const incremental = clampMin0(withOneOff.total - base.total);
  return {
    regular,
    incremental,
    total: regular + incremental,
    annual: withOneOff.total,
    projected_income: income.gross + month.one_off,
    taxable_income: withOneOff.taxable,
    tds_to_date: ytd.tds,
    previous_tds: previous.tds,
    previous_income: previous.income,
    months_left: left,
    variable_average: variableAverage,
    no_pan: noPan && withOneOff.no_pan_floor > 0,
    estimated_months: ytd.missing ?? 0,
    income: { ...income, gross: income.gross + month.one_off },
    working: withOneOff,
  };
}

/**
 * Monthly TDS with no year-to-date history: projected annual tax spread evenly over
 * twelve months, plus the incremental tax a taxable one-off causes in the month it is paid.
 * Kept for callers that only need an estimate (salary previews).
 */
export function monthlyTds(projected, oneOffTaxable, decl, regime) {
  const base = computeAnnualTax(projected, decl, regime);
  const regular = roundRupee(Math.round(base.total / 12));
  let incremental = 0;
  if (oneOffTaxable > 0) {
    const withOneOff = computeAnnualTax({ ...projected, gross: projected.gross + oneOffTaxable }, decl, regime);
    incremental = clampMin0(withOneOff.total - base.total);
  }
  return { regular, incremental, total: regular + incremental, annual: base.total };
}
