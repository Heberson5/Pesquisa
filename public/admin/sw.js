// Service worker do painel: guarda a "casca" para abrir como aplicativo.
// As chamadas de API NUNCA são guardadas (dados sempre vêm do servidor).
const CACHE = 'painel-v1';
const SHELL = ['/admin/', '/admin/admin.css', '/admin/admin.js', '/admin/pwa.js', '/admin/icon-192.png', '/shared/icons.js'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/admin/') || url.pathname.startsWith('/shared/')) {
    // rede primeiro (sempre a versão mais nova); cache só como reserva sem internet
    e.respondWith(fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('/admin/'))));
  }
});
