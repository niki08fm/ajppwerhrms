import { formatINR } from '@ajpwer/shared';

/**
 * Loan and advance types. Pure: what a type allows a person, and the instalment and number
 * of months a grant comes to. Amounts are paise; percentages and multiples are plain numbers.
 *
 *  - The most that can be granted: the lower of `max_amount` and `max_gross_multiple` × gross.
 *  - Recovery: EQUAL_INSTALMENTS splits the amount into the instalments chosen (the last may
 *    be lower); FIXED_AMOUNT recovers the amount HR enters each month; PCT_OF_GROSS recovers
 *    `recovery_pct` of gross each month.
 *  - The months it takes may not exceed `max_instalments`, and one month's instalment may not
 *    exceed `max_instalment_pct` of gross.
 */

/** The most a type allows a person with this monthly gross; null when it sets no limit. */
export function loanLimit(type, gross) {
  const parts = [];
  if (type.max_amount !== null && type.max_amount !== undefined) parts.push(type.max_amount);
  if (type.max_gross_multiple !== null && type.max_gross_multiple !== undefined) parts.push(Math.floor((gross * type.max_gross_multiple) / 100) * 100);
  return parts.length ? Math.min(...parts) : null;
}

/** In words, for the grant form: "Up to ₹60,000 (2 months' gross) · at most 12 instalments · …". */
export function describeLoanType(type, gross = null) {
  const bits = [];
  const limit = gross === null ? null : loanLimit(type, gross);
  const multiple = type.max_gross_multiple ? `${type.max_gross_multiple} month${Number(type.max_gross_multiple) === 1 ? "'s" : "s'"} gross` : null;
  const cap = type.max_amount ? formatINR(type.max_amount) : null;
  if (limit !== null) bits.push(`Up to ${formatINR(limit)}${multiple && cap ? ` (${multiple}, at most ${cap})` : multiple ? ` (${multiple})` : ''}`);
  else if (multiple || cap) bits.push(`Up to ${[multiple, cap].filter(Boolean).join(', at most ')}`);
  else bits.push('No amount limit');
  bits.push(`at most ${type.max_instalments} instalment${type.max_instalments === 1 ? '' : 's'}`);
  if (type.recovery_method === 'PCT_OF_GROSS') bits.push(`recovers ${type.recovery_pct}% of gross a month`);
  else if (type.recovery_method === 'FIXED_AMOUNT') bits.push('monthly amount set when granting');
  else bits.push('equal instalments');
  if (type.max_instalment_pct) bits.push(`a month's instalment at most ${type.max_instalment_pct}% of gross`);
  if (type.min_service_months) bits.push(`after ${type.min_service_months} months of service`);
  if (type.one_at_a_time) bits.push('one at a time');
  return bits.join(' · ');
}

/**
 * The plan for a grant: the limit, the monthly instalment and how many months it takes,
 * with every rule it breaks. `instalments` (EQUAL_INSTALMENTS) and `instalment`
 * (FIXED_AMOUNT) come from the grant form; `active_of_type` counts the person's
 * recovering loans or advances of this type; `service_months` is completed service.
 */
export function loanPlan(type, { amount, gross, instalments = null, instalment = null, service_months = 0, active_of_type = 0 }) {
  const errors = [];
  const limit = loanLimit(type, gross);
  if (!type.active) errors.push(`${type.name} is switched off.`);
  if (!(amount > 0)) errors.push('Enter the amount.');
  if (limit !== null && amount > limit) errors.push(`${type.name} allows at most ${formatINR(limit)} for this person (monthly gross ${formatINR(gross)}).`);
  if (service_months < (type.min_service_months ?? 0)) errors.push(`${type.name} needs ${type.min_service_months} months of service; this person has ${service_months}.`);
  if (type.one_at_a_time && active_of_type > 0) errors.push(`This person already has a ${type.name} being recovered. Only one at a time.`);

  let monthly = 0;
  if (type.recovery_method === 'EQUAL_INSTALMENTS') {
    const n = Number(instalments);
    if (!Number.isInteger(n) || n < 1) errors.push('Choose the number of instalments.');
    else if (n > type.max_instalments) errors.push(`${type.name} allows at most ${type.max_instalments} instalments.`);
    else if (amount > 0) monthly = Math.ceil(amount / n / 100) * 100;
  } else if (type.recovery_method === 'FIXED_AMOUNT') {
    if (!(instalment > 0)) errors.push('Enter the monthly instalment.');
    else monthly = instalment;
  } else {
    monthly = Math.ceil((gross * Number(type.recovery_pct ?? 0)) / 100 / 100) * 100;
    if (!(monthly > 0)) errors.push('This person has no monthly gross to recover a percentage of.');
  }
  if (monthly > amount && amount > 0) monthly = amount;
  const months = monthly > 0 && amount > 0 ? Math.ceil(amount / monthly) : 0;
  if (months > type.max_instalments && type.recovery_method !== 'EQUAL_INSTALMENTS') {
    errors.push(`At ${formatINR(monthly)} a month this takes ${months} months; ${type.name} allows at most ${type.max_instalments}.`);
  }
  const instalmentCap = type.max_instalment_pct ? Math.floor((gross * Number(type.max_instalment_pct)) / 100 / 100) * 100 : null;
  if (instalmentCap !== null && monthly > instalmentCap) {
    errors.push(`${formatINR(monthly)} a month is more than ${type.max_instalment_pct}% of gross (${formatINR(instalmentCap)}). Take more instalments or a smaller amount.`);
  }
  return { limit, gross, instalment: monthly, months, last_instalment: months ? amount - monthly * (months - 1) : 0, instalment_cap: instalmentCap, errors };
}
