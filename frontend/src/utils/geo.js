/**
 * Coordinates from what HR pastes: "17.4448, 78.3498", or a Google Maps link —
 * a place link carries the pin as !3d<lat>!4d<lng>, a map link the view as @lat,lng,
 * and a shared pin as ?q=lat,lng. Returns { lat, lng } or null.
 */
export function parseLatLng(text) {
  if (!text) return null;
  const s = decodeURIComponent(String(text).trim());
  const num = '(-?\\d{1,3}(?:\\.\\d+)?)';
  const patterns = [
    new RegExp(`!3d${num}!4d${num}`),
    new RegExp(`[?&](?:q|query|ll|destination)=${num}\\s*,\\s*${num}`),
    new RegExp(`@${num},${num}`),
    new RegExp(`^${num}\\s*[,\\s]\\s*${num}$`),
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (!m) continue;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat: round6(lat), lng: round6(lng) };
  }
  return null;
}

export const round6 = (x) => Math.round(x * 1e6) / 1e6;
