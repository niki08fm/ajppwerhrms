import { addDays, ATTENDANCE_RULES, istDate, istMidnight } from '@ajpwer/shared';
import { requiredShiftMinutes, shiftShortfall } from './summary.js';

/** Kept for older callers: the built-in rules no longer use a percentage of the day. */
export const PRESENT_TOLERANCE_PCT = 92;

const minutesBetween = (a, b) => Math.floor((b - a) / 60_000);

/**
 * Step 1 — pair the punches. Walk in time order holding one open IN:
 * IN with none open → hold; IN with one open → close the held one unmatched;
 * OUT with one open → pair; OUT with none open → orphan.
 */
export function pairPunches(punches) {
  // At an instantaneous site handover, close the old session before opening the
  // next one. Random punch IDs must not turn equal-time OUT/INs into missing pairs.
  const sorted = [...punches].sort((a, b) => a.at - b.at || (a.direction === b.direction ? 0 : a.direction === 'OUT' ? -1 : 1) || a.id.localeCompare(b.id));
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
 * Built-in rules: time counts from the punch-in; under 4 hours is a half day, 4 hours or
 * more a full day; a missing punch-out is a full day without overtime. The day ends
 * (`due_out_min`, where overtime starts) at the later of the shift end and punch-in + the
 * shift less 15 minutes. Leaving before it is flagged EARLY_OUT for HR, never deducted.
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
    standard_min: Math.max(0, (input.shift_end_min ?? (input.shift_start_min ?? 540) + ATTENDANCE_RULES.default_shift_min) - (input.shift_start_min ?? 540) - ATTENDANCE_RULES.grace_min),
    shift_kind: input.is_holiday ? 'HOLIDAY' : input.is_weekly_off ? 'WEEKLY_OFF' : 'WORKING',
    required_shift_min: 0,
    shift_shortfall_min: 0,
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

  // Built-in rules (see ATTENDANCE_RULES): no attendance policy is read.
  const shiftStart = input.shift_start_min ?? 9 * 60;
  const shiftEnd = input.shift_end_min ?? shiftStart + ATTENDANCE_RULES.default_shift_min;
  const shiftMin = shiftEnd > shiftStart ? shiftEnd - shiftStart : ATTENDANCE_RULES.default_shift_min;
  const required = Math.max(0, shiftMin - ATTENDANCE_RULES.grace_min);
  // A missing punch-out (an IN never closed, or an OUT with no IN): the time cannot be counted.
  const missing = pr.pairs.some((p) => !p.out) || pr.orphan_outs.length > 0;
  const firstIn = pr.pairs[0]?.in ? minuteOfWorkDate(pr.pairs[0].in.at, date) : first_punch_min;

  // Step 3 — lateness: more than 15 minutes after shift start. Recorded and shown, never deducted.
  const late_min = firstIn > shiftStart + ATTENDANCE_RULES.grace_min ? firstIn - shiftStart : 0;
  if (late_min > 0) flags.push('LATE');
  // Overtime starts at the later of the shift end and punch-in + the shift less 15 minutes.
  const due_out_min = Math.max(shiftEnd, firstIn + required);
  const early_min = missing ? 0 : Math.max(0, due_out_min - last_punch_min);
  if (early_min > 0) flags.push('EARLY_OUT');

  // Step 4 — overtime: time worked after it starts. The overtime policy's minimum and rounding
  // still apply when there is one; its rate and cap are for payroll.
  const ot = policies.overtime;
  const raw = missing ? 0 : workedAfter(pr.pairs, date, due_out_min, travel_min);
  const counted = ot ? (raw < (ot.after_min ?? 0) ? 0 : Math.floor(raw / Math.max(1, ot.rounding_min ?? 1)) * Math.max(1, ot.rounding_min ?? 1)) : raw;
  // The policy's daily cap: minutes above it that day are not counted, and shown to HR.
  const dailyCap = ot?.daily_cap_min ?? null;
  const ot_min = dailyCap !== null ? Math.min(counted, dailyCap) : counted;
  const ot_capped_min = counted - ot_min;
  if (ot_capped_min > 0) flags.push('OT_DAILY_CAP');

  const withTime = { ...base, standard_min: required, late_min, early_min, due_out_min, ot_min, ...(ot_capped_min > 0 ? { ot_capped_min } : {}) };
  const complete = (status, day_value) => {
    const result = { ...withTime, status, day_value };
    return { ...result, required_shift_min: requiredShiftMinutes(result), shift_shortfall_min: shiftShortfall(result) };
  };
  // A missing punch-out is a full day with no overtime; HR is shown it.
  if (missing) return { ...withTime, status: 'MISSING_PUNCH', day_value: 1, ot_min: 0, ot_capped_min: undefined };
  if (worked_min < ATTENDANCE_RULES.half_day_below_min) {
    flags.push('UNDER_FOUR_HOURS');
    return complete('HALF_DAY', 0.5);
  }
  if (worked_min < required) flags.push('SHORT_HOURS');
  return complete('PRESENT', 1);
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
