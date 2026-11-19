// Opens the app instantly from the copy saved on the phone (even offline or when GitHub is down),
// downloads a fresh copy in the background for next time, and shows reminder notifications.
// Never touches requests to the Google Sheet.
// A new release changes CACHE below: the phone then saves the whole new version, switches to it,
// and the app reloads itself at a quiet moment (see app.js).
const CACHE = 'babylog-v14';
const SHELL = ['./', 'index.html', 'app.js', 'config.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/apple-touch-icon.png',
  'fonts/nunito-latin-400-normal.woff2', 'fonts/nunito-latin-600-normal.woff2',
  'fonts/nunito-latin-700-normal.woff2', 'fonts/nunito-latin-800-normal.woff2'];

self.addEventListener('install', e => {
  // cache: 'reload' skips the browser's own HTTP cache, so the new version is saved, not a stale one
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // The saved copy of this file; for a page load, the saved app page if this exact address is not saved
  const saved = () => caches.match(e.request, { ignoreSearch: true }).then(r => r || (e.request.mode === 'navigate' ? caches.match('./') : undefined));
  // Only a good answer replaces the saved copy. If GitHub is down or returns an error page
  // (for example its "unicorn" 5xx page), the last good copy stays.
  const fromNetwork = fetch(e.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  });
  e.waitUntil(fromNetwork.catch(() => {}));
  e.respondWith(saved().then(r => r || fromNetwork.then(res => (res.ok ? res : saved().then(s => s || res)))));
});

// Reminder notifications (see "Reminders" in the README)
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Baby Log', {
    body: d.body || '', tag: d.tag || 'baby-log', renotify: true,
    icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { tag: d.tag || '' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const tag = (e.notification.data && e.notification.data.tag) || '';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => new URL(c.url).origin === self.location.origin);
    if (open) { open.postMessage({ type: 'notification', tag: tag }); return open.focus(); }
    return self.clients.openWindow('./');
  }));
});
