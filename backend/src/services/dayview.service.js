import { istMidnight } from '@ajpwer/shared';

/**
 * One vocabulary for a day, shared by the Today screen and the Attendance register,
 * so a card on Today and a filter chip on Attendance always give the same number.
 *
 *   in       came in (any punch on the day, or worked an off day)
 *   onsite   still punched in right now (today only)
 *   nopunch  no punch-out — the 2 AM auto punch-out closed the day (past days)
 *   ot       in overtime now / did overtime
 *   absent   no punch and no leave on a working day
 *   late     punched in after the grace period
 *   early    left before the day was done (under the standard hours)
 *   leave    approved leave
 */
export const VIEWS = ['in', 'onsite', 'nopunch', 'ot', 'absent', 'late', 'early', 'leave'];

const IN_STATUSES = ['PRESENT', 'HALF_DAY', 'SHORT', 'MISSING_PUNCH', 'HOLIDAY_WORKED', 'OFF_WORKED'];
const NOT_EXPECTED = ['WEEKLY_OFF', 'HOLIDAY', 'NOT_JOINED', 'EXITED', 'ON_LEAVE'];

/** Minutes since IST midnight of `date`, now. */
export function minutesNow(date) {
  return Math.floor((Date.now() - istMidnight(date).getTime()) / 60_000);
}

/**
 * Hours so far for someone still punched in: what the punches have closed plus the open
 * stretch since the last IN; overtime by the same rule the day uses (beyond the standard
 * day, from the overtime threshold, rounded down).
 */
export function liveFigures(r, nowMin) {
  if (!r.open_now) return { worked_min: r.day.worked_min, ot_min: r.day.ot_min };
  const lastIn = r.day.last_punch_min ?? r.in_min ?? nowMin;
  const worked = r.day.worked_min + Math.max(0, nowMin - lastIn);
  const ot = r.context?.ot;
  let otMin = 0;
  if (ot && r.context.kind === 'WORKING') {
    const raw = Math.max(0, worked - r.context.standard_min);
    otMin = raw < ot.after_min ? 0 : Math.floor(raw / Math.max(1, ot.rounding_min)) * Math.max(1, ot.rounding_min);
  }
  return { worked_min: worked, ot_min: otMin };
}

export const isIn = (r) => r.open_now || IN_STATUSES.includes(r.day.status);
export const isExpected = (r) => !NOT_EXPECTED.includes(r.day.status) || isIn(r);

/** Does a register row belong to a view? `live` holds liveFigures() for the row. */
export function inView(view, r, live) {
  switch (view) {
    case 'in':
      return isIn(r);
    case 'onsite':
      return !!r.open_now;
    case 'nopunch':
      return r.day.status === 'MISSING_PUNCH' && !r.open_now && !r.override;
    case 'ot':
      return (live?.ot_min ?? r.day.ot_min) > 0;
    case 'absent':
      return r.day.status === 'ABSENT';
    case 'late':
      return r.day.late_min > 0;
    case 'early':
      return !r.open_now && r.day.early_min > 0;
    case 'leave':
      return r.day.status === 'ON_LEAVE';
    default:
      return true;
  }
}

/** Counts for every view, plus how many were expected in. */
export function summarize(rows, nowMin) {
  const out = { everyone: rows.length, expected: 0 };
  for (const v of VIEWS) out[v] = 0;
  for (const r of rows) {
    const live = liveFigures(r, nowMin);
    if (isExpected(r)) out.expected += 1;
    for (const v of VIEWS) if (inView(v, r, live)) out[v] += 1;
  }
  return out;
}
