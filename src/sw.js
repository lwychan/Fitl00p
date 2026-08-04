/* ═══════════════════════════════════════════════════════════
   fitl00p — Service Worker
   Cache-first for static assets, network-first for API calls.
   Handles incoming push notifications.
   ═══════════════════════════════════════════════════════════ */

const CACHE_NAME    = 'fitl00p-v3';
const NEVER_CACHE   = ['/app.js', '/app.css', '/index.html', '/', '/diabetes-engine.js', '/nightscout-adapter.js'];

// Absolute last-resort shell for a failed navigation with nothing cached
// yet — self-contained (no dependency on app.js/app.css, which are
// likely also failing in this exact scenario) so a reload always has
// something to actually click, instead of a bare browser error page.
const OFFLINE_SHELL_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>fitl00p</title></head>
<body style="display:flex;align-items:center;justify-content:center;min-height:100dvh;margin:0;
             font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:24px;text-align:center;
             background:#111318;color:#F0F2F7">
  <div>
    <div style="font-size:32px;margin-bottom:12px">📡</div>
    <p style="font-size:17px;font-weight:600;margin-bottom:8px">fitl00p couldn't connect</p>
    <p style="font-size:14px;color:#888;max-width:320px;line-height:1.5">
      Couldn't reach the server on this first attempt. Check your connection and try again.
    </p>
    <button onclick="location.reload()" style="margin-top:16px;padding:10px 22px;border:none;
            border-radius:10px;background:#C6FF00;color:#111318;font-weight:700;font-size:15px">Retry</button>
  </div>
</body></html>`;
const STATIC_ASSETS = [
  '/sw.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];
// index.html is deliberately excluded from NEVER_CACHE's fetch routing
// (always network-first, never served cache-first) — but it's still
// pre-cached here so the navigate-fallback below has something real to
// serve. Without this, a timed-out/offline navigation would call
// caches.match('/index.html') against an entry that was never written,
// getting back `undefined` — an invalid respondWith() value that the
// browser treats as an outright network error for the whole page load.
// That skips index.html's own static #screenBoot markup and every bit
// of app.js's boot-retry/connectivity-error UI, since none of it ever
// gets a chance to run — exactly the "app just won't open, no error
// shown" failure mode, as opposed to the boot screen's own (working)
// "couldn't connect" retry path.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return Promise.allSettled(
        [...STATIC_ASSETS, '/index.html'].map(url => cache.add(url).catch(() => {}))
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

  // Always network-first: Supabase API, Netlify functions, app JS/HTML/CSS.
  // The .js/.css/.html rule is scoped to same-origin on purpose — it's
  // there so a deploy's own updated app.js/app.css always wins over a
  // stale cache, not to force-refetch a third-party CDN script (e.g.
  // ZXing's barcode-scan fallback, see index.html) on every single load.
  // Those are pinned to an exact version and effectively immutable, so
  // they fall through to the cache-first branch below instead — cached
  // once, instant and offline-safe after that.
  const sameOrigin = url.origin === self.location.origin;
  const alwaysNetwork =
    url.hostname.includes('supabase.co') ||
    url.pathname.startsWith('/.netlify/') ||
    NEVER_CACHE.includes(url.pathname) ||
    (sameOrigin && (url.pathname.endsWith('.js') || url.pathname.endsWith('.css') || url.pathname.endsWith('.html')));

  if (alwaysNetwork) {
    event.respondWith(
      fetchBounded(request, 8000).catch(err => {
        // Offline fallback for navigation — cached index.html first (see
        // the install handler above for why it's cached at all despite
        // being network-first), but never allowed to resolve to
        // `undefined` even if that cache lookup itself comes up empty
        // (e.g. the very first visit, mid-install). An invalid
        // respondWith() value is a hard navigation failure with zero
        // page content — this inline fallback guarantees something
        // real always renders, with its own reload button independent
        // of app.js in case that's failing to load too.
        if (request.mode === 'navigate') {
          return caches.match('/index.html').then(cached => cached || new Response(OFFLINE_SHELL_HTML, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }));
        }
        // Everything else — Supabase API calls, Netlify functions, JS/CSS —
        // re-throws the real fetch failure instead of synthesizing a flat
        // "Offline" 503. supabase-js surfaces that response body directly
        // as error.message, so a save that failed only because this 8s
        // bound tripped (e.g. a slow connection, not a truly offline
        // device) showed up as "Couldn't save: Offline" — misleading the
        // user into thinking their device had no connection at all, and
        // masking whatever the actual network error was.
        throw err;
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
