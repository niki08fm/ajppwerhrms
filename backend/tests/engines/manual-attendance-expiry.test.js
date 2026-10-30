import { afterEach, describe, expect, it, vi } from 'vitest';
import { startManualAttendanceExpiry } from '../../src/jobs/manual-attendance-expiry.js';
import { dashboardCache } from '../../src/utils/dashboard-cache.js';

afterEach(() => { vi.useRealTimers(); dashboardCache.clear(); });

describe('Idle manual attendance expiry sweep', () => {
  it('runs at startup, invalidates stale dashboard counts, and stops on shutdown', async () => {
    vi.useFakeTimers();
    dashboardCache.set('waiting', 'old');
    const expire = vi.fn().mockResolvedValue({ count: 1 });
    const stop = startManualAttendanceExpiry({ db: {}, expire, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(expire).toHaveBeenCalledTimes(1);
    expect(dashboardCache.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(expire).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(expire).toHaveBeenCalledTimes(2);
  });

  it('avoids overlapping sweeps and recovers after a temporary database failure', async () => {
    vi.useFakeTimers();
    let reject;
    const expire = vi.fn().mockImplementationOnce(() => new Promise((resolve, fail) => { reject = fail; }))
      .mockResolvedValue({ count: 0 });
    const onError = vi.fn();
    const stop = startManualAttendanceExpiry({ db: {}, expire, onError, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(expire).toHaveBeenCalledTimes(1);
    const error = new Error('Temporary database connection failure');
    reject(error);
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(expire).toHaveBeenCalledTimes(2);
    stop();
  });
});
