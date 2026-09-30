import { esiContributionPeriod, pct, roundRupee, type ISODate, type Paise } from '@ajpwer/shared';
import type { EsiRates } from '@ajpwer/shared';

export interface EsiResult {
  applicable: boolean;
  wage: Paise;
  employee: Paise;
  employer: Paise;
}

/**
 * ESI contribution on *earned* gross, both sides rounded UP to the rupee.
 * Whether it applies is decided separately by `esiEligibility`.
 */
export function computeEsi(applicable: boolean, earnedGross: Paise, rates: EsiRates): EsiResult {
  if (!applicable || earnedGross <= 0) return { applicable, wage: 0, employee: 0, employer: 0 };
  return {
    applicable: true,
    wage: earnedGross,
    employee: roundRupee(pct(earnedGross, rates.employee_pct, 'up'), 'up'),
    employer: roundRupee(pct(earnedGross, rates.employer_pct, 'up'), 'up'),
  };
}

export interface EsiEligibilityInput {
  esi_enabled: boolean;
  /** The month being paid, any date inside it */
  date: ISODate;
  /** Fixed (contracted) monthly gross valid at the start of the contribution block */
  fixed_gross_at_block_start: Paise;
  /** Stored decision: covered until this date (inclusive), or null */
  esi_locked_until: ISODate | null;
}

export interface EsiEligibility {
  applicable: boolean;
  /** Write this back to the employee when it differs from the stored value */
  esi_locked_until: ISODate | null;
  block: { start: ISODate; end: ISODate };
  reason: string;
}

/**
 * The contribution-period rule. Blocks run April–September and October–March.
 * Eligibility is decided once, at the start of each block, by fixed gross
 * against the ceiling, and holds for the whole block.
 */
export function esiEligibility(input: EsiEligibilityInput, rates: EsiRates): EsiEligibility {
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
