import { addDays, istDate, istMidnight, type ISODate } from '@ajpwer/shared';
import type { DayFlag, DayInput, DayRecord, EnginePunch, PunchPair } from './types';

/** PRESENT needs at least 92% of the standard day. A constant, not a policy. */
export const PRESENT_TOLERANCE_PCT = 92;

const minutesBetween = (a: number, b: number) => Math.floor((b - a) / 60_000);

export interface PairResult {
  pairs: PunchPair[];
  orphan_outs: EnginePunch[];
  worked_min: number;
  break_min: number;
  sites: string[];
}

/**
 * Step 1 — pair the punches. Walk in time order holding one open IN:
 * IN with none open → hold; IN with one open → close the held one unmatched;
 * OUT with one open → pair; OUT with none open → orphan.
 */
export function pairPunches(punches: EnginePunch[]): PairResult {
  const sorted = [...punches].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const pairs: PunchPair[] = [];
  const orphan_outs: EnginePunch[] = [];
  let open: EnginePunch | null = null;

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
    break_min += Math.max(0, minutesBetween(closed[i - 1].out!.at, closed[i].in.at));
  }

  const sites: string[] = [];
  for (const p of sorted) if (!sites.includes(p.site_id)) sites.push(p.site_id);

  return { pairs, orphan_outs, worked_min, break_min, sites };
}

/** Minutes from IST midnight of the work date — can exceed 1440 for an overnight punch. */
function minuteOfWorkDate(at: number, workDate: ISODate): number {
  return minutesBetween(istMidnight(workDate).getTime(), at);
}

/** Steps 1–4 for one employee-day. Pure: no I/O, no clock. */
export function computeDay(input: DayInput): DayRecord {
  const { date, policies } = input;
  const pr = pairPunches(input.punches);
  const hasPunches = input.punches.length > 0;
  const flags: DayFlag[] = [];
  if (pr.orphan_outs.length) flags.push('ORPHAN_OUT');
  if (pr.pairs.some((p) => !p.out)) flags.push('UNMATCHED_IN');
  if (pr.sites.length > 1) flags.push('CROSS_SITE');
  if (policies.attendance_defaulted) flags.push('NO_ATTENDANCE_POLICY');

  const sortedAt = input.punches.map((p) => p.at).sort((a, b) => a - b);
  const first_punch_min = hasPunches ? minuteOfWorkDate(sortedAt[0], date) : null;
  const last_punch_min = hasPunches ? minuteOfWorkDate(sortedAt[sortedAt.length - 1], date) : null;

  const base: DayRecord = {
    date,
    status: 'ABSENT',
    day_value: 0,
    provisional: false,
    worked_min: pr.worked_min,
    break_min: pr.break_min,
    late_min: 0,
    ot_min: 0,
    first_punch_min,
    last_punch_min,
    pairs: pr.pairs,
    orphan_outs: pr.orphan_outs,
    sites: pr.sites,
    cross_site: pr.sites.length > 1,
    leave_type: null,
    flags,
  };

  // Step 2 — classify. The first check that applies wins.
  if (date < input.joined_on) return { ...base, status: 'NOT_JOINED', day_value: 0 };
  if (input.last_day && date > input.last_day) return { ...base, status: 'EXITED', day_value: 0 };
  if (input.is_holiday) return { ...base, status: hasPunches ? 'HOLIDAY_WORKED' : 'HOLIDAY', day_value: 1, provisional: true };
  if (input.is_weekly_off) return { ...base, status: hasPunches ? 'OFF_WORKED' : 'WEEKLY_OFF', day_value: 1, provisional: true };
  if (input.leave) {
    return { ...base, status: 'ON_LEAVE', day_value: input.leave.paid ? 1 : 0, leave_type: input.leave.leave_type };
  }
  if (!hasPunches) return { ...base, status: 'ABSENT', day_value: 0 };

  const rules = policies.attendance;

  // Step 3 — lateness, working days only. Recorded daily, charged monthly.
  let late_min = 0;
  if (first_punch_min !== null) {
    late_min = Math.max(0, first_punch_min - (input.shift_start_min + rules.grace_min));
  }
  if (late_min > 0) flags.push('LATE');

  // Step 4 — overtime, working days only, only with an overtime policy.
  let ot_min = 0;
  const ot = policies.overtime;
  if (ot) {
    const raw = Math.max(0, pr.worked_min - rules.standard_min);
    ot_min = raw < ot.after_min ? 0 : Math.floor(raw / ot.rounding_min) * ot.rounding_min;
  }

  const withTime = { ...base, late_min, ot_min };
  // An orphan OUT (an OUT with no IN) is treated like an unmatched pair: someone forgot a punch.
  if (pr.pairs.some((p) => !p.out) || pr.orphan_outs.length > 0) {
    return { ...withTime, status: 'MISSING_PUNCH', day_value: 0.5, ot_min: 0 };
  }
  if (pr.worked_min * 100 >= rules.standard_min * PRESENT_TOLERANCE_PCT) return { ...withTime, status: 'PRESENT', day_value: 1 };
  if (pr.worked_min >= rules.half_day_min) return { ...withTime, status: 'HALF_DAY', day_value: 0.5 };
  return { ...withTime, status: 'SHORT', day_value: 0 };
}

export interface LastPunch {
  direction: 'IN' | 'OUT';
  work_date: ISODate;
  at: number;
}

/** An open IN closed within this window by a punch after midnight belongs to the previous work date. */
export const OVERNIGHT_MAX_GAP_MIN = 16 * 60;

/**
 * The server derives work_date in Asia/Kolkata. For an overnight shift, an OUT
 * after midnight that closes an open IN from the previous date belongs to that date.
 * Never trust the tablet's clock for this.
 */
export function assignWorkDate(at: Date, direction: 'IN' | 'OUT', last: LastPunch | null): ISODate {
  const today = istDate(at);
  if (
    direction === 'OUT' &&
    last &&
    last.direction === 'IN' &&
    last.work_date === addDays(today, -1) &&
    minutesBetween(last.at, at.getTime()) <= OVERNIGHT_MAX_GAP_MIN
  ) {
    return last.work_date;
  }
  return today;
}

/** IN if the last punch was an OUT or there is none, OUT otherwise. */
export function inferDirection(last: { direction: 'IN' | 'OUT' } | null): 'IN' | 'OUT' {
  return !last || last.direction === 'OUT' ? 'IN' : 'OUT';
}
