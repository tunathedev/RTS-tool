/* SA50 RTS Ready — service worker.
 * Speeds up repeat loads and works offline. Only intercepts same-origin GETs,
 * so Firebase sync, weather, and HEB images are never touched. Shell assets use
 * stale-while-revalidate (fast load, refresh in background → applied next load);
 * product data is network-first (fresh) with a cache fallback when offline. */
const CACHE = 'rts-ready-v3';
const SHELL = ['./', './index.html', './app.js', './styles.css', './sync-config.js'];

self.addEventListener('install', (e) => {
  // don't auto-activate — wait for the page to confirm via the "Reload" prompt
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // leave cross-origin (Firebase/weather/images) alone

  const fresh = url.pathname.endsWith('/data/products.json') || url.pathname.endsWith('sync-config.js');
  if (fresh) {
    // network-first: always try the network, fall back to cache when offline
    e.respondWith(
      fetch(req).then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); return r; })
        .catch(() => caches.match(req))
    );
    return;
  }
  // stale-while-revalidate for the app shell
  e.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req).then((r) => { caches.open(CACHE).then((c) => c.put(req, r.clone())); return r; }).catch(() => cached);
      return cached || net;
    })
  );
});
