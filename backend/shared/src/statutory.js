import { z } from 'zod';
import { pct, roundRupee } from './money.js';

/**
 * Company-wide statutory rates, versioned by `valid_from`. Money is paise,
 * percentages are percentages (12 means 12%). None of these are constants in code.
 */

const paise = z.number().int().min(0);
const percent = z.number().min(0).max(100);

export const pfRatesSchema = z
  .object({
    employee_pct: percent,
    employer_pct: percent,
    /**
     * Wage ceiling the percentage runs on when restrict-to-ceiling is on. It is the
     * only PF limit: the largest contribution follows from it (rate × ceiling), so
     * there is no separate maximum to keep in step. See pfMaxContribution.
     */
    ceiling: paise,
    /** Pension (EPS) share of the employer contribution */
    eps_pct: percent,
    /** EPS is computed on wages up to this figure (statutory ₹15,000) */
    eps_wage_ceiling: paise,
    edli_pct: percent,
    admin_pct: percent,
  })
  .strict();

export const esiRatesSchema = z
  .object({
    ceiling: paise,
    employee_pct: percent,
    employer_pct: percent,
  })
  .strict();

export const gratuityRatesSchema = z
  .object({
    min_years: z.number().min(0),
    /** Service between this and min_years raises a warning instead of silently paying nothing */
    flag_from_years: z.number().min(0),
    days_per_year: z.number().min(0),
    divisor: z.number().int().min(1),
  })
  .strict();

export const statutoryRatesSchema = z
  .object({
    valid_from: z.string(),
    pf: pfRatesSchema,
    esi: esiRatesSchema,
    gratuity: gratuityRatesSchema,
    recovery_cap_pct: percent,
  })
  .strict();

/** Statutory minimums — what ships as the default. */
export const STATUTORY_MINIMUM_RATES = {
  pf: {
    employee_pct: 12,
    employer_pct: 12,
    ceiling: 15_000_00,
    eps_pct: 8.33,
    eps_wage_ceiling: 15_000_00,
    edli_pct: 0.5,
    admin_pct: 0.5,
  },
  esi: { ceiling: 21_000_00, employee_pct: 0.75, employer_pct: 3.25 },
  gratuity: { min_years: 5, flag_from_years: 4.5, days_per_year: 15, divisor: 26 },
  recovery_cap_pct: 40,
};

/** AJPWER's own figures — what the setup screen is seeded with. */
export const AJPWER_RATES = {
  ...STATUTORY_MINIMUM_RATES,
  pf: {
    ...STATUTORY_MINIMUM_RATES.pf,
    ceiling: 25_000_00,
  },
};

/**
 * The most anyone contributes each month while restrict-to-ceiling is on: the rate
 * applied to the ceiling. On ₹25,000 at 12% that is ₹3,000 from the employee and
 * ₹3,000 from the company — ₹6,000 together.
 */
export function pfMaxContribution(pf) {
  const employee = roundRupee(pct(pf.ceiling, pf.employee_pct));
  const employer = roundRupee(pct(pf.ceiling, pf.employer_pct));
  return { employee, employer, total: employee + employer };
}

const r = (n) => n * 100;

/** Seed slabs. AP and Telangana are confirmed; verify the others against current state schedules. */
export const SEED_PT_SLABS = [
  { state: 'Andhra Pradesh', gender_scope: 'ALL', upto_amount: r(15000), amount: 0, feb_amount: null },
  { state: 'Andhra Pradesh', gender_scope: 'ALL', upto_amount: r(20000), amount: r(150), feb_amount: null },
  { state: 'Andhra Pradesh', gender_scope: 'ALL', upto_amount: null, amount: r(200), feb_amount: null },
  { state: 'Telangana', gender_scope: 'ALL', upto_amount: r(15000), amount: 0, feb_amount: null },
  { state: 'Telangana', gender_scope: 'ALL', upto_amount: r(20000), amount: r(150), feb_amount: null },
  { state: 'Telangana', gender_scope: 'ALL', upto_amount: null, amount: r(200), feb_amount: null },
  { state: 'Karnataka', gender_scope: 'ALL', upto_amount: r(24999), amount: 0, feb_amount: null },
  { state: 'Karnataka', gender_scope: 'ALL', upto_amount: null, amount: r(200), feb_amount: r(300) },
  { state: 'Maharashtra', gender_scope: 'MALE', upto_amount: r(7500), amount: 0, feb_amount: null },
  { state: 'Maharashtra', gender_scope: 'MALE', upto_amount: r(10000), amount: r(175), feb_amount: null },
  { state: 'Maharashtra', gender_scope: 'MALE', upto_amount: null, amount: r(200), feb_amount: r(300) },
  { state: 'Maharashtra', gender_scope: 'FEMALE', upto_amount: r(25000), amount: 0, feb_amount: null },
  { state: 'Maharashtra', gender_scope: 'FEMALE', upto_amount: null, amount: r(200), feb_amount: r(300) },
  { state: 'West Bengal', gender_scope: 'ALL', upto_amount: r(10000), amount: 0, feb_amount: null },
  { state: 'West Bengal', gender_scope: 'ALL', upto_amount: r(15000), amount: r(110), feb_amount: null },
  { state: 'West Bengal', gender_scope: 'ALL', upto_amount: r(25000), amount: r(130), feb_amount: null },
  { state: 'West Bengal', gender_scope: 'ALL', upto_amount: r(40000), amount: r(150), feb_amount: null },
  { state: 'West Bengal', gender_scope: 'ALL', upto_amount: null, amount: r(200), feb_amount: null },
  { state: 'Gujarat', gender_scope: 'ALL', upto_amount: r(12000), amount: 0, feb_amount: null },
  { state: 'Gujarat', gender_scope: 'ALL', upto_amount: null, amount: r(200), feb_amount: null },
  // Delhi levies no professional tax: no rows means nil at any salary.
];

const L = (lakh) => lakh * 100_000 * 100;

/** FY 2026-27 regimes. Confirm against the Finance Act before the first live run. */
export const SEED_TAX_REGIMES = [
  {
    code: 'NEW',
    name: 'New regime',
    valid_from: '2026-04-01',
    std_deduction: r(75000),
    rebate_limit: L(12),
    rebate_max: null,
    marginal_relief: true,
    allows_80c: false,
    allows_hra: false,
    cess_pct: 4,
    slabs: [
      { upto_amount: L(4), rate: 0 },
      { upto_amount: L(8), rate: 5 },
      { upto_amount: L(12), rate: 10 },
      { upto_amount: L(16), rate: 15 },
      { upto_amount: L(20), rate: 20 },
      { upto_amount: L(24), rate: 25 },
      { upto_amount: null, rate: 30 },
    ],
  },
  {
    code: 'OLD',
    name: 'Old regime',
    valid_from: '2026-04-01',
    std_deduction: r(50000),
    rebate_limit: L(5),
    rebate_max: r(12500),
    marginal_relief: false,
    allows_80c: true,
    allows_hra: true,
    cess_pct: 4,
    slabs: [
      { upto_amount: L(2.5), rate: 0 },
      { upto_amount: L(5), rate: 5 },
      { upto_amount: L(10), rate: 20 },
      { upto_amount: null, rate: 30 },
    ],
  },
];

/** Statutory caps on old-regime declarations. */
export const LIMIT_80C = r(150000);
export const LIMIT_80D = r(25000);
