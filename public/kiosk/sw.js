// Service worker: guarda a "casca" do quiosque para abrir mesmo sem internet.
// As chamadas de API nunca são cacheadas aqui (a fila offline fica no kiosk.js).
const CACHE = 'kiosk-v2';
const SHELL = ['/kiosk/', '/kiosk/index.html', '/kiosk/kiosk.css', '/kiosk/kiosk.js', '/kiosk/icon.svg', '/kiosk/manifest.webmanifest', '/shared/icons.js'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/kiosk/') || url.pathname.startsWith('/shared/') || url.pathname === '/favicon' || url.pathname === '/apple-touch-icon.png') {
    // rede primeiro (pega atualizações), cache como reserva
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request)));
  } else if (url.pathname.startsWith('/media/')) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
      if (r.ok && r.status === 200) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    })));
  }
});
