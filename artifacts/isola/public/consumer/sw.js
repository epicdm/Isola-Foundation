/**
 * Service worker for the EMA consumer PWA. Scope is /consumer/ by default
 * (this file is served from /consumer/sw.js). Strategy: cache the app shell
 * for installability + fast repeat loads; everything else (API calls,
 * dynamic pages) goes straight to the network — this app shows live
 * balance/line/call data and must never serve stale data from cache.
 */

const CACHE_NAME = 'ema-consumer-shell-v1';
const SHELL_ASSETS = [
  '/consumer/manifest.webmanifest',
  '/consumer/icon-192.png',
  '/consumer/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only serve shell assets from cache; never intercept navigations, pages,
  // or API calls — this is a live-data app, not an offline-first one.
  if (event.request.method === 'GET' && SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request)),
    );
  }
});
