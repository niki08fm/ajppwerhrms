import { formatYearMonth, isYearMonth } from '@ajpwer/shared';

export { addMonths, formatYearMonth } from '@ajpwer/shared';

export { CALENDAR_METHOD_INFO, CALENDAR_METHODS, DAY_NAMES, formatINR, POLICY_KINDS, POLICY_KIND_LABELS, POLICY_KIND_MISSING_WARNING } from '@ajpwer/shared';
export type { CalendarMethod } from '@ajpwer/shared';

export const monthLabelSafe = (ym: string) => (isYearMonth(ym) ? formatYearMonth(ym) : ym);
