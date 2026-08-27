/**
 * الواجهة تنادي نفس أصل الصفحة، لا عنوانًا محفورًا.
 *
 * كان `WORKER_URL` عنوان `workers.dev` مكتوبًا في الشيفرة. ثم صارت الصيدلية
 * تُخدم من `pharmacy.athar.date` وتوقّف ذلك المضيف عن الردّ، فصارت كل محاولة
 * دخول تنتهي بـ«فشل الاتصال بالسيرفر» — والمستخدم يظنّ كلمة مروره خاطئة.
 *
 * العطل من صنف يتكرّر: عنوان يُكتب مرة ويُنسى، ثم يتغيّر النطاق. الحارس هنا
 * بنيوي لا سلوكي — يمنع عودة أي عنوان مطلق إلى ملفات الواجهة.
 *
 * التشغيل: node tests/frontend-origin.contract.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const scripts = readdirSync(publicDir).filter((name) => name.endsWith('.js'));
assert.ok(scripts.length, 'لا ملفات واجهة — تغيّر مكان الملفات؟');

const failures = [];

for (const name of scripts) {
  const source = readFileSync(publicDir + name, 'utf8');

  // عنوان مطلق داخل شيفرة تنفيذية (لا داخل تعليق) يعني اعتمادًا على مضيف
  // بعينه. التعليقات تُنزع أولًا لأن شرح العطل يذكر العنوان بالضرورة.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n');

  for (const match of code.matchAll(/https?:\/\/[^'"`\s)]+/g)) {
    const url = match[0];
    // روابط تُفتح للمستخدم أو معايير مُعرَّفة ليست نداءً للـAPI.
    if (/^https?:\/\/(www\.)?(w3\.org|schema\.org|wa\.me|api\.whatsapp\.com)/.test(url)) continue;
    failures.push(`${name}: عنوان مطلق «${url}»`);
  }
}

// وتحديدًا: قاعدة النداء يجب أن تكون فارغة.
const appSource = readFileSync(publicDir + 'app.js', 'utf8');
assert.ok(/WORKER_URL:\s*''/.test(appSource), 'app.js: WORKER_URL يجب أن تكون فارغة (نفس الأصل)');
const adminSource = readFileSync(publicDir + 'admin.js', 'utf8');
assert.ok(/const WORKER_URL = ''/.test(adminSource), 'admin.js: WORKER_URL يجب أن تكون فارغة');

if (failures.length) {
  console.log(`pharmacy-frontend-origin-contract-FAILED (${failures.length})`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exit(1);
}
console.log('pharmacy-frontend-origin-contract-ok');
