// Network first for the app shell (always fresh when online), cache as fallback offline.
// API calls are never cached here; the app keeps its own last-known copy for offline viewing.
const CACHE = 'mep-shell';
const SHELL = ['/', '/index.html', '/app.css', '/app.js', '/i18n.js', '/engine.js', '/parse.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/apple-touch-icon.png', '/vendor/zxing.min.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('/index.html'))));
});
