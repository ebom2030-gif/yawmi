// يومي — بوابة الخادم على Cloudflare (المرحلة الأولى من النقل)
// كل طلب من الواجهة يمر من هنا إلى خادم Google Apps Script كما هو (Google Sheets ما زال المصدر الأساسي)،
// وفي الخلفية تُنسخ البيانات إلى قاعدة Cloudflare D1 (نسخة مطابقة) تمهيداً للنقل الكامل.
// أي خطأ في النسخ لا يؤثر على الطلب، وإذا تعطلت البوابة ترجع الواجهة تلقائياً للاتصال المباشر بـ Google.
const GAS = 'https://script.google.com/macros/s/AKfycbwgvjkn2Op3hg-sSwxMi3PJO4MmIot0udoa8FXKOGTK9LBjqKuGtqlLYY1FaAkMwnI9/exec';
const FULL_SYNC_MIN = 60; // أقصى تكرار لنسخ البيانات الكاملة لكل مستخدم (دقائق)
const H = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-yw-gw': '1' };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS items (tn TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, owner TEXT, space TEXT, due TEXT, done INTEGER DEFAULT 0, title TEXT, data TEXT NOT NULL, updated_at INTEGER, PRIMARY KEY (tn, id))`,
  `CREATE TABLE IF NOT EXISTS projects (tn TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, name TEXT, status TEXT, space TEXT, data TEXT NOT NULL, updated_at INTEGER, PRIMARY KEY (tn, id))`,
  `CREATE TABLE IF NOT EXISTS contacts (tn TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, name TEXT, cat TEXT, space TEXT, data TEXT NOT NULL, updated_at INTEGER, PRIMARY KEY (tn, id))`,
  `CREATE TABLE IF NOT EXISTS users (tn TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, username TEXT, name TEXT, role TEXT, active INTEGER, data TEXT NOT NULL, updated_at INTEGER, PRIMARY KEY (tn, id))`,
  `CREATE TABLE IF NOT EXISTS notes (tn TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL, date TEXT NOT NULL, text TEXT, updated_at INTEGER, PRIMARY KEY (tn, owner, date))`,
  `CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, data TEXT, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS sess (th TEXT PRIMARY KEY, tn TEXT, uid TEXT, full_at INTEGER, seen_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS sync_log (at INTEGER, tn TEXT, uid TEXT, fn TEXT, ok INTEGER, ms INTEGER, err TEXT)`,
  `CREATE INDEX IF NOT EXISTS items_owner ON items (tn, owner)`,
];
let ready = false;
async function init(db) { if (ready) return; await db.batch(SCHEMA.map(q => db.prepare(q))); ready = true; }
async function sha(s) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); }
const J = v => JSON.stringify(v ?? null);

async function mirror(env, req, res, ms) {
  const db = env.DB; if (!db) return; const { t, fn, args = [] } = req; const now = Date.now();
  try {
    await init(db);
    const th = t ? await sha('yw|' + t) : '';
    if (fn === 'logout') { if (th) await db.prepare('DELETE FROM sess WHERE th = ?').bind(th).run(); return; }
    let s = th ? await db.prepare('SELECT tn, uid, full_at FROM sess WHERE th = ?').bind(th).first() : null;
    const S = [];
    if (fn === 'getAll' && res && res.me) {
      const tn = (res.ten && res.ten.id) || '', uid = res.me.id;
      S.push(db.prepare('INSERT INTO sess (th, tn, uid, full_at, seen_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(th) DO UPDATE SET tn = excluded.tn, uid = excluded.uid, seen_at = excluded.seen_at').bind(th, tn, uid, s ? s.full_at || 0 : 0, now));
      if (!s || !s.full_at || now - s.full_at > FULL_SYNC_MIN * 60000) {
        S.push(db.prepare('UPDATE sess SET full_at = ? WHERE th = ?').bind(now, th));
        if (res.ten) S.push(db.prepare('INSERT INTO tenants (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at WHERE tenants.data IS NOT excluded.data').bind(tn, J(res.ten), now));
        (res.items || []).forEach(o => o && o.id && S.push(upItem(db, tn, o, now)));
        (res.projects || []).filter(p => p && p.id && !p._nofin).forEach(p => S.push(upProj(db, tn, p, now)));
        (res.contacts || []).forEach(c => c && c.id && S.push(upCont(db, tn, c, now)));
        (res.users || []).forEach(u => u && u.id && S.push(db.prepare('INSERT INTO users (tn, id, username, name, role, active, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tn, id) DO UPDATE SET username = excluded.username, name = excluded.name, role = excluded.role, active = excluded.active, data = excluded.data, updated_at = excluded.updated_at WHERE users.data IS NOT excluded.data')
          .bind(tn, u.id, u.username || '', u.name || '', u.role || '', u.active === false ? 0 : 1, J(u), now)));
        Object.entries(res.notes || {}).forEach(([d, x]) => S.push(upNote(db, tn, uid, d, x, now)));
      }
    } else if (s) {
      const tn = s.tn || '';
      if (fn === 'saveItem' && args[0] && args[0].id) S.push(upItem(db, tn, args[0], now));
      else if (fn === 'deleteItem' && args[0]) S.push(db.prepare('DELETE FROM items WHERE tn = ? AND id = ?').bind(tn, String(args[0])));
      else if (fn === 'saveProject' && args[0] && args[0].id && !args[0]._nofin) S.push(upProj(db, tn, Object.assign({}, args[0], { updatedAt: (res && res.updatedAt) || now }), now));
      else if (fn === 'deleteProject' && args[0]) S.push(db.prepare('DELETE FROM projects WHERE tn = ? AND id = ?').bind(tn, String(args[0])));
      else if (fn === 'saveContact' && args[0] && args[0].id) S.push(upCont(db, tn, args[0], now));
      else if (fn === 'deleteContact' && args[0]) S.push(db.prepare('DELETE FROM contacts WHERE tn = ? AND id = ?').bind(tn, String(args[0])));
      else if (fn === 'saveNote' && args[0]) S.push(upNote(db, tn, s.uid, String(args[0]), args[1], now));
    }
    if (!S.length) return;
    S.push(db.prepare('INSERT INTO sync_log (at, tn, uid, fn, ok, ms, err) VALUES (?, ?, ?, ?, 1, ?, NULL)').bind(now, s ? s.tn : (res && res.ten && res.ten.id) || '', s ? s.uid : (res && res.me && res.me.id) || '', fn, ms));
    for (let i = 0; i < S.length; i += 90) await db.batch(S.slice(i, i + 90));
  } catch (e) { try { await db.prepare('INSERT INTO sync_log (at, tn, uid, fn, ok, ms, err) VALUES (?, ?, ?, ?, 0, ?, ?)').bind(now, '', '', fn, ms, String(e && e.message || e).slice(0, 400)).run(); } catch (x) {} }
}
const upItem = (db, tn, o, now) => db.prepare('INSERT INTO items (tn, id, owner, space, due, done, title, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tn, id) DO UPDATE SET owner = excluded.owner, space = excluded.space, due = excluded.due, done = excluded.done, title = excluded.title, data = excluded.data, updated_at = excluded.updated_at WHERE items.data IS NOT excluded.data')
  .bind(tn, String(o.id), o.owner || '', o.space || '', o.due || '', o.done ? 1 : 0, String(o.title || '').slice(0, 300), J(o), now);
const upProj = (db, tn, p, now) => db.prepare('INSERT INTO projects (tn, id, name, status, space, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tn, id) DO UPDATE SET name = excluded.name, status = excluded.status, space = excluded.space, data = excluded.data, updated_at = excluded.updated_at WHERE projects.data IS NOT excluded.data')
  .bind(tn, String(p.id), p.name || '', p.status || '', p.space || '', J(p), now);
const upCont = (db, tn, c, now) => db.prepare('INSERT INTO contacts (tn, id, name, cat, space, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tn, id) DO UPDATE SET name = excluded.name, cat = excluded.cat, space = excluded.space, data = excluded.data, updated_at = excluded.updated_at WHERE contacts.data IS NOT excluded.data')
  .bind(tn, String(c.id), c.name || '', c.cat || '', c.space || '', J(c), now);
const upNote = (db, tn, uid, d, x, now) => db.prepare('INSERT INTO notes (tn, owner, date, text, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tn, owner, date) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at WHERE notes.text IS NOT excluded.text').bind(tn, uid || '', d, String(x ?? ''), now);

export async function onRequestPost({ request, env, waitUntil }) {
  const body = await request.text(); const t0 = Date.now();
  let r;
  try { r = await fetch(env.GAS_URL || GAS, { method: 'POST', body, redirect: 'follow', headers: { 'content-type': 'text/plain;charset=utf-8' } }); }
  catch (e) { return new Response(J({ ok: false, error: 'تعذّر الاتصال بالخادم — حاول مرة أخرى' }), { status: 502, headers: H }); }
  const text = await r.text();
  if (!r.ok || text.charAt(0) !== '{') return new Response(J({ ok: false, error: 'خطأ في الاتصال بالخادم (' + r.status + ')' }), { status: 502, headers: H });
  if (env.DB) waitUntil((async () => { let req, out; try { req = JSON.parse(body); out = JSON.parse(text); } catch (e) { return; } if (out && out.ok) await mirror(env, req, out.data, Date.now() - t0); })());
  return new Response(text, { headers: H });
}
export async function onRequestGet({ request, env }) { // حالة البوابة؛ الأعداد تظهر فقط لمستخدم مسجّل (?t=رمز الجلسة) وتخص مساحته
  const o = { ok: true, gateway: true, d1: !!env.DB }; const t = new URL(request.url).searchParams.get('t');
  if (env.DB) { try { await init(env.DB); o.lastSync = (await env.DB.prepare('SELECT MAX(at) n FROM sync_log WHERE ok = 1').first()).n;
    const s = t ? await env.DB.prepare('SELECT tn FROM sess WHERE th = ?').bind(await sha('yw|' + t)).first() : null;
    if (s) { const c = async q => (await env.DB.prepare(q).bind(s.tn).first()).n;
      Object.assign(o, { items: await c('SELECT COUNT(*) n FROM items WHERE tn = ?'), projects: await c('SELECT COUNT(*) n FROM projects WHERE tn = ?'), contacts: await c('SELECT COUNT(*) n FROM contacts WHERE tn = ?'), users: await c('SELECT COUNT(*) n FROM users WHERE tn = ?'), errors24h: (await env.DB.prepare('SELECT COUNT(*) n FROM sync_log WHERE ok = 0 AND at > ?').bind(Date.now() - 864e5).first()).n }); } } catch (e) { o.err = String(e.message || e); } }
  return new Response(J(o), { headers: H });
}
