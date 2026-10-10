import { addDays, isISODate, istDate } from '@ajpwer/shared';
import { fromDbDate, toDbDate } from '../utils/dbDates.js';

const LOOKBACK_DAYS = 30;
const emptyStreak = () => ({ days: 0, latest_date: null, requires_review: false, dates: [] });
const workDate = (value) => value instanceof Date ? fromDbDate(value) : value;

/**
 * A suggestion for HR, never permission to overwrite a registered face. Only
 * approved failed-try requests backed by their actual EXCEPTION punch count.
 * Work dates preserve overnight shifts; repeated IN/OUT failures count once.
 * Successful face punches break the streak, including on a mixed-method day.
 */
export function calculateManualFaceFailureStreak({ exceptions = [], punches = [], employeeId, now = new Date() }) {
  const today = istDate(now);
  const oldest = addDays(today, -(LOOKBACK_DAYS - 1));
  const validPunches = punches.filter((p) => {
    const date = workDate(p.work_date);
    return p.employee_id === employeeId && !p.deleted_at && isISODate(date)
      && date >= oldest && date <= today && new Date(p.punched_at).getTime() <= now.getTime();
  });
  const byId = new Map(validPunches.map((p) => [p.id, p]));
  const successDates = new Set(validPunches.filter((p) => p.method === 'FACE').map((p) => workDate(p.work_date)));
  const failureDates = new Set();
  for (const exception of exceptions) {
    if (exception.status !== 'APPROVED' || exception.kind !== 'FAILED_TRIES' || exception.deleted_at
      || exception.decided_employee_id !== employeeId
      || (exception.decided_at && new Date(exception.decided_at).getTime() > now.getTime())) continue;
    const punch = byId.get(exception.punch_id);
    if (punch?.method === 'EXCEPTION' && punch.source_ref === exception.id) failureDates.add(workDate(punch.work_date));
  }
  const latest = [...new Set([...successDates, ...failureDates])].sort().at(-1);
  if (!latest || latest < addDays(today, -1) || successDates.has(latest)) return emptyStreak();

  const dates = [];
  for (let day = latest; failureDates.has(day) && !successDates.has(day); day = addDays(day, -1)) dates.push(day);
  dates.reverse();
  return { days: dates.length, latest_date: latest, requires_review: dates.length > 3, dates };
}

/** Read at most 30 work dates for one employee; no attendance/template changes. */
export async function getManualFaceFailureStreak(db, employeeId, now = new Date()) {
  const today = istDate(now);
  const punches = await db.punch.findMany({
    where: {
      employee_id: employeeId, deleted_at: null, method: { in: ['FACE', 'EXCEPTION'] },
      work_date: { gte: toDbDate(addDays(today, -(LOOKBACK_DAYS - 1))), lte: toDbDate(today) },
      punched_at: { lte: now },
    },
    select: { id: true, employee_id: true, work_date: true, punched_at: true, method: true, source_ref: true, deleted_at: true },
  });
  const exceptionPunchIds = punches.filter((p) => p.method === 'EXCEPTION').map((p) => p.id);
  if (!exceptionPunchIds.length) return emptyStreak();
  const exceptions = await db.faceException.findMany({
    where: {
      decided_employee_id: employeeId, status: 'APPROVED', kind: 'FAILED_TRIES', deleted_at: null,
      punch_id: { in: exceptionPunchIds }, decided_at: { lte: now },
    },
    select: { id: true, punch_id: true, decided_employee_id: true, status: true, kind: true, deleted_at: true, decided_at: true },
  });
  return calculateManualFaceFailureStreak({ exceptions, punches, employeeId, now });
}
