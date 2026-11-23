import { istMidnight } from '@ajpwer/shared';
import { qualifyingIntervals, siteOvertimeMinutes } from './site-overtime.js';

/** Closed work intervals plus qualifying OT, preserving their actual order. */
export function recordedSiteIntervals(day, input) {
  const intervals = qualifyingIntervals(day, input);
  const budgets = siteOvertimeMinutes(day, input);
  return intervals.map(({ pair, minutes }) => {
    const ot = Math.min(budgets.get(pair.site_id) ?? 0, minutes);
    budgets.set(pair.site_id, (budgets.get(pair.site_id) ?? 0) - ot);
    return { date: input.date, site_id: pair.site_id, worked_min: pair.minutes, ot_min: ot, first_at: pair.in.at, first_ot_at: pair.out.at - minutes * 60_000 };
  });
}

/**
 * Split integer paise without losing money at site/date boundaries. Stable tie
 * ordering makes a range's subdivisions reconcile with the enclosing range.
 */
export function allocatePaise(amount, weights) {
  const total = weights.reduce((sum, w) => sum + Math.max(0, w), 0);
  if (!total) return weights.map(() => 0);
  const sign = amount < 0 ? -1 : 1;
  const value = BigInt(Math.abs(amount));
  const denominator = BigInt(total);
  const shares = weights.map((w, i) => {
    const numerator = value * BigInt(Math.max(0, w));
    return { i, amount: Number(numerator / denominator), remainder: numerator % denominator };
  });
  let left = Math.abs(amount) - shares.reduce((sum, s) => sum + s.amount, 0);
  const order = [...shares].sort((a, b) => a.remainder === b.remainder ? a.i - b.i : a.remainder > b.remainder ? -1 : 1);
  for (const row of order) if (left-- > 0) row.amount++;
  return shares.map((s) => s.amount * sign);
}

/**
 * Allocate one employee's whole-month earnings before any period/site filter.
 * Rows are closed recorded intervals grouped by work date and IN site. Normal
 * time and overtime never share a cost denominator. The monthly OT cap is used
 * in chronological order; later unpaid OT cannot receive earlier OT wages.
 *
 * Live salary is spread across effective paid dates first, retaining paid leave,
 * future off days and unlocated overrides as unallocated. Old payroll snapshots
 * have only monthly totals, so their normal time allocation uses recorded month
 * minutes and is explicitly an estimate. Monetary snapshot values stay frozen.
 */
export function allocateSiteWages({ rows, normal_wages, ot_wages, other_wages = 0, paid_ot_min = 0,
  paid_days = null, ot_days = null, dated_other = [] }) {
  const out = rows.map((r) => ({ ...r, normal_wages: 0, ot_wages: 0, other_wages: 0, paid_ot_min: 0 }))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.first_at ?? 0) - (b.first_at ?? 0) || a.site_id.localeCompare(b.site_id));
  let unallocated_normal = 0;
  if (paid_days) {
    const dates = [...paid_days].sort((a, b) => a.date.localeCompare(b.date));
    // Day values have at most two decimal places; integer weights avoid float
    // drift and support approved half days as well as paid leave.
    const shares = allocatePaise(normal_wages, dates.map((d) => Math.round(Math.max(0, d.day_value) * 100)));
    if (!dates.some((d) => d.day_value > 0)) unallocated_normal = normal_wages;
    dates.forEach((d, i) => {
      const located = out.filter((r) => r.date === d.date);
      const weights = located.map((r) => Math.max(0, r.worked_min - r.ot_min));
      if (!weights.some((w) => w > 0)) unallocated_normal += shares[i];
      else allocatePaise(shares[i], weights).forEach((value, j) => { located[j].normal_wages += value; });
    });
  } else {
    const weights = out.map((r) => Math.max(0, r.worked_min - r.ot_min));
    if (!weights.some((w) => w > 0)) unallocated_normal = normal_wages;
    else allocatePaise(normal_wages, weights).forEach((value, i) => { out[i].normal_wages = value; });
  }

  let remaining = Math.max(0, paid_ot_min);
  const otOrder = [...out].sort((a, b) => a.date.localeCompare(b.date) || (a.first_ot_at ?? a.first_at ?? 0) - (b.first_ot_at ?? b.first_at ?? 0) || a.site_id.localeCompare(b.site_id));
  let unlocatedPaidMinutes = 0;
  if (ot_days) {
    const dates = [...ot_days].sort((a, b) => a.date.localeCompare(b.date));
    for (const day of dates) {
      let daily = Math.min(remaining, Math.max(0, day.ot_min));
      remaining -= daily;
      for (const row of otOrder.filter((r) => r.date === day.date)) {
        row.paid_ot_min = Math.min(daily, row.ot_min);
        daily -= row.paid_ot_min;
      }
      unlocatedPaidMinutes += daily;
    }
  } else {
    for (const row of otOrder) {
      row.paid_ot_min = Math.min(remaining, row.ot_min);
      remaining -= row.paid_ot_min;
    }
  }
  const otShares = allocatePaise(ot_wages, [...out.map((r) => r.paid_ot_min), remaining + unlocatedPaidMinutes]);
  out.forEach((r, i) => { r.ot_wages = otShares[i]; });
  const unallocated_ot = paid_ot_min > 0 ? otShares.at(-1) : ot_wages;

  let unallocated_other = 0;
  let undated = other_wages;
  for (const item of dated_other) {
    undated -= item.amount;
    const located = out.filter((r) => r.date === item.date);
    const weights = located.map((r) => r.worked_min);
    if (!weights.some((w) => w > 0)) unallocated_other += item.amount;
    else allocatePaise(item.amount, weights).forEach((value, i) => { located[i].other_wages += value; });
  }
  if (paid_days) {
    const dates = [...paid_days].sort((a, b) => a.date.localeCompare(b.date));
    const shares = allocatePaise(undated, dates.map((d) => Math.round(Math.max(0, d.day_value) * 100)));
    if (!dates.some((d) => d.day_value > 0)) unallocated_other += undated;
    dates.forEach((d, i) => {
      const located = out.filter((r) => r.date === d.date);
      const weights = located.map((r) => r.worked_min);
      if (!weights.some((w) => w > 0)) unallocated_other += shares[i];
      else allocatePaise(shares[i], weights).forEach((value, j) => { located[j].other_wages += value; });
    });
  } else {
    const weights = out.map((r) => r.worked_min);
    if (!weights.some((w) => w > 0)) unallocated_other += undated;
    else allocatePaise(undated, weights).forEach((value, i) => { out[i].other_wages += value; });
  }
  for (const row of out) row.total_wages = row.normal_wages + row.ot_wages + row.other_wages;
  return { rows: out, unallocated_normal, unallocated_ot, unallocated_other,
    unallocated_wages: unallocated_normal + unallocated_ot + unallocated_other };
}
