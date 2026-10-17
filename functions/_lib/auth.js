// يومي — الخادم الجديد: الدخول والجلسات والرقم السري للأعمال الخاصة وإدارة المستخدمين (مطابق لـ Code.gs)
import { SESSION_DAYS, IDLE_MIN, PRIV_MIN, MAXTRY, PERMS, fail, cleanUser, cleanRole, rank, isOwner, need, can, canManage, pub, usersFor, cleanOrg,
  newToken, rid, sha256hex, hash1, hash2, pwHash, pwOk, pwRule, normPhone } from './core.js';
import { usersOf, userById, saveUser, findUserAny, kvGet, kvPut, kvDel, tenant, tenState, audit } from './db.js';

const th = t => sha256hex('s|' + t);
export async function newSession(db, tn, uid) {
  const t = newToken(), now = Date.now();
  await db.batch([db.prepare('INSERT INTO t_sessions (th, uid, tn, exp, last, pv) VALUES (?, ?, ?, ?, ?, NULL)').bind(await th(t), uid, tn || '', now + SESSION_DAYS * 864e5, now),
    db.prepare('DELETE FROM t_sessions WHERE exp < ?').bind(now)]);
  return t;
}
export async function killSessions(db, tn, uid, keepT) { const k = keepT ? await th(keepT) : ''; await db.prepare('DELETE FROM t_sessions WHERE tn = ? AND uid = ? AND th != ?').bind(tn || '', uid, k).run(); }
// التحقق من الجلسة: انتهاء 30 يوماً، والقفل بعد 30 دقيقة دون نشاط، وحالة اشتراك الشركة
export async function me(ctx, t) {
  const { db } = ctx; if (!t) fail('سجّل الدخول أولاً');
  const h = await th(t), s = await db.prepare('SELECT * FROM t_sessions WHERE th = ?').bind(h).first();
  if (!s) fail('انتهت الجلسة — سجّل الدخول مرة أخرى');
  const now = Date.now();
  if (s.exp < now) fail('انتهت الجلسة — سجّل الدخول مرة أخرى');
  if (s.last && now - s.last > IDLE_MIN * 60000) { await db.prepare('DELETE FROM t_sessions WHERE th = ?').bind(h).run(); fail('انتهت الجلسة — أُغلقت بعد ' + IDLE_MIN + ' دقيقة دون نشاط'); }
  if (!s.last || now - s.last > 60000) await db.prepare('UPDATE t_sessions SET last = ? WHERE th = ?').bind(now, h).run();
  const u = await userById(db, s.tn, s.uid); if (!u || !u.active) fail('الحساب غير مفعّل');
  let ro = false, ten = null;
  if (s.tn) { ten = await tenant(db, s.tn); const st = tenState(ten); if (st === 'suspended') { await db.prepare('DELETE FROM t_sessions WHERE th = ?').bind(h).run(); fail('حساب الشركة غير مفعّل حالياً — تواصل مع إدارة يومي'); } ro = st === 'expired'; }
  Object.assign(ctx, { u, tn: s.tn || '', sess: s, sh: h, ro, ten });
  return u;
}
// ---------- الأعمال الخاصة (رقم سري منفصل) ----------
export async function pinRec(db, tn, uid) { return await db.prepare('SELECT s, h FROM t_pins WHERE tn = ? AND uid = ?').bind(tn, uid).first(); }
export async function privOpen(ctx) { const { db, u, tn, sess, sh } = ctx; if (!(await pinRec(db, tn, u.id))) return true;
  const now = Date.now(); if (!sess.pv || sess.pv < now) return false;
  if (sess.pv - now < PRIV_MIN * 60000 - 120000) { sess.pv = now + PRIV_MIN * 60000; await db.prepare('UPDATE t_sessions SET pv = ? WHERE th = ?').bind(sess.pv, sh).run(); }
  return true; }
export async function privGuard(ctx) { if (!(await privOpen(ctx))) fail('أعمالك الخاصة مقفلة — افتحها بالرقم السري أولاً'); }
async function tries(db, k) { const n = Number(await kvGet(db, k) || 0); return { n, fail: async () => { await kvPut(db, k, n + 1, 900); const left = MAXTRY - n - 1; return left <= 2 ? ' — باقي ' + Math.max(left, 0) + ' محاولات' : ''; }, ok: () => kvDel(db, k) }; }
export async function setPrivPin(ctx, t, password, pin) { const u = await me(ctx, t), { db, env, tn } = ctx; const tr = await tries(db, 'pf_' + tn + ':' + u.id);
  if (tr.n >= MAXTRY) fail('محاولات خاطئة كثيرة — انتظر 15 دقيقة');
  if (!(await pwOk(env, u, password))) fail('كلمة مرور الحساب غير صحيحة' + await tr.fail());
  await tr.ok(); pin = String(pin == null ? '' : pin).trim();
  if (!pin) { await db.prepare('DELETE FROM t_pins WHERE tn = ? AND uid = ?').bind(tn, u.id).run(); return ctx.privData ? ctx.privData(ctx) : { priv: { pin: false, open: true } }; }
  if (pin.length < 4 || pin.length > 20) fail('الرقم السري من 4 إلى 20 حرفاً أو رقماً');
  if (await pwOk(env, u, pin)) fail('اختر رقماً سرياً مختلفاً عن كلمة مرور الدخول');
  const salt = rid(); await db.prepare('INSERT INTO t_pins (tn, uid, s, h) VALUES (?, ?, ?, ?) ON CONFLICT(tn, uid) DO UPDATE SET s = excluded.s, h = excluded.h').bind(tn, u.id, salt, await hash2(env.PEPPER, salt, pin)).run();
  ctx.sess.pv = Date.now() + PRIV_MIN * 60000; await db.prepare('UPDATE t_sessions SET pv = ? WHERE th = ?').bind(ctx.sess.pv, ctx.sh).run();
  return ctx.privData ? ctx.privData(ctx) : { priv: { pin: true, open: true } }; }
export async function unlockPriv(ctx, t, pin) { const u = await me(ctx, t), { db, env, tn } = ctx; const rec = await pinRec(db, tn, u.id); if (!rec) return ctx.privData ? ctx.privData(ctx) : { priv: { pin: false, open: true } };
  const tr = await tries(db, 'pf_' + tn + ':' + u.id); if (tr.n >= MAXTRY) fail('محاولات خاطئة كثيرة — انتظر 15 دقيقة');
  if ((await hash2(env.PEPPER, rec.s, String(pin == null ? '' : pin).trim())) !== rec.h) fail('الرقم السري غير صحيح' + await tr.fail());
  await tr.ok(); ctx.sess.pv = Date.now() + PRIV_MIN * 60000; await db.prepare('UPDATE t_sessions SET pv = ? WHERE th = ?').bind(ctx.sess.pv, ctx.sh).run();
  return ctx.privData ? ctx.privData(ctx) : { priv: { pin: true, open: true } }; }
export async function lockPriv(ctx, t) { await me(ctx, t); if (ctx.sess.pv) await ctx.db.prepare('UPDATE t_sessions SET pv = NULL WHERE th = ?').bind(ctx.sh).run(); return true; }

// ---------- الإعداد الأول والدخول واستعادة كلمة المرور ----------
export async function setupStatus(ctx) { const n = (await ctx.db.prepare("SELECT COUNT(*) n FROM t_users WHERE tn = ''").first()).n; return { needsSetup: n === 0 }; }
export async function setup(ctx, username, name, password) { const { db, env } = ctx; username = cleanUser(username);
  if (!username || !name) fail('أكمل البيانات'); pwRule(password);
  if (!(await setupStatus(ctx)).needsSetup) fail('تم الإعداد مسبقاً');
  const salt = rid(), id = rid(); const u = { tn: '', id, username, name, role: 'owner', salt, hash: await pwHash(env, salt, password), active: true, createdAt: Date.now(), prefs: {}, perms: {}, org: {} };
  await saveUser(db, u); return { token: await newSession(db, '', id), user: pub(u) }; }
export async function login(ctx, username, password) { const { db, env } = ctx;
  const u = await findUserAny(db, username, normPhone); username = u ? u.username : cleanUser(username);
  const k = 'lf_' + username, n = Number(await kvGet(db, k) || 0);
  if (n >= MAXTRY) fail('الحساب مقفل مؤقتاً لمدة 15 دقيقة بسبب محاولات دخول خاطئة كثيرة — استخدم «نسيت كلمة المرور» عند الحاجة');
  if (!u || !(await pwOk(env, u, password))) { await kvPut(db, k, n + 1, 900); const left = MAXTRY - n - 1;
    fail('بيانات الدخول أو كلمة المرور غير صحيحة' + (left <= 0 ? ' — أُقفل الحساب لمدة 15 دقيقة' : left <= 2 ? ' — باقي ' + left + ' محاولات' : '')); }
  if (!u.active) fail('الحساب غير مفعّل — تواصل مع المدير');
  if (u.tn && tenState(await tenant(db, u.tn)) === 'suspended') fail('حساب الشركة موقوف حالياً — تواصل مع إدارة يومي');
  await kvDel(db, k);
  if (String(u.hash).indexOf('v2$') !== 0) { u.salt = rid(); u.hash = await pwHash(env, u.salt, password); await saveUser(db, u); } // ترقية التجزئة القديمة
  return { token: await newSession(db, u.tn, u.id), user: pub(u) }; }
const codeFor = (env, uid, code) => hash1(uid + (env.PEPPER || ''), String(code || '').trim());
export async function forgotPw(ctx, username) { const { db, env } = ctx; username = cleanUser(username); const ok = { sent: true };
  if (!username || await kvGet(db, 'fpw_' + username)) return ok; await kvPut(db, 'fpw_' + username, 1, 60);
  const u = await findUserAny(db, username, normPhone); if (!u || !u.active || !u.email) return ok;
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  await kvPut(db, 'rc_' + u.tn + ':' + u.id, JSON.stringify({ h: await codeFor(env, u.id, code), n: 0 }), 900);
  if (ctx.mail) await ctx.mail(u.email, 'يومي | رمز استعادة كلمة المرور', 'استعادة كلمة المرور', '<p>أهلاً ' + esc(u.name) + '،</p><p>هذا رمز تغيير كلمة المرور لحساب <b dir="ltr">' + esc(u.username) + '</b>:</p><div dir="ltr" style="font-size:32px;font-weight:bold;letter-spacing:8px;background:#f0f3f8;border-radius:10px;padding:12px;text-align:center;color:#14213d">' + code + '</div><p style="color:#8b94aa">الرمز صالح لمدة 15 دقيقة. إذا لم تكن أنت من طلبه فتجاهل الرسالة — حسابك في أمان.</p>');
  return ok; }
export async function resetPw(ctx, username, code, password) { const { db, env } = ctx; pwRule(password);
  const u = await findUserAny(db, username, normPhone); const rk = u ? 'rc_' + u.tn + ':' + u.id : '', raw = u ? await kvGet(db, rk) : null;
  if (!raw) fail('الرمز غير صحيح أو انتهت صلاحيته — اطلب رمزاً جديداً');
  const d = JSON.parse(raw);
  if (d.h !== await codeFor(env, u.id, code)) { d.n++; if (d.n >= 5) await kvDel(db, rk); else await kvPut(db, rk, JSON.stringify(d), 900); fail(d.n >= 5 ? 'محاولات كثيرة — اطلب رمزاً جديداً' : 'الرمز غير صحيح'); }
  await kvDel(db, rk); await kvDel(db, 'lf_' + u.username);
  u.salt = rid(); u.hash = await pwHash(env, u.salt, password); await saveUser(db, u); await killSessions(db, u.tn, u.id, '');
  if (!u.active) fail('الحساب غير مفعّل — تواصل مع المدير');
  return { token: await newSession(db, u.tn, u.id), user: pub(u) }; }
export async function logout(ctx, t) { if (t) await ctx.db.prepare('DELETE FROM t_sessions WHERE th = ?').bind(await th(t)).run(); return true; }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- إدارة المستخدمين ----------
const reUser = /^[a-z0-9._-]{3,30}$/, reMail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
async function nameTaken(db, un, uid) { const r = await db.prepare('SELECT id FROM t_users WHERE username = ?').bind(un).first(); return !!r && r.id !== uid; }
async function emailTaken(db, em, uid) { if (!em) return false; const r = await db.prepare('SELECT id FROM t_users WHERE lower(email) = ? AND id != ? LIMIT 1').bind(em, uid || '').first(); return !!r; }
export async function listUsers(ctx, t) { const u = await me(ctx, t); need(u, 'users'); return usersFor(u, await usersOf(ctx.db, ctx.tn)); }
export async function addUser(ctx, t, username, name, role, password, org, email) {
  const u = await me(ctx, t), { db, env, tn } = ctx; need(u, 'users'); role = cleanRole(role);
  if (role === 'owner') fail('لا يمكن إضافة مالك آخر');
  if (!isOwner(u) && rank(role) >= rank(u.role)) fail('غير مسموح بإضافة دور مساوٍ لدورك أو أعلى منه');
  org = cleanOrg(org); const uo = u.org || {};
  if (!isOwner(u) && u.role !== 'ceo') { if (uo.branch) org.branch = uo.branch; if (u.role !== 'branch' && uo.dept) org.dept = uo.dept; }
  username = cleanUser(username); if (!reUser.test(username)) fail('اسم المستخدم: 3 أحرف إنجليزية أو أرقام على الأقل بدون مسافات');
  if (!name) fail('اكتب الاسم'); pwRule(password);
  if (await nameTaken(db, username, '')) fail('اسم المستخدم مستخدم مسبقاً');
  email = String(email || '').trim().toLowerCase(); if (email && !reMail.test(email)) fail('البريد الإلكتروني غير صحيح');
  if (email && await emailTaken(db, email, '')) fail('هذا البريد الإلكتروني مسجّل لمستخدم آخر');
  const all = await usersOf(db, tn); if (tn && all.length >= ctx.ten.maxUsers) fail('وصلت للحد الأقصى لعدد المستخدمين في باقتك (' + ctx.ten.maxUsers + ') — تواصل معنا لزيادته');
  const salt = rid(); await saveUser(db, { tn, id: rid(), username, name, role, salt, hash: await pwHash(env, salt, password), active: true, createdAt: Date.now(), email, phone: '', prefs: {}, perms: {}, org });
  if (email && ctx.welcome) await ctx.welcome(email, name, username, 'تمت إضافتك إلى فريق العمل', [esc(u.name) + ' أضافك إلى «يومي» لإدارة المهام والمشاريع.', 'ستصلك على هذا البريد المهام التي تُسند إليك، والتذكيرات، وملخص يومك كل صباح.', 'كلمة المرور يسلّمها لك مديرك، ويمكنك تغييرها من «حسابي» بعد الدخول.'], u);
  await audit(db, tn, u, 'إضافة مستخدم', name, role + (org.branch ? ' · ' + org.branch : '') + (org.dept ? ' · ' + org.dept : ''));
  return usersFor(u, await usersOf(db, tn)); }
export async function updateUser(ctx, t, id, patch) {
  const u = await me(ctx, t), { db, env, tn } = ctx; patch = patch || {}; const self = id === u.id; if (!self) need(u, 'users');
  const tgt = await userById(db, tn, id); if (!tgt) fail('المستخدم غير موجود'); const row = Object.assign({}, tgt);
  if (!self && !canManage(u, tgt)) fail(tgt.role === 'owner' ? 'لا يمكن تعديل حساب المالك إلا من قِبله' : 'غير مسموح بتعديل مستخدم في مستواك نفسه أو أعلى أو خارج فرعك/قسمك');
  if (patch.perms !== undefined || patch.role !== undefined) {
    if (self && !isOwner(u)) fail('لا يمكنك تغيير دورك أو صلاحياتك بنفسك');
    if (row.role === 'owner') fail('صلاحيات المالك كاملة ولا تتغير');
    if (patch.perms !== undefined && !isOwner(u) && u.role !== 'ceo') fail('توزيع الصلاحيات للمالك والرئيس التنفيذي فقط');
    if (patch.role !== undefined) { const nr = cleanRole(patch.role); if (nr === 'owner') fail('لا يمكن تعيين مالك آخر'); if (!isOwner(u) && rank(nr) >= rank(u.role)) fail('غير مسموح بمنح دور مساوٍ لدورك أو أعلى'); } }
  if (patch.org !== undefined) { if (self && !isOwner(u)) fail('يحدد مديرك الفرع والقسم'); const o = cleanOrg(patch.org), uo = u.org || {}; if (!isOwner(u) && u.role !== 'ceo' && uo.branch) o.branch = uo.branch; row.org = o; }
  if (patch.perms) { const pr = {}; PERMS.forEach(k => { if (patch.perms[k] !== undefined) pr[k] = !!patch.perms[k]; }); row.perms = pr; }
  if (patch.name) row.name = String(patch.name);
  if (patch.username !== undefined && cleanUser(patch.username) !== row.username) { const un = cleanUser(patch.username); if (!reUser.test(un)) fail('اسم المستخدم: 3 أحرف إنجليزية أو أرقام على الأقل بدون مسافات'); if (await nameTaken(db, un, id)) fail('اسم المستخدم هذا مستخدم مسبقاً — اختر اسماً آخر'); row.username = un; }
  if (patch.email !== undefined) { const em = String(patch.email || '').trim().toLowerCase(); if (em && !reMail.test(em)) fail('البريد الإلكتروني غير صحيح'); if (em && await emailTaken(db, em, id)) fail('هذا البريد الإلكتروني مسجّل لمستخدم آخر'); row.email = em; }
  if (patch.phone !== undefined) { const ph = normPhone(patch.phone); if (ph && await db.prepare('SELECT id FROM t_users WHERE tn = ? AND phone = ? AND id != ? LIMIT 1').bind(tn, ph, id).first()) fail('رقم الجوال هذا مسجّل لمستخدم آخر'); row.phone = ph; }
  if (patch.prefs) { const pr = Object.assign({}, row.prefs || {}), P = patch.prefs;
    ['daily', 'assign', 'cal'].forEach(k => { if (P[k] !== undefined) pr[k] = !!P[k]; });
    if (P.notify !== undefined) pr.notify = ['email', 'wa', 'both'].indexOf(P.notify) >= 0 ? P.notify : 'email';
    if (P.spaceName !== undefined) pr.spaceName = String(P.spaceName).slice(0, 40);
    if (P.stpl !== undefined) { const st = {}; try { Object.keys(P.stpl || {}).slice(0, 30).forEach(k => { const a = (P.stpl[k] || []).map(x => String(x).slice(0, 120)).filter(Boolean).slice(0, 40); if (a.length) st[String(k).slice(0, 60)] = a; }); } catch (e) {} pr.stpl = st; }
    if (P.skin !== undefined) pr.skin = ['night', 'roshan', 'earth'].indexOf(P.skin) >= 0 ? P.skin : 'night';
    if (self && P.waKey !== undefined) { const k = String(P.waKey || '').trim(); if (k && !/^[A-Za-z0-9_-]{4,40}$/.test(k)) fail('مفتاح الواتساب غير صحيح'); if (k) pr.waKey = k; else delete pr.waKey; }
    row.prefs = pr; }
  if (!self && patch.role && row.role !== 'owner') row.role = cleanRole(patch.role);
  if (!self && patch.active !== undefined && row.role !== 'owner') row.active = !!patch.active;
  if (patch.password) { pwRule(patch.password); row.salt = rid(); row.hash = await pwHash(env, row.salt, patch.password); }
  await saveUser(db, row);
  if (!self && (patch.role !== undefined || patch.perms !== undefined || patch.active !== undefined || patch.org !== undefined || patch.password))
    await audit(db, tn, u, 'تعديل مستخدم', row.name, [patch.role !== undefined ? 'الدور: ' + patch.role : '', patch.perms ? 'الصلاحيات: ' + Object.keys(patch.perms).filter(k => patch.perms[k]).join('، ') : '', patch.active !== undefined ? (patch.active ? 'تفعيل' : 'إيقاف') : '', patch.org ? 'الفرع/القسم' : '', patch.password ? 'كلمة مرور جديدة' : ''].filter(Boolean).join(' · '));
  if (patch.password || (patch.active === false && !self)) await killSessions(db, tn, id, self ? t : '');
  const me2 = await userById(db, tn, u.id);
  return (can(me2, 'users') || can(me2, 'team')) ? usersFor(me2, await usersOf(db, tn)) : [pub(me2)]; }
export async function deleteUser(ctx, t, id) {
  const u = await me(ctx, t), { db, tn } = ctx; need(u, 'users'); if (id === u.id) fail('لا يمكنك حذف حسابك');
  const x = await userById(db, tn, id); if (!x) fail('المستخدم غير موجود'); if (x.role === 'owner') fail('لا يمكن حذف المالك');
  if (!canManage(u, x)) fail('غير مسموح بحذف مستخدم في مستواك نفسه أو أعلى أو خارج فرعك/قسمك');
  // تُنقل مهام العمل لمن قام بالحذف، وتُحذف مساحته الخاصة ومذكراته ومشاريعه الخاصة
  const { results } = await db.prepare('SELECT id, owner, assigned_by, space, data FROM t_items WHERE tn = ? AND (owner = ? OR assigned_by = ?)').bind(tn, id, id).all();
  const S = [];
  results.forEach(r => { if (r.owner === id && r.space === 'p') { S.push(db.prepare('DELETE FROM t_items WHERE tn = ? AND id = ?').bind(tn, r.id)); return; }
    const o = JSON.parse(r.data); if (o.owner === id) { o.owner = u.id; if (o.assignedBy === u.id) o.assignedBy = ''; } if (o.assignedBy === id) o.assignedBy = '';
    S.push(db.prepare('UPDATE t_items SET owner = ?, assigned_by = ?, data = ?, updated_at = ? WHERE tn = ? AND id = ?').bind(o.owner || '', o.assignedBy || '', JSON.stringify(o), Date.now(), tn, r.id)); });
  S.push(db.prepare('DELETE FROM t_notes WHERE tn = ? AND owner = ?').bind(tn, id), db.prepare("DELETE FROM t_projects WHERE tn = ? AND space = 'p' AND created_by = ?").bind(tn, id),
    db.prepare('DELETE FROM t_users WHERE tn = ? AND id = ?').bind(tn, id), db.prepare('DELETE FROM t_sessions WHERE tn = ? AND uid = ?').bind(tn, id), db.prepare('DELETE FROM t_pins WHERE tn = ? AND uid = ?').bind(tn, id));
  for (let i = 0; i < S.length; i += 90) await db.batch(S.slice(i, i + 90));
  await audit(db, tn, u, 'حذف مستخدم', x.name, '');
  return usersFor(u, await usersOf(db, tn)); }
