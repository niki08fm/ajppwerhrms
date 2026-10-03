import { addDays, addMonths, daysInMonth, daysToHundredths, diffDays, firstOfMonth, lastOfMonth, maxDate, minDate, mulDiv, ymOf } from '@ajpwer/shared';
import { baseMonthly } from '../pay/overtime.js';

const r2 = (n) => Math.round(n * 100) / 100;
/** Leave is taken in half days: 1.25 days left pays at most 1. */
const downToHalf = (n) => Math.floor(n * 2 + 1e-9) / 2;
const toHalf = (n) => Math.round(n * 2) / 2;

/** The days of a month someone can be on leave. Off days, and days outside employment, never take leave. */
const WORKING = ['PRESENT', 'HALF_DAY', 'SHORT', 'ABSENT', 'MISSING_PUNCH', 'ON_LEAVE'];

/** Types that keep a balance. PER_OCCASION and NONE types do not. */
export const hasBalance = (t) => t.allowance === 'MONTHLY' || t.allowance === 'YEARLY';

/** Months from a to b: 2026-04 → 2027-03 is 11. */
export function monthsFrom(a, b) {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}

/** The leave year a month falls in. With the year starting in April, March 2027 belongs to 2026. */
export function leaveYearOf(ym, startMonth = 1) {
  const [y, m] = ym.split('-').map(Number);
  const year = m >= startMonth ? y : y - 1;
  const start = `${year}-${String(startMonth).padStart(2, '0')}`;
  return { year, start, end: addMonths(start, 11) };
}

/** The part of a month someone is employed: 1 for the whole month. */
export function employedShare(ym, joined, lastDay) {
  const from = maxDate(firstOfMonth(ym), joined);
  const to = lastDay ? minDate(lastOfMonth(ym), lastDay) : lastOfMonth(ym);
  return to < from ? 0 : (diffDays(from, to) + 1) / daysInMonth(ym);
}

/** The date a type becomes usable: joining plus its months of service. */
export function usableFrom(type, joined) {
  if (!type.min_service_months) return joined;
  const target = addMonths(ymOf(joined), type.min_service_months);
  const day = Math.min(Number(joined.slice(8, 10)), daysInMonth(target));
  return `${target}-${String(day).padStart(2, '0')}`;
}

/**
 * What each type adds in a month, before anything is taken. A MONTHLY type earns its
 * share of the month, up to its yearly cap. A YEARLY type gives the year's days in the
 * first month the year is tracked, part of them for someone who joined during the year.
 */
export function creditMonth(types, ctx) {
  const credit = {};
  for (const t of types) {
    if (t.allowance === 'MONTHLY') {
      let d = (t.per_month ?? 0) * employedShare(ctx.ym, ctx.joined, ctx.last_day);
      if (t.yearly_cap !== null) d = Math.min(d, Math.max(0, t.yearly_cap - (ctx.earned_ytd[t.code] ?? 0)));
      credit[t.code] = r2(d);
    } else if (t.allowance === 'YEARLY' && ctx.grant_due) {
      const from = ymOf(maxDate(firstOfMonth(ctx.year.start), ctx.joined));
      const months = monthsFrom(from, ctx.year.end) + 1;
      credit[t.code] = toHalf(((t.per_year ?? 0) * months) / 12);
    }
  }
  return credit;
}

/**
 * Pays a month's leave out of the balances, changing the days in place. Pure.
 *
 *  1. Recorded leave, in date order: a paid type pays from its own balance, or for its
 *     first days each occasion, up to its monthly limit. An unpaid type pays nothing.
 *  2. Then whatever a working day still lacks — an absence, a short day, the missing half
 *     of a half day, or recorded paid leave its balance could not pay — comes from the
 *     type that applies automatically, up to its monthly limit. Recorded unpaid leave
 *     stays unpaid, a missing punch is left for HR to correct, and days after `upto` (not
 *     yet happened) are not paid from leave.
 *
 * What no balance covers stays unpaid: loss of pay.
 */
export function allocateLeave(days, types, available, opts = {}) {
  const byCode = Object.fromEntries(types.map((t) => [t.code, t]));
  const left = { ...available };
  const month = {};
  const recorded = {};
  const auto = {};
  const unpaid = {};
  const usable = (t, date) => !opts.usableFrom?.[t.code] || date >= opts.usableFrom[t.code];
  const take = (t, want) => {
    let can = want;
    if (hasBalance(t)) can = Math.min(can, left[t.code] ?? 0);
    if (t.monthly_max !== null) can = Math.min(can, t.monthly_max - (month[t.code] ?? 0));
    can = downToHalf(Math.max(0, can));
    if (can <= 0) return 0;
    if (hasBalance(t)) left[t.code] = r2(left[t.code] - can);
    month[t.code] = r2((month[t.code] ?? 0) + can);
    return can;
  };
  // An HR correction to "on leave" is final: no balance is touched for it.
  const settled = (d) => !WORKING.includes(d.status) || (d.overridden && d.status === 'ON_LEAVE');

  for (const d of days) {
    if (!d.applied || settled(d)) continue;
    const t = byCode[d.applied.leave_type];
    const worked = d.status === 'ON_LEAVE' ? 0 : d.day_value;
    const want = Math.max(0, Math.min(d.applied.portion, 1 - worked));
    if (want <= 0) continue; // worked the day after all
    let paid = 0;
    if (t?.paid && usable(t, d.date)) {
      if (t.allowance === 'PER_OCCASION') {
        paid = d.applied.occasion_paid ? want : 0;
        if (paid) month[t.code] = r2((month[t.code] ?? 0) + paid);
      } else paid = take(t, want);
    }
    if (t?.paid && paid < want) {
      unpaid[t.code] = r2((unpaid[t.code] ?? 0) + want - paid);
      d.flags = [...d.flags, 'LEAVE_UNPAID'];
    }
    if (paid) recorded[t.code] = r2((recorded[t.code] ?? 0) + paid);
    d.day_value = r2(worked + paid);
    d.leave_days = paid;
    d.leave_type = d.applied.leave_type;
  }

  const a = types.find((t) => t.auto_apply && t.active && t.paid && hasBalance(t));
  if (a) {
    for (const d of days) {
      if (settled(d) || d.status === 'MISSING_PUNCH') continue;
      if (opts.upto && d.date > opts.upto) continue;
      if (d.applied && !byCode[d.applied.leave_type]?.paid) continue;
      const short = r2(1 - d.day_value);
      if (short <= 0 || !usable(a, d.date)) continue;
      const got = take(a, short);
      if (!got) continue;
      auto[a.code] = r2((auto[a.code] ?? 0) + got);
      d.day_value = r2(d.day_value + got);
      d.leave_days = r2((d.leave_days ?? 0) + got);
      d.auto_leave = got;
      d.leave_type ??= a.code;
      d.flags = [...d.flags, 'AUTO_LEAVE'];
    }
  }

  // A day with no work on it that leave paid for is a day on leave.
  for (const d of days) if ((d.status === 'ABSENT' || d.status === 'SHORT') && d.leave_days > 0) d.status = 'ON_LEAVE';
  return { left, recorded, auto, unpaid };
}

/** Days left at the end of the leave year: carried into the next, paid out, or lapsed. */
export function closeYear(types, balances) {
  const out = {};
  for (const t of types) {
    if (!hasBalance(t)) continue;
    const left = Math.max(0, balances[t.code] ?? 0);
    let carried = 0;
    let encashed = 0;
    let lapsed = 0;
    if (t.year_end === 'ENCASH') encashed = left;
    else if (t.year_end === 'LAPSE') lapsed = left;
    else {
      carried = t.carry_max === null ? left : Math.min(left, t.carry_max);
      if (t.carry_excess === 'ENCASH') encashed = left - carried;
      else lapsed = left - carried;
    }
    out[t.code] = { carried: r2(carried), encashed: r2(encashed), lapsed: r2(lapsed) };
  }
  return out;
}

/**
 * One month of leave for one person: what the types add, what HR adjusted, what was
 * taken (recorded and automatic), what is left, and at the end of the leave year what
 * is carried, paid out or lapsed. Pure; changes the days in place.
 */
export function leaveMonth(days, ctx) {
  const credit = creditMonth(ctx.types, ctx);
  const available = {};
  for (const t of ctx.types) {
    if (hasBalance(t)) available[t.code] = r2(Math.max(0, (ctx.opening[t.code] ?? 0) + (credit[t.code] ?? 0) + (ctx.adjustments[t.code] ?? 0)));
  }
  const alloc = allocateLeave(days, ctx.types, available, { upto: ctx.upto, usableFrom: ctx.usable_from });
  const yearEnd = ctx.close_year ? closeYear(ctx.types, alloc.left) : null;
  const sum = (a, b) => r2((a ?? 0) + (b ?? 0));
  return {
    year: ctx.year,
    types: ctx.types.map((t) => {
      const ytd = ctx.ytd[t.code] ?? {};
      const used = alloc.recorded[t.code] ?? 0;
      const auto = alloc.auto[t.code] ?? 0;
      return {
        code: t.code,
        name: t.name,
        paid: t.paid,
        allowance: t.allowance,
        auto_apply: t.auto_apply,
        on_exit: t.on_exit,
        encash_base: t.encash_base,
        encash_divisor: t.encash_divisor,
        opening: hasBalance(t) ? (ctx.opening[t.code] ?? 0) : null,
        earned: credit[t.code] ?? 0,
        adjusted: ctx.adjustments[t.code] ?? 0,
        used,
        auto,
        unpaid: alloc.unpaid[t.code] ?? 0,
        closing: hasBalance(t) ? alloc.left[t.code] : null,
        year_opening: ctx.year_opening[t.code] ?? 0,
        earned_ytd: sum(ctx.earned_ytd[t.code], credit[t.code]),
        adjusted_ytd: sum(ytd.adjusted, ctx.adjustments[t.code]),
        used_ytd: sum(ytd.used, used),
        auto_ytd: sum(ytd.auto, auto),
        ...(yearEnd?.[t.code] ?? {}),
      };
    }),
  };
}

/** The balances a month's leave leaves for the next month of the same leave year. */
export function nextLeaveState(month) {
  const state = { opening: {}, earned_ytd: {}, year_opening: {}, ytd: {} };
  for (const r of month.types) {
    if (r.closing !== null) state.opening[r.code] = r.closing;
    state.earned_ytd[r.code] = r.earned_ytd;
    state.year_opening[r.code] = r.year_opening;
    state.ytd[r.code] = { adjusted: r.adjusted_ytd, used: r.used_ytd, auto: r.auto_ytd };
  }
  return state;
}

/** The working days of a per-occasion leave that are paid: its first `perOccasion` of them. */
export function occasionPaidDates(from, to, perOccasion, isWorkingDay) {
  const paid = new Set();
  let n = 0;
  for (let d = from; d <= to && n < perOccasion; d = addDays(d, 1)) {
    if (!isWorkingDay(d)) continue;
    paid.add(d);
    n++;
  }
  return paid;
}

/** Leave paid out: days × this part of the monthly salary ÷ the divisor. */
export function encashAmount(days, base, divisor, structure) {
  return mulDiv(baseMonthly(base, structure), daysToHundredths(days), divisor * 100);
}

/** "6.5 days × gross ÷ 26" */
export function describeEncash(days, base, divisor) {
  return `${days} days × ${base === 'BASIC_HRA' ? 'basic + HRA' : base.toLowerCase()} ÷ ${divisor}`;
}
