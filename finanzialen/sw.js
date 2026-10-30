// Haushaltsbuch service worker: makes the app open offline.
// Bump VERSION when you change this file; old caches are removed on activate.
const VERSION = 'v2';
const SHELL_CACHE = `budget-shell-${VERSION}`;
const CDN_CACHE = `budget-cdn-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png'
];

// Libraries the page loads. Cached best-effort on install, and on first use otherwise.
const CDN_HOSTS = [
  'cdn.tailwindcss.com',
  'unpkg.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'www.gstatic.com'
];

// Live data and sign-in must always go to the network, never to a cache.
const NEVER_CACHE = [
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'www.googleapis.com',
  'apis.google.com',
  'accounts.google.com'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll(SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = [SHELL_CACHE, CDN_CACHE];
    const names = await caches.keys();
    await Promise.all(names.filter(n => !keep.includes(n)).map(n => caches.delete(n)));
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (NEVER_CACHE.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) return;
  // Firebase's sign-in helper pages live on the project's own domain.
  if (url.pathname.startsWith('/__/auth/')) return;

  // The app page: network first so updates arrive immediately, cache when offline.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = (await event.preloadResponse) || await fetch(request);
        if (fresh.ok) {
          const cache = await caches.open(SHELL_CACHE);
          cache.put('./index.html', fresh.clone());
        }
        return fresh;
      } catch (e) {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }

  // Libraries: serve from cache right away, refresh in the background.
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(event, CDN_CACHE));
    return;
  }

  // Our own files (icons, manifest): same approach.
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(event, SHELL_CACHE));
  }
});

async function staleWhileRevalidate(event, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(event.request);
  const network = fetch(event.request)
    .then((resp) => {
      // Opaque responses (scripts loaded without CORS) are fine to cache too.
      if (resp.ok || resp.type === 'opaque') cache.put(event.request, resp.clone());
      return resp;
    })
    .catch(() => cached || Response.error());
  if (cached) {
    event.waitUntil(network.catch(() => {}));
    return cached;
  }
  return network;
}
