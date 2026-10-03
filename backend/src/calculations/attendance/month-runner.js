import { dayName, monthDates } from '@ajpwer/shared';
import { computeDay } from './day.js';
import { computeMonth } from './month.js';
import { resolvePolicies } from './policies.js';

/** Classify every day of a month for one employee and run the monthly pass. Pure. */
export function runEmployeeMonth(input) {
  const holidays = input.holidays instanceof Set ? input.holidays : new Set(input.holidays);
  const policiesByDate = {};
  const days = monthDates(input.ym).map((date) => {
    const policies = resolvePolicies(input.policies, date);
    policiesByDate[date] = policies;
    return computeDay({
      date,
      joined_on: input.joined_on,
      last_day: input.last_day,
      is_holiday: holidays.has(date),
      is_weekly_off: input.weekly_off.includes(dayName(date)),
      leave: input.leave[date] ?? null,
      punches: input.punches[date] ?? [],
      travel_min: input.travel?.[date] ?? 0,
      policies,
      shift_start_min: input.shift_start_min,
      shift_end_min: input.shift_end_min,
      shift_break_min: input.shift_break_min,
    });
  });
  return computeMonth({
    ym: input.ym,
    days,
    overrides: input.overrides,
    policiesByDate,
    before: input.before,
    after: input.after,
    leave: input.leave_ctx ?? null,
  });
}

/** Days in a month that are neither weekly off nor holiday — the WORKING calendar divisor. */
export function workingDaysInMonth(ym, weeklyOff, holidays) {
  const h = holidays instanceof Set ? holidays : new Set(holidays);
  return monthDates(ym).filter((d) => !weeklyOff.includes(dayName(d)) && !h.has(d)).length;
}
