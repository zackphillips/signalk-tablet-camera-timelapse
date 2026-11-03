/*
 * Minimal service worker so Chrome offers "Install app". It caches nothing:
 * Signal K data and the hosted app must always come from the server.
 */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
// Pass-through: no respondWith(), so the browser handles every request normally.
self.addEventListener('fetch', () => {})
