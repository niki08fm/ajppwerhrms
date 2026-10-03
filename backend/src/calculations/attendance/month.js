import { daysInMonth } from '@ajpwer/shared';
import { leaveMonth } from '../leave/index.js';

const OFF_STATUSES = ['HOLIDAY', 'WEEKLY_OFF', 'HOLIDAY_WORKED', 'OFF_WORKED'];
const SANDWICH_TRIGGERS = ['ABSENT', 'SHORT'];
const WORKING_STATUSES = ['PRESENT', 'HALF_DAY', 'SHORT', 'MISSING_PUNCH'];

export const isOffStatus = (s) => OFF_STATUSES.includes(s);

const round2 = (n) => Math.round(n * 100) / 100;

/** Step 5 — the monthly pass, run after every day is classified. Pure. */
export function computeMonth(input) {
  // Layer 3: effective = override if one exists, otherwise computed. A correction settles the day: it is no longer flagged as left early.
  const days = input.days.map((d) => {
    const o = input.overrides[d.date];
    if (!o) return { ...d, computed: null, overridden: false };
    return {
      ...d,
      status: o.status,
      day_value: o.day_value,
      worked_min: o.worked_min,
      ot_min: o.ot_min,
      late_min: o.late_min,
      early_min: 0,
      // A day corrected by its times shows HR's times; a marked day keeps the punches.
      first_punch_min: o.in_min ?? d.first_punch_min,
      last_punch_min: o.out_min ?? d.last_punch_min,
      leave_days: 0,
      provisional: false,
      flags: [...d.flags, 'OVERRIDDEN'],
      computed: { status: d.status, day_value: d.day_value, worked_min: d.worked_min, ot_min: d.ot_min, late_min: d.late_min },
      overridden: true,
    };
  });

  // 5a — leave: recorded leave is paid from its balance, and absences from the automatic type.
  // Before the off days, so an absence paid as leave does not trigger the sandwich rule.
  const leave = input.leave ? leaveMonth(days, input.leave) : null;

  const sandwiched = [];
  const offday_work = [];

  const neighbour = (i, step) => {
    for (let j = i + step; j >= 0 && j < days.length; j += step) {
      if (!isOffStatus(days[j].status)) return days[j].status;
    }
    const outside = step === -1 ? input.before : input.after;
    if (outside) for (const s of outside) if (!isOffStatus(s)) return s;
    return null;
  };

  // 5b — off days.
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

  // 5c — totals. Late arrivals and early punch-outs are counted for HR, never deducted.
  const dim = daysInMonth(input.ym);
  const inWindow = days.filter((d) => d.status !== 'NOT_JOINED' && d.status !== 'EXITED');
  const day_value_sum = round2(days.reduce((s, d) => s + d.day_value, 0));
  const paid_days = day_value_sum;
  const lop_days = round2(dim - paid_days);
  const windowValue = round2(inWindow.reduce((s, d) => s + d.day_value, 0));
  const lop_in_window = round2(Math.max(0, inWindow.length - windowValue));
  const count = (pred) => days.filter(pred).length;
  const working = (d) => WORKING_STATUSES.includes(d.status);

  return {
    ym: input.ym,
    days,
    offday_work,
    leave,
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
      /** Days paid as leave, half days included; auto_leave_days of them taken automatically for absences */
      leave_days: round2(days.reduce((s, d) => s + (d.leave_days ?? 0), 0)),
      auto_leave_days: round2(days.reduce((s, d) => s + (d.auto_leave ?? 0), 0)),
      weekly_off: count((d) => d.status === 'WEEKLY_OFF' || d.status === 'OFF_WORKED'),
      holidays: count((d) => d.status === 'HOLIDAY' || d.status === 'HOLIDAY_WORKED'),
      off_days_worked: count((d) => d.status === 'HOLIDAY_WORKED' || d.status === 'OFF_WORKED'),
      late_days: count((d) => d.late_min > 0 && working(d)),
      early_out_days: count((d) => d.early_min > 0 && working(d)),
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
