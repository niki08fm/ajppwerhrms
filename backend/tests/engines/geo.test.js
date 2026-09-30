import { describe, expect, it } from 'vitest';
import { checkGeofence, haversineM } from '../../src/utils/geo.js';

describe('Haversine distance', () => {
  it('is zero for the same point', () => {
    expect(haversineM(17.4448, 78.3498, 17.4448, 78.3498)).toBe(0);
  });

  it('one thousandth of a degree of latitude is about 111 m', () => {
    expect(haversineM(17.4448, 78.3498, 17.4458, 78.3498)).toBe(111);
  });

  it('matches known city distances (Hyderabad → Vijayawada ≈ 249 km, Mumbai → Delhi ≈ 1,148 km)', () => {
    const hydVij = haversineM(17.385, 78.4867, 16.5062, 80.648);
    expect(hydVij).toBeGreaterThan(248_000);
    expect(hydVij).toBeLessThan(251_000);
    const bomDel = haversineM(19.076, 72.8777, 28.6139, 77.209);
    expect(bomDel).toBeGreaterThan(1_145_000);
    expect(bomDel).toBeLessThan(1_152_000);
  });

  it('is symmetric', () => {
    expect(haversineM(16.5062, 80.648, 16.5731, 80.7101)).toBe(haversineM(16.5731, 80.7101, 16.5062, 80.648));
  });
});

describe('Geofence check', () => {
  const site = { name: 'Site A', lat: 17.4448, lng: 78.3498, radius_m: 200 };

  it('checks accuracy before distance', () => {
    const r = checkGeofence(site, { lat: 17.5, lng: 78.4, accuracy_m: 120 }, 50);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('GPS_ACCURACY');
    expect(r.reason).toContain('120 m');
  });

  it('outside the radius says how far, and the limit, in plain words', () => {
    const r = checkGeofence(site, { lat: 17.4479, lng: 78.3498, accuracy_m: 10 }, 50);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('OUTSIDE_GEOFENCE');
    expect(r.reason).toBe(`You are ${r.distance_m} m from Site A. Sign in from inside the site (within 200 m).`);
    expect(checkGeofence(site, { lat: 17.4479, lng: 78.3498, accuracy_m: 10 }, 50, 'Punch').reason).toContain('Punch from inside the site');
  });

  it('inside the radius, and exactly on it, is allowed', () => {
    expect(checkGeofence(site, { lat: 17.4449, lng: 78.3499, accuracy_m: 10 }, 50).ok).toBe(true);
    const edge = haversineM(site.lat, site.lng, 17.4466, 78.3498);
    expect(checkGeofence({ ...site, radius_m: edge }, { lat: 17.4466, lng: 78.3498, accuracy_m: 10 }, 50).ok).toBe(true);
  });
});
