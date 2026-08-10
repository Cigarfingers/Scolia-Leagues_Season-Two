const CACHE = 'yardbook-v9';

// This one sw.js file is shared by every yard, but each yard registers it
// with its own scope (/y/:slug/), so self.registration.scope tells us which
// yard this particular installation belongs to — no yard-specific data is
// hardcoded here.
function scopePath() {
  return new URL(self.registration.scope).pathname; // e.g. '/y/joda/'
}

self.addEventListener('install', e => {
  const sp = scopePath(); // e.g. '/y/joda/' — this is the actual page URL now (board route redirects here)
  const assets = [sp, sp + 'manifest.json', '/icon-192.png', '/apple-touch-icon.png', '/header-logo.png'];
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(assets.map(a => c.add(a).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // never cache live booking data

  const isPage = req.mode === 'navigate' || url.pathname.endsWith('.html');
  if (isPage) {
    e.respondWith(
      fetch(req)
        .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; })
        .catch(() => caches.match(req).then(r => r || caches.match(scopePath())))
    );
    return;
  }
  e.respondWith(caches.match(req).then(r => r || fetch(req)));
});

// ── Push notifications ────────────────────────────────────────────────
self.addEventListener('push', e => {
  let data = { title: 'School Booking', body: 'Something changed on the booking board' };
  try { data = { ...data, ...e.data.json() }; } catch (err) {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || undefined,
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = scopePath() || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      for (const c of clients) if ('focus' in c) return c.focus();
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
