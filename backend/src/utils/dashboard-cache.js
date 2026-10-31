/** Shared invalidation after attendance and approval changes. */
export const dashboardCache = new Map();

export function invalidateDashboardCache() {
  dashboardCache.clear();
}


/** Share pending reads too: concurrent requests must not duplicate a cold-cache load. */
export async function cachedDashboard(key, ttlMs, fn) {
  const hit = dashboardCache.get(key);
  if (hit && (hit.pending || Date.now() - hit.at < ttlMs)) return hit.v;
  const entry = { pending: true, at: 0, v: Promise.resolve().then(fn) };
  dashboardCache.set(key, entry);
  try {
    const value = await entry.v;
    // A mutation may clear the cache while this request is still reading.
    if (dashboardCache.get(key) === entry) dashboardCache.set(key, { at: Date.now(), v: value });
    return value;
  } catch (error) {
    if (dashboardCache.get(key) === entry) dashboardCache.delete(key);
    throw error;
  }
}
