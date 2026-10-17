// يومي — الخادم الجديد على Cloudflare (المرحلة 3): الأساسيات المشتركة
// نقل مطابق لمنطق Code.gs: تجزئة كلمات المرور، الجلسات، الأدوار والصلاحيات، والنطاق (الفرع/القسم).
// لا يُستخدم من الواجهة قبل التحويل الرسمي؛ الطلبات الحالية ما زالت تمر إلى Google عبر /api.

export const SESSION_DAYS = 30, IDLE_MIN = 30, PRIV_MIN = 15, MAXTRY = 5, TZ_OFF = 3; // الرياض UTC+3
export const SITE_URL = 'https://yawmi.arkiqo.com/';
export const PERMS = ['team', 'assign', 'transfer', 'approve', 'projects', 'projectsEdit', 'finance', 'users', 'audit'];
export const PDEF = {
  ceo: { team: true, assign: true, transfer: true, approve: true, projects: true, projectsEdit: true, finance: true, users: true, audit: true },
  branch: { team: true, assign: true, transfer: true, approve: true, projects: true, projectsEdit: true, finance: true, users: true, audit: true },
  admin: { team: true, assign: true, transfer: true, approve: true, projects: true, projectsEdit: true, finance: true, users: false, audit: false },
  member: { team: false, assign: false, transfer: true, approve: false, projects: false, projectsEdit: false, finance: false, users: false, audit: false } };
export const ROLES = ['member', 'admin', 'branch', 'ceo', 'owner'];
export const rank = r => Math.max(0, ROLES.indexOf(r));
export const cleanRole = r => ROLES.indexOf(r) >= 0 ? r : 'member';
export const cleanUser = s => String(s || '').trim().toLowerCase();
export const isOwner = u => u.role === 'owner';
export class UErr extends Error {} // رسالة تظهر للمستخدم كما هي
export const fail = m => { throw new UErr(m); };

// ---------- التاريخ بتوقيت الرياض ----------
export const todayISO = (ms = Date.now()) => new Date(ms + TZ_OFF * 3600e3).toISOString().slice(0, 10);
export const stamp = (ms = Date.now()) => new Date(ms + TZ_OFF * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
export const addDaysISO = (ms, n) => todayISO(ms + n * 864e5);

// ---------- معرّفات وتجزئة ----------
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
export const rid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);
export const newToken = () => crypto.randomUUID().replace(/-/g, '') + rid();
const enc = new TextEncoder();
const b64 = buf => { let s = ''; new Uint8Array(buf).forEach(c => s += String.fromCharCode(c)); return btoa(s); };
export async function sha256hex(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
// v1 (قديم): Base64(SHA-256(salt + '|' + pw))
export async function hash1(salt, pw) { return b64(await crypto.subtle.digest('SHA-256', enc.encode(salt + '|' + pw))); }
// v2: HMAC-SHA256 بمفتاح pepper (سر خارج قاعدة البيانات) ثم 150 تكراراً — مطابق لـ hash2_ في Code.gs
export async function hash2(pepper, salt, pw) {
  if (!pepper) fail('إعداد الخادم غير مكتمل (PEPPER)');
  const key = await crypto.subtle.importKey('raw', enc.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  let h = await crypto.subtle.sign('HMAC', key, enc.encode(salt + '|' + pw));
  for (let i = 0; i < 150; i++) h = await crypto.subtle.sign('HMAC', key, h);
  return 'v2$' + b64(h);
}
export const pwHash = (env, salt, pw) => hash2(env.PEPPER, salt, String(pw));
export async function pwOk(env, u, pw) { pw = String(pw || ''); return String(u.hash).indexOf('v2$') === 0 ? (await hash2(env.PEPPER, u.salt, pw)) === u.hash : (await hash1(u.salt, pw)) === u.hash; }
export function pwRule(pw) { if (String(pw || '').length < 8) fail('كلمة المرور 8 أحرف على الأقل'); }
export function normPhone(p) {
  let d = String(p || '').replace(/[^0-9+]/g, ''); if (!d) return '';
  if (d.indexOf('+') === 0) d = d.slice(1); else if (d.indexOf('00') === 0) d = d.slice(2);
  else if (/^05[0-9]{8}$/.test(d)) d = '966' + d.slice(1); else if (/^5[0-9]{8}$/.test(d)) d = '966' + d; else if (/^01[0-9]{9}$/.test(d)) d = '20' + d.slice(1);
  d = d.replace(/[^0-9]/g, ''); if (d.length < 8 || d.length > 15) fail('رقم الجوال غير صحيح'); return d;
}

// ---------- الصلاحيات والنطاق ----------
export function eff(u) { const o = {}; PERMS.forEach(k => o[k] = u.role === 'owner' ? true : (u.perms && u.perms[k] !== undefined ? !!u.perms[k] : !!(PDEF[u.role] || PDEF.member)[k])); return o; }
export const can = (u, k) => !!eff(u)[k];
export function need(u, k) { if (!can(u, k)) fail('ليس لديك صلاحية لهذه العملية'); }
export function inScope(v, x) {
  if (!x) return v.role === 'owner' || v.role === 'ceo';
  if (v.id === x.id || v.role === 'owner' || v.role === 'ceo') return true;
  const vo = v.org || {}, xo = x.org || {};
  if (v.role === 'branch') return !vo.branch || xo.branch === vo.branch;
  return (!vo.branch || xo.branch === vo.branch) && (!vo.dept || xo.dept === vo.dept);
}
export function seeScope(v, x) { if (!x) return v.role === 'owner' || v.role === 'ceo'; if (v.id === x.id || v.role === 'owner') return true; if (x.role === 'owner') return false; if (v.role === 'ceo') return true; if (rank(x.role) >= rank(v.role)) return false; return inScope(v, x); }
export function canManage(v, x) { if (!x || x.role === 'owner') return false; if (v.role === 'owner') return true; return can(v, 'users') && rank(x.role) < rank(v.role) && inScope(v, x); }
export function pubPrefs(p) { const o = Object.assign({}, p || {}); o.waOn = !!o.waKey; delete o.waKey; return o; }
export function pub(u) { return { id: u.id, username: u.username, name: u.name, role: u.role, active: u.active, email: u.email || '', phone: u.phone || '', prefs: pubPrefs(u.prefs), perms: eff(u), rawPerms: u.perms || {}, org: u.org || {} }; }
export function usersFor(u, all) { const full = can(u, 'team') || can(u, 'users');
  return all.map(x => full && inScope(u, x) ? Object.assign(pub(x), { sc: true, mg: canManage(u, x) }) : { id: x.id, name: x.name, role: x.role, active: x.active, org: x.org || {}, phone: x.phone || '', prefs: { notify: (x.prefs || {}).notify || 'email' }, sc: x.id === u.id }); }
export function cleanOrg(o) { o = o || {}; const c = v => String(v || '').trim().slice(0, 60); return { branch: c(o.branch), dept: c(o.dept), title: c(o.title) }; }
export const FINK = ['price', 'agreed', 'claims', 'expenses', 'adds', 'hourCost', 'visitFee', 'qRevs', 'hourTarget'];
export function stripFin(p) { const o = JSON.parse(JSON.stringify(p)); FINK.forEach(k => delete o[k]); if (Array.isArray(o.visits)) o.visits.forEach(v => { delete v.fee; delete v.paid; delete v.paidDate; }); if (Array.isArray(o.phases)) o.phases.forEach(x => { delete x.amount; }); o._nofin = true; return o; }
export function keepFin(p, old) { FINK.forEach(k => { if (old[k] !== undefined) p[k] = old[k]; else delete p[k]; }); if (Array.isArray(p.visits) && Array.isArray(old.visits)) p.visits.forEach((v, i) => { const o = old.visits[i] || {}; v.fee = o.fee; v.paid = o.paid; v.paidDate = o.paidDate; }); delete p._nofin; }
