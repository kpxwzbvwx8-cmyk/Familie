/* Service Worker: Offline-Hülle + Push-Benachrichtigungen */
const CACHE = 'familie-v3';
// Zähler am App-Symbol: Stand liegt in einem eigenen Speicher, den auch die App lesen/schreiben kann
const BADGE_CACHE = 'familie-badge';

async function readBadge(key) {
  const c = await caches.open(BADGE_CACHE);
  const r = await c.match(key);
  return r ? r.text() : null;
}
async function writeBadge(n) {
  const c = await caches.open(BADGE_CACHE);
  await c.put('/badge', new Response(String(n)));
  try {
    if (n > 0 && self.navigator.setAppBadge) await self.navigator.setAppBadge(n);
    else if (self.navigator.clearAppBadge) await self.navigator.clearAppBadge();
  } catch { /* nicht unterstützt */ }
}
/** Neue Push-Nachricht, während die App nicht offen ist → Zähler +1 */
async function bumpBadge() {
  if ((await readBadge('/badge-off')) === '1') return;
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (wins.some((w) => w.visibilityState === 'visible')) return;
  const n = Number(await readBadge('/badge')) || 0;
  await writeBadge(n + 1);
}
const SHELL = [
  './', 'index.html', 'app.css', 'app.js', 'config.js', 'vendor/supabase.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'img/trainer-m.png', 'img/trainer-w.png', 'img/egg.png', 'img/speedy.png', 'img/idefix.png', 'img/portrait-m.png', 'img/portrait-w.png', 'img/pokeball.png', 'img/cal-m.png', 'img/cal-w.png', 'img/cal-m-head.png', 'img/cal-w-head.png', 'img/pokeball-wobble.png', 'img/menu/dex.png', 'img/menu/card.png', 'img/menu/ball.png', 'img/menu/save.png', 'img/menu/cal.png', 'img/menu/opt.png', 'img/menu/gear.png', 'img/menu/bike.png', 'img/menu/item.png', 'fonts/pokemon-ds.woff2', 'fonts/pokemon-solid.woff2',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' umgeht den HTTP-Zwischenspeicher, damit wirklich die neue Version gespeichert wird
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== BADGE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Netzwerk zuerst, bei Offline aus dem Cache. Nur eigene Dateien, keine Supabase-Aufrufe.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // cache: 'no-cache' = immer beim Server nachfragen, ob es eine neuere Datei gibt
  e.respondWith(
    fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' })
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
  e.waitUntil(Promise.all([bumpBadge().catch(() => {}),
    self.registration.showNotification(data.title || 'Neues im Austausch', {
      body: data.body || '',
      tag: data.tag,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      data: { url: new URL(data.url || '?tab=austausch', self.registration.scope).href, id: data.tag },
      requireInteraction: data.urgency === 'dringend',
      vibrate: data.urgency === 'dringend' ? [200, 100, 200, 100, 200] : [120],
    })])
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
