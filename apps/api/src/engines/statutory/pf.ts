import { clampMin0, pct, roundRupee, type Paise } from '@ajpwer/shared';
import type { PfRates } from '@ajpwer/shared';

export interface PfChoice {
  pf_enabled: boolean;
  pf_restrict_to_ceiling: boolean;
  vpf_pct: number;
}

export interface PfResult {
  pf_wage: Paise;
  employee: Paise;
  vpf: Paise;
  /** Total employer 12% before the split */
  employer_total: Paise;
  /** Employer share going to EPF (employer total − EPS) */
  employer_epf: Paise;
  eps: Paise;
  edli: Paise;
  admin: Paise;
}

const ZERO: PfResult = { pf_wage: 0, employee: 0, vpf: 0, employer_total: 0, employer_epf: 0, eps: 0, edli: 0, admin: 0 };

/**
 * Provident fund on earned component pay only.
 *
 *   pf_wage  = min(Σ components ticked as PF base, ceiling)   — ceiling only when restrict-to-ceiling is on
 *   employee = min(employee% × pf_wage, max contribution)
 *
 * The ceiling caps the wage the percentage runs on; the maximum caps the rupees.
 * PF rounds to the nearest rupee.
 */
export function computePf(pfBaseEarned: Paise, choice: PfChoice, rates: PfRates): PfResult {
  if (!choice.pf_enabled || pfBaseEarned <= 0) return { ...ZERO };
  const pf_wage = choice.pf_restrict_to_ceiling ? Math.min(pfBaseEarned, rates.ceiling) : pfBaseEarned;

  const cap = (v: Paise) => (rates.max_contribution !== null ? Math.min(v, rates.max_contribution) : v);
  const employee = cap(roundRupee(pct(pf_wage, rates.employee_pct)));
  const employer_total = cap(roundRupee(pct(pf_wage, rates.employer_pct)));

  const epsWage = Math.min(pf_wage, rates.eps_wage_ceiling);
  const eps = Math.min(roundRupee(pct(epsWage, rates.eps_pct)), employer_total);
  const employer_epf = clampMin0(employer_total - eps);
  const edli = roundRupee(pct(Math.min(pf_wage, rates.eps_wage_ceiling), rates.edli_pct));
  const admin = roundRupee(pct(pf_wage, rates.admin_pct));
  const vpf = choice.vpf_pct > 0 ? roundRupee(pct(pf_wage, choice.vpf_pct)) : 0;

  return { pf_wage, employee, vpf, employer_total, employer_epf, eps, edli, admin };
}

/** Employer PF cost the company bears on top of gross: employer 12% + EDLI + admin. */
export function pfEmployerCost(r: PfResult): Paise {
  return r.employer_total + r.edli + r.admin;
}
