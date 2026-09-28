// يومي | Yawmi — service worker: يفتح الواجهة فوراً من الجهاز ويحدّثها في الخلفية
const V = 'yawmi-v1', FONTS = 'yawmi-fonts';
const SHELL = ['./', './manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V && k !== FONTS).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
async function shell(e) {
  const c = await caches.open(V); const cached = await c.match('./');
  const net = fetch(e.request.url.split('?')[0], { cache: 'no-cache' }).then(async res => {
    if (res.ok && res.type === 'basic') {
      const txt = await res.clone().text(); const old = cached ? await cached.clone().text() : null;
      await c.put('./', res.clone());
      if (old !== null && old !== txt) (await self.clients.matchAll({ type: 'window' })).forEach(w => w.postMessage('yawmi-updated'));
    }
    return res;
  });
  if (cached) { e.waitUntil(net.catch(() => {})); return cached; }
  return net;
}
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return; // طلبات البيانات (POST) لا تُخزَّن أبداً
  const u = new URL(r.url);
  if (u.origin === location.origin) {
    if (r.mode === 'navigate') { e.respondWith(shell(e)); return; }
    e.respondWith(caches.open(V).then(async c => { const m = await c.match(r, { ignoreSearch: true }); const n = fetch(r).then(res => { if (res.ok) c.put(r, res.clone()); return res; }); if (m) { e.waitUntil(n.catch(() => {})); return m; } return n; }));
    return;
  }
  if (u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(async c => { const m = await c.match(r); if (m) return m; const res = await fetch(r); if (res.ok || res.type === 'opaque') c.put(r, res.clone()); return res; }));
  }
});
