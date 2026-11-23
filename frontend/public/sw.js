// Makes the app installable. It caches nothing: every page and every figure comes
// fresh from the server, so payroll and attendance can never show stale data.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
