import { esiContributionPeriod, pct, roundRupee } from '@ajpwer/shared';

/**
 * ESI contribution on *earned* gross, both sides rounded UP to the rupee.
 * Whether it applies is decided separately by `esiEligibility`.
 */
export function computeEsi(applicable, earnedGross, rates) {
  if (!applicable || earnedGross <= 0) return { applicable, wage: 0, employee: 0, employer: 0 };
  return {
    applicable: true,
    wage: earnedGross,
    employee: roundRupee(pct(earnedGross, rates.employee_pct, 'up'), 'up'),
    employer: roundRupee(pct(earnedGross, rates.employer_pct, 'up'), 'up'),
  };
}

/**
 * The contribution-period rule. Blocks run April–September and October–March.
 * Eligibility is decided once, at the start of each block, by fixed gross
 * against the ceiling, and holds for the whole block.
 */
export function esiEligibility(input, rates) {
  const block = esiContributionPeriod(input.date);
  if (!input.esi_enabled) {
    return { applicable: false, esi_locked_until: input.esi_locked_until, block, reason: 'ESI is switched off for this person' };
  }
  if (input.esi_locked_until && input.esi_locked_until >= input.date) {
    return {
      applicable: true,
      esi_locked_until: input.esi_locked_until,
      block,
      reason: `Covered for the contribution period ending ${input.esi_locked_until}`,
    };
  }
  if (input.fixed_gross_at_block_start <= rates.ceiling) {
    return {
      applicable: true,
      esi_locked_until: block.end,
      block,
      reason: `Gross at the start of the period was within the ceiling; covered until ${block.end}`,
    };
  }
  return {
    applicable: false,
    esi_locked_until: input.esi_locked_until,
    block,
    reason: 'Gross at the start of the contribution period was above the ceiling',
  };
}
