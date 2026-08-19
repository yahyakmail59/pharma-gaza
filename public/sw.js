/* ============================================================
 * Service Worker — يجعل التطبيق يعمل فعلياً بلا إنترنت.
 * كان هذا مفقوداً تماماً رغم أن التطبيق يوصف بأنه offline-first:
 * المكتبات كانت من CDN، ففتح الصفحة بلا شبكة كان يعطي صفحة بيضاء.
 *
 * عند تعديل أي ملف: ارفع رقم CACHE_VERSION لتصل النسخة الجديدة للأجهزة.
 * ============================================================ */

const CACHE_VERSION = 'pharma-v1';

const SHELL = [
  './',
  './index.html',
  './admin.html',
  './app.css',
  './app.js',
  './admin.js',
  './icon.svg',
  './manifest.webmanifest',
  './vendor/dexie.min.js',
  './vendor/html5-qrcode.min.js',
  './vendor/xlsx.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      // addAll يفشل كلياً لو سقط ملف واحد — نضيف كلاً على حدة ليبقى الباقي
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const NET_TIMEOUT_MS = 4000;

/** الشبكة أولاً مع مهلة، ثم الكاش. يضمن وصول التحديثات فوراً. */
async function networkFirst(req) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), NET_TIMEOUT_MS)),
    ]);
    if (res && res.status === 200 && res.type === 'basic') cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req);
    if (hit) return hit;
    // تنقّل بلا شبكة وبلا نسخة مخزّنة ⇒ نعيد الصفحة الرئيسية من الكاش
    if (req.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    throw new Error('offline');
  }
}

/** الكاش أولاً — للمكتبات الثابتة الكبيرة فقط. */
async function cacheFirst(req) {
  const cache = await caches.open(CACHE_VERSION);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.status === 200 && res.type === 'basic') cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // لا نعترض المزامنة أبداً — يجب أن تصل للشبكة أو تفشل بوضوح
  if (url.pathname.startsWith('/api/')) return;
  if (url.origin !== self.location.origin) return;

  // المكتبات مثبّتة الإصدار: الكاش أولاً (سرعة، ولا تتغير)
  if (url.pathname.startsWith('/vendor/') || url.pathname.endsWith('.svg')) {
    e.respondWith(cacheFirst(req));
    return;
  }

  // كود التطبيق وصفحاته: الشبكة أولاً.
  // بدون هذا يبقى الجهاز يشغّل نسخة قديمة بعد كل نشر — بما فيها الإصلاحات الأمنية.
  e.respondWith(networkFirst(req));
});

// يسمح للصفحة بطلب تفعيل النسخة الجديدة فوراً
self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});
