/* ═══════════════════════════════════════════════════════════
   fitl00p — Service Worker
   Cache-first for static assets, network-first for API calls.
   Handles incoming push notifications.
   ═══════════════════════════════════════════════════════════ */

const CACHE_NAME    = 'fitl00p-v2';
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
      fetch(request).catch(() => {
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
