import { istMidnight } from '@ajpwer/shared';

/**
 * Attribute recorded day OT to the sites of its closed IN/OUT intervals. The
 * employee's standard day, threshold and rounding are applied once by computeDay;
 * independently calculating each site's day would lose or duplicate overtime.
 *
 * For STANDARD_DAY the earlier worked minutes fill the standard day first. For
 * SHIFT_END only time after due_out_min qualifies; when full-day eligibility
 * limits that time, the later intervals qualify first. The rounded daily budget
 * is then allocated in chronological order, leaving any rounding remainder at
 * the end. An interval never receives more OT than its qualifying minutes.
 *
 * Use a computeDay result from actual punches, without global HR overrides or
 * paid travel. This is recorded site OT, not a site's share of payroll payments.
 */
export function siteOvertimeMinutes(day, input) {
  const allocated = new Map();
  const policy = input.policies.overtime;
  if (!policy || day.ot_min <= 0) return allocated;
  const pairs = day.pairs.filter((p) => p.out)
    .sort((a, b) => a.in.at - b.in.at || a.in.id.localeCompare(b.in.id));
  const eligible = [];
  const standard = input.policies.attendance.standard_min;
  if (policy.counts_from === 'SHIFT_END') {
    const midnight = istMidnight(input.date).getTime();
    const minute = (at) => Math.floor((at - midnight) / 60_000);
    for (const p of pairs) {
      const minutes = Math.max(0, minute(p.out.at) - Math.max(minute(p.in.at), day.due_out_min));
      if (minutes) eligible.push({ site_id: p.site_id, minutes });
    }
    const allowedBreak = Math.min(Math.max(0, day.break_min), input.shift_break_min ?? 0);
    const graceUsed = day.late_min > 0 ? 0 : Math.max(0, day.first_punch_min - input.shift_start_min);
    const fullDayExcess = Math.max(0, day.worked_min + allowedBreak + graceUsed - standard);
    let skip = Math.max(0, eligible.reduce((sum, p) => sum + p.minutes, 0) - fullDayExcess);
    for (const p of eligible) {
      const beforeEligibility = Math.min(skip, p.minutes);
      p.minutes -= beforeEligibility;
      skip -= beforeEligibility;
    }
  } else {
    let worked = 0;
    for (const p of pairs) {
      const minutes = Math.max(0, worked + p.minutes - standard) - Math.max(0, worked - standard);
      worked += p.minutes;
      if (minutes) eligible.push({ site_id: p.site_id, minutes });
    }
  }
  let remaining = day.ot_min;
  for (const p of eligible) {
    const minutes = Math.min(remaining, p.minutes);
    if (minutes > 0) allocated.set(p.site_id, (allocated.get(p.site_id) ?? 0) + minutes);
    remaining -= minutes;
    if (!remaining) break;
  }
  return allocated;
}
