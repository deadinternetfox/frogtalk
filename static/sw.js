/* FrogTalk Service Worker — caching + web push */
const CACHE_NAME = 'frogtalk-v596';
const STATIC_ASSETS = [
  '/app',
  '/static/js/app.js',
  '/static/js/state.js',
  '/static/js/ui.js',
  '/static/js/ws.js',
  '/static/js/crypto.js',
  '/static/js/rooms.js',
  '/static/js/messages.js',
  '/static/js/users.js',
  '/static/js/emoji.js',
  '/static/js/friends.js',
  '/static/js/dms.js',
  '/static/js/calls.js',
  '/static/js/media.js',
  '/static/js/notifications.js',
  '/static/js/music.js',
  '/static/icons/icon-192.png',
  '/manifest.json',
];

// ── Install: skip waiting immediately ────────────────────────────────────────
self.addEventListener('install', event => {
  self.skipWaiting();
});

// ── Activate: delete ONLY stale caches then claim clients ───────────────────
// Previously this wiped every cache on activate, forcing every client to
// re-download ~1MB of assets on each deploy. Now we keep the current
// CACHE_NAME and only purge older versions.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: network-first for everything ──────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-same-origin and WebSocket requests
  if (url.origin !== location.origin) return;
  if (event.request.url.includes('/ws/')) return;

  // Skip uploads and POSTs entirely so the browser can fire real
  // xhr.upload.onprogress events and stream large bodies natively.
  // Story / media uploads, login, send-message, etc — none of these
  // benefit from SW caching and SW interception breaks XHR progress
  // events on Android WebView.
  if (event.request.method && event.request.method !== 'GET' && event.request.method !== 'HEAD') {
    return;
  }
  if (
    url.pathname.startsWith('/api/social/stories') ||
    url.pathname.startsWith('/api/upload') ||
    url.pathname.includes('/upload')
  ) {
    return;
  }

  // Always fetch fresh app shell and JS to avoid stale UI after deployments.
  if (
    url.pathname === '/app' ||
    url.pathname.startsWith('/app/') ||
    url.pathname === '/static/index.html' ||
    url.pathname.startsWith('/static/js/')
  ) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
    return;
  }

  // Admin / board pages: bypass the SW entirely so the upstream
  // Cache-Control: no-store headers from FastAPI (/server) and PHP
  // (/board, /board/admin) are honoured. Without this the SW kept
  // serving the previous render after a deploy, making CSS/HTML
  // changes invisible until the next sw.js bump.
  if (
    url.pathname === '/server' ||
    url.pathname.startsWith('/server/') ||
    url.pathname === '/board' ||
    url.pathname.startsWith('/board/')
  ) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
    return;
  }

  // Network-first: try network, fallback to cache
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cache successful responses
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// ── Push: show notification ───────────────────────────────────────────────────
self.addEventListener('push', event => {
  let data = { title: 'FrogTalk', body: 'New message', url: '/app', icon: '/static/icons/icon-192.png' };
  try {
    data = { ...data, ...event.data.json() };
  } catch { /* malformed payload, use defaults */ }

  // If the app is already focused AND visible, the in-page code is already
  // handling this event (message/call ringtone). Skip the OS notification so
  // the user isn't spammed with duplicates.
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const focused = wins.some(w => w.focused && w.visibilityState === 'visible');
    if (focused && data.kind !== 'call') return;

    const isCall = data.kind === 'call';
    const opts = {
      body:    data.body,
      icon:    data.icon,
      badge:   '/static/icons/icon-96.png',
      data:    { url: data.url, ...data },
      vibrate: isCall ? [400, 200, 400, 200, 400, 200, 400] : [200, 100, 200],
      tag:     data.tag || (isCall ? 'frogtalk-call' : 'frogtalk-msg'),
      renotify: true,
      requireInteraction: !!data.requireInteraction || isCall,
      silent: false,
    };
    // Calls intentionally have NO action buttons. Tapping the notification
    // just opens/focuses the app, where the in-page #incoming-call popup
    // (driven by the WS call_offer event) is the single source of truth
    // for Accept/Decline. OS-level buttons proved unreliable: the page
    // they nudged could miss the WS offer (cold start race) and end up
    // "accepting" with no peer connection, leaving the caller hanging.
    return self.registration.showNotification(data.title, opts);
  })());
});

// ── NotificationClick: focus or open /app ────────────────────────────────────
// All notifications (calls included) just open / focus the app. The page's
// existing handlers (WS call_offer drives #incoming-call; message tap routes
// to room) take it from there.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const d = event.notification.data || {};
  const url = d.url || '/app';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const win of wins) {
      if (win.url.includes(self.location.origin)) {
        try { win.focus(); } catch {}
        return;
      }
    }
    return self.clients.openWindow(url);
  })());
});
