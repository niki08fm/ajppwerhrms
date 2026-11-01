import { AsyncLocalStorage } from 'node:async_hooks';
const scopes = new AsyncLocalStorage();
/** Share repeated reads only inside one read operation, never across users or mutations. */
export function withReadScope(fn) {
  return scopes.getStore() ? fn() : scopes.run(new WeakMap(), fn);
}
export function scopedRead(db, key, load) {
  const scope = scopes.getStore();
  if (!scope) return load();
  let reads = scope.get(db);
  if (!reads) {
    reads = new Map();
    scope.set(db, reads);
  }
  if (reads.has(key)) return reads.get(key);
  const result = Promise.resolve().then(load);
  reads.set(key, result);
  result.catch(() => {
    if (reads.get(key) === result) reads.delete(key);
  });
  return result;
}
export function scopeReadRequests(req, _res, next) {
  if (req.method !== 'GET') return next();
  return withReadScope(next);
}
