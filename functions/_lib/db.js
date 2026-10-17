// يومي — الخادم الجديد: جداول D1 وطبقة الوصول للبيانات (المستخدمون، الجلسات، المشتركون، السجل)
// كل جدول يحمل عمود tn (معرّف المشترك؛ '' = المساحة الرئيسية) بدلاً من ملف Google Sheet لكل مشترك.
import { rid, todayISO, stamp, fail } from './core.js';

export const SCHEMA_V2 = [
  `CREATE TABLE IF NOT EXISTS t_users (tn TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, username TEXT NOT NULL, name TEXT, role TEXT, salt TEXT, hash TEXT, active INTEGER DEFAULT 1, created_at INTEGER, email TEXT, phone TEXT, prefs TEXT, perms TEXT, org TEXT, PRIMARY KEY (tn, id))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS t_users_un ON t_users (username)`,
  `CREATE INDEX IF NOT EXISTS t_users_em ON t_users (email)`,
  `CREATE INDEX IF NOT EXISTS t_users_ph ON t_users (phone)`,
  `CREATE TABLE IF NOT EXISTS t_sessions (th TEXT PRIMARY KEY, uid TEXT NOT NULL, tn TEXT NOT NULL DEFAULT '', exp INTEGER, last INTEGER, pv INTEGER)`,
  `CREATE INDEX IF NOT EXISTS t_sessions_uid ON t_sessions (tn, uid)`,
  `CREATE TABLE IF NOT EXISTS t_kv (k TEXT PRIMARY KEY, v TEXT, exp INTEGER)`,
  `CREATE TABLE IF NOT EXISTS t_tenants (id TEXT PRIMARY KEY, name TEXT, kind TEXT, status TEXT, trial_start TEXT, trial_end TEXT, paid_until TEXT, max_users INTEGER DEFAULT 1, owner_name TEXT, email TEXT, phone TEXT, created_at INTEGER, notes TEXT, plan TEXT, sheet_id TEXT, folder_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS t_pins (tn TEXT NOT NULL DEFAULT '', uid TEXT NOT NULL, s TEXT, h TEXT, PRIMARY KEY (tn, uid))`,
  `CREATE TABLE IF NOT EXISTS t_audit (tn TEXT NOT NULL DEFAULT '', at TEXT, by_id TEXT, by_name TEXT, action TEXT, target TEXT, details TEXT, ts INTEGER)`,
  `CREATE INDEX IF NOT EXISTS t_audit_tn ON t_audit (tn, ts)`,
  // البيانات (تُستخدم في الجزء الثاني من المرحلة 3)
  `CREATE TABLE IF NOT EXISTS t_items (tn TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, owner TEXT, assigned_by TEXT, space TEXT, pv INTEGER DEFAULT 0, due TEXT, done INTEGER DEFAULT 0, data TEXT NOT NULL, updated_at INTEGER, PRIMARY KEY (tn, id))`,
  `CREATE INDEX IF NOT EXISTS t_items_owner ON t_items (tn, owner)`,
  `CREATE TABLE IF NOT EXISTS t_notes (tn TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL, date TEXT NOT NULL, text TEXT, updated_at INTEGER, PRIMARY KEY (tn, owner, date))`,
  `CREATE TABLE IF NOT EXISTS t_projects (tn TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, name TEXT, status TEXT, space TEXT, created_by TEXT, data TEXT NOT NULL, updated_at INTEGER, updated_by TEXT, PRIMARY KEY (tn, id))`,
  `CREATE TABLE IF NOT EXISTS t_contacts (tn TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, name TEXT, cat TEXT, space TEXT, created_by TEXT, data TEXT NOT NULL, updated_at INTEGER, updated_by TEXT, PRIMARY KEY (tn, id))`,
  `CREATE TABLE IF NOT EXISTS t_ideas (tn TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, title TEXT, status TEXT, data TEXT NOT NULL, updated_at INTEGER, updated_by TEXT, PRIMARY KEY (tn, id))`,
  `CREATE TABLE IF NOT EXISTS t_mat (tn TEXT PRIMARY KEY, data TEXT, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS t_meta (k TEXT PRIMARY KEY, v TEXT)`,
];
let readyV2 = false;
export async function initV2(db) { if (readyV2) return; await db.batch(SCHEMA_V2.map(q => db.prepare(q))); readyV2 = true; }

const J = (s, d) => { try { return JSON.parse(s || '') ?? d; } catch (e) { return d; } };
export const rowUser = r => r && ({ tn: r.tn, id: r.id, username: r.username, name: r.name || '', role: r.role || 'member', salt: r.salt || '', hash: r.hash || '', active: r.active !== 0, createdAt: String(r.created_at || ''), email: r.email || '', phone: r.phone || '', prefs: J(r.prefs, {}), perms: J(r.perms, {}), org: J(r.org, {}) });
export async function usersOf(db, tn) { const { results } = await db.prepare('SELECT * FROM t_users WHERE tn = ? ORDER BY created_at').bind(tn).all(); return results.map(rowUser); }
export async function userById(db, tn, id) { return rowUser(await db.prepare('SELECT * FROM t_users WHERE tn = ? AND id = ?').bind(tn, id).first()); }
export async function saveUser(db, u) {
  await db.prepare('INSERT INTO t_users (tn, id, username, name, role, salt, hash, active, created_at, email, phone, prefs, perms, org) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tn, id) DO UPDATE SET username = excluded.username, name = excluded.name, role = excluded.role, salt = excluded.salt, hash = excluded.hash, active = excluded.active, email = excluded.email, phone = excluded.phone, prefs = excluded.prefs, perms = excluded.perms, org = excluded.org')
    .bind(u.tn || '', u.id, u.username, u.name || '', u.role || 'member', u.salt || '', u.hash || '', u.active === false ? 0 : 1, Number(u.createdAt) || Date.now(), u.email || '', u.phone || '', JSON.stringify(u.prefs || {}), JSON.stringify(u.perms || {}), JSON.stringify(u.org || {})).run();
}
// البحث باسم المستخدم أو البريد أو الجوال على مستوى المنصة كلها (يحدد المساحة تلقائياً)
export async function findUserAny(db, ident, normPhone) {
  const lo = String(ident || '').trim().toLowerCase(); if (!lo) return null;
  let r = await db.prepare('SELECT * FROM t_users WHERE username = ?').bind(lo).first(); if (r) return rowUser(r);
  if (lo.indexOf('@') > 0) { const { results } = await db.prepare('SELECT * FROM t_users WHERE lower(email) = ? LIMIT 2').bind(lo).all(); return results.length === 1 ? rowUser(results[0]) : null; }
  let ph = ''; try { ph = normPhone(lo); } catch (e) {}
  if (ph) { const { results } = await db.prepare('SELECT * FROM t_users WHERE phone = ? LIMIT 2').bind(ph).all(); return results.length === 1 ? rowUser(results[0]) : null; }
  return null;
}
// ---------- مخزن مؤقت (محاولات الدخول، رموز الاستعادة، حدود التسجيل) ----------
export async function kvGet(db, k) { const r = await db.prepare('SELECT v, exp FROM t_kv WHERE k = ?').bind(k).first(); if (!r) return null; if (r.exp && r.exp < Date.now()) { await db.prepare('DELETE FROM t_kv WHERE k = ?').bind(k).run(); return null; } return r.v; }
export async function kvPut(db, k, v, ttlSec) { await db.prepare('INSERT INTO t_kv (k, v, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp').bind(k, String(v), ttlSec ? Date.now() + ttlSec * 1000 : null).run(); }
export async function kvDel(db, k) { await db.prepare('DELETE FROM t_kv WHERE k = ?').bind(k).run(); }
// ---------- المشتركون ----------
export const rowTen = r => r && ({ id: r.id, name: r.name || '', kind: r.kind || 'company', status: r.status || 'trial', trialStart: r.trial_start || '', trialEnd: r.trial_end || '', paidUntil: r.paid_until || '', maxUsers: Number(r.max_users) || 1, ownerName: r.owner_name || '', email: r.email || '', phone: r.phone || '', createdAt: Number(r.created_at) || 0, notes: r.notes || '', plan: r.plan || '', sheetId: r.sheet_id || '', folderId: r.folder_id || '' });
export async function tenant(db, id) { const t = rowTen(await db.prepare('SELECT * FROM t_tenants WHERE id = ?').bind(id).first()); if (!t) fail('مساحة العمل غير موجودة — سجّل الدخول مرة أخرى'); return t; }
export function tenState(r) { const d = todayISO(); if (r.status === 'suspended') return 'suspended'; if (r.status === 'active') return (!r.paidUntil || r.paidUntil >= d) ? 'active' : 'expired'; return r.trialEnd >= d ? 'trial' : 'expired'; }
export function tenPub(r, contact) { const st = tenState(r), end = r.status === 'active' ? r.paidUntil : r.trialEnd;
  const left = end ? Math.ceil((Date.parse(end + 'T00:00:00+03:00') + 864e5 - Date.now()) / 864e5) : null;
  return { id: r.id, name: r.name, kind: r.kind, state: st, trialEnd: r.trialEnd, paidUntil: r.paidUntil, left, maxUsers: r.maxUsers, ro: st === 'expired', contact: contact || {} }; }
// ---------- سجل النشاط ----------
export async function audit(db, tn, u, action, target, details) { try { await db.prepare('INSERT INTO t_audit (tn, at, by_id, by_name, action, target, details, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(tn || '', stamp(), u ? u.id : '', u ? u.name : '', String(action), String(target || '').slice(0, 200), String(details || '').slice(0, 500), Date.now()).run(); } catch (e) { console.warn('audit', e); } }
export const newId = rid;
