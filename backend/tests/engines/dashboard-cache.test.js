import { afterEach, describe, expect, it, vi } from 'vitest';
import { cachedDashboard, invalidateDashboardCache } from '../../src/utils/dashboard-cache.js';

afterEach(() => { invalidateDashboardCache(); vi.useRealTimers(); });
describe('Dashboard pending-read sharing', () => {
  it('loads once for concurrent requests, with TTL starting when data is ready', async () => {
    vi.useFakeTimers();
    let resolve;
    const gate = new Promise((r) => { resolve = r; });
    const load = vi.fn(() => gate);
    const a = cachedDashboard('month', 1000, load);
    await Promise.resolve();
    vi.advanceTimersByTime(2000);
    const b = cachedDashboard('month', 1000, load);
    resolve({ value: 1 });
    expect(await a).toEqual(await b);
    await cachedDashboard('month', 1000, load);
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    await cachedDashboard('month', 1000, load);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('does not repopulate invalidated data after an attendance change', async () => {
    let resolve;
    const old = cachedDashboard('register', 1000, () => new Promise((r) => { resolve = r; }));
    await Promise.resolve();
    invalidateDashboardCache();
    expect(await cachedDashboard('register', 1000, () => 'corrected')).toBe('corrected');
    resolve('old');
    expect(await old).toBe('old');
    expect(await cachedDashboard('register', 1000, () => 'unexpected')).toBe('corrected');
  });
  it('allows retry after a rejected shared load', async () => {
    const load = vi.fn(async () => { throw new Error('Unavailable'); });
    const results = await Promise.allSettled([cachedDashboard('register', 1000, load), cachedDashboard('register', 1000, load)]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await cachedDashboard('register', 1000, () => 'recovered')).toBe('recovered');
  });
  it('keeps independent dates isolated', async () => {
    expect(await cachedDashboard('register:1', 1000, () => 'day 1')).toBe('day 1');
    expect(await cachedDashboard('register:2', 1000, () => 'day 2')).toBe('day 2');
  });
});
