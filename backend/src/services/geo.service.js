import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';

/**
 * Place search for the site form, proxied to Nominatim (OpenStreetMap) so the
 * browser never calls it directly. Nominatim's usage policy asks for an
 * identifying User-Agent with a contact, at most one request a second, and
 * caching — so every outbound call waits its turn, and answers are kept 24 hours.
 * One process holds the queue and cache; that is enough for HR's occasional searches.
 */

const DAY_MS = 24 * 3600_000;

export function normaliseQuery(q) {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function createGeoSearch({
  fetchImpl = (...a) => globalThis.fetch(...a),
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  minIntervalMs = 1000,
  cacheMs = DAY_MS,
  maxWaitMs = 5000,
  maxEntries = 1000,
  baseUrl = env.NOMINATIM_URL,
  userAgent = env.NOMINATIM_USER_AGENT,
  email = env.NOMINATIM_EMAIL,
} = {}) {
  const cache = new Map();
  const inflight = new Map();
  // Time the next outbound call may start. Reserved synchronously, so calls never overlap the limit.
  let nextSlot = 0;

  async function call(q) {
    const t = now();
    const slot = Math.max(t, nextSlot);
    if (slot - t > maxWaitMs) throw new AppError('RATE_LIMITED', 'Place search is busy. Try again in a few seconds.', 429);
    nextSlot = slot + minIntervalMs;
    if (slot > t) await sleep(slot - t);
    const url = new URL('/search', baseUrl);
    url.searchParams.set('q', q);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '6');
    url.searchParams.set('addressdetails', '0');
    if (email) url.searchParams.set('email', email);
    const ua = email ? `${userAgent} (${email})` : userAgent;
    let r;
    try {
      r = await fetchImpl(url.toString(), { headers: { 'User-Agent': ua, 'Accept-Language': 'en' }, signal: AbortSignal.timeout(8000) });
    } catch {
      throw new AppError('GEO_UNAVAILABLE', 'Place search is not reachable right now. Drag the marker or paste coordinates instead.', 502);
    }
    if (!r.ok) throw new AppError('GEO_UNAVAILABLE', 'Place search is not reachable right now. Drag the marker or paste coordinates instead.', 502);
    const rows = await r.json();
    return (Array.isArray(rows) ? rows : []).map((x) => ({ name: x.display_name, lat: Number(Number(x.lat).toFixed(6)), lng: Number(Number(x.lon).toFixed(6)), type: x.type ?? null }));
  }

  async function search(raw) {
    const key = normaliseQuery(raw);
    const hit = cache.get(key);
    if (hit && now() - hit.at < cacheMs) return { results: hit.results, cached: true };
    if (inflight.has(key)) return { results: await inflight.get(key), cached: true };
    const p = call(key);
    inflight.set(key, p);
    try {
      const results = await p;
      cache.set(key, { at: now(), results });
      if (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      return { results, cached: false };
    } finally {
      inflight.delete(key);
    }
  }

  return { search, clear: () => cache.clear() };
}

export const geoSearch = createGeoSearch();
