/* ═══════════════════════════════════════════════════════════
   fitl00p — Service Worker
   Cache-first for static assets, network-first for API calls.
   Handles incoming push notifications.
   ═══════════════════════════════════════════════════════════ */

const CACHE_NAME    = 'fitl00p-v3';
const NEVER_CACHE   = ['/app.js', '/app.css', '/index.html', '/', '/diabetes-engine.js', '/nightscout-adapter.js'];
const STATIC_ASSETS = [
  '/sw.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];

/* ── INSTALL: pre-cache static assets only ──────────────── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return Promise.allSettled(
        STATIC_ASSETS.map(url => cache.add(url).catch(() => {}))
      );
    }).then(() => self.skipWaiting())
  );
});

/* ── ACTIVATE: clear old caches ─────────────────────────── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Bounds the SW's own network-first fetch. iOS can fully suspend a
// backgrounded PWA's service worker mid-request; when it wakes to
// resume that request, or the request itself is simply slow to settle,
// event.respondWith()'s promise is what the page's own fetch() is
// ultimately waiting on — a page-side AbortController racing against
// this same request isn't guaranteed to unstick it (the abort signal
// has to travel through the SW's own fetch machinery, an extra hop
// with more room for a platform quirk to swallow it). Bounding it here,
// at the source, means this promise always settles on its own terms
// regardless of whether that outer signal ever arrives.
function fetchBounded(request, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

/* ── FETCH: network-first for app files, cache-first for assets ── */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Always network-first: Supabase API, Netlify functions, app JS/HTML/CSS
  const alwaysNetwork =
    url.hostname.includes('supabase.co') ||
    url.pathname.startsWith('/.netlify/') ||
    NEVER_CACHE.includes(url.pathname) ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.html');

  if (alwaysNetwork) {
    event.respondWith(
      fetchBounded(request, 8000).catch(() => {
        // Offline fallback for navigation
        if (request.mode === 'navigate') {
          return caches.match('/index.html');
        }
        return new Response('Offline', { status: 503 });
      })
    );
    return;
  }

  // Cache-first for icons, fonts, images
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (request.method === 'GET' && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      }).catch(() => new Response('Offline', { status: 503 }));
    })
  );
});

/* ── PUSH: show notification ─────────────────────────────── */
self.addEventListener('push', event => {
  let data = { title: 'fitl00p', body: 'You have a new notification.' };
  if (event.data) {
    try { data = event.data.json(); } catch {}
  }

  const options = {
    body:    data.body,
    icon:    '/icon-192.png',
    badge:   '/icon-192.png',
    vibrate: [100, 50, 100],
    data:    { url: data.url || '/' },
    actions: data.actions || [],
    tag:     data.tag || 'fitl00p-notification',
    renotify: true,
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'fitl00p', options)
  );
});

/* ── NOTIFICATION CLICK: focus or open app ───────────────── */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // If app is already open, focus it
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new window
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
