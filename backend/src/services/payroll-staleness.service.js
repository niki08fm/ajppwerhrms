import { formatYearMonth, ymOf } from '@ajpwer/shared';
import { AppError } from '../utils/errors.js';

/*
 * A month whose payroll is generated but not locked is a snapshot of the rules, rates and
 * salaries at that moment. When one of them changes for dates in that month, the month is
 * flagged: HR sees "regenerate before locking", and locking is refused until it is regenerated.
 * Locked and paid months are protected by each change's own checks and are never flagged.
 */

/** Flag every generated (RUN) month from `from` to `to` (open-ended when null). Returns how many. */
export async function flagRerun(db, { from = null, to = null, reason }) {
  if (!db?.payrollPeriod?.updateMany) return 0;
  const r = await db.payrollPeriod.updateMany({
    where: { deleted_at: null, state: 'RUN', period_ym: { gte: from ? ymOf(from) : '0000-01', lte: to ? ymOf(to) : '9999-12' } },
    data: { rerun_reason: reason, rerun_flagged_at: new Date() },
  });
  return r.count;
}

/** Flag the months several changed date ranges touch. */
export async function flagRerunRanges(db, ranges, reason) {
  let n = 0;
  for (const r of ranges) n += await flagRerun(db, { from: r.from, to: r.to, reason });
  return n;
}

/** Locking a month generated before a change would freeze stale payslips. */
export function assertNotStale(period) {
  if (period.rerun_reason) {
    throw new AppError('RERUN_NEEDED', `${formatYearMonth(period.period_ym)} was generated before a change: ${period.rerun_reason}. Regenerate the payroll before locking it.`, 409);
  }
}
