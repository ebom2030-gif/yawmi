// يومي | Yawmi — service worker v2: أحدث نسخة دايماً، والنسخة المحفوظة لو النت بطيء أو مقطوع
const V = 'yawmi-v3', FONTS = 'yawmi-fonts';
const SHELL = ['./', './manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V && k !== FONTS).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return; // طلبات البيانات (POST) لا تُخزَّن أبداً
  const u = new URL(r.url);
  if (u.origin === location.origin && r.mode === 'navigate') {
    const net = fetch(r.url.split('?')[0], { cache: 'no-store' });
    e.waitUntil(net.then(res => { if (res.ok) { const cp = res.clone(); return caches.open(V).then(c => c.put('./', cp)); } }).catch(() => {}));
    const slow = new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 1800));
    e.respondWith(Promise.race([net.then(res => res.ok ? res : Promise.reject(new Error('bad'))), slow])
      .catch(() => caches.open(V).then(c => c.match('./')).then(m => m || net)));
    return;
  }
  if (u.origin === location.origin && u.searchParams.has('vc')) { e.respondWith(fetch(r, { cache: 'no-store' })); return; } // فحص التحديثات: من النت دايماً
  if (u.origin === location.origin) {
    e.respondWith(caches.open(V).then(async c => { const m = await c.match(r, { ignoreSearch: true }); const n = fetch(r).then(res => { if (res.ok) c.put(r, res.clone()); return res; }); if (m) { e.waitUntil(n.catch(() => {})); return m; } return n; }));
    return;
  }
  if (u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(async c => { const m = await c.match(r); if (m) return m; const res = await fetch(r); if (res.ok || res.type === 'opaque') c.put(r, res.clone()); return res; }));
  }
});
