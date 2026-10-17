// يومي — نقل البيانات الكاملة من Google Sheets إلى قاعدة D1 للخادم الجديد (المرحلة 3)
// يستدعيه مالك المنصة وهو مسجّل الدخول: البوابة تطلب exportAll من Apps Script برمز جلسته (التحقق هناك: مالك المنصة فقط)
// ثم تكتب كل المساحات (الرئيسية + المشتركين) في جداول t_*. تجزئات كلمات المرور لا تمر أبداً عبر المتصفح.
import { initV2 } from '../_lib/db.js';
const GAS = 'https://script.google.com/macros/s/AKfycbwgvjkn2Op3hg-sSwxMi3PJO4MmIot0udoa8FXKOGTK9LBjqKuGtqlLYY1FaAkMwnI9/exec';
const H = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const J = v => JSON.stringify(v ?? null);
const P = (s, d) => { try { return JSON.parse(s); } catch (e) { return d; } };

export async function onRequestPost({ request, env }) {
  if (!env.DB) return new Response(J({ ok: false, error: 'قاعدة البيانات غير مربوطة' }), { headers: H });
  await initV2(env.DB); const cut = await env.DB.prepare("SELECT v FROM t_meta WHERE k = 'cutover'").first();
  if (cut) return new Response(J({ ok: false, error: 'تم التحويل للخادم الجديد — النقل من Google مغلق لحماية البيانات' }), { headers: H });
  let b; try { b = JSON.parse(await request.text()); } catch (e) { return new Response(J({ ok: false, error: 'طلب غير صالح' }), { headers: H }); }
  const r = await fetch(env.GAS_URL || GAS, { method: 'POST', redirect: 'follow', headers: { 'content-type': 'text/plain;charset=utf-8' }, body: J({ t: b.t || '', fn: 'exportAll', args: [] }) });
  const out = P(await r.text(), null);
  if (!out || !out.ok) return new Response(J({ ok: false, error: (out && out.error) || 'تعذّر قراءة البيانات من الخادم الحالي' }), { headers: H });
  const X = out.data, db = env.DB, now = Date.now(); await initV2(db);
  const S = [], sum = { tenants: 0, spaces: [] };
  const tenOf = {}; // لربط الرقم السري (pp_uid) بمساحة صاحبه
  for (const t of X.tenants || []) { sum.tenants++;
    S.push(db.prepare('INSERT OR REPLACE INTO t_tenants (id, name, kind, status, trial_start, trial_end, paid_until, max_users, owner_name, email, phone, created_at, notes, plan, sheet_id, folder_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(t.id, t.name || '', t.kind || 'company', t.status || 'trial', t.trialStart || '', t.trialEnd || '', t.paidUntil || '', Number(t.maxUsers) || 1, t.ownerName || '', t.email || '', t.phone || '', Number(t.createdAt) || 0, t.notes || '', t.plan || '', t.sheetId || '', t.folderId || '')); }
  for (const sp of X.spaces || []) {
    const tn = sp.tn || ''; if (sp.error) { sum.spaces.push({ tn, error: sp.error }); continue; }
    ['t_users', 't_items', 't_notes', 't_projects', 't_contacts', 't_ideas', 't_audit', 't_pins'].forEach(tb => S.push(db.prepare(`DELETE FROM ${tb} WHERE tn = ?`).bind(tn)));
    for (const u of sp.users || []) { tenOf[u.id] = tn;
      S.push(db.prepare('INSERT OR REPLACE INTO t_users (tn, id, username, name, role, salt, hash, active, created_at, email, phone, prefs, perms, org) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(tn, u.id, String(u.username || '').toLowerCase(), u.name || '', u.role || 'member', u.salt || '', u.hash || '', u.active === false ? 0 : 1, Number(u.createdAt) || 0, u.email || '', u.phone || '', J(u.prefs || {}), J(u.perms || {}), J(u.org || {}))); }
    for (const o of sp.items || []) S.push(db.prepare('INSERT OR REPLACE INTO t_items (tn, id, owner, assigned_by, space, pv, due, done, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(tn, String(o.id), o.owner || '', o.assignedBy || '', o.space || '', o.pv ? 1 : 0, o.due || '', o.done ? 1 : 0, J(o), Number(o.doneAt || o.createdAt) || now));
    for (const n of sp.notes || []) S.push(db.prepare('INSERT OR REPLACE INTO t_notes (tn, owner, date, text, updated_at) VALUES (?, ?, ?, ?, ?)').bind(tn, n.owner || '', n.date, n.text || '', Number(n.updatedAt) || now));
    for (const [tb, L] of [['t_projects', sp.projects], ['t_contacts', sp.contacts]]) for (const x of L || []) { const d = P(x.data, {}); if (!d.id) continue;
      S.push(db.prepare(`INSERT OR REPLACE INTO ${tb} (tn, id, name, ${tb === 't_projects' ? 'status' : 'cat'}, space, created_by, data, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(tn, String(d.id), d.name || '', String((tb === 't_projects' ? d.status : d.cat) || ''), d.space || '', d.createdBy || '', x.data, x.updatedAt || now, x.updatedBy || '')); }
    for (const x of sp.ideas || []) { const d = P(x.data, {}); if (!d.id) continue; S.push(db.prepare('INSERT OR REPLACE INTO t_ideas (tn, id, title, status, data, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(tn, String(d.id), d.title || '', d.status || '', x.data, x.updatedAt || now, x.updatedBy || '')); }
    (sp.audit || []).forEach((a, i) => S.push(db.prepare('INSERT INTO t_audit (tn, at, by_id, by_name, action, target, details, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(tn, a[0], a[1], a[2], a[3], a[4], a[5], (Date.parse(String(a[0]).replace(' ', 'T') + ':00+03:00') || 0) + i % 1000)));
    S.push(db.prepare('INSERT OR REPLACE INTO t_mat (tn, data, updated_at) VALUES (?, ?, ?)').bind(tn, J(sp.mat || {}), now));
    sum.spaces.push({ tn, users: (sp.users || []).length, items: (sp.items || []).length, notes: (sp.notes || []).length, projects: (sp.projects || []).length, contacts: (sp.contacts || []).length, ideas: (sp.ideas || []).length, audit: (sp.audit || []).length });
  }
  for (const [uid, raw] of Object.entries(X.pins || {})) { const p = P(raw, null); if (p && p.s && p.h && tenOf[uid] !== undefined) S.push(db.prepare('INSERT OR REPLACE INTO t_pins (tn, uid, s, h) VALUES (?, ?, ?, ?)').bind(tenOf[uid], uid, p.s, p.h)); }
  S.push(db.prepare("INSERT OR REPLACE INTO t_meta (k, v) VALUES ('migratedAt', ?)").bind(String(now)));
  for (let i = 0; i < S.length; i += 80) await db.batch(S.slice(i, i + 80));
  return new Response(J({ ok: true, data: sum }), { headers: H });
}
