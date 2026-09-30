import { clampMin0, daysInMonth, daysToHundredths, mulDiv } from '@ajpwer/shared';

export function calendarDivisor(method, ym, workingDays) {
  switch (method) {
    case 'FIXED_26':
      return 26;
    case 'FIXED_30':
      return 30;
    case 'ACTUAL':
      return daysInMonth(ym);
    case 'WORKING':
      return Math.max(1, workingDays);
  }
}

export const LOP_RULE_TEXT = {
  FULL_MONTH: 'Full month: full − full ÷ divisor × LOP days',
  PART_MONTH: 'Part month: full ÷ divisor × paid days, capped at full',
};

/**
 * Earned amount of one monthly component after loss of pay.
 *
 * Full month:  max(0, full − full/divisor × lop_days)
 * Part month:  min(full, full/divisor × paid_days)
 *
 * The two differ deliberately: subtracting non-employment days at a 26-day rate
 * would take a mid-month joiner's pay below what they earned.
 */
export function earnedAfterLop(full, divisor, rule, lopDays, paidDays) {
  if (full <= 0) return 0;
  if (rule === 'FULL_MONTH') {
    const deduction = mulDiv(full, daysToHundredths(lopDays), divisor * 100);
    return clampMin0(full - deduction);
  }
  return Math.min(full, mulDiv(full, daysToHundredths(paidDays), divisor * 100));
}
