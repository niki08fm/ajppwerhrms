import { dayName, monthDates, type DayName, type DayStatus, type ISODate } from '@ajpwer/shared';
import { computeDay } from './day';
import { computeMonth } from './month';
import { resolvePolicies } from './policies';
import type { AttachedPolicy, DayLeave, DayOverride, DayRecord, EnginePunch, MonthResult, ResolvedPolicies } from './types';

export interface EmployeeMonthInput {
  ym: string;
  joined_on: ISODate;
  last_day: ISODate | null;
  weekly_off: DayName[];
  holidays: Set<ISODate> | ISODate[];
  shift_start_min: number;
  policies: AttachedPolicy[];
  /** Punches keyed by work_date */
  punches: Record<ISODate, EnginePunch[]>;
  /** Approved leave keyed by date */
  leave: Record<ISODate, DayLeave>;
  overrides: Record<ISODate, DayOverride>;
  before?: DayStatus[];
  after?: DayStatus[];
}

/** Classify every day of a month for one employee and run the monthly pass. Pure. */
export function runEmployeeMonth(input: EmployeeMonthInput): MonthResult {
  const holidays = input.holidays instanceof Set ? input.holidays : new Set(input.holidays);
  const policiesByDate: Record<ISODate, ResolvedPolicies> = {};
  const days: DayRecord[] = monthDates(input.ym).map((date) => {
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
      policies,
      shift_start_min: input.shift_start_min,
    });
  });
  return computeMonth({
    ym: input.ym,
    days,
    overrides: input.overrides,
    policiesByDate,
    before: input.before,
    after: input.after,
  });
}

/** Days in a month that are neither weekly off nor holiday — the WORKING calendar divisor. */
export function workingDaysInMonth(ym: string, weeklyOff: DayName[], holidays: Set<ISODate> | ISODate[]): number {
  const h = holidays instanceof Set ? holidays : new Set(holidays);
  return monthDates(ym).filter((d) => !weeklyOff.includes(dayName(d)) && !h.has(d)).length;
}
