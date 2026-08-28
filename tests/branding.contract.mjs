/**
 * هوية الصيدلية في الصفحة، لا اسم المنتج.
 *
 * لماذا هذا الملف موجود: رابط الصيدلية يُرسَل على واتساب، والزاحف الذي يبني
 * المعاينة **لا يشغّل جافاسكربت** — فأي تعديل بعد التحميل لا يصل إليه. وكان
 * كل رابط يُعرض باسم «PharmaGaza» مهما كان اسم صاحبه: يرسله الصيدلاني
 * لزبونه فيقرأ الزبون اسم منتجٍ لا اسم صيدليته.
 *
 * والشرط الذي يجعل الوسم ممكنًا هو أن يمرّ طلب الجذر بالـWorker أصلًا.
 * وهذا إعداد لا شيفرة، ولا يكشفه اختبارٌ يشغّل الشيفرة — فيُقرأ هنا صراحةً.
 * وقد وقع العطل نفسه في محرك المدارس مرّتين: مرّة بلا `/` في القائمة، ومرّة
 * بلا `binding` فردّ الموقع 404 دقيقتين.
 *
 * التشغيل: node tests/branding.contract.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const config = JSON.parse(
  readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
);
const worker = readFileSync(new URL('../worker/worker.js', import.meta.url), 'utf8');

const first = config.assets?.run_worker_first;
check(
  'كل الطلبات تمرّ بالـWorker',
  first === true || (Array.isArray(first) && first.includes('/')),
  'بدون الجذر تخدم طبقة الأصول الصفحة مباشرة فلا تُكتب هوية',
);

check(
  'الأصول لها ربط',
  config.assets?.binding === 'ASSETS',
  'بدونه `env.ASSETS` غير معرَّفة فيردّ 404 على الصفحة نفسها',
);

check(
  'الـWorker يطلب الأصول بنفسه',
  worker.includes('env.ASSETS.fetch(request)'),
  'وإلا مرّ الطلب به ولم يجد من يخدم الملف',
);

check(
  'العنوان المرئي في شاشة الدخول يحمل اسم الصيدلية',
  worker.includes('#login-brand') && readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').includes('id="login-brand"'),
  'وإلا قرأ الصيدلاني اسم المنتج لا اسم صيدليته',
);

check(
  'اسم الصيدلية يُكتب في الوسم',
  worker.includes('brandPharmacyPage') && worker.includes('data-pharmacy-name'),
);

check(
  'بصمة الأصول تُنزَع من الصفحة المُوسَمة',
  /headers\.delete\("ETag"\)/.test(worker),
  'البصمة تُحسب قبل الوسم فهي نفسها لكل صيدلية — والمتصفّح يردّ 304 بنسخته القديمة',
);

check(
  'الصفحة المُوسَمة لا تُخزَّن',
  /Cache-Control".*no-store/.test(worker),
  'وإلا رأى من غيّر اسم صيدليته الاسم القديم',
);

check(
  'الرمز يُثبَّت بكعكة',
  worker.includes('pharmacy_code=') && worker.includes('readPharmacyCookie'),
  'كي تعرف الصفحة صيدليتها حين يُفتح رابط بلا ?pharmacy=',
);

const failed = checks.filter((row) => !row.ok);
if (failed.length) {
  console.error(`\n${failed.length} فحصًا فشل.`);
  process.exit(1);
}
console.log('\npharmacy-branding-contract-ok');
