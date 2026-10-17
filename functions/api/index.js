// D1: yawmi-db (5951d5bd-9a48-4415-a0c4-6f02c0eb5d4d) مربوطة باسم DB في إعدادات مشروع yawmi-dmc
// يومي — خادم Cloudflare (المرحلة 3: البيانات في D1، والدخول في Google)
// • الدخول وكلمات المرور والمستخدمين تبقى في Google Apps Script (لا تخرج منه أي أسرار).
// • عند تفعيل «الوضع الأصلي» لمساحة العمل (cfg native:<tn> = 1) وللمالك فقط: تحميل البيانات والحفظ والحذف
//   تتم في D1 مباشرة (أجزاء من الثانية)، وتُرسل نسخة كل تعديل إلى Google بالترتيب في الخلفية (outbox)
//   حتى يبقى Google Sheets والتقويم وTo Do والملخص الصباحي محدّثاً، وتُراجَع البيانات مع Google دورياً.
// • غير ذلك: تمرير الطلب إلى Google كما هو مع نسخة مطابقة في D1.
const GAS = 'https://script.google.com/macros/s/AKfycbwgvjkn2Op3hg-sSwxMi3PJO4MmIot0udoa8FXKOGTK9LBjqKuGtqlLYY1FaAkMwnI9/exec';
const FULL_SYNC_MIN = 60, RECONCILE_MIN = 10, KEEPALIVE_MIN = 20, IDLE = 30 * 60000, PRIV_MIN = 15;
const H = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-yw-gw': '1' };
const J = v => JSON.stringify(v ?? null);
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS items (tn TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, owner TEXT, space TEXT, due TEXT, done INTEGER DEFAULT 0, title TEXT, data TEXT NOT NULL, updated_at INTEGER, PRIMARY KEY (tn, id))`,
  `CREATE TABLE IF NOT EXISTS projects (tn TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, name TEXT, status TEXT, space TEXT, data TEXT NOT NULL, updated_at INTEGER, PRIMARY KEY (tn, id))`,
  `CREATE TABLE IF NOT EXISTS contacts (tn TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, name TEXT, cat TEXT, space TEXT, data TEXT NOT NULL, updated_at INTEGER, PRIMARY KEY (tn, id))`,
  `CREATE TABLE IF NOT EXISTS users (tn TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, username TEXT, name TEXT, role TEXT, active INTEGER, data TEXT NOT NULL, updated_at INTEGER, PRIMARY KEY (tn, id))`,
  `CREATE TABLE IF NOT EXISTS notes (tn TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL, date TEXT NOT NULL, text TEXT, updated_at INTEGER, PRIMARY KEY (tn, owner, date))`,
  `CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, data TEXT, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS sess (th TEXT PRIMARY KEY, tn TEXT, uid TEXT, full_at INTEGER, seen_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS ss (th TEXT PRIMARY KEY, t TEXT, tn TEXT, uid TEXT, me TEXT, users TEXT, ten TEXT, plat INTEGER, pin INTEGER, pv INTEGER, seen INTEGER, gas_at INTEGER, rec_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS cfg (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, tn TEXT, uid TEXT, kind TEXT, rid TEXT, fn TEXT, args TEXT, at INTEGER, tries INTEGER DEFAULT 0, done INTEGER DEFAULT 0, err TEXT)`,
  `CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (done, seq)`,
  `CREATE TABLE IF NOT EXISTS sync_log (at INTEGER, tn TEXT, uid TEXT, fn TEXT, ok INTEGER, ms INTEGER, err TEXT)`,
  `CREATE INDEX IF NOT EXISTS items_owner ON items (tn, owner)`,
];
let ready = false;
async function init(db) { if (ready) return; await db.batch(SCHEMA.map(q => db.prepare(q))); ready = true; }
async function sha(s) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); }
const cfgGet = async (db, k) => { const r = await db.prepare('SELECT v FROM cfg WHERE k = ?').bind(k).first(); return r ? r.v : null; };
const cfgSet = (db, k, v) => db.prepare('INSERT INTO cfg (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, v == null ? null : String(v)).run();
const log = (db, tn, uid, fn, ok, ms, err) => db.prepare('INSERT INTO sync_log (at, tn, uid, fn, ok, ms, err) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(Date.now(), tn || '', uid || '', fn, ok ? 1 : 0, ms || 0, err ? String(err).slice(0, 400) : null).run();
class UErr extends Error {}
const ok = data => new Response(J({ ok: true, data }), { headers: H });
const fail = m => new Response(J({ ok: false, error: m }), { headers: H });

// ---------- الكتابة في جداول D1 (الصفوف المتغيرة فقط) ----------
const upItem = (db, tn, o, now) => db.prepare(`INSERT INTO items (tn, id, owner, space, due, done, title, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tn, id) DO UPDATE SET owner = excluded.owner, space = excluded.space, due = excluded.due, done = excluded.done, title = excluded.title, data = excluded.data, updated_at = excluded.updated_at WHERE items.data IS NOT excluded.data`)
  .bind(tn, String(o.id), o.owner || '', o.space || '', o.due || '', o.done ? 1 : 0, String(o.title || '').slice(0, 300), J(o), now);
const upProj = (db, tn, p, now) => db.prepare(`INSERT INTO projects (tn, id, name, status, space, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tn, id) DO UPDATE SET name = excluded.name, status = excluded.status, space = excluded.space, data = excluded.data, updated_at = excluded.updated_at WHERE projects.data IS NOT excluded.data`)
  .bind(tn, String(p.id), p.name || '', p.status || '', p.space || '', J(p), now);
const upCont = (db, tn, c, now) => db.prepare(`INSERT INTO contacts (tn, id, name, cat, space, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tn, id) DO UPDATE SET name = excluded.name, cat = excluded.cat, space = excluded.space, data = excluded.data, updated_at = excluded.updated_at WHERE contacts.data IS NOT excluded.data`)
  .bind(tn, String(c.id), c.name || '', c.cat || '', c.space || '', J(c), now);
const upNote = (db, tn, uid, d, x, now) => db.prepare(`INSERT INTO notes (tn, owner, date, text, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tn, owner, date) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at WHERE notes.text IS NOT excluded.text`).bind(tn, uid || '', d, String(x ?? ''), now);
const upUser = (db, tn, u, now) => db.prepare(`INSERT INTO users (tn, id, username, name, role, active, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tn, id) DO UPDATE SET username = excluded.username, name = excluded.name, role = excluded.role, active = excluded.active, data = excluded.data, updated_at = excluded.updated_at WHERE users.data IS NOT excluded.data`)
  .bind(tn, u.id, u.username || '', u.name || '', u.role || '', u.active === false ? 0 : 1, J(u), now);
const DEL = { item: 'items', project: 'projects', contact: 'contacts' };

// ---------- جلسة Google المعروفة لدى Cloudflare ----------
async function rememberSession(db, t, th, res, now) { // من رد getAll الناجح من Google
  const tn = (res.ten && res.ten.id) || '';
  await db.prepare(`INSERT INTO ss (th, t, tn, uid, me, users, ten, plat, pin, pv, seen, gas_at, rec_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(th) DO UPDATE SET t = excluded.t, tn = excluded.tn, uid = excluded.uid, me = excluded.me, users = excluded.users, ten = excluded.ten, plat = excluded.plat, pin = excluded.pin, pv = CASE WHEN excluded.pv > 0 THEN excluded.pv ELSE ss.pv END, seen = excluded.seen, gas_at = excluded.gas_at, rec_at = excluded.rec_at`)
    .bind(th, t, tn, res.me.id, J(res.me), J(res.users || []), J(res.ten || null), res.plat ? 1 : 0, res.priv && res.priv.pin ? 1 : 0, res.priv && res.priv.pin && res.priv.open ? now + PRIV_MIN * 60000 : 0, now, now, now).run();
}
async function nativeSession(db, th) { // الجلسة صالحة للوضع الأصلي؟
  if (!th) return null; const s = await db.prepare('SELECT * FROM ss WHERE th = ?').bind(th).first(); if (!s) return null;
  const me = JSON.parse(s.me || 'null'); if (!me || me.role !== 'owner' || me.active === false) return null;
  if ((await cfgGet(db, 'native:' + (s.tn || ''))) !== '1') return null;
  s.meo = me; return s;
}
const privOpen = s => !s.pin || (s.pv && s.pv > Date.now());

// ---------- إرسال التعديلات إلى Google بالترتيب ----------
async function enqueue(db, s, kind, rid, fn, args) { await db.prepare('INSERT INTO outbox (tn, uid, kind, rid, fn, args, at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(s.tn || '', s.uid, kind, String(rid || ''), fn, J(args), Date.now()).run(); }
async function gasCall(env, t, fn, args) {
  const r = await fetch(env.GAS_URL || GAS, { method: 'POST', body: J({ t, fn, args }), redirect: 'follow', headers: { 'content-type': 'text/plain;charset=utf-8' } });
  const x = await r.text(); if (!r.ok || x.charAt(0) !== '{') throw new Error('net:' + r.status); return JSON.parse(x);
}
async function drain(env, budgetMs) {
  const db = env.DB, t0 = Date.now(), now = Date.now();
  const lk = await db.prepare(`INSERT INTO cfg (k, v) VALUES ('drain', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE CAST(cfg.v AS INTEGER) < ?`).bind(String(now + 60000), now).run();
  if (!lk.meta || !lk.meta.changes) return; // مُرسِل آخر يعمل الآن
  try {
    while (Date.now() - t0 < (budgetMs || 20000)) {
      const o = await db.prepare('SELECT * FROM outbox WHERE done = 0 ORDER BY seq LIMIT 1').first(); if (!o) break;
      const s = await db.prepare('SELECT t FROM ss WHERE uid = ? AND tn = ? ORDER BY seen DESC LIMIT 1').bind(o.uid, o.tn || '').first();
      if (!s) { await db.prepare('UPDATE outbox SET tries = tries + 1, err = ? WHERE seq = ?').bind('لا توجد جلسة Google — بانتظار الدخول', o.seq).run(); break; }
      let r; try { r = await gasCall(env, s.t, o.fn, JSON.parse(o.args)); }
      catch (e) { await db.prepare('UPDATE outbox SET tries = tries + 1, err = ? WHERE seq = ?').bind(String(e.message || e).slice(0, 300), o.seq).run(); break; }
      if (!r.ok && /سجّل الدخول|انتهت الجلسة|غير مفعّل/.test(r.error || '')) { await db.prepare('DELETE FROM ss WHERE t = ?').bind(s.t).run(); await db.prepare('UPDATE outbox SET tries = tries + 1, err = ? WHERE seq = ?').bind(r.error, o.seq).run(); continue; }
      const B = [db.prepare('UPDATE outbox SET done = 1, tries = tries + 1, err = ? WHERE seq = ?').bind(r.ok ? null : String(r.error || '').slice(0, 300), o.seq), db.prepare('UPDATE ss SET gas_at = ? WHERE t = ?').bind(Date.now(), s.t)];
      if (r.ok && o.fn === 'saveItem' && r.data && (r.data.calId || r.data.todo)) { // معرّف التقويم / To Do من Google
        const row = await db.prepare('SELECT data FROM items WHERE tn = ? AND id = ?').bind(o.tn || '', o.rid).first();
        if (row) { const x = JSON.parse(row.data); if ((r.data.calId || '') !== (x.calId || '') || (r.data.todo || '') !== (x.todo || '')) { x.calId = r.data.calId || x.calId || ''; if (r.data.todo) x.todo = r.data.todo; B.push(upItem(db, o.tn || '', x, Date.now())); } } }
      if (!r.ok) B.push(db.prepare('INSERT INTO sync_log (at, tn, uid, fn, ok, ms, err) VALUES (?, ?, ?, ?, 0, 0, ?)').bind(Date.now(), o.tn || '', o.uid, 'outbox:' + o.fn, String(r.error || '').slice(0, 300)));
      await db.batch(B);
    }
  } finally { await cfgSet(db, 'drain', '0'); }
}

// ---------- مطابقة البيانات مع Google (تغييرات من خارج البرنامج: الوارد، To Do، منصة التأهيلات…) ----------
async function reconcile(env, s) {
  const db = env.DB; let r; try { r = await gasCall(env, s.t, 'getAll', []); } catch (e) { return; }
  if (!r.ok) { if (/سجّل الدخول|انتهت الجلسة|غير مفعّل/.test(r.error || '')) await db.prepare('DELETE FROM ss WHERE th = ?').bind(s.th).run(); return; }
  const d = r.data, tn = s.tn || '', now = Date.now(); await rememberSession(db, s.t, s.th, d, now);
  const pend = new Set((await db.prepare('SELECT kind, rid FROM outbox WHERE done = 0 AND tn = ?').bind(tn).all()).results.map(x => x.kind + ':' + x.rid));
  const B = []; const sync = (kind, table, list, up, keepPriv) => { const ids = new Set();
    list.forEach(o => { if (!o || !o.id) return; ids.add(String(o.id)); if (!pend.has(kind + ':' + o.id)) B.push(up(db, tn, o, now)); });
    return ids; };
  const iI = sync('item', 'items', d.items || [], upItem), iP = sync('project', 'projects', (d.projects || []).filter(p => !p._nofin), upProj), iC = sync('contact', 'contacts', d.contacts || [], upCont);
  (d.users || []).forEach(u => u && u.id && B.push(upUser(db, tn, u, now)));
  Object.entries(d.notes || {}).forEach(([k, x]) => B.push(upNote(db, tn, d.me.id, k, x, now)));
  const po = d.priv ? d.priv.open : true; // المحذوف في Google يُحذف هنا (عدا ما ينتظر الإرسال، والخاص عند قفله)
  for (const [kind, table, ids] of [['item', 'items', iI], ['project', 'projects', iP], ['contact', 'contacts', iC]]) {
    const rows = (await db.prepare(`SELECT id, space FROM ${table} WHERE tn = ?`).bind(tn).all()).results;
    rows.forEach(x => { if (!ids.has(x.id) && !pend.has(kind + ':' + x.id) && (x.space !== 'p' || po)) B.push(db.prepare(`DELETE FROM ${table} WHERE tn = ? AND id = ?`).bind(tn, x.id)); }); }
  for (let i = 0; i < B.length; i += 90) await db.batch(B.slice(i, i + 90));
  await log(db, tn, d.me.id, 'reconcile', 1, 0, null);
}

// ---------- العمليات الأصلية على D1 ----------
const rowsOf = async (db, table, tn) => (await db.prepare(`SELECT data FROM ${table} WHERE tn = ?`).bind(tn).all()).results.map(x => JSON.parse(x.data));
async function nGetAll(db, s) {
  const tn = s.tn || '', uid = s.uid, po = privOpen(s);
  const items = (await rowsOf(db, 'items', tn)).filter(x => (x.space !== 'p' || (x.owner === uid && po)) && (!x.pv || x.owner === uid));
  const projects = (await rowsOf(db, 'projects', tn)).filter(p => p.space === 'p' ? (p.createdBy === uid && po) : true);
  const contacts = (await rowsOf(db, 'contacts', tn)).filter(c => c.space === 'p' ? (c.createdBy === uid && po) : true);
  const notes = {}; (await db.prepare('SELECT date, text FROM notes WHERE tn = ? AND owner = ?').bind(tn, uid).all()).results.forEach(r => notes[r.date] = r.text || '');
  return { me: s.meo, users: JSON.parse(s.users || '[]'), items, notes, projects, contacts, priv: { pin: !!s.pin, open: po }, ten: JSON.parse(s.ten || 'null'), plat: !!s.plat, cf: 1 };
}
async function nSaveItem(db, s, obj) { // يعيد null إذا احتاجت العملية منطق Google (إسناد/تحويل/طلبات اعتماد)
  if (!obj || !obj.id) throw new UErr('بيانات غير صالحة'); const tn = s.tn || '', uid = s.uid;
  const row = await db.prepare('SELECT data FROM items WHERE tn = ? AND id = ?').bind(tn, String(obj.id)).first(); const old = row ? JSON.parse(row.data) : null;
  if (old && old.space === 'p' && old.owner !== uid) throw new UErr('غير مسموح');
  if (obj.space === 'p' || (old && old.space === 'p')) { if (!privOpen(s)) throw new UErr('أعمالك الخاصة مقفلة — افتحها بالرقم السري أولاً'); obj.space = 'p'; obj.owner = uid; obj.assignedBy = ''; }
  else if (!old) { if (!obj.owner) obj.owner = uid; if (obj.owner !== uid) return null; }
  else { if (obj.owner && obj.owner !== old.owner) return null; obj.owner = old.owner; obj.assignedBy = old.assignedBy || ''; obj.wf = obj.wf || old.wf || null;
    if ((obj.wf && obj.wf.req) || (old.wf && old.wf.req) || (old.assignedBy && old.assignedBy !== uid)) return null; }
  obj.calId = old ? (old.calId || '') : '';
  if (obj.todo === 'new' && old && old.todo && old.todo !== 'new') obj.todo = old.todo;
  ['done', 'star', 'pv'].forEach(k => obj[k] = !!obj[k]); if (!obj.due) obj.due = null;
  await upItem(db, tn, obj, Date.now()).run(); await enqueue(db, s, 'item', obj.id, 'saveItem', [obj]);
  return { calId: obj.calId || '', todo: obj.todo || '' };
}
async function nSaveProject(db, s, p, base, force) {
  if (!p || !p.id || !String(p.name || '').trim()) throw new UErr('اكتب اسم المشروع'); if (J(p).length > 45000) throw new UErr('بيانات المشروع كبيرة جداً');
  const tn = s.tn || '', row = await db.prepare('SELECT data FROM projects WHERE tn = ? AND id = ?').bind(tn, String(p.id)).first(), old = row ? JSON.parse(row.data) : null;
  if (old && base && !force && Number(old.updatedAt || 0) > Number(base) + 1000) throw new UErr('CONFLICT:' + (s.meo.name || '') + '|' + old.updatedAt);
  if (old) { if (old.space === 'p' && old.createdBy !== s.uid) throw new UErr('غير مسموح'); p.createdBy = old.createdBy || s.uid; p.space = old.space || ''; }
  else { p.createdBy = s.uid; p.space = p.space === 'p' ? 'p' : ''; } delete p._nofin;
  if (p.space === 'p' && !privOpen(s)) throw new UErr('أعمالك الخاصة مقفلة — افتحها بالرقم السري أولاً');
  const now = Date.now(); p.updatedAt = now; await upProj(db, tn, p, now).run(); await enqueue(db, s, 'project', p.id, 'saveProject', [p, 0, true]); return { updatedAt: now };
}
async function nSaveContact(db, s, c) {
  if (!c || !c.id || !String(c.name || '').trim()) throw new UErr('اكتب اسم العميل'); if (J(c).length > 45000) throw new UErr('بيانات العميل كبيرة جداً');
  const tn = s.tn || '', row = await db.prepare('SELECT data FROM contacts WHERE tn = ? AND id = ?').bind(tn, String(c.id)).first(), old = row ? JSON.parse(row.data) : null;
  if (old) { if (old.space === 'p' && old.createdBy !== s.uid) throw new UErr('غير مسموح'); c.createdBy = old.createdBy || s.uid; c.space = old.space || ''; } else { c.createdBy = s.uid; c.space = c.space === 'p' ? 'p' : ''; }
  c.updatedAt = Date.now(); await upCont(db, tn, c, c.updatedAt).run(); await enqueue(db, s, 'contact', c.id, 'saveContact', [c]); return true;
}
async function nDelete(db, s, kind, id) { const tn = s.tn || '', table = DEL[kind];
  const row = await db.prepare(`SELECT data FROM ${table} WHERE tn = ? AND id = ?`).bind(tn, String(id)).first();
  if (row) { const o = JSON.parse(row.data); if (o.space === 'p' && ((kind === 'item' ? o.owner : o.createdBy) !== s.uid || !privOpen(s))) throw new UErr('غير مسموح'); }
  await db.prepare(`DELETE FROM ${table} WHERE tn = ? AND id = ?`).bind(tn, String(id)).run();
  await enqueue(db, s, kind, id, { item: 'deleteItem', project: 'deleteProject', contact: 'deleteContact' }[kind], [id]); return true; }
async function nSaveNote(db, s, date, text) { await upNote(db, s.tn || '', s.uid, String(date), text, Date.now()).run(); await enqueue(db, s, 'note', date, 'saveNote', [date, text]); return true; }
async function nGetMat(env, s) { const db = env.DB, k = 'mat:' + (s.tn || ''); const v = await cfgGet(db, k); if (v != null) return JSON.parse(v);
  const r = await gasCall(env, s.t, 'getMat', []); if (!r.ok) throw new UErr(r.error || 'تعذّر تحميل الأسعار'); await cfgSet(db, k, J(r.data || {})); return r.data || {}; }
async function nSaveMat(db, s, d) { d = d && typeof d === 'object' ? d : {}; await cfgSet(db, 'mat:' + (s.tn || ''), J(d)); await enqueue(db, s, 'mat', '', 'saveMat', [d]); return d; }

// ---------- نسخة مطابقة في وضع التمرير ----------
async function mirror(env, req, res, ms) {
  const db = env.DB; const { t, fn, args = [] } = req; const now = Date.now();
  try {
    const th = t ? await sha('yw|' + t) : '';
    if (fn === 'logout') { if (th) await db.batch([db.prepare('DELETE FROM sess WHERE th = ?').bind(th), db.prepare('DELETE FROM ss WHERE th = ?').bind(th)]); return; }
    if ((fn === 'unlockPriv' || fn === 'setPrivPin') && th) { await db.prepare('UPDATE ss SET pv = ?, pin = ? WHERE th = ?').bind(res && res.priv && res.priv.open ? now + PRIV_MIN * 60000 : 0, res && res.priv && res.priv.pin ? 1 : 0, th).run(); }
    if (fn === 'lockPriv' && th) await db.prepare('UPDATE ss SET pv = 0 WHERE th = ?').bind(th).run();
    let s = th ? await db.prepare('SELECT tn, uid, full_at FROM sess WHERE th = ?').bind(th).first() : null;
    const S = [];
    if (fn === 'getAll' && res && res.me) {
      await rememberSession(db, t, th, res, now);
      const tn = (res.ten && res.ten.id) || '', uid = res.me.id;
      S.push(db.prepare('INSERT INTO sess (th, tn, uid, full_at, seen_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(th) DO UPDATE SET tn = excluded.tn, uid = excluded.uid, seen_at = excluded.seen_at').bind(th, tn, uid, s ? s.full_at || 0 : 0, now));
      if (!s || !s.full_at || now - s.full_at > FULL_SYNC_MIN * 60000) {
        S.push(db.prepare('UPDATE sess SET full_at = ? WHERE th = ?').bind(now, th));
        if (res.ten) S.push(db.prepare('INSERT INTO tenants (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at WHERE tenants.data IS NOT excluded.data').bind(tn, J(res.ten), now));
        (res.items || []).forEach(o => o && o.id && S.push(upItem(db, tn, o, now)));
        (res.projects || []).filter(p => p && p.id && !p._nofin).forEach(p => S.push(upProj(db, tn, p, now)));
        (res.contacts || []).forEach(c => c && c.id && S.push(upCont(db, tn, c, now)));
        (res.users || []).forEach(u => u && u.id && S.push(upUser(db, tn, u, now)));
        Object.entries(res.notes || {}).forEach(([d, x]) => S.push(upNote(db, tn, uid, d, x, now)));
      }
    } else if (s) {
      const tn = s.tn || '';
      if (fn === 'saveItem' && args[0] && args[0].id) S.push(upItem(db, tn, Object.assign({}, args[0], res && res.calId ? { calId: res.calId } : {}), now));
      else if (fn === 'deleteItem' && args[0]) S.push(db.prepare('DELETE FROM items WHERE tn = ? AND id = ?').bind(tn, String(args[0])));
      else if (fn === 'saveProject' && args[0] && args[0].id && !args[0]._nofin) S.push(upProj(db, tn, Object.assign({}, args[0], { updatedAt: (res && res.updatedAt) || now }), now));
      else if (fn === 'deleteProject' && args[0]) S.push(db.prepare('DELETE FROM projects WHERE tn = ? AND id = ?').bind(tn, String(args[0])));
      else if (fn === 'saveContact' && args[0] && args[0].id) S.push(upCont(db, tn, args[0], now));
      else if (fn === 'deleteContact' && args[0]) S.push(db.prepare('DELETE FROM contacts WHERE tn = ? AND id = ?').bind(tn, String(args[0])));
      else if (fn === 'saveNote' && args[0]) S.push(upNote(db, tn, s.uid, String(args[0]), args[1], now));
      else if (fn === 'saveMat') S.push(db.prepare('INSERT INTO cfg (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind('mat:' + tn, J(res || args[0] || {})));
    }
    if (!S.length) return;
    for (let i = 0; i < S.length; i += 90) await db.batch(S.slice(i, i + 90));
    await log(db, s ? s.tn : (res && res.ten && res.ten.id) || '', s ? s.uid : (res && res.me && res.me.id) || '', fn, 1, ms, null);
  } catch (e) { try { await log(db, '', '', fn, 0, ms, e && e.message || e); } catch (x) {} }
}

// ---------- نقطة الدخول ----------
const NATIVE = new Set(['getAll', 'saveItem', 'deleteItem', 'saveProject', 'deleteProject', 'saveContact', 'deleteContact', 'saveNote', 'getMat', 'saveMat']);
const WRITES = new Set(['saveItem', 'deleteItem', 'saveProject', 'deleteProject', 'saveContact', 'deleteContact', 'saveNote', 'saveMat', 'deleteUser', 'restoreTenant']);
export async function onRequestPost({ request, env, waitUntil }) {
  const body = await request.text(); const t0 = Date.now(); const db = env.DB;
  let req = {}; try { req = JSON.parse(body); } catch (e) {}
  if (db) {
    try {
      await init(db); const th = req.t ? await sha('yw|' + req.t) : '';
      if (req.fn === 'cfNative') { // تفعيل/إيقاف الوضع الأصلي — لمالك المنصة فقط
        const s = th ? await db.prepare('SELECT * FROM ss WHERE th = ?').bind(th).first() : null, me = s && JSON.parse(s.me || 'null');
        if (!me || me.role !== 'owner' || !s.plat) return fail('هذه العملية لمالك المنصة فقط — افتح البرنامج وسجّل الدخول أولاً');
        const on = !!(req.args || [])[0]; if (!on) { await drain(env, 25000); const left = (await db.prepare('SELECT COUNT(*) n FROM outbox WHERE done = 0').first()).n; if (left) return fail('ما زالت ' + left + ' تعديلات بانتظار الإرسال إلى Google — حاول بعد دقيقة'); }
        await cfgSet(db, 'native:' + (s.tn || ''), on ? '1' : '0'); await log(db, s.tn, s.uid, 'cfNative:' + (on ? 'on' : 'off'), 1, 0, null); return ok({ native: on });
      }
      const s = NATIVE.has(req.fn) ? await nativeSession(db, th) : null;
      if (s) {
        if (Date.now() - (s.seen || 0) > IDLE) { await db.prepare('DELETE FROM ss WHERE th = ?').bind(th).run(); waitUntil(gasCall(env, req.t, 'logout', []).catch(() => {})); return fail('انتهت الجلسة — أُغلقت بعد 30 دقيقة دون نشاط'); }
        if (Date.now() - (s.seen || 0) > 60000) await db.prepare('UPDATE ss SET seen = ? WHERE th = ?').bind(Date.now(), th).run();
        const a = req.args || []; let data, handled = true;
        try {
          if (req.fn === 'getAll') data = await nGetAll(db, s);
          else if (req.fn === 'saveItem') { data = await nSaveItem(db, s, a[0]); if (data === null) handled = false; }
          else if (req.fn === 'deleteItem') data = await nDelete(db, s, 'item', a[0]);
          else if (req.fn === 'saveProject') data = await nSaveProject(db, s, a[0], a[1], a[2]);
          else if (req.fn === 'deleteProject') data = await nDelete(db, s, 'project', a[0]);
          else if (req.fn === 'saveContact') data = await nSaveContact(db, s, a[0]);
          else if (req.fn === 'deleteContact') data = await nDelete(db, s, 'contact', a[0]);
          else if (req.fn === 'saveNote') data = await nSaveNote(db, s, a[0], a[1]);
          else if (req.fn === 'getMat') data = await nGetMat(env, s);
          else if (req.fn === 'saveMat') data = await nSaveMat(db, s, a[0]);
        } catch (e) { if (e instanceof UErr) return fail(e.message); throw e; }
        if (handled) {
          waitUntil((async () => { try {
            if (WRITES.has(req.fn)) await drain(env, 25000);
            else if (Date.now() - (s.rec_at || 0) > RECONCILE_MIN * 60000) { await db.prepare('UPDATE ss SET rec_at = ? WHERE th = ?').bind(Date.now(), th).run(); await drain(env, 15000); await reconcile(env, s); }
            else if (Date.now() - (s.gas_at || 0) > KEEPALIVE_MIN * 60000) { await db.prepare('UPDATE ss SET gas_at = ? WHERE th = ?').bind(Date.now(), th).run(); await gasCall(env, req.t, 'getMat', []); await drain(env, 15000); }
          } catch (e) { try { await log(db, s.tn, s.uid, 'bg:' + req.fn, 0, 0, e.message || e); } catch (x) {} } })());
          return ok(data);
        }
      }
      if (WRITES.has(req.fn) || req.fn === 'saveItem') { const n = (await db.prepare('SELECT COUNT(*) n FROM outbox WHERE done = 0').first()).n; if (n) await drain(env, 20000); } // الترتيب: ما ينتظر الإرسال أولاً
    } catch (e) { try { await log(db, '', '', 'native:' + req.fn, 0, Date.now() - t0, e.message || e); } catch (x) {} }
  }
  let r;
  try { r = await fetch(env.GAS_URL || GAS, { method: 'POST', body, redirect: 'follow', headers: { 'content-type': 'text/plain;charset=utf-8' } }); }
  catch (e) { return new Response(J({ ok: false, error: 'تعذّر الاتصال بالخادم — حاول مرة أخرى' }), { status: 502, headers: H }); }
  const text = await r.text();
  if (!r.ok || text.charAt(0) !== '{') return new Response(J({ ok: false, error: 'خطأ في الاتصال بالخادم (' + r.status + ')' }), { status: 502, headers: H });
  if (db) waitUntil((async () => { let out; try { out = JSON.parse(text); } catch (e) { return; } if (out && out.ok) await mirror(env, req, out.data, Date.now() - t0); })());
  return new Response(text, { headers: H });
}
export async function onRequestGet({ request, env }) { // حالة الخادم؛ التفاصيل لمستخدم مسجّل (?t=رمز الجلسة) وتخص مساحته
  const o = { ok: true, gateway: true, d1: !!env.DB }; const t = new URL(request.url).searchParams.get('t');
  if (env.DB) { try { const db = env.DB; await init(db); o.lastSync = (await db.prepare('SELECT MAX(at) n FROM sync_log WHERE ok = 1').first()).n;
    const th = t ? await sha('yw|' + t) : '', s = th ? await db.prepare('SELECT tn FROM ss WHERE th = ?').bind(th).first() || await db.prepare('SELECT tn FROM sess WHERE th = ?').bind(th).first() : null;
    if (s) { const tn = s.tn || '', c = async q => (await db.prepare(q).bind(tn).first()).n;
      Object.assign(o, { native: (await cfgGet(db, 'native:' + tn)) === '1', items: await c('SELECT COUNT(*) n FROM items WHERE tn = ?'), projects: await c('SELECT COUNT(*) n FROM projects WHERE tn = ?'), contacts: await c('SELECT COUNT(*) n FROM contacts WHERE tn = ?'), users: await c('SELECT COUNT(*) n FROM users WHERE tn = ?'),
        pending: await c('SELECT COUNT(*) n FROM outbox WHERE done = 0 AND tn = ?'), sentOk: await c('SELECT COUNT(*) n FROM outbox WHERE done = 1 AND err IS NULL AND tn = ?'),
        lastErr: ((await db.prepare('SELECT err FROM outbox WHERE tn = ? AND err IS NOT NULL ORDER BY seq DESC LIMIT 1').bind(tn).first()) || {}).err || null,
        errors24h: (await db.prepare('SELECT COUNT(*) n FROM sync_log WHERE ok = 0 AND at > ?').bind(Date.now() - 864e5).first()).n }); } } catch (e) { o.err = String(e.message || e); } }
  return new Response(J(o), { headers: H });
}
