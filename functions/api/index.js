// D1: yawmi-db (5951d5bd-9a48-4415-a0c4-6f02c0eb5d4d) مربوطة باسم DB في إعدادات مشروع yawmi-dmc
// يومي — خادم Cloudflare الكامل (v111): Cloudflare هو المصدر الوحيد للبيانات والدخول والصلاحيات لكل المستخدمين وكل المساحات.
// • الدخول والجلسات وكلمات المرور (PBKDF2) والصلاحيات وسير العمل والمشاريع والعملاء والملاحظات… كلها في D1 مباشرة.
// • Google لم يعد طرفاً في أي قراءة أو حفظ: يصله نسخة احتياطية من كل تعديل في الخلفية (outbox)، ويبقى فقط لخدمات Google
//   نفسها (التقويم، رفع الملفات إلى Drive، Notability، To Do، البريد الوارد، رسائل البريد والملخص الصباحي).
// • الانتقال تلقائي وبدون أي إعداد: أول دخول لكل مستخدم يتحقق من كلمة المرور عند Google مرة واحدة، ثم تُحفظ بصمتها هنا.
// • مفتاح طوارئ: cfg native:<tn> = '0' يعيد المساحة لوضع التمرير إلى Google كما كانت.
const GAS = 'https://script.google.com/macros/s/AKfycbwgvjkn2Op3hg-sSwxMi3PJO4MmIot0udoa8FXKOGTK9LBjqKuGtqlLYY1FaAkMwnI9/exec';
const RECONCILE_MIN = 5, KEEPALIVE_MIN = 20, IDLE = 30 * 60000, PRIV_MIN = 15, SESSION_DAYS = 30, MAXTRY = 5;
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
  `CREATE TABLE IF NOT EXISTS trash (id TEXT PRIMARY KEY, tn TEXT, kind TEXT, rid TEXT, title TEXT, data TEXT, uid TEXT, uname TEXT, priv INTEGER DEFAULT 0, at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS trash_tn ON trash (tn, at)`,
  `CREATE TABLE IF NOT EXISTS ach (tn TEXT NOT NULL DEFAULT '', uid TEXT NOT NULL, k TEXT NOT NULL, data TEXT, at INTEGER, PRIMARY KEY (tn, uid, k))`,
  // v111: الدخول والجلسات والرقم السري وسجل النشاط والمحذوفات نهائياً
  `CREATE TABLE IF NOT EXISTS auth (tn TEXT NOT NULL DEFAULT '', uid TEXT NOT NULL, salt TEXT, hash TEXT, at INTEGER, PRIMARY KEY (tn, uid))`,
  `CREATE TABLE IF NOT EXISTS sess2 (th TEXT PRIMARY KEY, tn TEXT, uid TEXT, exp INTEGER, last INTEGER, pv INTEGER DEFAULT 0, gt TEXT, gt_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS sess2_uid ON sess2 (tn, uid)`,
  `CREATE TABLE IF NOT EXISTS pins (tn TEXT NOT NULL DEFAULT '', uid TEXT NOT NULL, salt TEXT, hash TEXT, PRIMARY KEY (tn, uid))`,
  `CREATE TABLE IF NOT EXISTS audit (tn TEXT, at INTEGER, by TEXT, byName TEXT, action TEXT, target TEXT, details TEXT)`,
  `CREATE INDEX IF NOT EXISTS audit_tn ON audit (tn, at)`,
  `CREATE TABLE IF NOT EXISTS gone (tn TEXT NOT NULL DEFAULT '', kind TEXT, id TEXT, at INTEGER, PRIMARY KEY (tn, kind, id))`,
  `CREATE TABLE IF NOT EXISTS ltry (k TEXT PRIMARY KEY, n INTEGER, until INTEGER)`,
];
let ready = false;
async function init(db) { if (ready) return; await db.batch(SCHEMA.map(q => db.prepare(q))); try { await db.prepare('ALTER TABLE sess2 ADD COLUMN rem INTEGER DEFAULT 0').run(); } catch (e) {} ready = true; }
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
async function sha(s) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))); }
const rnd = n => hex(crypto.getRandomValues(new Uint8Array(n || 16)));
const rid = () => rnd(8);
async function pbk(salt, pw) { const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(pw)), 'PBKDF2', false, ['deriveBits']);
  return 'p1$' + hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(String(salt)), iterations: 100000 }, k, 256)); }
const cfgGet = async (db, k) => { const r = await db.prepare('SELECT v FROM cfg WHERE k = ?').bind(k).first(); return r ? r.v : null; };
const cfgSet = (db, k, v) => db.prepare('INSERT INTO cfg (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, v == null ? null : String(v)).run();
const log = (db, tn, uid, fn, ok, ms, err) => db.prepare('INSERT INTO sync_log (at, tn, uid, fn, ok, ms, err) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(Date.now(), tn || '', uid || '', fn, ok ? 1 : 0, ms || 0, err ? String(err).slice(0, 400) : null).run();
class UErr extends Error {}
const ok = (data, ver) => new Response(J({ ok: true, data }), { headers: ver ? Object.assign({}, H, { 'x-yw-ver': String(ver) }) : H });
const fail = m => new Response(J({ ok: false, error: m }), { headers: H });
const bump = async (db, tn) => { const v = Date.now(); await cfgSet(db, 'ver:' + (tn || ''), v); return v; };
const sumCh = rs => (rs || []).reduce((n, r) => n + ((r && r.meta && r.meta.changes) || 0), 0);
const today = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);

// ---------- الكتابة في جداول D1 ----------
const upItem = (db, tn, o, now) => db.prepare(`INSERT INTO items (tn, id, owner, space, due, done, title, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tn, id) DO UPDATE SET owner = excluded.owner, space = excluded.space, due = excluded.due, done = excluded.done, title = excluded.title, data = excluded.data, updated_at = excluded.updated_at WHERE items.data IS NOT excluded.data`)
  .bind(tn, String(o.id), o.owner || '', o.space || '', o.due || '', o.done ? 1 : 0, String(o.title || '').slice(0, 300), J(o), now);
const insItem = (db, tn, o, now) => db.prepare(`INSERT OR IGNORE INTO items (tn, id, owner, space, due, done, title, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(tn, String(o.id), o.owner || '', o.space || '', o.due || '', o.done ? 1 : 0, String(o.title || '').slice(0, 300), J(o), now);
const upProj = (db, tn, p, now) => db.prepare(`INSERT INTO projects (tn, id, name, status, space, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tn, id) DO UPDATE SET name = excluded.name, status = excluded.status, space = excluded.space, data = excluded.data, updated_at = excluded.updated_at WHERE projects.data IS NOT excluded.data`)
  .bind(tn, String(p.id), p.name || '', p.status || '', p.space || '', J(p), now);
const upCont = (db, tn, c, now) => db.prepare(`INSERT INTO contacts (tn, id, name, cat, space, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tn, id) DO UPDATE SET name = excluded.name, cat = excluded.cat, space = excluded.space, data = excluded.data, updated_at = excluded.updated_at WHERE contacts.data IS NOT excluded.data`)
  .bind(tn, String(c.id), c.name || '', c.cat || '', c.space || '', J(c), now);
const upNote = (db, tn, uid, d, x, now) => db.prepare(`INSERT INTO notes (tn, owner, date, text, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tn, owner, date) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at WHERE notes.text IS NOT excluded.text`).bind(tn, uid || '', d, String(x ?? ''), now);
const upUser = (db, tn, u, now) => db.prepare(`INSERT INTO users (tn, id, username, name, role, active, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tn, id) DO UPDATE SET username = excluded.username, name = excluded.name, role = excluded.role, active = excluded.active, data = excluded.data, updated_at = excluded.updated_at WHERE users.data IS NOT excluded.data`)
  .bind(tn, u.id, u.username || '', u.name || '', u.role || '', u.active === false ? 0 : 1, J(u), now);
const DEL = { item: 'items', project: 'projects', contact: 'contacts' };
const rowsOf = async (db, table, tn) => (await db.prepare(`SELECT data FROM ${table} WHERE tn = ?`).bind(tn).all()).results.map(x => JSON.parse(x.data));
async function batchAll(db, B) { let ch = 0; for (let i = 0; i < B.length; i += 90) ch += sumCh(await db.batch(B.slice(i, i + 90))); return ch; }

// ---------- الأدوار والصلاحيات (منقولة حرفياً من خادم Google) ----------
const PERMS = ['team', 'assign', 'transfer', 'approve', 'projects', 'projectsEdit', 'finance', 'users', 'audit'];
const PDEF = { ceo: { team: 1, assign: 1, transfer: 1, approve: 1, projects: 1, projectsEdit: 1, finance: 1, users: 1, audit: 1 }, branch: { team: 1, assign: 1, transfer: 1, approve: 1, projects: 1, projectsEdit: 1, finance: 1, users: 1, audit: 1 },
  admin: { team: 1, assign: 1, transfer: 1, approve: 1, projects: 1, projectsEdit: 1, finance: 1, users: 0, audit: 0 }, member: { transfer: 1 } };
const ROLES = ['member', 'admin', 'branch', 'ceo', 'owner'];
const rank = r => Math.max(0, ROLES.indexOf(r));
const cleanRole = r => ROLES.includes(r) ? r : 'member';
const rawP = u => u.rawPerms || u.perms || {};
function eff(u) { const o = {}; PERMS.forEach(k => o[k] = u.role === 'owner' ? true : (rawP(u)[k] !== undefined ? !!rawP(u)[k] : !!(PDEF[u.role] || PDEF.member)[k])); return o; }
const can = (u, k) => !!eff(u)[k];
const need = (u, k) => { if (!can(u, k)) throw new UErr('ليس لديك صلاحية لهذه العملية'); };
function inScope(v, x) { if (!x) return v.role === 'owner' || v.role === 'ceo'; if (v.id === x.id || v.role === 'owner' || v.role === 'ceo') return true; const vo = v.org || {}, xo = x.org || {};
  if (v.role === 'branch') return !vo.branch || xo.branch === vo.branch; return (!vo.branch || xo.branch === vo.branch) && (!vo.dept || xo.dept === vo.dept); }
function seeScope(v, x) { if (!x) return v.role === 'owner' || v.role === 'ceo'; if (v.id === x.id || v.role === 'owner') return true; if (x.role === 'owner') return false; if (v.role === 'ceo') return true; if (rank(x.role) >= rank(v.role)) return false; return inScope(v, x); }
const canManage = (v, x) => { if (!x || x.role === 'owner') return false; if (v.role === 'owner') return true; return can(v, 'users') && rank(x.role) < rank(v.role) && inScope(v, x); };
const pub = u => ({ id: u.id, username: u.username, name: u.name, role: u.role, active: u.active !== false, email: u.email || '', phone: u.phone || '', prefs: u.prefs || {}, perms: eff(u), rawPerms: rawP(u), org: u.org || {} });
function usersFor(u, US) { const full = can(u, 'team') || can(u, 'users');
  return US.map(x => full && inScope(u, x) ? Object.assign(pub(x), { sc: true, mg: canManage(u, x) }) : { id: x.id, name: x.name, role: x.role, active: x.active !== false, org: x.org || {}, phone: x.phone || '', prefs: { notify: (x.prefs || {}).notify || 'email' }, sc: x.id === u.id }); }
// صلاحيات الصفحات الإضافية (v110) — تُفرض هنا على الخادم أيضاً
const XPDEF = { ceo: { clients: 1, brk: 1, mat: 1, del: 1, trash: 1, achTeam: 1 }, branch: { clients: 1, brk: 1, mat: 1, del: 1, trash: 1, achTeam: 1 }, admin: { clients: 1, brk: 0, mat: 1, del: 1, trash: 1, achTeam: 1 }, member: { clients: 0, brk: 0, mat: 1, del: 1, trash: 1, achTeam: 0 } };
const xcan = (X, u, k) => u.role === 'owner' || ((X[u.id] || {})[k] !== undefined ? !!(X[u.id] || {})[k] : !!(XPDEF[u.role] || XPDEF.member)[k]);
const FINK = ['price', 'agreed', 'claims', 'expenses', 'adds', 'hourCost', 'visitFee', 'qRevs', 'hourTarget'];
function stripFin(p) { const o = JSON.parse(J(p)); FINK.forEach(k => delete o[k]); if (Array.isArray(o.visits)) o.visits.forEach(v => { delete v.fee; delete v.paid; delete v.paidDate; }); if (Array.isArray(o.phases)) o.phases.forEach(x => { delete x.amount; }); o._nofin = true; return o; }
function keepFin(p, old) { FINK.forEach(k => { if (old[k] !== undefined) p[k] = old[k]; else delete p[k]; }); if (Array.isArray(p.visits) && Array.isArray(old.visits)) p.visits.forEach((v, i) => { const o = old.visits[i] || {}; v.fee = o.fee; v.paid = o.paid; v.paidDate = o.paidDate; }); delete p._nofin; }
const wfReq = o => (o && o.wf && o.wf.req) || null;

// ---------- المستخدم الحالي والجلسة ----------
async function usersOf(db, tn) { return (await rowsOf(db, 'users', tn)).map(u => Object.assign(u, { active: u.active !== false })); }
async function tenOf(db, tn) { if (!tn) return null; const r = await db.prepare('SELECT data FROM tenants WHERE id = ?').bind(tn).first(); return r ? JSON.parse(r.data || 'null') : null; }
function tenState(t) { if (!t) return 'active'; if (t.state === 'suspended') return 'suspended'; if (t.state === 'active' && !t.paidUntil) return 'active'; const end = t.state === 'active' ? t.paidUntil : t.trialEnd; return end && end < today() ? 'expired' : 'ok'; }
async function ctxOf(db, th) { if (!th) return null; const s = await db.prepare('SELECT * FROM sess2 WHERE th = ?').bind(th).first(); if (!s) return null;
  const now = Date.now(); if (s.exp < now) { await db.prepare('DELETE FROM sess2 WHERE th = ?').bind(th).run(); throw new UErr('انتهت الجلسة — سجّل الدخول مرة أخرى'); }
  if (!s.rem && s.last && now - s.last > IDLE) { await db.prepare('DELETE FROM sess2 WHERE th = ?').bind(th).run(); throw new UErr('انتهت الجلسة — أُغلقت بعد 30 دقيقة دون نشاط'); }
  if (!s.last || now - s.last > 60000) await db.prepare('UPDATE sess2 SET last = ? WHERE th = ?').bind(now, th).run();
  const tn = s.tn || '', US = await usersOf(db, tn), u = US.find(x => x.id === s.uid); if (!u || u.active === false) throw new UErr('الحساب غير مفعّل');
  const ten = await tenOf(db, tn), st = tn ? tenState(ten) : 'active'; if (st === 'suspended') throw new UErr('حساب الشركة غير مفعّل حالياً — تواصل مع إدارة يومي');
  const pin = await db.prepare('SELECT 1 x FROM pins WHERE tn = ? AND uid = ?').bind(tn, u.id).first();
  return { s, th, tn, u, US, ten, ro: st === 'expired', po: !pin || (s.pv && s.pv > now), pin: !!pin, X: JSON.parse((await cfgGet(db, 'xp:' + tn)) || '{}') }; }
const byId = (C, id) => C.US.find(x => x.id === id);
async function audit(db, C, action, target, details) { try { await db.prepare('INSERT INTO audit (tn, at, by, byName, action, target, details) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(C.tn, Date.now(), C.u.id, C.u.name || '', String(action), String(target || '').slice(0, 200), String(details || '').slice(0, 500)).run(); } catch (e) {} }
const nativeOn = async (db, tn) => (await cfgGet(db, 'native:' + (tn || ''))) !== '0';

// ---------- الاتصال بخادم Google (نسخة احتياطية + خدماته فقط) ----------
async function gasCall(env, t, fn, args) { const r = await fetch(env.GAS_URL || GAS, { method: 'POST', body: J({ t, fn, args }), redirect: 'follow', headers: { 'content-type': 'text/plain;charset=utf-8' } });
  const x = await r.text(); if (!r.ok || x.charAt(0) !== '{') throw new Error('net:' + r.status); return JSON.parse(x); }
async function gasOpen(env, fn, args) { return gasCall(env, '', fn, args); }
async function enqueue(db, C, kind, rid, fn, args) { await db.prepare('INSERT INTO outbox (tn, uid, kind, rid, fn, args, at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(C.tn, C.u.id, kind, String(rid || ''), fn, J(args), Date.now()).run(); }
async function gtFor(db, tn, uid) { const r = await db.prepare('SELECT gt FROM sess2 WHERE tn = ? AND uid = ? AND gt IS NOT NULL AND gt != \'\' ORDER BY gt_at DESC LIMIT 1').bind(tn || '', uid).first(); return r ? r.gt : null; }
async function drain(env, budgetMs) {
  const db = env.DB, t0 = Date.now(), now = Date.now();
  const lk = await db.prepare(`INSERT INTO cfg (k, v) VALUES ('drain', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE CAST(cfg.v AS INTEGER) < ?`).bind(String(now + 60000), now).run();
  if (!lk.meta || !lk.meta.changes) return;
  try {
    let minSeq = 0; const skip = new Set();
    while (Date.now() - t0 < (budgetMs || 20000)) {
      const o = await db.prepare('SELECT * FROM outbox WHERE done = 0 AND seq > ? ORDER BY seq LIMIT 1').bind(minSeq).first(); if (!o) break;
      if (skip.has(o.tn + '|' + o.uid)) { minSeq = o.seq; continue; }
      const newer = await db.prepare('SELECT seq FROM outbox WHERE done = 0 AND tn = ? AND kind = ? AND rid = ? AND seq > ? LIMIT 1').bind(o.tn || '', o.kind, o.rid, o.seq).first();
      if (newer) { await db.prepare('UPDATE outbox SET done = 1, err = NULL WHERE seq = ?').bind(o.seq).run(); continue; }
      const gt = await gtFor(db, o.tn, o.uid);
      if (!gt) { if (Date.now() - o.at > 3 * 864e5) { await db.prepare('UPDATE outbox SET done = 1, err = ? WHERE seq = ?').bind('أُسقط من النسخة الاحتياطية: لا توجد جلسة Google منذ 3 أيام', o.seq).run(); continue; }
        await db.prepare('UPDATE outbox SET tries = tries + 1, err = ? WHERE seq = ?').bind('بانتظار دخول المستخدم لتحديث النسخة الاحتياطية في Google', o.seq).run(); skip.add(o.tn + '|' + o.uid); minSeq = o.seq; continue; }
      let r; try { r = await gasCall(env, gt, o.fn, JSON.parse(o.args)); }
      catch (e) { await db.prepare('UPDATE outbox SET tries = tries + 1, err = ? WHERE seq = ?').bind(String(e.message || e).slice(0, 300), o.seq).run(); break; }
      if (!r.ok && /سجّل الدخول|انتهت الجلسة|غير مفعّل/.test(r.error || '')) { await db.prepare('UPDATE sess2 SET gt = NULL WHERE gt = ?').bind(gt).run(); await db.prepare('UPDATE outbox SET tries = tries + 1, err = ? WHERE seq = ?').bind(r.error, o.seq).run(); continue; }
      const B = [db.prepare('UPDATE outbox SET done = 1, tries = tries + 1, args = CASE WHEN fn IN (\'addUser\', \'updateUser\', \'setPrivPin\') THEN \'[]\' ELSE args END, err = ? WHERE seq = ?').bind(r.ok ? null : String(r.error || '').slice(0, 300), o.seq), db.prepare('UPDATE sess2 SET gt_at = ? WHERE gt = ?').bind(Date.now(), gt)];
      if (r.ok && o.fn === 'saveItem' && r.data && (r.data.calId || r.data.todo)) { const row = await db.prepare('SELECT data FROM items WHERE tn = ? AND id = ?').bind(o.tn || '', o.rid).first();
        if (row) { const x = JSON.parse(row.data); if ((r.data.calId || '') !== (x.calId || '') || (r.data.todo || '') !== (x.todo || '')) { x.calId = r.data.calId || x.calId || ''; if (r.data.todo) x.todo = r.data.todo; B.push(upItem(db, o.tn || '', x, Date.now())); } } }
      if (!r.ok) B.push(db.prepare('INSERT INTO sync_log (at, tn, uid, fn, ok, ms, err) VALUES (?, ?, ?, ?, 0, 0, ?)').bind(Date.now(), o.tn || '', o.uid, 'backup:' + o.fn, String(r.error || '').slice(0, 300)));
      await db.batch(B);
    }
  } finally { await cfgSet(db, 'drain', '0'); }
}
// استيراد كامل من Google (يُستخدم عند أول دخول لكل مساحة، ولمرة واحدة) — لا يكتب فوق ما ينتظر الإرسال
async function importFrom(db, tn, d, uid, full) { const now = Date.now(), pend = new Set((await db.prepare('SELECT kind, rid FROM outbox WHERE done = 0 AND tn = ?').bind(tn).all()).results.map(x => x.kind + ':' + x.rid));
  const gone = new Set((await db.prepare('SELECT kind, id FROM gone WHERE tn = ?').bind(tn).all()).results.map(x => x.kind + ':' + x.id)); const B = [];
  const ok2 = (k, id) => !pend.has(k + ':' + id) && !gone.has(k + ':' + id);
  (d.items || []).forEach(o => { if (o && o.id && ok2('item', o.id)) B.push(full ? upItem(db, tn, o, now) : insItem(db, tn, o, now)); });
  (d.projects || []).filter(p => p && p.id && !p._nofin).forEach(p => { if (ok2('project', p.id)) B.push(full ? upProj(db, tn, p, now) : db.prepare('INSERT OR IGNORE INTO projects (tn, id, name, status, space, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(tn, String(p.id), p.name || '', p.status || '', p.space || '', J(p), now)); });
  (d.contacts || []).forEach(c => { if (c && c.id && ok2('contact', c.id)) B.push(full ? upCont(db, tn, c, now) : db.prepare('INSERT OR IGNORE INTO contacts (tn, id, name, cat, space, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(tn, String(c.id), c.name || '', c.cat || '', c.space || '', J(c), now)); });
  (d.users || []).filter(u => u && u.id && u.username !== undefined).forEach(u => B.push(upUser(db, tn, u, now)));
  if (d.me && d.me.id) B.push(upUser(db, tn, d.me, now));
  Object.entries(d.notes || {}).forEach(([k, x]) => B.push(upNote(db, tn, uid, k, x, now)));
  if (d.ten && d.ten.id) B.push(db.prepare('INSERT INTO tenants (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').bind(d.ten.id, J(d.ten), now));
  const ch = await batchAll(db, B); if (ch) await bump(db, tn); }
// مطابقة دورية: تلتقط فقط ما يُنشأ في Google من الخدمات (البريد الوارد، To Do، منصة التأهيلات) ولا تحذف ولا تكتب فوق بيانات Cloudflare
async function reconcile(env, C) { const db = env.DB; if (C.u.role !== 'owner' && !can(C.u, 'team')) return; const gt = await gtFor(db, C.tn, C.u.id); if (!gt) return;
  await drain(env, 15000); let r; try { r = await gasCall(env, gt, 'getAll', []); } catch (e) { return; } if (!r.ok) return; const d = r.data, tn = C.tn, now = Date.now();
  const pend = new Set((await db.prepare('SELECT kind, rid FROM outbox WHERE done = 0 AND tn = ?').bind(tn).all()).results.map(x => x.kind + ':' + x.rid));
  const gone = new Set((await db.prepare("SELECT id FROM gone WHERE tn = ? AND kind = 'item'").bind(tn).all()).results.map(x => x.id));
  const have = new Map((await db.prepare('SELECT id, data FROM items WHERE tn = ?').bind(tn).all()).results.map(x => [x.id, x.data])); const B = [];
  (d.items || []).forEach(o => { if (!o || !o.id || pend.has('item:' + o.id) || gone.has(o.id)) return; const cur = have.get(String(o.id));
    if (!cur) { B.push(upItem(db, tn, o, now)); return; } const x = JSON.parse(cur); let ch = false;
    if (o.done && !x.done && (x.todo || o.todo)) { x.done = true; x.doneAt = o.doneAt || now; ch = true; } ['calId', 'todo'].forEach(k => { if (o[k] && o[k] !== x[k]) { x[k] = o[k]; ch = true; } }); if (ch) B.push(upItem(db, tn, x, now)); });
  // v117: لا نعلن «تغيير» للأجهزة إلا إذا تغيّرت مهمة فعلاً (المستخدمون والمشترك يُحدَّثون بصمت)
  const B2 = []; (d.users || []).filter(u => u && u.id && u.username !== undefined).forEach(u => B2.push(upUser(db, tn, u, now)));
  if (d.ten && d.ten.id) B2.push(db.prepare('INSERT INTO tenants (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').bind(d.ten.id, J(d.ten), now));
  const chI = await batchAll(db, B); if (B2.length) await batchAll(db, B2); if (chI) await bump(db, tn); await log(db, tn, C.u.id, 'reconcile', 1, 0, null); }

// ---------- الدخول ----------
async function throttle(db, k) { const r = await db.prepare('SELECT n, until FROM ltry WHERE k = ?').bind(k).first(); if (r && r.until > Date.now() && r.n >= MAXTRY) throw new UErr('الحساب مقفل مؤقتاً لمدة 15 دقيقة بسبب محاولات دخول خاطئة كثيرة — استخدم «نسيت كلمة المرور» عند الحاجة'); return r && r.until > Date.now() ? r.n : 0; }
async function failTry(db, k, n) { await db.prepare('INSERT INTO ltry (k, n, until) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET n = excluded.n, until = excluded.until').bind(k, n + 1, Date.now() + 15 * 60000).run(); const left = MAXTRY - n - 1;
  return 'بيانات الدخول أو كلمة المرور غير صحيحة' + (left <= 0 ? ' — أُقفل الحساب لمدة 15 دقيقة' : left <= 2 ? ' — باقي ' + left + ' محاولات' : ''); }
function normPhone(p) { let d = String(p || '').replace(/[^0-9+]/g, ''); if (!d) return ''; if (d[0] === '+') d = d.slice(1); else if (d.startsWith('00')) d = d.slice(2); else if (/^05\d{8}$/.test(d)) d = '966' + d.slice(1); else if (/^5\d{8}$/.test(d)) d = '966' + d; else if (/^01\d{9}$/.test(d)) d = '20' + d.slice(1); return d.replace(/\D/g, ''); }
async function findUser(db, ident) { const lo = String(ident || '').trim().toLowerCase(); if (!lo) return null; const all = (await db.prepare('SELECT tn, data FROM users').all()).results.map(r => Object.assign(JSON.parse(r.data), { _tn: r.tn || '' }));
  let m = all.filter(x => String(x.username || '').toLowerCase() === lo); if (m.length === 1) return m[0];
  if (lo.includes('@')) { m = all.filter(x => String(x.email || '').toLowerCase() === lo); return m.length === 1 ? m[0] : null; }
  const ph = normPhone(lo); if (ph.length >= 8) { m = all.filter(x => String(x.phone || '') === ph); return m.length === 1 ? m[0] : null; } return null; }
async function newSess(db, tn, uid, gt) { const t = rnd(24), th = await sha('yw|' + t), now = Date.now();
  await db.prepare('INSERT INTO sess2 (th, tn, uid, exp, last, pv, gt, gt_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)').bind(th, tn || '', uid, now + SESSION_DAYS * 864e5, now, gt || null, gt ? now : null).run();
  await db.prepare('DELETE FROM sess2 WHERE exp < ?').bind(now).run(); return t; }
async function setAuth(db, tn, uid, pw) { const salt = rnd(16); await db.prepare('INSERT INTO auth (tn, uid, salt, hash, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tn, uid) DO UPDATE SET salt = excluded.salt, hash = excluded.hash, at = excluded.at').bind(tn || '', uid, salt, await pbk(salt, pw), Date.now()).run(); }
// نتيجة دخول ناجح من Google (أول مرة لكل مستخدم، أو التسجيل/الاستعادة): نستورد بياناته ونبدأ جلسة Cloudflare
async function adoptGoogle(env, res, pw) { const db = env.DB, gt = res.token; const g = await gasCall(env, gt, 'getAll', []); if (!g.ok) throw new UErr(g.error || 'تعذّر تحميل البيانات');
  const d = g.data, tn = (d.ten && d.ten.id) || '', uid = d.me.id; const cut = (await cfgGet(db, 'cut:' + tn)) || (await cfgGet(db, 'native:' + tn)) === '1'; await importFrom(db, tn, d, uid, !cut); if (!cut) await cfgSet(db, 'cut:' + tn, Date.now());
  if (pw) await setAuth(db, tn, uid, pw); if (d.plat) await cfgSet(db, 'plat:' + uid, '1'); const t = await newSess(db, tn, uid, gt); return { token: t, user: pub(d.me) }; }
async function login(env, ident, pw, waitUntil) { const db = env.DB, k = 'lf:' + String(ident || '').trim().toLowerCase(), n = await throttle(db, k);
  const u = await findUser(db, ident); const a = u ? await db.prepare('SELECT salt, hash FROM auth WHERE tn = ? AND uid = ?').bind(u._tn, u.id).first() : null;
  if (u && a) { if ((await pbk(a.salt, pw)) !== a.hash) throw new UErr(await failTry(db, k, n)); if (u.active === false) throw new UErr('الحساب غير مفعّل — تواصل مع المدير');
    const ten = await tenOf(db, u._tn); if (u._tn && tenState(ten) === 'suspended') throw new UErr('حساب الشركة موقوف حالياً — تواصل مع إدارة يومي');
    await db.prepare('DELETE FROM ltry WHERE k = ?').bind(k).run(); const t = await newSess(db, u._tn, u.id, null), th = await sha('yw|' + t);
    // جلسة Google في الخلفية: تُستخدم فقط لإرسال النسخة الاحتياطية وخدمات Google (التقويم، Drive…)
    waitUntil((async () => { try { const g = await gasOpen(env, 'login', [ident, pw]); if (g.ok && g.data && g.data.token) await db.prepare('UPDATE sess2 SET gt = ?, gt_at = ? WHERE th = ?').bind(g.data.token, Date.now(), th).run(); await drain(env, 20000); } catch (e) {} })());
    return { token: t, user: pub(u) }; }
  const g = await gasOpen(env, 'login', [ident, pw]); if (!g.ok) { if (/غير صحيحة/.test(g.error || '')) throw new UErr(await failTry(db, k, n)); throw new UErr(g.error || 'تعذّر الدخول'); }
  await db.prepare('DELETE FROM ltry WHERE k = ?').bind(k).run(); return adoptGoogle(env, g.data, pw); }

// ---------- العمليات الأصلية ----------
async function nGetAll(env, C) { const db = env.DB, u = C.u, tn = C.tn, po = C.po, B = Object.fromEntries(C.US.map(x => [x.id, x]));
  const mineRel = x => x.owner === u.id || x.assignedBy === u.id || (wfReq(x) && wfReq(x).ap === u.id);
  let items = (await rowsOf(db, 'items', tn)).filter(x => (x.space !== 'p' || (x.owner === u.id && po)) && (!x.pv || x.owner === u.id));
  items = can(u, 'team') ? items.filter(x => mineRel(x) || seeScope(u, B[x.owner])) : items.filter(mineRel);
  const notes = {}; (await db.prepare('SELECT date, text FROM notes WHERE tn = ? AND owner = ?').bind(tn, u.id).all()).results.forEach(r => notes[r.date] = r.text || '');
  const fin = can(u, 'finance');
  const projects = (await rowsOf(db, 'projects', tn)).filter(p => p.space === 'p' ? (p.createdBy === u.id && po) : (can(u, 'projects') || (Array.isArray(p.team) && p.team.includes(u.id)))).map(p => p.space === 'p' || fin ? p : stripFin(p));
  const cOK = can(u, 'projects') && xcan(C.X, u, 'clients'), bOK = xcan(C.X, u, 'brk');
  const contacts = (await rowsOf(db, 'contacts', tn)).filter(c => c.space === 'p' ? (c.createdBy === u.id && po) : (cOK || (bOK && can(u, 'projects') && c.cat === 'contractor'))).map(c => c.space === 'p' || bOK ? c : Object.assign({}, c, { refs: [] }));
  const plat = !tn && u.role === 'owner';
  return { me: pub(u), users: usersFor(u, C.US), items, notes, projects, contacts, priv: { pin: C.pin, open: po }, ten: C.ten ? Object.assign({}, C.ten, { ro: C.ro }) : null, plat, cf: 1, v3: 1 }; }
async function nSaveItem(env, C, obj) { const db = env.DB, u = C.u, tn = C.tn; if (!obj || !obj.id) throw new UErr('بيانات غير صالحة'); let ev = null;
  const row = await db.prepare('SELECT data FROM items WHERE tn = ? AND id = ?').bind(tn, String(obj.id)).first(), old = row ? JSON.parse(row.data) : null;
  if (old && old.space === 'p' && old.owner !== u.id) throw new UErr('غير مسموح'); const ow0 = old ? old.owner : '';
  const canAp = o => { if (!o) return false; if (u.role === 'owner') return true; if (o.assignedBy && o.assignedBy === u.id) return true; const r = wfReq(o); if (r && r.ap === u.id) return true; return can(u, 'approve') && o.owner !== u.id && seeScope(u, byId(C, o.owner)); };
  const approverFor = o => { const ab = o.assignedBy && byId(C, o.assignedBy); if (ab && ab.active !== false) return ab.id; const ow = byId(C, o.owner) || {}; const L = C.US.filter(a => a.active !== false && a.id !== o.owner && (a.role === 'owner' || can(a, 'approve')) && seeScope(a, ow)).sort((a, b) => rank(a.role) - rank(b.role)); return L.length ? L[0].id : ''; };
  if (obj.space === 'p' || (old && old.space === 'p')) { if (!C.po) throw new UErr('أعمالك الخاصة مقفلة — افتحها بالرقم السري أولاً'); obj.space = 'p'; obj.owner = u.id; obj.assignedBy = ''; }
  else if (!old) { if (!obj.owner) obj.owner = u.id;
    if (obj.owner !== u.id) { need(u, 'assign'); if (!inScope(u, byId(C, obj.owner))) throw new UErr('هذا الموظف خارج فرعك/قسمك'); obj.assignedBy = u.id; obj.wf = Object.assign({}, obj.wf || {}, { acc: 'pending', hist: [{ t: 'assign', by: u.id, to: obj.owner, at: Date.now() }] }); ev = ['إسناد مهمة', obj.title, 'إلى ' + ((byId(C, obj.owner) || {}).name || '')]; } else obj.assignedBy = ''; }
  else { const apv = canAp(old); if (old.owner !== u.id && !apv) { need(u, 'team'); if (!seeScope(u, byId(C, old.owner))) throw new UErr('غير مسموح'); }
    const req0 = wfReq(old), tgt = obj.owner && obj.owner !== old.owner ? byId(C, obj.owner) : null;
    const okDirect = tgt && can(u, 'assign') && inScope(u, tgt), okReq = tgt && apv && req0 && ((req0.type === 'transfer' && req0.to === obj.owner) || (req0.type === 'decline' && obj.owner === old.assignedBy));
    obj.owner = (okDirect || okReq) ? obj.owner : old.owner; obj.assignedBy = old.assignedBy || ''; obj.wf = obj.wf || old.wf || null;
    if (old.wf && old.wf.strict && !apv && u.id === old.owner) { obj.wf.strict = true; if (obj.done && !old.done) { obj.done = false; obj.doneAt = null; obj.wf.req = { type: 'done', by: u.id, at: Date.now(), note: (obj.wf.req && obj.wf.req.note) || '' }; } if (String(obj.due || '') !== String(old.due || '')) obj.due = old.due; }
    if (obj.wf && old.wf && old.wf.strict && !apv) obj.wf.strict = true;
    const req1 = wfReq(obj);
    if (req1 && (!req0 || req1.at !== req0.at)) { if (u.id !== old.owner && !apv) obj.wf.req = req0; else { req1.by = u.id; req1.at = req1.at || Date.now(); req1.ap = approverFor(old); ev = ['طلب: ' + ({ transfer: 'تحويل مهمة', due: 'تغيير موعد', done: 'اعتماد إنجاز', decline: 'اعتذار عن مهمة' }[req1.type] || req1.type), old.title, (req1.to ? 'إلى ' + ((byId(C, req1.to) || {}).name || '') + ' · ' : '') + (req1.due ? 'الموعد المقترح ' + req1.due + ' · ' : '') + (req1.note || '')]; } }
    if (req0 && !req1 && u.id !== old.owner && !apv) obj.wf.req = req0;
    if (req0 && !wfReq(obj) && apv && u.id !== old.owner) ev = [(obj.wf && obj.wf.last === 'rej' ? 'رفض ' : 'اعتماد ') + ({ transfer: 'تحويل', due: 'تغيير موعد', done: 'إنجاز', decline: 'اعتذار' }[req0.type] || ''), old.title, ''];
    if (obj.owner !== ow0) { obj.wf = obj.wf || {}; obj.wf.hist = (obj.wf.hist || []).concat([{ t: 'transfer', by: u.id, from: ow0, to: obj.owner, at: Date.now() }]); obj.wf.acc = 'pending'; ev = ['تحويل مهمة', obj.title, 'من ' + ((byId(C, ow0) || {}).name || '') + ' إلى ' + ((byId(C, obj.owner) || {}).name || '')]; } }
  obj.calId = old ? (old.calId || '') : ''; if (obj.todo === 'new' && old && old.todo && old.todo !== 'new') obj.todo = old.todo;
  ['done', 'star', 'pv'].forEach(k => obj[k] = !!obj[k]); if (!obj.due) obj.due = null;
  // v116: تعديل تم بدون إنترنت وتعارض مع تعديل أحدث من مستخدم آخر — تُحفظ النسخة الأخرى في سلة المحذوفات ولا تضيع
  const offAt = Number(obj._off || 0); delete obj._off; let conf = null;
  if (old && offAt && Number(old._at || 0) > offAt && old._by && old._by !== u.id) { conf = (byId(C, old._by) || {}).name || 'مستخدم آخر';
    await db.prepare('INSERT INTO trash (id, tn, kind, rid, title, data, uid, uname, priv, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), tn, 'item', String(old.id), ('نسخة قبل التعارض — ' + (old.title || '')).slice(0, 200), J(old), u.id, u.name || '', old.space === 'p' ? 1 : 0, Date.now()).run(); }
  obj._at = Date.now(); obj._by = u.id;
  await upItem(db, tn, obj, Date.now()).run(); await enqueue(db, C, 'item', obj.id, 'saveItem', [obj]); if (ev) await audit(db, C, ev[0], ev[1], ev[2]);
  return { calId: obj.calId || '', todo: obj.todo || '', conflict: conf }; }
async function goneMark(db, tn, kind, id) { await db.prepare('INSERT INTO gone (tn, kind, id, at) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET at = excluded.at').bind(tn, kind, String(id), Date.now()).run(); }
async function nDeleteItem(env, C, id) { const db = env.DB, u = C.u, tn = C.tn; const row = await db.prepare('SELECT data FROM items WHERE tn = ? AND id = ?').bind(tn, String(id)).first(); if (!row) return true; const o = JSON.parse(row.data);
  if (o.space === 'p' && o.owner !== u.id) throw new UErr('غير مسموح'); if (o.space === 'p' && !C.po) throw new UErr('أعمالك الخاصة مقفلة — افتحها بالرقم السري أولاً');
  if (!xcan(C.X, u, 'del')) throw new UErr('ليس لديك صلاحية الحذف');
  if (o.owner !== u.id && o.assignedBy !== u.id) { need(u, 'team'); if (!seeScope(u, byId(C, o.owner))) throw new UErr('غير مسموح'); }
  else if (o.owner === u.id && !can(u, 'team') && o.assignedBy && o.assignedBy !== u.id) throw new UErr('لا يمكنك حذف مهمة أسندها لك المدير');
  const ab = o.assignedBy ? byId(C, o.assignedBy) : null; if (ab && ab.id !== u.id && u.role !== 'owner' && rank(ab.role) > rank(u.role)) throw new UErr('لا يمكنك حذف مهمة أسندها ' + ab.name);
  if (o.owner !== u.id || o.assignedBy) await audit(db, C, 'حذف مهمة', o.title, 'صاحبها: ' + ((byId(C, o.owner) || {}).name || ''));
  await db.prepare('DELETE FROM items WHERE tn = ? AND id = ?').bind(tn, String(id)).run(); await goneMark(db, tn, 'item', id); await enqueue(db, C, 'item', id, 'deleteItem', [id]); return true; }
function projGuard(C, meta) { if (meta.space === 'p') { if (meta.createdBy !== C.u.id) throw new UErr('غير مسموح'); if (!C.po) throw new UErr('أعمالك الخاصة مقفلة — افتحها بالرقم السري أولاً'); } else need(C.u, 'projectsEdit'); }
async function nSaveProject(env, C, p, base, force) { const db = env.DB, tn = C.tn; if (!p || !p.id || !String(p.name || '').trim()) throw new UErr('اكتب اسم المشروع'); if (J(p).length > 90000) throw new UErr('بيانات المشروع كبيرة جداً — احذف بعض الملفات أو الجداول');
  const row = await db.prepare('SELECT data, updated_at FROM projects WHERE tn = ? AND id = ?').bind(tn, String(p.id)).first(), old = row ? JSON.parse(row.data) : null;
  let merged = false; const chg = Array.isArray(p._chg) ? p._chg.filter(k => typeof k === 'string' && !/^(id|createdBy|space|updatedAt|updatedBy)$/.test(k)) : null; delete p._chg;
  if (old && base && !force && Number(old.updatedAt || 0) > Number(base) + 1000) {
    // v122: دمج تلقائي حقلاً حقلاً — تعديلك يُطبَّق على أحدث نسخة دون إلغاء تعديلات الآخرين
    if (chg && chg.length) { const m = JSON.parse(J(old)); chg.forEach(k => { if (k in p) m[k] = p[k]; else delete m[k]; }); p = m; merged = true; }
    else throw new UErr('CONFLICT:' + ((byId(C, old.updatedBy) || {}).name || '') + '|' + old.updatedAt); }
  if (old) { projGuard(C, { space: old.space || '', createdBy: old.createdBy || '' }); p.createdBy = old.createdBy || C.u.id; p.space = old.space || ''; if (p.space !== 'p' && !can(C.u, 'finance')) keepFin(p, old); }
  else { p.createdBy = C.u.id; p.space = p.space === 'p' ? 'p' : ''; projGuard(C, p); } delete p._nofin;
  const now = Date.now(); p.updatedAt = now; p.updatedBy = C.u.id; await upProj(db, tn, p, now).run(); await enqueue(db, C, 'project', p.id, 'saveProject', [p, 0, true]); return merged ? { updatedAt: now, merged: true, p } : { updatedAt: now }; }
async function nSaveContact(env, C, c) { const db = env.DB, tn = C.tn; if (!c || !c.id || !String(c.name || '').trim()) throw new UErr('اكتب اسم العميل'); if (J(c).length > 90000) throw new UErr('بيانات العميل كبيرة جداً');
  const row = await db.prepare('SELECT data FROM contacts WHERE tn = ? AND id = ?').bind(tn, String(c.id)).first(), old = row ? JSON.parse(row.data) : null;
  if (old) { projGuard(C, { space: old.space || '', createdBy: old.createdBy || '' }); c.createdBy = old.createdBy || C.u.id; c.space = old.space || ''; if (old.cat === 'contractor' && !xcan(C.X, C.u, 'brk') && c.space !== 'p') c.refs = old.refs || []; }
  else { c.createdBy = C.u.id; c.space = c.space === 'p' ? 'p' : ''; projGuard(C, c); }
  c.updatedAt = Date.now(); await upCont(db, tn, c, c.updatedAt).run(); await enqueue(db, C, 'contact', c.id, 'saveContact', [c]); return true; }
async function nDelete(env, C, kind, id) { const db = env.DB, tn = C.tn, table = DEL[kind]; const row = await db.prepare(`SELECT data FROM ${table} WHERE tn = ? AND id = ?`).bind(tn, String(id)).first(); if (!row) return true; const o = JSON.parse(row.data);
  projGuard(C, { space: o.space || '', createdBy: o.createdBy || '' }); if (!xcan(C.X, C.u, 'del')) throw new UErr('ليس لديك صلاحية الحذف');
  await db.prepare(`DELETE FROM ${table} WHERE tn = ? AND id = ?`).bind(tn, String(id)).run(); await goneMark(db, tn, kind, id); if (kind === 'project' && o.space !== 'p') await audit(db, C, 'حذف مشروع', o.name, '');
  await enqueue(db, C, kind, id, { project: 'deleteProject', contact: 'deleteContact' }[kind], [id]); return true; }
async function nUsersOp(env, C, fn, a) { // عمليات المستخدمين: تُطبَّق في Google مباشرة (حتى تبقى الإشعارات والبريد متوافقة) ثم تُحدَّث هنا فوراً
  const db = env.DB, u = C.u; if (fn === 'listUsers') { need(u, 'users'); return usersFor(u, C.US); }
  if (!(fn === 'updateUser' && a[0] === u.id)) need(u, 'users');
  if (fn === 'updateUser') { const tgt = byId(C, a[0]); if (!tgt) throw new UErr('المستخدم غير موجود'); if (a[0] !== u.id && !canManage(u, tgt)) throw new UErr(tgt.role === 'owner' ? 'لا يمكن تعديل حساب المالك إلا من قِبله' : 'غير مسموح بتعديل مستخدم في مستواك نفسه أو أعلى أو خارج فرعك/قسمك'); }
  if (fn === 'deleteUser') { const tgt = byId(C, a[0]); if (!tgt || !canManage(u, tgt)) throw new UErr('غير مسموح'); }
  const gt = await gtFor(db, C.tn, u.id); if (!gt) throw new UErr('سجّل الخروج ثم الدخول مرة واحدة لتفعيل إدارة المستخدمين على الخادم الجديد');
  await drain(env, 15000); const r = await gasCall(env, gt, fn, a); if (!r.ok) throw new UErr(r.error || 'تعذّر التنفيذ'); const now = Date.now(), B = [];
  (Array.isArray(r.data) ? r.data : []).filter(x => x && x.id && x.username !== undefined).forEach(x => B.push(upUser(db, C.tn, x, now)));
  if (fn === 'deleteUser') { B.push(db.prepare('DELETE FROM users WHERE tn = ? AND id = ?').bind(C.tn, a[0]), db.prepare('DELETE FROM sess2 WHERE tn = ? AND uid = ?').bind(C.tn, a[0]), db.prepare('DELETE FROM auth WHERE tn = ? AND uid = ?').bind(C.tn, a[0]));
    const L = await rowsOf(db, 'items', C.tn); L.forEach(o => { if (o.owner === a[0]) { if (o.space === 'p') B.push(db.prepare('DELETE FROM items WHERE tn = ? AND id = ?').bind(C.tn, o.id)); else { o.owner = u.id; if (o.assignedBy === u.id) o.assignedBy = ''; B.push(upItem(db, C.tn, o, now)); } } else if (o.assignedBy === a[0]) { o.assignedBy = ''; B.push(upItem(db, C.tn, o, now)); } }); }
  if (fn === 'addUser' && a[3]) { const nu = (Array.isArray(r.data) ? r.data : []).find(x => x.username === String(a[0] || '').trim().toLowerCase()); if (nu) await setAuth(db, C.tn, nu.id, a[3]); }
  if (fn === 'updateUser' && a[1] && a[1].password) { await setAuth(db, C.tn, a[0], a[1].password); B.push(db.prepare('DELETE FROM sess2 WHERE tn = ? AND uid = ? AND th != ?').bind(C.tn, a[0], C.th)); }
  if (fn === 'updateUser' && a[1] && a[1].active === false) B.push(db.prepare('DELETE FROM sess2 WHERE tn = ? AND uid = ?').bind(C.tn, a[0]));
  await batchAll(db, B); await audit(db, C, { addUser: 'إضافة مستخدم', updateUser: 'تعديل مستخدم', deleteUser: 'حذف مستخدم' }[fn], (byId(C, a[0]) || {}).name || a[1] || '', ''); await bump(db, C.tn); return r.data; }
async function nPriv(env, C, fn, a) { const db = env.DB, u = C.u, tn = C.tn;
  if (fn === 'lockPriv') { await db.prepare('UPDATE sess2 SET pv = 0 WHERE th = ?').bind(C.th).run(); return true; }
  const privData = async () => { const items = (await rowsOf(db, 'items', tn)).filter(x => x.space === 'p' && x.owner === u.id), projects = (await rowsOf(db, 'projects', tn)).filter(p => p.space === 'p' && p.createdBy === u.id), contacts = (await rowsOf(db, 'contacts', tn)).filter(c => c.space === 'p' && c.createdBy === u.id); return { priv: { pin: !!(await db.prepare('SELECT 1 x FROM pins WHERE tn = ? AND uid = ?').bind(tn, u.id).first()), open: true }, items, projects, contacts }; };
  const open = () => db.prepare('UPDATE sess2 SET pv = ? WHERE th = ?').bind(Date.now() + PRIV_MIN * 60000, C.th).run();
  if (fn === 'unlockPriv') { const p = await db.prepare('SELECT salt, hash FROM pins WHERE tn = ? AND uid = ?').bind(tn, u.id).first(), k = 'pf:' + tn + ':' + u.id, n = await throttle(db, k);
    if (p) { if ((await pbk(p.salt, String(a[0] ?? '').trim())) !== p.hash) { await failTry(db, k, n); throw new UErr('الرقم السري غير صحيح'); } await open(); return privData(); }
    const gt = await gtFor(db, tn, u.id); if (!gt) throw new UErr('سجّل الخروج ثم الدخول مرة واحدة لفتح أعمالك الخاصة على الخادم الجديد');
    const r = await gasCall(env, gt, 'unlockPriv', a); if (!r.ok) throw new UErr(r.error || 'الرقم السري غير صحيح');
    if (r.data && r.data.priv && r.data.priv.pin) { const salt = rnd(16); await db.prepare('INSERT INTO pins (tn, uid, salt, hash) VALUES (?, ?, ?, ?) ON CONFLICT(tn, uid) DO UPDATE SET salt = excluded.salt, hash = excluded.hash').bind(tn, u.id, salt, await pbk(salt, String(a[0] ?? '').trim())).run(); }
    await importFrom(db, tn, r.data || {}, u.id, true); await open(); return privData(); }
  if (fn === 'setPrivPin') { const a2 = await db.prepare('SELECT salt, hash FROM auth WHERE tn = ? AND uid = ?').bind(tn, u.id).first(); if (!a2 || (await pbk(a2.salt, a[0])) !== a2.hash) throw new UErr('كلمة مرور الحساب غير صحيحة');
    const pin = String(a[1] ?? '').trim(); if (!pin) await db.prepare('DELETE FROM pins WHERE tn = ? AND uid = ?').bind(tn, u.id).run();
    else { if (pin.length < 4 || pin.length > 20) throw new UErr('الرقم السري من 4 إلى 20 حرفاً أو رقماً'); const salt = rnd(16); await db.prepare('INSERT INTO pins (tn, uid, salt, hash) VALUES (?, ?, ?, ?) ON CONFLICT(tn, uid) DO UPDATE SET salt = excluded.salt, hash = excluded.hash').bind(tn, u.id, salt, await pbk(salt, pin)).run(); await open(); }
    return privData(); } }
async function nAudit(env, C, n) { const db = env.DB; need(C.u, 'audit'); const R = (await db.prepare('SELECT at, by, byName, action, target, details FROM audit WHERE tn = ? ORDER BY at DESC LIMIT ?').bind(C.tn, Math.min(Number(n) || 400, 2000)).all()).results
  .map(r => ({ at: new Date(r.at + 3 * 3600000).toISOString().slice(0, 16).replace('T', ' '), by: r.by, byName: r.byName, action: r.action, target: r.target, details: r.details }));
  let old = []; const gt = await gtFor(db, C.tn, C.u.id); if (gt) { try { const g = await gasCall(env, gt, 'listAudit', [n]); if (g.ok) old = g.data || []; } catch (e) {} }
  const seen = new Set(R.map(r => r.at + r.action + r.target)); const all = R.concat(old.filter(r => !seen.has(r.at + r.action + r.target)));
  return (C.u.role === 'owner' || C.u.role === 'ceo') ? all : all.filter(r => r.by === C.u.id || seeScope(C.u, byId(C, r.by))); }

// ---------- سلة المحذوفات والإنجازات والصلاحيات الإضافية والإجازات ----------
const TRASH = new Set(['trashPut', 'trashList', 'trashDel', 'achList', 'achPut', 'achDel', 'xpGet', 'xpSet', 'holSet', 'orgSet', 'diagLog']);
async function trashOp(db, C, fn, a) { const u = C.u, tn = C.tn, big = ['owner', 'ceo', 'branch'].includes(u.role), now = Date.now();
  if (fn === 'trashPut') { const [kind, o] = a; if (!o || !o.id || !['item', 'project', 'contact', 'ref'].includes(kind)) throw new UErr('بيانات غير صالحة'); const d = J(o); if (d.length > 120000) throw new UErr('العنصر كبير جداً');
    await db.batch([db.prepare('INSERT INTO trash (id, tn, kind, rid, title, data, uid, uname, priv, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), tn, kind, String(o.id), String(o.title || o.name || o.co || '').slice(0, 200), d, u.id, u.name || '', o.space === 'p' || o.pv ? 1 : 0, now), db.prepare('DELETE FROM trash WHERE tn = ? AND at < ?').bind(tn, now - 30 * 864e5)]); return true; }
  if (fn === 'trashList') { if (!xcan(C.X, u, 'trash')) throw new UErr('ليس لديك صلاحية سلة المحذوفات'); const r = (await db.prepare('SELECT id, kind, rid, title, data, uid, uname, priv, at FROM trash WHERE tn = ? AND at > ? ORDER BY at DESC LIMIT 400').bind(tn, now - 30 * 864e5).all()).results;
    return r.filter(x => x.uid === u.id || (big && !x.priv)).map(x => Object.assign(x, { data: JSON.parse(x.data || 'null') })); }
  if (fn === 'trashDel') { const x = await db.prepare('SELECT uid, priv, kind, rid FROM trash WHERE id = ? AND tn = ?').bind(String(a[0] || ''), tn).first(); if (!x) return true; if (x.uid !== u.id && !(big && !x.priv)) throw new UErr('غير مسموح');
    await db.batch([db.prepare('DELETE FROM trash WHERE id = ?').bind(String(a[0])), db.prepare('DELETE FROM gone WHERE tn = ? AND kind = ? AND id = ?').bind(tn, x.kind, x.rid)]); return true; }
  if (fn === 'achList' || fn === 'achPut' || fn === 'achDel') { const uid = String((fn === 'achPut' ? (a[0] || {}).uid : a[0]) || u.id); if (uid !== u.id) { const t = byId(C, uid); if (!(u.role === 'owner' || (xcan(C.X, u, 'achTeam') && can(u, 'team') && t && seeScope(u, t)))) throw new UErr('غير مسموح'); }
    if (fn === 'achList') return (await db.prepare('SELECT data FROM ach WHERE tn = ? AND uid = ?').bind(tn, uid).all()).results.map(x => JSON.parse(x.data || 'null')).filter(Boolean);
    if (fn === 'achPut') { const o = a[0] || {}; if (!o.k) throw new UErr('بيانات غير صالحة'); const d = J(o); if (d.length > 8000) throw new UErr('البيانات كبيرة جداً'); await db.prepare('INSERT INTO ach (tn, uid, k, data, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tn, uid, k) DO UPDATE SET data = excluded.data, at = excluded.at').bind(tn, uid, String(o.k), d, now).run(); return true; }
    await db.prepare('DELETE FROM ach WHERE tn = ? AND uid = ? AND k = ?').bind(tn, uid, String(a[1] || '')).run(); return true; }
  if (fn === 'xpGet') return { xp: C.X, hol: JSON.parse((await cfgGet(db, 'hol:' + tn)) || '[]'), org: JSON.parse((await cfgGet(db, 'org:' + tn)) || '{}') };
  if (fn === 'orgSet') { if (!big) throw new UErr('إعدادات الشركة للمالك والإدارة العليا فقط'); const o = a[0] && typeof a[0] === 'object' ? a[0] : {}; const d = J(o); if (d.length > 20000) throw new UErr('الإعدادات كبيرة جداً'); await cfgSet(db, 'org:' + tn, d); return true; }
  if (fn === 'diagLog') { const o = a[0] && typeof a[0] === 'object' ? a[0] : {}; await cfgSet(db, 'diag:' + tn, J(Object.assign({}, o, { at: now, by: u.id }))); return true; }
  if (fn === 'xpSet') { if (!(u.role === 'owner' || u.role === 'ceo')) throw new UErr('توزيع الصلاحيات للمالك والرئيس التنفيذي فقط'); const t = byId(C, String(a[0] || '')); if (!t || t.role === 'owner') throw new UErr('غير مسموح'); const m = Object.assign({}, C.X), o = {}; Object.entries(a[1] || {}).slice(0, 30).forEach(([k, v]) => o[String(k).slice(0, 20)] = !!v); m[t.id] = o; await cfgSet(db, 'xp:' + tn, J(m)); await audit(db, C, 'صلاحيات الصفحات', t.name, Object.keys(o).filter(k => o[k]).join('، ')); return true; }
  if (fn === 'holSet') { if (!big) throw new UErr('غير مسموح'); const L = (Array.isArray(a[0]) ? a[0] : []).filter(d => /^\d{4}-\d\d-\d\d$/.test(d)).slice(0, 200); await cfgSet(db, 'hol:' + tn, J(L)); return true; }
  throw new UErr('عملية غير معروفة'); }

// ---------- نقطة الدخول ----------
const OPEN = new Set(['setupStatus', 'setup', 'forgotPw', 'resetPw', 'signup', 'logErr', 'ext', 'extVerify']);
const WRITES = new Set(['saveItem', 'deleteItem', 'saveProject', 'deleteProject', 'saveContact', 'deleteContact', 'saveNote', 'saveMat', 'addUser', 'updateUser', 'deleteUser', 'restoreTenant', 'setPrivPin', 'trashDel', 'xpSet']);
const TREAD = new Set(['getMat', 'getAll', 'listUsers', 'listAudit', 'listIdeas', 'lockPriv', 'unlockPriv', 'logout', 'trashList', 'achList', 'xpGet', 'todoStatus', 'health']);
export async function onRequestPost({ request, env, waitUntil }) {
  const body = await request.text(); const t0 = Date.now(); const db = env.DB; let req = {}; try { req = JSON.parse(body); } catch (e) {}
  const fn = String(req.fn || ''), a = Array.isArray(req.args) ? req.args : [];
  if (!db) return fail('قاعدة البيانات غير مربوطة');
  try {
    await init(db);
    if (fn === 'login') { const r = await login(env, a[0], a[1], waitUntil); if (a[2] && r && r.token) { try { await env.DB.prepare('UPDATE sess2 SET rem = 1 WHERE th = ?').bind(await sha('yw|' + r.token)).run(); } catch (e) {} } return ok(r); }
    if (OPEN.has(fn)) { // تمرير إلى Google ثم تبنّي الجلسة إن عادت بجلسة
      const r = await gasOpen(env, fn, a); if (!r.ok) return fail(r.error || 'تعذّر التنفيذ');
      if ((fn === 'setup' || fn === 'resetPw' || fn === 'signup') && r.data && r.data.token) return ok(await adoptGoogle(env, r.data, fn === 'resetPw' ? a[2] : fn === 'setup' ? a[2] : (a[0] || {}).password));
      return ok(r.data); }
    const th = req.t ? await sha('yw|' + req.t) : '';
    let C = await ctxOf(db, th);
    if (!C && req.t) { // جلسة قديمة من Google (قبل v111): تُنقل تلقائياً دون إعادة الدخول
      const o = await db.prepare('SELECT tn, uid FROM ss WHERE th = ?').bind(th).first();
      if (o) { const g = await gasCall(env, req.t, 'getAll', []).catch(() => null); if (g && g.ok) { const d = g.data, tn = (d.ten && d.ten.id) || ''; const cut = (await cfgGet(db, 'cut:' + tn)) || (await cfgGet(db, 'native:' + tn)) === '1'; await importFrom(db, tn, d, d.me.id, !cut); if (!cut) await cfgSet(db, 'cut:' + tn, Date.now());
        await db.prepare('INSERT OR REPLACE INTO sess2 (th, tn, uid, exp, last, pv, gt, gt_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(th, tn, d.me.id, Date.now() + SESSION_DAYS * 864e5, Date.now(), d.priv && d.priv.open && d.priv.pin ? Date.now() + PRIV_MIN * 60000 : 0, req.t, Date.now()).run(); C = await ctxOf(db, th); } } }
    if (!C) return fail(fn === 'logout' ? 'ok' : 'انتهت الجلسة — سجّل الدخول مرة أخرى');
    if (fn === 'logout') { await db.prepare('DELETE FROM sess2 WHERE th = ?').bind(th).run(); if (C.s.gt) waitUntil(gasCall(env, C.s.gt, 'logout', []).catch(() => {})); return ok(true); }
    if (C.ro && !TREAD.has(fn)) return fail('انتهت الفترة التجريبية — الحساب الآن للعرض فقط. بياناتك محفوظة كما هي، وتواصل معنا لتفعيل الاشتراك');
    if (fn === 'cfNative') { if (C.u.role !== 'owner') return fail('هذه العملية للمالك فقط'); await cfgSet(db, 'native:' + C.tn, a[0] ? '1' : '0'); await log(db, C.tn, C.u.id, 'cfNative:' + (a[0] ? 'on' : 'off'), 1, 0, null); return ok({ native: !!a[0] }); }
    const native = await nativeOn(db, C.tn); let data, done = true;
    try {
      if (TRASH.has(fn)) data = await trashOp(db, C, fn, a);
      else if (!native) done = false;
      else if (fn === 'getAll') data = await nGetAll(env, C);
      else if (fn === 'saveItem') data = await nSaveItem(env, C, a[0]);
      else if (fn === 'deleteItem') data = await nDeleteItem(env, C, a[0]);
      else if (fn === 'saveProject') data = await nSaveProject(env, C, a[0], a[1], a[2]);
      else if (fn === 'deleteProject') data = await nDelete(env, C, 'project', a[0]);
      else if (fn === 'saveContact') data = await nSaveContact(env, C, a[0]);
      else if (fn === 'deleteContact') data = await nDelete(env, C, 'contact', a[0]);
      else if (fn === 'saveNote') { await upNote(db, C.tn, C.u.id, String(a[0]), a[1], Date.now()).run(); await enqueue(db, C, 'note', C.u.id + ':' + a[0], 'saveNote', a); data = true; }
      else if (fn === 'getMat') { const v = await cfgGet(db, 'mat:' + C.tn); if (v != null) data = JSON.parse(v); else { const gt = C.s.gt || await gtFor(db, C.tn, C.u.id); const r = gt ? await gasCall(env, gt, 'getMat', []).catch(() => null) : null; data = r && r.ok ? r.data || {} : {}; await cfgSet(db, 'mat:' + C.tn, J(data)); } }
      else if (fn === 'saveMat') { if (C.u.role !== 'owner' && !can(C.u, 'projectsEdit')) throw new UErr('تعديل الأسعار متاح للمالك ومن يملك صلاحية تعديل المشاريع'); const d = a[0] && typeof a[0] === 'object' ? a[0] : {}; await cfgSet(db, 'mat:' + C.tn, J(d)); await enqueue(db, C, 'mat', '', 'saveMat', [d]); data = d; }
      else if (['listUsers', 'addUser', 'updateUser', 'deleteUser'].includes(fn)) data = await nUsersOp(env, C, fn, a);
      else if (['setPrivPin', 'unlockPriv', 'lockPriv'].includes(fn)) data = await nPriv(env, C, fn, a);
      else if (fn === 'listAudit') data = await nAudit(env, C, a[0]);
      else done = false;
    } catch (e) { if (e instanceof UErr) return fail(e.message); throw e; }
    if (done) { const ver = WRITES.has(fn) ? await bump(db, C.tn) : 0;
      waitUntil((async () => { try { await drain(env, 20000); const rk = 'rec:' + C.tn, last = Number(await cfgGet(db, rk) || 0); if (Date.now() - last > RECONCILE_MIN * 60000 && (C.u.role === 'owner' || can(C.u, 'team'))) { await cfgSet(db, rk, Date.now()); await reconcile(env, C); }
          else if (C.s.gt && Date.now() - (C.s.gt_at || 0) > KEEPALIVE_MIN * 60000) { await db.prepare('UPDATE sess2 SET gt_at = ? WHERE th = ?').bind(Date.now(), th).run(); await gasCall(env, C.s.gt, 'todoStatus', []).catch(() => {}); } } catch (e) { try { await log(db, C.tn, C.u.id, 'bg:' + fn, 0, 0, e.message || e); } catch (x) {} } })());
      return ok(data, ver); }
    // خدمات Google فقط (Drive، Notability، To Do، البريد، الأفكار، المشتركون…) — بجلسة Google الخاصة بالمستخدم
    const gt = C.s.gt || await gtFor(db, C.tn, C.u.id);
    if (!gt) return fail('خدمات Google (Drive، To Do، Notability…) تحتاج تسجيل الدخول مرة أخرى لتفعيلها');
    let r; try { r = await gasCall(env, gt, fn, a); } catch (e) { return fail('تعذّر الاتصال بخدمات Google — حاول مرة أخرى'); }
    if (!r.ok && /سجّل الدخول|انتهت الجلسة/.test(r.error || '')) { await db.prepare('UPDATE sess2 SET gt = NULL WHERE gt = ?').bind(gt).run(); return fail('انتهت جلسة خدمات Google — سجّل الخروج ثم الدخول لتجديدها'); }
    if (r.ok && fn === 'restoreTenant') waitUntil((async () => { try { const g = await gasCall(env, gt, 'getAll', []); if (g.ok) await importFrom(db, C.tn, g.data, C.u.id, true); } catch (e) {} })());
    return new Response(J(r), { headers: H });
  } catch (e) { if (e instanceof UErr) return fail(e.message); try { await log(db, '', '', 'err:' + fn, 0, Date.now() - t0, e.message || e); } catch (x) {} return fail('خطأ في الخادم — حاول مرة أخرى'); }
}
export async function onRequestGet({ request, env }) { // حالة الخادم؛ ورقم إصدار البيانات (?v=1&t=رمز) لمزامنة الأجهزة
  const o = { ok: true, gateway: true, d1: !!env.DB, v3: 1 }; const url = new URL(request.url), t = url.searchParams.get('t');
  if (!env.DB) return new Response(J(o), { headers: H });
  try { const db = env.DB; await init(db); const th = t ? await sha('yw|' + t) : ''; const s = th ? (await db.prepare('SELECT tn, uid FROM sess2 WHERE th = ?').bind(th).first() || await db.prepare('SELECT tn, uid FROM ss WHERE th = ?').bind(th).first()) : null;
    if (url.searchParams.get('v')) return new Response(J({ ok: true, ver: s ? Number(await cfgGet(db, 'ver:' + (s.tn || '')) || 0) : null }), { headers: H });
    o.lastSync = (await db.prepare('SELECT MAX(at) n FROM sync_log WHERE ok = 1').first()).n;
    if (s) { const tn = s.tn || '', c = async q => (await db.prepare(q).bind(tn).first()).n;
      Object.assign(o, { native: await nativeOn(db, tn), cut: Number(await cfgGet(db, 'cut:' + tn) || 0), items: await c('SELECT COUNT(*) n FROM items WHERE tn = ?'), projects: await c('SELECT COUNT(*) n FROM projects WHERE tn = ?'), contacts: await c('SELECT COUNT(*) n FROM contacts WHERE tn = ?'), users: await c('SELECT COUNT(*) n FROM users WHERE tn = ?'),
        migrated: await c('SELECT COUNT(*) n FROM auth WHERE tn = ?'), pending: await c('SELECT COUNT(*) n FROM outbox WHERE done = 0 AND tn = ?'), sentOk: await c('SELECT COUNT(*) n FROM outbox WHERE done = 1 AND err IS NULL AND tn = ?'),
        lastErr: ((await db.prepare('SELECT err FROM outbox WHERE tn = ? AND err IS NOT NULL ORDER BY seq DESC LIMIT 1').bind(tn).first()) || {}).err || null,
        errors24h: (await db.prepare('SELECT COUNT(*) n FROM sync_log WHERE ok = 0 AND at > ?').bind(Date.now() - 864e5).first()).n,
        recentErrors: (await db.prepare('SELECT at, fn, substr(err, 1, 160) err FROM sync_log WHERE ok = 0 ORDER BY at DESC LIMIT 4').all()).results }); } } catch (e) { o.err = String(e.message || e); }
  return new Response(J(o), { headers: H }); }
