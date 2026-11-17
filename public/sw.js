/* Service Worker: Offline-Hülle + Push-Benachrichtigungen */
const CACHE = 'familie-v2';
const SHELL = ['/', '/index.html', '/app.css', '/app.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/img/trainer-m.png', '/img/trainer-w.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Netzwerk zuerst, bei Offline aus dem Cache. API wird nie gecacht.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html')))
  );
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'Familie', body: e.data && e.data.text() }; }
  e.waitUntil(
    self.registration.showNotification(data.title || 'Neues im Austausch', {
      body: data.body || '',
      tag: data.tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: data.url || '/?tab=austausch', id: data.tag },
      requireInteraction: data.urgency === 'dringend',
      vibrate: data.urgency === 'dringend' ? [200, 100, 200, 100, 200] : [120],
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const { url, id } = e.notification.data || {};
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const win = wins.find((w) => new URL(w.url).origin === location.origin);
      if (win) {
        win.postMessage({ type: 'open-message', id });
        return win.focus();
      }
      return self.clients.openWindow(url || '/');
    })
  );
});
