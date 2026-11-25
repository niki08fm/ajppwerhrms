import { esiContributionPeriod, pct, roundRupee } from '@ajpwer/shared';

/**
 * ESI contribution on *earned* ESI wages, both sides rounded UP to the rupee.
 * Whether it applies is decided separately by `esiEligibility`.
 */
export function computeEsi(applicable, earnedWage, rates) {
  if (!applicable || earnedWage <= 0) return { applicable, wage: 0, employee: 0, employer: 0 };
  return {
    applicable: true,
    wage: earnedWage,
    employee: roundRupee(pct(earnedWage, rates.employee_pct, 'up'), 'up'),
    employer: roundRupee(pct(earnedWage, rates.employer_pct, 'up'), 'up'),
  };
}

/**
 * The contribution-period rule. Blocks run April–September and October–March. ESI is decided
 * by gross alone, with no switch to tick: it applies when the ESI wage (the full monthly gross)
 * at the start of a block is within the ceiling, and holds for the whole block even if pay
 * rises above it. At the next block it stops by itself if the gross is above the ceiling.
 */
export function esiEligibility(input, rates) {
  const block = esiContributionPeriod(input.date);
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
      reason: `ESI wages at the start of the period were within the ceiling; covered until ${block.end}`,
    };
  }
  return {
    applicable: false,
    esi_locked_until: input.esi_locked_until,
    block,
    reason: 'ESI wages at the start of the contribution period were above the ceiling',
  };
}
