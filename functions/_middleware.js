// v278: ملفات العمل الداخلية (ملاحظات الإصدارات، لقطات المراجعة، دليل التصميم) لا تُعرض للزوار.
// تبقى في المجلد وفي المستودع كما هي (لا حذف) — تُمنع قراءتها من الموقع فقط.
// يُستدعى هذا الملف للمسارات المذكورة في _routes.json فقط، فلا يبطئ بقية الملفات.
const BLOCK = /^\/(RELEASE-v\d+\.md|review-gallery\.html|STYLE-GUIDE\.md|README\.md|\.gitignore|assets\/reviews-v16\d\/.*|assets\/brand\/hybrid\.png|assets\/(hybrid|focus)\/[^/]+\.png|icon-512-1\.png)$/i;
export async function onRequest(ctx) {
  const p = new URL(ctx.request.url).pathname;
  if (BLOCK.test(decodeURIComponent(p))) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
  return ctx.next();
}
