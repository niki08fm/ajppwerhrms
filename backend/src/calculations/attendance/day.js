import { addDays, istDate, istMidnight } from '@ajpwer/shared';

/** Under a policy with no half-day limit, PRESENT needs at least 92% of the standard day. A constant, not a policy. */
export const PRESENT_TOLERANCE_PCT = 92;

const minutesBetween = (a, b) => Math.floor((b - a) / 60_000);

/**
 * Step 1 — pair the punches. Walk in time order holding one open IN:
 * IN with none open → hold; IN with one open → close the held one unmatched;
 * OUT with one open → pair; OUT with none open → orphan.
 */
export function pairPunches(punches) {
  const sorted = [...punches].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const pairs = [];
  const orphan_outs = [];
  let open = null;

  for (const p of sorted) {
    if (p.direction === 'IN') {
      if (open) pairs.push({ in: open, out: null, minutes: 0, site_id: open.site_id });
      open = p;
    } else if (open) {
      pairs.push({ in: open, out: p, minutes: Math.max(0, minutesBetween(open.at, p.at)), site_id: open.site_id });
      open = null;
    } else {
      orphan_outs.push(p);
    }
  }
  if (open) pairs.push({ in: open, out: null, minutes: 0, site_id: open.site_id });

  const worked_min = pairs.reduce((s, x) => s + x.minutes, 0);
  let break_min = 0;
  const closed = pairs.filter((x) => x.out);
  for (let i = 1; i < closed.length; i++) {
    break_min += Math.max(0, minutesBetween(closed[i - 1].out.at, closed[i].in.at));
  }

  const sites = [];
  for (const p of sorted) if (!sites.includes(p.site_id)) sites.push(p.site_id);

  return { pairs, orphan_outs, worked_min, break_min, sites };
}

/** Minutes from IST midnight of the work date — can exceed 1440 for an overnight punch. */
function minuteOfWorkDate(at, workDate) {
  return minutesBetween(istMidnight(workDate).getTime(), at);
}

/** Where a shift ends in minutes of its work date: past 1440 for a shift that crosses midnight. */
export function shiftEndOnWorkDate(shift) {
  return shift.crosses_midnight || shift.end_min <= shift.start_min ? shift.end_min + 24 * 60 : shift.end_min;
}

/**
 * Minutes worked after a minute of the work date: the closed pairs' time past it, plus
 * travel between sites up to the breaks that fall past it (travel happens in a break).
 */
function workedAfter(pairs, workDate, fromMin, travelMin) {
  let worked = 0;
  let gaps = 0;
  let prevOut = null;
  for (const p of pairs) {
    if (!p.out) continue;
    const a = minuteOfWorkDate(p.in.at, workDate);
    const b = minuteOfWorkDate(p.out.at, workDate);
    worked += Math.max(0, b - Math.max(a, fromMin));
    if (prevOut !== null) gaps += Math.max(0, a - Math.max(prevOut, fromMin));
    prevOut = b;
  }
  return worked + Math.min(travelMin, gaps);
}

/**
 * Steps 1–4 for one employee-day. Pure: no I/O, no clock.
 * `travel_min` is time spent moving between sites on the tablet's "Change site"
 * (counted only on arrival at the named site the same day, or as HR set it). It is
 * worked time: it adds to the paired minutes and comes out of the break between them.
 *
 * The day ends at the shift end, or — for someone who arrived after the grace period —
 * a standard day after they arrived (`due_out_min`). Leaving before it is flagged
 * EARLY_OUT for HR, never deducted.
 */
export function computeDay(input) {
  const { date, policies } = input;
  const pr = pairPunches(input.punches);
  const hasPunches = input.punches.length > 0;
  const travel_min = hasPunches ? Math.max(0, input.travel_min ?? 0) : 0;
  const worked_min = pr.worked_min + travel_min;
  const flags = [];
  if (pr.orphan_outs.length) flags.push('ORPHAN_OUT');
  if (pr.pairs.some((p) => !p.out)) flags.push('UNMATCHED_IN');
  if (pr.sites.length > 1) flags.push('CROSS_SITE');
  if (policies.attendance_defaulted) flags.push('NO_ATTENDANCE_POLICY');
  if (travel_min > 0) flags.push('TRAVEL');

  const sortedAt = input.punches.map((p) => p.at).sort((a, b) => a - b);
  const first_punch_min = hasPunches ? minuteOfWorkDate(sortedAt[0], date) : null;
  const last_punch_min = hasPunches ? minuteOfWorkDate(sortedAt[sortedAt.length - 1], date) : null;

  const base = {
    date,
    status: 'ABSENT',
    day_value: 0,
    provisional: false,
    worked_min,
    break_min: Math.max(0, pr.break_min - travel_min),
    travel_min,
    late_min: 0,
    early_min: 0,
    due_out_min: null,
    ot_min: 0,
    first_punch_min,
    last_punch_min,
    pairs: pr.pairs,
    orphan_outs: pr.orphan_outs,
    sites: pr.sites,
    cross_site: pr.sites.length > 1,
    leave_type: null,
    /** Recorded leave on this date ({ leave_type, paid, portion, request_id, occasion_paid }); the month pays it from a balance */
    applied: null,
    leave_days: 0,
    auto_leave: 0,
    flags,
  };

  // Step 2 — classify. The first check that applies wins.
  if (date < input.joined_on) return { ...base, status: 'NOT_JOINED', day_value: 0 };
  if (input.last_day && date > input.last_day) return { ...base, status: 'EXITED', day_value: 0 };
  if (input.is_holiday) return { ...base, status: hasPunches ? 'HOLIDAY_WORKED' : 'HOLIDAY', day_value: 1, provisional: true };
  if (input.is_weekly_off) return { ...base, status: hasPunches ? 'OFF_WORKED' : 'WEEKLY_OFF', day_value: 1, provisional: true };
  if (input.leave && (input.leave.portion ?? 1) >= 1) {
    // Paid until the month checks the balance.
    const paid = input.leave.paid ? 1 : 0;
    return { ...base, status: 'ON_LEAVE', day_value: paid, leave_type: input.leave.leave_type, applied: input.leave, leave_days: paid };
  }
  // Half a day of recorded leave: the other half comes from the punches.
  if (input.leave) Object.assign(base, { leave_type: input.leave.leave_type, applied: input.leave });
  if (!hasPunches) return { ...base, status: 'ABSENT', day_value: 0 };

  const rules = policies.attendance;
  // An orphan OUT (an OUT with no IN) is treated like an unmatched pair: someone forgot a punch.
  const missing = pr.pairs.some((p) => !p.out) || pr.orphan_outs.length > 0;

  // Step 3 — lateness and the end of the day, working days only. Recorded and flagged, never deducted.
  // Within the grace period nobody is late; past it, lateness counts from the shift start.
  const late_min = first_punch_min > input.shift_start_min + rules.grace_min ? first_punch_min - input.shift_start_min : 0;
  if (late_min > 0) flags.push('LATE');
  const shiftEnd = input.shift_end_min ?? input.shift_start_min + rules.standard_min;
  const due_out_min = late_min > 0 ? Math.max(shiftEnd, first_punch_min + rules.standard_min) : shiftEnd;
  const early_min = missing ? 0 : Math.max(0, due_out_min - last_punch_min);
  if (early_min > 0) flags.push('EARLY_OUT');

  // Step 4 — overtime, working days only, only with an overtime policy.
  let ot_min = 0;
  const ot = policies.overtime;
  if (ot) {
    let raw;
    if (ot.counts_from === 'SHIFT_END') {
      // Time worked after the day ends, and only beyond a full standard day: breaks up to the
      // shift's allowance count as worked, and so do grace minutes for someone who was not late.
      const allowedBreak = Math.min(Math.max(0, pr.break_min - travel_min), input.shift_break_min ?? 0);
      const graceUsed = late_min > 0 ? 0 : Math.max(0, first_punch_min - input.shift_start_min);
      raw = Math.min(workedAfter(pr.pairs, date, due_out_min, travel_min), Math.max(0, worked_min + allowedBreak + graceUsed - rules.standard_min));
    } else {
      raw = Math.max(0, worked_min - rules.standard_min);
    }
    ot_min = raw < ot.after_min ? 0 : Math.floor(raw / ot.rounding_min) * ot.rounding_min;
  }

  const withTime = { ...base, late_min, early_min, due_out_min, ot_min };
  if (missing) return { ...withTime, status: 'MISSING_PUNCH', day_value: 0.5, ot_min: 0 };
  const fullDay = (rules.half_day_upto_min ?? null) !== null ? worked_min > rules.half_day_upto_min : worked_min * 100 >= rules.standard_min * PRESENT_TOLERANCE_PCT;
  if (fullDay) return { ...withTime, status: 'PRESENT', day_value: 1 };
  if (worked_min >= rules.half_day_min) return { ...withTime, status: 'HALF_DAY', day_value: 0.5 };
  return { ...withTime, status: 'SHORT', day_value: 0 };
}

/** An open IN closed within this window by a punch after midnight belongs to the previous work date. */
export const OVERNIGHT_MAX_GAP_MIN = 16 * 60;

/**
 * The server derives work_date in Asia/Kolkata. For an overnight shift, an OUT
 * after midnight that closes an open IN from the previous date belongs to that date.
 * Never trust the tablet's clock for this.
 */
export function assignWorkDate(at, direction, last) {
  const today = istDate(at);
  if (direction === 'OUT' && last && last.direction === 'IN' && last.work_date === addDays(today, -1) && minutesBetween(last.at, at.getTime()) <= OVERNIGHT_MAX_GAP_MIN) {
    return last.work_date;
  }
  return today;
}

/** IN if the last punch was an OUT or there is none, OUT otherwise. */
export function inferDirection(last) {
  return !last || last.direction === 'OUT' ? 'IN' : 'OUT';
}
