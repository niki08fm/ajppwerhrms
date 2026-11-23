import { istMidnight } from '@ajpwer/shared';

/**
 * Attribute recorded day OT to the sites of its closed IN/OUT intervals. computeDay
 * counts OT as time worked after `due_out_min` (the later of the shift end and punch-in
 * + the shift less 15 minutes), applying any minimum and rounding once for the day.
 * Each interval's minutes after `due_out_min` qualify, in chronological order; the day's
 * OT budget is allocated to them in turn, leaving any rounding remainder at the end.
 *
 * Use a computeDay result from actual punches, without global HR overrides or
 * paid travel. This is recorded site OT, not a site's share of payroll payments.
 */
export function siteOvertimeMinutes(day, input) {
  const allocated = new Map();
  if (day.ot_min <= 0) return allocated;
  let remaining = day.ot_min;
  for (const p of qualifyingIntervals(day, input)) {
    const minutes = Math.min(remaining, p.minutes);
    if (minutes > 0) allocated.set(p.site_id, (allocated.get(p.site_id) ?? 0) + minutes);
    remaining -= minutes;
    if (!remaining) break;
  }
  return allocated;
}

/** Closed intervals in time order with their minutes after the day's OT start. */
export function qualifyingIntervals(day, input) {
  const midnight = istMidnight(input.date).getTime();
  const minute = (at) => Math.floor((at - midnight) / 60_000);
  return day.pairs.filter((p) => p.out)
    .sort((a, b) => a.in.at - b.in.at || a.in.id.localeCompare(b.in.id))
    .map((p) => ({ pair: p, site_id: p.site_id, minutes: Math.max(0, minute(p.out.at) - Math.max(minute(p.in.at), day.due_out_min ?? Infinity)) }));
}
