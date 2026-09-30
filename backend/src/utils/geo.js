/** Great-circle distance in metres. */
export function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

/**
 * Is this position good enough, and inside the site? Accuracy is checked before
 * distance: a poor fix cannot say where the tablet is. `action` words the
 * message for sign-in or punch. Uses the site's current centre and radius, so a
 * change applies from the next sign-in and punch, never to past punches.
 */
export function checkGeofence(site, pos, maxAccuracy, action = 'Sign in') {
  const distance_m = haversineM(site.lat, site.lng, pos.lat, pos.lng);
  if (pos.accuracy_m > maxAccuracy) {
    return {
      ok: false,
      code: 'GPS_ACCURACY',
      distance_m,
      reason: `Your location is only accurate to ${Math.round(pos.accuracy_m)} m; it must be ${maxAccuracy} m or better. Go outside or near a window, wait a moment, and try again.`,
    };
  }
  if (distance_m > site.radius_m) {
    return {
      ok: false,
      code: 'OUTSIDE_GEOFENCE',
      distance_m,
      reason: `You are ${distance_m} m from ${site.name ?? 'the site'}. ${action} from inside the site (within ${site.radius_m} m).`,
    };
  }
  return { ok: true, code: null, distance_m, reason: null };
}
