/* FrogTalk Service Worker — caching + web push */
const CACHE_NAME = 'frogtalk-v193';
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

// ── Activate: delete ALL caches then claim clients ───────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: network-first for everything ──────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-same-origin and WebSocket requests
  if (url.origin !== location.origin) return;
  if (event.request.url.includes('/ws/')) return;

  // Always fetch fresh app shell and JS to avoid stale UI after deployments.
  if (
    url.pathname === '/app' ||
    url.pathname.startsWith('/app/') ||
    url.pathname === '/static/index.html' ||
    url.pathname.startsWith('/static/js/')
  ) {
    event.respondWith(fetch(event.request));
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
    if (isCall) {
      opts.actions = [
        { action: 'accept', title: '✅ Accept' },
        { action: 'reject', title: '❌ Decline' },
      ];
    }
    return self.registration.showNotification(data.title, opts);
  })());
});

// ── NotificationClick: focus or open /app ────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const d = event.notification.data || {};
  const action = event.action || '';
  const baseUrl = d.url || '/app';
  // For call actions, attach intent so the page auto-accepts/rejects on focus
  let url = baseUrl;
  if (d.kind === 'call' && d.call_id) {
    const tag = action === 'reject' ? 'ftCallReject' : 'ftCallAccept';
    url = `${baseUrl}#${tag}=${encodeURIComponent(d.call_id)}&from=${encodeURIComponent(d.from_nickname||'')}`;
  }
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const win of wins) {
      if (win.url.includes(self.location.origin)) {
        try { win.focus(); } catch {}
        // Nudge page with intent
        try { win.postMessage({ type: 'ft-call-action', action: action || 'accept', call_id: d.call_id, from_nickname: d.from_nickname }); } catch {}
        return;
      }
    }
    return self.clients.openWindow(url);
  })());
});
