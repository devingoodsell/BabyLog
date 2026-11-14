// Keeps the app opening when the connection is poor or GitHub has an outage, and shows reminder
// notifications. Tries the network first so updates show up right away, but after 3 seconds uses
// the saved copy. Never touches requests to the Google Sheet.
const CACHE = 'babylog-v11';
const SHELL = ['./', 'index.html', 'app.js', 'config.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/apple-touch-icon.png',
  'fonts/nunito-latin-400-normal.woff2', 'fonts/nunito-latin-600-normal.woff2',
  'fonts/nunito-latin-700-normal.woff2', 'fonts/nunito-latin-800-normal.woff2'];
const NETWORK_WAIT = 3000;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// After the page itself had to fall back to the saved copy, its other files do the same at once
// for a little while, instead of each waiting out the slow network again.
let slowUntil = 0;
const STATIC = /\/(fonts|icons)\//;   // these rarely change: saved copy first, refreshed in the background
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // The saved copy of this file; for a page load, the saved app page if this exact address is not saved
  const saved = () => caches.match(e.request, { ignoreSearch: true }).then(r => r || (e.request.mode === 'navigate' ? caches.match('./') : undefined));
  // Only a good answer replaces the saved copy. If GitHub is down or returns an error page
  // (for example its "unicorn" 5xx page), keep showing the last good copy instead.
  const fromNetwork = fetch(e.request).then(res => {
    if (!res.ok) return saved().then(r => r || res);
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(e.request, copy));
    return res;
  }, saved);
  e.waitUntil(fromNetwork.catch(() => {}));
  const wait = STATIC.test(url.pathname) || (e.request.mode !== 'navigate' && Date.now() < slowUntil) ? 0 : NETWORK_WAIT;
  // A slow network: after a few seconds show the saved copy; the download still refreshes it
  const slow = new Promise(resolve => setTimeout(resolve, wait)).then(saved).then(r => {
    if (r && e.request.mode === 'navigate') slowUntil = Date.now() + 30000;
    return r || fromNetwork;
  });
  e.respondWith(Promise.race([fromNetwork, slow]));
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
