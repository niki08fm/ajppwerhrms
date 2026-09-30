import { daysInMonth, type DayStatus, type ISODate, type LatePenaltyRules } from '@ajpwer/shared';
import type { DayOverride, DayRecord, EffectiveDay, MonthResult, OffDayWorkEntry, ResolvedPolicies } from './types';

const OFF_STATUSES: DayStatus[] = ['HOLIDAY', 'WEEKLY_OFF', 'HOLIDAY_WORKED', 'OFF_WORKED'];
const SANDWICH_TRIGGERS: DayStatus[] = ['ABSENT', 'SHORT'];
const WORKING_STATUSES: DayStatus[] = ['PRESENT', 'HALF_DAY', 'SHORT', 'MISSING_PUNCH'];

export const isOffStatus = (s: DayStatus) => OFF_STATUSES.includes(s);

export interface MonthInput {
  ym: string;
  /** Every day of the month, in order, from computeDay */
  days: DayRecord[];
  /** Overrides keyed by date */
  overrides: Record<ISODate, DayOverride>;
  /** Policies in force on each date */
  policiesByDate: Record<ISODate, ResolvedPolicies>;
  /**
   * Effective statuses of days just outside the month, nearest first, so the
   * sandwich rule can see across a month boundary. Optional.
   */
  before?: DayStatus[];
  after?: DayStatus[];
}

function slabDays(rules: LatePenaltyRules, lateMin: number): number {
  const slab = rules.slabs.find((s) => lateMin >= s.from_min && (s.to_min === null || lateMin <= s.to_min));
  return slab ? slab.deduct_days : 0;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Step 5 — the monthly pass, run after every day is classified. Pure. */
export function computeMonth(input: MonthInput): MonthResult {
  // Layer 3: effective = override if one exists, otherwise computed.
  const days: EffectiveDay[] = input.days.map((d) => {
    const o = input.overrides[d.date];
    if (!o) return { ...d, computed: null, overridden: false, late_penalty_days: 0 };
    return {
      ...d,
      status: o.status,
      day_value: o.day_value,
      worked_min: o.worked_min,
      ot_min: o.ot_min,
      late_min: o.late_min,
      provisional: false,
      flags: [...d.flags, 'OVERRIDDEN'],
      computed: { status: d.status, day_value: d.day_value, worked_min: d.worked_min, ot_min: d.ot_min, late_min: d.late_min },
      overridden: true,
      late_penalty_days: 0,
    };
  });

  const sandwiched: ISODate[] = [];
  const offday_work: OffDayWorkEntry[] = [];

  const neighbour = (i: number, step: -1 | 1): DayStatus | null => {
    for (let j = i + step; j >= 0 && j < days.length; j += step) {
      if (!isOffStatus(days[j].status)) return days[j].status;
    }
    const outside = step === -1 ? input.before : input.after;
    if (outside) for (const s of outside) if (!isOffStatus(s)) return s;
    return null;
  };

  // 5a / 5b — off days.
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    if (!isOffStatus(d.status)) continue;
    const pol = input.policiesByDate[d.date];
    const isHoliday = d.status === 'HOLIDAY' || d.status === 'HOLIDAY_WORKED';
    const worked = d.status === 'HOLIDAY_WORKED' || d.status === 'OFF_WORKED';

    if (!d.overridden) {
      const pay = isHoliday ? pol?.holiday_pay : pol?.weekoff_pay;
      if (!pay || !pay.paid) {
        d.day_value = 0;
      } else if (pay.sandwich && !worked) {
        const prev = neighbour(i, -1);
        const next = neighbour(i, 1);
        if (prev && next && SANDWICH_TRIGGERS.includes(prev) && SANDWICH_TRIGGERS.includes(next)) {
          d.day_value = 0;
          d.flags = [...d.flags, 'SANDWICHED'];
          sandwiched.push(d.date);
        } else {
          d.day_value = 1;
        }
      } else {
        d.day_value = 1;
      }
    }
    d.provisional = false;

    if (worked) {
      const hw = pol?.holiday_work;
      const rule = hw ? (isHoliday ? hw.holiday : hw.weekly_off) : null;
      if (rule && rule.mode === 'PAY' && d.worked_min >= rule.min_minutes) {
        offday_work.push({
          date: d.date,
          kind: isHoliday ? 'HOLIDAY' : 'WEEKLY_OFF',
          worked_min: d.worked_min,
          rate_pct: rule.rate_pct,
          base: rule.base,
          day_paid: d.day_value > 0,
        });
      }
      // Hours on an off day are paid by the off-day work policy, never as overtime too.
      d.ot_min = 0;
    }
  }

  // 5c — late penalty, charged monthly.
  const lastPolicies = input.policiesByDate[days[days.length - 1]?.date];
  const free = lastPolicies?.late_penalty?.free_per_month ?? 0;
  let lateCount = 0;
  let late_penalty_days = 0;
  for (const d of days) {
    if (d.late_min <= 0 || !WORKING_STATUSES.includes(d.status)) continue;
    lateCount++;
    const rules = input.policiesByDate[d.date]?.late_penalty;
    if (!rules || lateCount <= free) continue;
    const pen = slabDays(rules, d.late_min);
    d.late_penalty_days = pen;
    late_penalty_days += pen;
  }

  // 5d — totals.
  const dim = daysInMonth(input.ym);
  const inWindow = days.filter((d) => d.status !== 'NOT_JOINED' && d.status !== 'EXITED');
  const day_value_sum = round2(days.reduce((s, d) => s + d.day_value, 0));
  const paid_days = round2(Math.max(0, day_value_sum - late_penalty_days));
  const lop_days = round2(dim - paid_days);
  const windowValue = round2(inWindow.reduce((s, d) => s + d.day_value, 0));
  const lop_in_window = round2(Math.max(0, inWindow.length - Math.max(0, windowValue - late_penalty_days)));
  const count = (pred: (d: EffectiveDay) => boolean) => days.filter(pred).length;

  return {
    ym: input.ym,
    days,
    offday_work,
    totals: {
      days_in_month: dim,
      days_in_employment: inWindow.length,
      present: count((d) => d.status === 'PRESENT'),
      half_day: count((d) => d.status === 'HALF_DAY'),
      absent: count((d) => d.status === 'ABSENT'),
      short: count((d) => d.status === 'SHORT'),
      missing_punch: count((d) => d.status === 'MISSING_PUNCH'),
      leave_paid: count((d) => d.status === 'ON_LEAVE' && d.day_value > 0),
      leave_unpaid: count((d) => d.status === 'ON_LEAVE' && d.day_value === 0),
      weekly_off: count((d) => d.status === 'WEEKLY_OFF' || d.status === 'OFF_WORKED'),
      holidays: count((d) => d.status === 'HOLIDAY' || d.status === 'HOLIDAY_WORKED'),
      off_days_worked: count((d) => d.status === 'HOLIDAY_WORKED' || d.status === 'OFF_WORKED'),
      late_days: lateCount,
      late_penalty_days: round2(late_penalty_days),
      ot_min: days.reduce((s, d) => s + (isOffStatus(d.status) ? 0 : d.ot_min), 0),
      worked_min: days.reduce((s, d) => s + d.worked_min, 0),
      day_value_sum,
      paid_days,
      lop_days,
      lop_in_window,
      partial: inWindow.length < dim,
      sandwiched,
      overridden_days: count((d) => d.overridden),
    },
  };
}
