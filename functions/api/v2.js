// يومي — نقطة دخول الخادم الجديد (/api/v2). مغلقة في الإنتاج حتى التحويل الرسمي (المتغير V2=1).
import { UErr } from '../_lib/core.js';
import { initV2 } from '../_lib/db.js';
import * as A from '../_lib/auth.js';

const H = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-yw-v2': '1' };
const TREAD = { getMat: 1, getAll: 1, listUsers: 1, listAudit: 1, listIdeas: 1, lockPriv: 1, unlockPriv: 1, logout: 1 };
const OPEN = { setupStatus: A.setupStatus, setup: A.setup, login: A.login, forgotPw: A.forgotPw, resetPw: A.resetPw };
const AUTHED = { logout: A.logout, listUsers: A.listUsers, addUser: A.addUser, updateUser: A.updateUser, deleteUser: A.deleteUser, setPrivPin: A.setPrivPin, unlockPriv: A.unlockPriv, lockPriv: A.lockPriv };

export async function onRequestPost({ request, env }) {
  if (env.V2 !== '1') return new Response('Not found', { status: 404 });
  let out;
  try {
    const b = JSON.parse(await request.text()); const ctx = { db: env.DB, env };
    await initV2(env.DB);
    if (OPEN[b.fn]) out = { ok: true, data: await OPEN[b.fn](ctx, ...(b.args || [])) };
    else if (AUTHED[b.fn]) {
      if (b.fn !== 'logout') { await A.me(ctx, b.t || ''); if (ctx.ro && !TREAD[b.fn]) throw new UErr('انتهت الفترة التجريبية — الحساب الآن للعرض فقط. بياناتك محفوظة كما هي، وتواصل معنا لتفعيل الاشتراك'); }
      out = { ok: true, data: await AUTHED[b.fn](ctx, b.t || '', ...(b.args || [])) };
    } else throw new UErr('طلب غير معروف');
  } catch (e) { out = { ok: false, error: e instanceof UErr ? e.message : 'خطأ في الخادم: ' + String(e && e.message || e).slice(0, 200) }; }
  return new Response(JSON.stringify(out), { headers: H });
}
