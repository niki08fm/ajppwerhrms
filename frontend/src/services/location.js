/** One GPS fix from the browser: where the device is and how sure it is, in metres. */
export function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This device has no location service.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy_m: p.coords.accuracy }),
      (e) => reject(new Error(e.code === 1 ? 'Location permission was refused. Allow location for this site in the browser.' : 'Could not get a GPS fix. Move to open sky and try again.')),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  });
}
