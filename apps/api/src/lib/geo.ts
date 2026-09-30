/** Great-circle distance in metres. */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

export interface GeofenceCheck {
  ok: boolean;
  distance_m: number;
  reason: string | null;
}

export function checkGeofence(
  site: { lat: number; lng: number; radius_m: number },
  pos: { lat: number; lng: number; accuracy_m: number },
  maxAccuracy: number,
): GeofenceCheck {
  const distance_m = haversineM(site.lat, site.lng, pos.lat, pos.lng);
  if (pos.accuracy_m > maxAccuracy) {
    return { ok: false, distance_m, reason: `GPS accuracy is ${Math.round(pos.accuracy_m)} m; it must be ${maxAccuracy} m or better. Move to open sky and try again.` };
  }
  if (distance_m > site.radius_m) {
    return { ok: false, distance_m, reason: `This tablet is ${distance_m} m from the site centre, outside the ${site.radius_m} m boundary.` };
  }
  return { ok: true, distance_m, reason: null };
}
