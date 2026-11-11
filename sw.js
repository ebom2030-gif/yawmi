// يومي | Yawmi — service worker v2: أحدث نسخة دايماً، والنسخة المحفوظة لو النت بطيء أو مقطوع
const V = 'yawmi-v259-99911e1d3e', FONTS = 'yawmi-fonts';
const SHELL = ['./', './manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(async c => { await c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })));
  // v112: تخزين ملفات البرنامج مسبقاً ليعمل بدون إنترنت من أول مرة
  try { const h = await (await c.match('./')).text(); const A = [...new Set((h.match(/assets\/(?:app\.(?:js|css)|yawmi-ui\.css)\?v=[\w.-]+/g) || []))].map(u => './' + u); await Promise.all(A.map(u => fetch(u).then(r => r.ok && c.put(u, r)).catch(() => {}))); } catch (x) {} }).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V && k !== FONTS).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return; // طلبات البيانات (POST) لا تُخزَّن أبداً
  const u = new URL(r.url);
  if (u.origin === location.origin && r.mode === 'navigate' && (u.pathname === '/' || u.pathname.endsWith('/index.html'))) {
    // v246: الفتح فوري من النسخة المحفوظة، وتُحدَّث النسخة في الخلفية (فحص الإصدار داخل البرنامج يعرض التحديث فور توفره)
    const net = fetch(r.url.split('?')[0], { cache: 'no-store' });
    e.waitUntil(net.then(res => { if (res.ok) { const cp = res.clone(); return caches.open(V).then(c => c.put('./', cp)); } }).catch(() => {}));
    e.respondWith(caches.open(V).then(c => c.match('./')).then(m => m || net.then(res => res.ok ? res : Promise.reject(new Error('bad')))).catch(() => net));
    return;
  }
  if (u.origin === location.origin && u.pathname.indexOf('/api') === 0) return; // طلبات الخادم لا تُخزَّن أبداً
  if (u.origin === location.origin && u.searchParams.has('vc')) { e.respondWith(fetch(r, { cache: 'no-store' })); return; } // فحص التحديثات: من النت دايماً
  if (u.origin === location.origin && (u.pathname.endsWith('/assets/app.js') || u.pathname.endsWith('/assets/yawmi-ui.css')) && /^v\d+-[a-f0-9]{10}$/.test(u.searchParams.get('v') || '')) {
    // v246: مع الاتصال يقرأ المتصفح الملف من ذاكرته مباشرة (أسرع بكثير من قراءته عبر عامل الخدمة)؛ النسخة المحفوظة للعمل دون اتصال فقط.
    if (navigator.onLine) { e.waitUntil(caches.open(V).then(async c => { if (!(await c.match(r))) { const res = await fetch(r); if (res.ok) await c.put(r, res); } }).catch(() => {})); return; }
    // البناء ذو البصمة يُقرأ بمفتاحه المطابق فقط؛ البصمة الجديدة تطلب الملف الجديد.
    e.respondWith(caches.open(V).then(async c => {
      const saved = await c.match(r);
      if (saved) return saved;
      const res = await fetch(r);
      if (res.ok) await c.put(r, res.clone());
      return res;
    }));
    return;
  }
  if (u.origin === location.origin && (u.pathname.endsWith('/assets/app.js') || u.pathname.endsWith('/assets/yawmi-ui.css'))) { // الروابط القديمة دون بصمة تبقى من الشبكة أولاً.
    e.respondWith(fetch(r, { cache: 'no-cache' }).then(res => { if (res.ok) { const cp = res.clone(); caches.open(V).then(c => c.put(r, cp)); } return res; }).catch(() => caches.open(V).then(c => c.match(r, { ignoreSearch: true })).then(m => m || Response.error())));
    return;
  }
  if (u.origin === location.origin && u.pathname.includes('/assets/')) { // ملفات البرنامج بإصدار في الرابط (?v=): من الذاكرة إن وُجدت بنفس الإصدار، وإلا من النت
    if (navigator.onLine) return; // v246: مع الاتصال ذاكرة المتصفح أسرع
    e.respondWith(caches.open(V).then(async c => { const m = await c.match(r); if (m) return m; const res = await fetch(r); if (res.ok) c.put(r, res.clone()); return res; }));
    return;
  }
  if (u.origin === location.origin) {
    e.respondWith(caches.open(V).then(async c => { const m = await c.match(r, { ignoreSearch: true }); const n = fetch(r).then(res => { if (res.ok) c.put(r, res.clone()); return res; }); if (m) { e.waitUntil(n.catch(() => {})); return m; } return n; }));
    return;
  }
  if (u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(async c => { const m = await c.match(r); if (m) return m; const res = await fetch(r); if (res.ok || res.type === 'opaque') c.put(r, res.clone()); return res; }));
  }
});
