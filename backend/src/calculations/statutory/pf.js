import { clampMin0, pct, roundRupee } from '@ajpwer/shared';

const ZERO = { pf_wage: 0, employee: 0, vpf: 0, employer_total: 0, employer_epf: 0, eps: 0, edli: 0, admin: 0 };

/**
 * Provident fund on earned component pay only.
 *
 *   pf_wage  = min(Σ components ticked as PF base, ceiling)   — ceiling only when restrict-to-ceiling is on
 *   employee = employee% × pf_wage
 *
 * The ceiling is the one limit: it caps the wage the percentage runs on, and so
 * the largest contribution is simply rate × ceiling (see pfMaxContribution).
 * With restrict-to-ceiling off, PF follows the full wage. PF rounds to the nearest rupee.
 */
export function computePf(pfBaseEarned, choice, rates) {
  if (!choice.pf_enabled || pfBaseEarned <= 0) return { ...ZERO };
  const pf_wage = choice.pf_restrict_to_ceiling ? Math.min(pfBaseEarned, rates.ceiling) : pfBaseEarned;

  const employee = roundRupee(pct(pf_wage, rates.employee_pct));
  const employer_total = roundRupee(pct(pf_wage, rates.employer_pct));

  const epsWage = Math.min(pf_wage, rates.eps_wage_ceiling);
  const eps = Math.min(roundRupee(pct(epsWage, rates.eps_pct)), employer_total);
  const employer_epf = clampMin0(employer_total - eps);
  const edli = roundRupee(pct(Math.min(pf_wage, rates.eps_wage_ceiling), rates.edli_pct));
  const admin = roundRupee(pct(pf_wage, rates.admin_pct));
  const vpf = choice.vpf_pct > 0 ? roundRupee(pct(pf_wage, choice.vpf_pct)) : 0;

  return { pf_wage, employee, vpf, employer_total, employer_epf, eps, edli, admin };
}

/**
 * The company's PF contribution, as it counts in CTC and on the payslip: the
 * employer 12% (EPF + pension). EDLI and admin charges are not part of it.
 */
export function pfEmployerCost(r) {
  return r.employer_total;
}

/**
 * EDLI and PF admin charges: the company pays them to EPFO with the monthly PF
 * challan, but they are not counted in anyone's CTC or company contributions.
 */
export function pfChallanCharges(r) {
  return { edli: r.edli, admin: r.admin };
}
