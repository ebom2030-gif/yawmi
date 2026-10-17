// فحص بسيط لخادم Cloudflare (Pages Functions) — جزء من خطة النقل إلى Cloudflare
export async function onRequest({ env }) {
  return new Response(JSON.stringify({ ok: true, at: new Date().toISOString(), d1: !!env.DB }), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
