import { istMidnight } from '@ajpwer/shared';
import { siteOvertimeMinutes } from './site-overtime.js';

/** Closed work intervals plus qualifying OT, preserving their actual order. */
export function recordedSiteIntervals(day, input) {
  const pairs = day.pairs.filter((p) => p.out)
    .sort((a, b) => a.in.at - b.in.at || a.in.id.localeCompare(b.in.id));
  const budgets = siteOvertimeMinutes(day, input);
  const rows = pairs.map((p) => ({ date: input.date, site_id: p.site_id, worked_min: p.minutes,
    ot_min: 0, first_at: p.in.at, first_ot_at: p.out.at }));
  const policy = input.policies.overtime;
  if (!policy || !budgets.size) return rows;
  let worked = 0;
  const midnight = istMidnight(input.date).getTime();
  const eligible = pairs.map((p) => {
    const start = Math.floor((p.in.at - midnight) / 60_000);
    const end = Math.floor((p.out.at - midnight) / 60_000);
    let minutes;
    if (policy.counts_from === 'SHIFT_END') minutes = Math.max(0, end - Math.max(start, day.due_out_min));
    else {
      const standard = input.policies.attendance.standard_min;
      minutes = Math.max(0, worked + p.minutes - standard) - Math.max(0, worked - standard);
      worked += p.minutes;
    }
    return minutes;
  });
  if (policy.counts_from === 'SHIFT_END') {
    const allowedBreak = Math.min(Math.max(0, day.break_min), input.shift_break_min ?? 0);
    const graceUsed = day.late_min > 0 ? 0 : Math.max(0, day.first_punch_min - input.shift_start_min);
    const excess = Math.max(0, day.worked_min + allowedBreak + graceUsed - input.policies.attendance.standard_min);
    let skip = Math.max(0, eligible.reduce((sum, m) => sum + m, 0) - excess);
    eligible.forEach((minutes, i) => {
      const ignored = Math.min(skip, minutes);
      eligible[i] -= ignored;
      skip -= ignored;
    });
  }
  rows.forEach((r, i) => {
    r.ot_min = Math.min(budgets.get(r.site_id) ?? 0, eligible[i]);
    budgets.set(r.site_id, (budgets.get(r.site_id) ?? 0) - r.ot_min);
    r.first_ot_at = pairs[i].out.at - eligible[i] * 60_000;
  });
  return rows;
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
