import { expireManualAttendanceSheets } from '../services/manual-attendance.service.js';
import { invalidateApprovalsCache } from '../services/approvals.service.js';
import { invalidateDashboardCache } from '../utils/dashboard-cache.js';

/** The API also enforces deadlines on reads/decisions; the sweep updates history while idle. */
export function startManualAttendanceExpiry({ db, intervalMs = 60_000, now = () => new Date(), expire = expireManualAttendanceSheets, onError = () => {} }) {
  let running = false;
  let stopped = false;
  const sweep = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await expire(db, now());
      if (result.count) {
        invalidateApprovalsCache();
        invalidateDashboardCache();
      }
    } catch (error) {
      onError(error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void sweep(), intervalMs);
  timer.unref?.();
  void sweep();
  return () => { stopped = true; clearInterval(timer); };
}
