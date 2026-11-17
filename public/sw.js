/* Service Worker: Offline-Hülle + Push-Benachrichtigungen */
const CACHE = 'familie-v3';
const SHELL = [
  './', 'index.html', 'app.css', 'app.js', 'config.js', 'vendor/supabase.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'img/trainer-m.png', 'img/trainer-w.png', 'img/egg.png', 'fonts/pokemon-ds.woff2', 'fonts/pokemon-solid.woff2',
];

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

// Netzwerk zuerst, bei Offline aus dem Cache. Nur eigene Dateien, keine Supabase-Aufrufe.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'Familie', body: e.data && e.data.text() }; }
  e.waitUntil(
    self.registration.showNotification(data.title || 'Neues im Austausch', {
      body: data.body || '',
      tag: data.tag,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      data: { url: new URL(data.url || '?tab=austausch', self.registration.scope).href, id: data.tag },
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
      const win = wins.find((w) => w.url.startsWith(self.registration.scope));
      if (win) {
        win.postMessage({ type: 'open-message', id });
        return win.focus();
      }
      return self.clients.openWindow(url || self.registration.scope);
    })
  );
});
