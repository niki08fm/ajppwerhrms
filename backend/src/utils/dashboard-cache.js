/** Shared invalidation after attendance and approval changes. */
export const dashboardCache = new Map();

export function invalidateDashboardCache() {
  dashboardCache.clear();
}
