/* ============================================================
 * PharmaGaza SaaS — منطق التطبيق
 * ------------------------------------------------------------
 * قواعد ثابتة في هذا الملف:
 *  1) لا يُبنى أي HTML من بيانات المستخدم. كل شيء عبر el()/textContent.
 *  2) كل المبالغ أعداد صحيحة بالأغورة. لا float في أي حساب مالي.
 *  3) الكمية لا تُكتب مباشرة — تتغير عبر حركة (move) لها معرّف فريد.
 *  4) لا يُرسَل pharmacy_id للسيرفر كمصدر ثقة؛ السيرفر يستنتجه من التوكن.
 * ============================================================ */

'use strict';

/* ==================== ١. الإعدادات ==================== */

const CONFIG = {
  // فارغ = نفس أصل الصفحة.
  //
  // كان هنا عنوان `workers.dev` محفورًا. ثم صارت الصيدلية تُخدم من
  // `pharmacy.athar.date`، وتوقّف مضيف `workers.dev` عن الردّ — فصارت
  // الواجهة تنادي عنوانًا ميتًا وتقول للمستخدم «فشل الاتصال بالسيرفر».
  //
  // نفس الأصل هو التصميم أصلًا: الـWorker يخدم الواجهة والـAPI معًا، فلا
  // حاجة إلى CORS ولا إلى عنوان يُحدَّث يدويًا كلما تغيّر النطاق.
  WORKER_URL: '',
  SYNC_INTERVAL_MS: 30000,
  IDLE_LOCK_MS: 10 * 60 * 1000,
  EXPIRY_WARN_DAYS: 90,
  LOW_STOCK_DEFAULT: 10,
  PAGE_SIZE: 50,
  PBKDF2_ITER: 100000,
};

/**
 * أسباب خروج المخزون. ثابتة عمدًا: السبب الحر («تلف» و«انتهاء» و«منتهي»)
 * يصنع ثلاث فئات لشيء واحد فلا يُجمَّع في تقرير.
 * `loss` تفصل الخسارة الفعلية عن الاسترداد — المرتجع للمورّد ليس هدرًا.
 */
const WRITE_OFF_REASONS = {
  expired: { label: 'انتهاء صلاحية', loss: true },
  damaged: { label: 'تلف أو كسر', loss: true },
  lost: { label: 'فقد أو سرقة', loss: true },
  return_supplier: { label: 'إرجاع للمورّد', loss: false },
};

const writeOffLabel = (reason) => WRITE_OFF_REASONS[reason]?.label || reason;
const isWriteOff = (reason) => Object.hasOwn(WRITE_OFF_REASONS, reason);

/* ==================== ٢. أدوات عامة ==================== */

/** إنشاء عنصر DOM بأمان. لا توجد أي مسارات innerHTML للبيانات. */
function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(3)) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

const $ = (id) => document.getElementById(id);
const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };

const ICON_PATHS = {
  home: 'M3 10.5 12 3l9 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19.5zM9 21v-6h6v6',
  pos: 'M4 5h16v14H4zM7 8h10M7 12h3M14 12h3M7 16h3M14 16h3',
  inventory: 'M4 4h16v16H4zM8 4v16M4 9h4M4 14h4',
  customers: 'M16 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM18 8a3 3 0 0 1 0 6M21 20v-1a4 4 0 0 0-3-3',
  reports: 'M5 20V10M12 20V4M19 20v-7',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0-8zM4 12H2M22 12h-2M12 4V2M12 22v-2M5 5 3.5 3.5M20.5 20.5 19 19M19 5l1.5-1.5M5 19l-1.5 1.5',
  package: 'M4 7.5 12 3l8 4.5v9L12 21l-8-4.5zM4 7.5l8 4.5 8-4.5M12 12v9',
};

function iconSvg(name, className = 'ui-icon') {
  const svg = el('svg', {
    class: className, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true', focusable: 'false',
  });
  svg.append(el('path', { d: ICON_PATHS[name] || ICON_PATHS.package }));
  return svg;
}

const uuid = () =>
  crypto.randomUUID ? crypto.randomUUID()
    : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);

/** يحوّل الأرقام العربية-الهندية والفارسية إلى لاتينية.
 *  لازم قبل أي Number(): ‏Number('٤٠') تساوي NaN. */
function toLatinDigits(input) {
  return String(input ?? '')
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
}

/** المال: أعداد صحيحة بالأغورة. ١ شيكل = ١٠٠ أغورة. */
const Money = {
  toAgorot(input) {
    let s = toLatinDigits(input).trim();
    if (!s) return 0;
    s = s.replace(/[٫,]/g, '.').replace(/[^\d.]/g, '');
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.round(n * 100);
  },
  fmt(agorot) {
    const v = Math.round(Number(agorot) || 0);
    return (v / 100).toFixed(2);
  },
};

/** نهاية الشهر محلياً — الدواء صالح حتى آخر يوم في شهر الصلاحية. */
function monthEnd(ym) {
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return 0;
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0, 23, 59, 59, 999).getTime();
}
function toMonthInput(ts) {
  if (!ts || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
/** تنسيق آمن — لا يرمي استثناء على تاريخ غير صالح (كان يُسقط الجدول كله). */
function fmtMonth(ts) {
  const s = toMonthInput(ts);
  return s || '—';
}
function fmtDateTime(ts) {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' });
}

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

/* ---------- تنبيهات وحوارات ---------- */

function toast(msg, type = 'success') {
  const c = $('toast-container');
  const t = el('div', { class: `toast ${type}`, text: msg });
  c.append(t);
  setTimeout(() => t.remove(), 3200);
}

/** بديل confirm() — منسّق، غير حاجب للصفحة، ويدعم Esc. */
function confirmDialog({ title, message, confirmText = 'تأكيد', danger = false, requireText = null }) {
  return new Promise((resolve) => {
    const dlg = el('dialog');
    let input = null;
    const body = [el('h3', { text: title }), el('p', { text: message })];
    if (requireText) {
      input = el('input', { type: 'text', placeholder: requireText, autocomplete: 'off' });
      body.push(input);
    }
    const okBtn = el('button', {
      class: danger ? 'btn-danger' : 'btn-primary',
      text: confirmText,
      onclick: () => {
        if (requireText && input.value.trim() !== requireText) {
          toast('النص المُدخل غير مطابق', 'error');
          return;
        }
        dlg.close('ok');
      },
    });
    dlg.append(
      ...body,
      el('div', { class: 'dialog-actions' },
        el('button', { class: 'btn-ghost', text: 'إلغاء', onclick: () => dlg.close('cancel') }),
        okBtn)
    );
    dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'ok'); dlg.remove(); });
    document.body.append(dlg);
    dlg.showModal();
    (input || okBtn).focus();
  });
}

/** بديل prompt() */
function promptDialog({ title, message, value = '', type = 'text', placeholder = '' }) {
  return new Promise((resolve) => {
    const dlg = el('dialog');
    const input = el('input', { type, value, placeholder, autocomplete: 'off' });
    dlg.append(
      el('h3', { text: title }),
      message ? el('p', { text: message }) : null,
      input,
      el('div', { class: 'dialog-actions' },
        el('button', { class: 'btn-ghost', text: 'إلغاء', onclick: () => dlg.close('') }),
        el('button', { class: 'btn-primary', text: 'حفظ', onclick: () => dlg.close(input.value) }))
    );
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') dlg.close(input.value); });
    dlg.addEventListener('close', () => { resolve(dlg.returnValue); dlg.remove(); });
    document.body.append(dlg);
    dlg.showModal();
    input.focus();
    input.select();
  });
}

/**
 * حوار إخراج كمية من المخزون. الكمية والسبب معًا في شاشة واحدة:
 * فصلهما كان يجعل المستخدم يؤكد رقمًا قبل أن يعرف أنه سيُسأل عن السبب.
 */
function writeOffDialog({ title, productName, batchNumber, maxQty, defaultQty, defaultReason }) {
  return new Promise((resolve) => {
    const dlg = el('dialog');
    const qty = el('input', {
      type: 'number', min: '1', max: String(maxQty), value: String(defaultQty || maxQty),
      autocomplete: 'off', 'aria-label': 'الكمية المُخرجة',
    });
    const reason = el('select', { 'aria-label': 'السبب' });
    for (const [key, cfg] of Object.entries(WRITE_OFF_REASONS)) {
      reason.append(el('option', { value: key, text: cfg.label }));
    }
    if (defaultReason) reason.value = defaultReason;
    const note = el('input', { type: 'text', placeholder: 'ملاحظة اختيارية', autocomplete: 'off' });

    dlg.append(
      el('h3', { text: title }),
      el('p', { text: `${productName} — دفعة ${batchNumber || '—'} • المتوفر ${maxQty}` }),
      el('label', { text: 'الكمية المُخرجة' }), qty,
      el('label', { text: 'السبب' }), reason,
      el('label', { text: 'ملاحظة' }), note,
      el('p', { class: 'dialog-hint', text: 'لا يُحذف السجل. تُسجَّل حركة إخراج تبقى في التقارير وسجل التدقيق.' }),
      el('div', { class: 'dialog-actions' },
        el('button', { class: 'btn-ghost', text: 'إلغاء', onclick: () => dlg.close('') }),
        el('button', {
          class: 'btn-danger', text: 'تأكيد الإخراج',
          onclick: () => {
            const n = parseInt(qty.value, 10);
            if (!Number.isInteger(n) || n < 1 || n > maxQty) { toast('أدخل كمية ضمن المتوفر', 'error'); return; }
            dlg.close(JSON.stringify({ qty: n, reason: reason.value, note: note.value.trim().slice(0, 80) }));
          },
        }))
    );
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue ? JSON.parse(dlg.returnValue) : null);
      dlg.remove();
    });
    document.body.append(dlg);
    dlg.showModal();
    qty.focus();
    qty.select();
  });
}

function emptyState(emoji, title, desc) {
  return el('div', { class: 'empty-state' },
    el('span', { class: 'em' }, iconSvg('package')),
    el('div', { class: 't', text: title }),
    el('div', { class: 'd', text: desc }));
}

/* ==================== ٢ب. تأجيل تنبيهات النواقص ==================== */

/**
 * التأجيل للنواقص وحدها. تنبيه الصلاحية لا يُؤجَّل: الدواء المنتهي على الرف
 * خطر لا قرار شراء، وطريقة إغلاقه هي إخراجه فعلًا.
 *
 * يُحفظ محليًا في `meta` لا في السحابة: هذا تفضيل عرض لجهاز، لا بيانات عمل.
 * والتأجيل مؤقت بتاريخ — يعود التنبيه وحده، فلا يتحوّل الإخفاء إلى نسيان.
 */
const SNOOZE_KEY = () => `snooze:${State.pharmacyId}`;

async function loadSnoozes() {
  const rec = await db.meta.get(SNOOZE_KEY());
  const map = rec?.value || {};
  const now = Date.now();
  const live = Object.fromEntries(Object.entries(map).filter(([, until]) => until > now));
  if (Object.keys(live).length !== Object.keys(map).length) {
    await db.meta.put({ key: SNOOZE_KEY(), value: live });
  }
  return live;
}

async function snoozeBatch(batchId, days) {
  const map = await loadSnoozes();
  map[batchId] = Date.now() + days * 86400000;
  await db.meta.put({ key: SNOOZE_KEY(), value: map });
}

async function clearSnoozes() {
  await db.meta.put({ key: SNOOZE_KEY(), value: {} });
}

/* ==================== ٣. قاعدة البيانات ==================== */

// اسم جديد: لا نلمس قاعدة النسخة القديمة إطلاقاً، ونستوردها لاحقاً بأمان.
const db = new Dexie('PharmaGaza');

db.version(1).stores({
  meta:       'key',
  users:      'id, pharmacy_id',
  products:   'id, [pharmacy_id+barcode], pharmacy_id, updated_at',
  batches:    'id, [pharmacy_id+product_id], pharmacy_id, expiry_end, updated_at',
  moves:      'id, [pharmacy_id+at], batch_id',
  invoices:   'id, [pharmacy_id+created_at], customer_id, updated_at',
  customers:  'id, pharmacy_id, updated_at',
  payments:   'id, [pharmacy_id+at], customer_id',
  settings:   'pharmacy_id',
  audit:      'id, [pharmacy_id+at]',
  sync_queue: '++qid, [pharmacy_id+status]',
});

const meta = {
  async get(key, dflt = null) {
    const r = await db.meta.get(key);
    return r ? r.value : dflt;
  },
  async set(key, value) { await db.meta.put({ key, value }); },
};

/* ==================== ٤. الحالة ==================== */

const State = {
  pharmacyId: '',
  user: null,          // {id, name, role}
  token: null,
  tokenExpires: 0,
  deviceId: '',
  settings: { name: 'صيدلية', phone: '', address: '', currency: '₪' },
  cart: [],
  readOnly: false,
  syncing: false,
  invPage: 1,
  searchResults: [],
  kbIndex: -1,
};

const can = (...roles) => State.user && roles.includes(State.user.role);

/* ==================== ٥. التشفير المحلي ==================== */

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(pin, saltB64, bits = 256) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const out = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: unb64(saltB64), iterations: CONFIG.PBKDF2_ITER, hash: 'SHA-256' },
    key, bits);
  return b64(out);
}

/* ==================== ٦. الاتصال بالسيرفر ==================== */

async function api(path, { method = 'GET', body = null, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && State.token) headers['Authorization'] = 'Bearer ' + State.token;
  const res = await fetch(CONFIG.WORKER_URL + path, {
    method, headers, body: body ? JSON.stringify(body) : null,
  });
  let data = null;
  try { data = await res.json(); } catch { /* رد بلا محتوى */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || 'HTTP_' + res.status);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* ==================== ٧. الدخول والجلسة ==================== */

let pinBuffer = '';
let lockMode = false;   // true = قفل خمول، لا خروج كامل

function updateDots() {
  for (let i = 1; i <= 6; i++) {
    const d = $('d' + i);
    if (d) d.classList.toggle('active', pinBuffer.length >= i);
  }
}
let autoTryTimer = null;

function addPin(n) {
  if (pinBuffer.length >= 6) return;
  pinBuffer += n;
  updateDots();
  // لا إرسال تلقائي للسيرفر. الرقم من ٤ إلى ٦ خانات، وإرساله عند الخانة
  // الرابعة كان يفشل لصاحب الـ ٦ ويحرق محاولة من عدّاد القفل في كل مرة.
  clearTimeout(autoTryTimer);
  if (pinBuffer.length >= 4) autoTryTimer = setTimeout(tryLocalUnlock, 250);
}
function clearPin() { pinBuffer = ''; clearTimeout(autoTryTimer); updateDots(); }

/* ---------- المستخدمون المحفوظون على هذا الجهاز ----------
 * خريطة بمفتاح user_id، لا سجل واحد. جهاز مشترك بين المالك والكاشير
 * يحتفظ بمُثبِّت كليهما، فلا يُلغي أحدهما قدرة الآخر على الدخول أوفلاين.
 */

async function getLocalUsers(pharmacyId) {
  const map = await meta.get('local_users_' + pharmacyId);
  if (map) return map;
  // ترحيل من الصيغة القديمة (مستخدم واحد لكل صيدلية)
  const legacy = await meta.get('local_user_' + pharmacyId);
  if (legacy && legacy.verifier) {
    const m = { [legacy.id]: { ...legacy, len: null, at: Date.now() } };
    await meta.set('local_users_' + pharmacyId, m);
    await meta.set('local_user_' + pharmacyId, null);
    // التوكن أيضاً: كان بمفتاح token_<صيدلية> وصار token_<صيدلية>_<مستخدم>.
    // بدون نقله يُعتبر المستخدم بلا توكن فيسقط في وضع القراءة فقط.
    const legacyTok = await meta.get('token_' + pharmacyId);
    if (legacyTok && legacyTok.token) {
      await meta.set(tokenKey(pharmacyId, legacy.id), legacyTok);
      await meta.set('token_' + pharmacyId, null);
    }
    return m;
  }
  return {};
}

/** هل لدى هذا المستخدم توكن سارٍ على هذا الجهاز؟ */
async function hasValidToken(pharmacyId, userId) {
  const t = await meta.get(tokenKey(pharmacyId, userId));
  return !!(t && t.token && t.expires > Date.now());
}

/** رسالة تشرح سبب وضع القراءة بدل «وضع القراءة فقط» المبهمة. */
function readOnlyReason() {
  if (!navigator.onLine) return 'وضع القراءة فقط — انتهت صلاحية الجلسة. اتصل بالإنترنت وسجّل الدخول مجدداً.';
  return 'وضع القراءة فقط — سجّل الخروج ثم الدخول لتجديد الجلسة.';
}

async function putLocalUser(pharmacyId, rec) {
  const m = await getLocalUsers(pharmacyId);
  m[rec.id] = rec;
  await meta.set('local_users_' + pharmacyId, m);
}

/** يبحث عن مستخدم محلي يطابق الرقم.
 *  byLength: اختبر أصحاب هذا الطول فقط — يجعل الفتح التلقائي اشتقاقاً واحداً
 *  بدل اشتقاق لكل موظف، فلا تتباطأ الشاشة على جهاز لوحي ضعيف. */
async function matchLocalUser(pharmacyId, pin, byLength = false) {
  const m = await getLocalUsers(pharmacyId);
  const cands = Object.values(m).filter(
    (u) => !byLength || u.len == null || u.len === pin.length);
  if (!cands.length) return null;
  const derived = await Promise.all(cands.map((u) => derive(pin, u.salt)));
  for (let i = 0; i < cands.length; i++) {
    if (derived[i] === cands[i].verifier) return cands[i];
  }
  return null;
}

const tokenKey = (pharmacyId, userId) => `token_${pharmacyId}_${userId}`;

/** فتح محلي صامت: بلا طلب شبكة وبلا عدّاد محاولات.
 *  يُبقي الدخول فورياً لصاحب الرقم القصير دون معاقبة صاحب الرقم الأطول. */
async function tryLocalUnlock() {
  if (State.user) return;
  const pharmacyId = lockMode
    ? State.pharmacyId
    : $('pharmacy-id-input').value.trim().toUpperCase();
  if (!pharmacyId) return;
  const u = await matchLocalUser(pharmacyId, pinBuffer, true);
  if (!u) return;                        // لا مطابقة: قد يكون الرقم أطول — لا تفعل شيئاً
  if (lockMode && State.user && u.id !== State.user.id) return;
  // الرقم صحيح لكن التوكن منتهٍ ولدينا إنترنت: جدّده من السيرفر
  // بدل الدخول لوضع القراءة فقط. المطابقة نجحت، فلن تُحرق محاولة فاشلة.
  if (navigator.onLine && !(await hasValidToken(pharmacyId, u.id))) { attemptLogin(); return; }
  await finishLocalLogin(pharmacyId, u);
}

async function finishLocalLogin(pharmacyId, local) {
  const tok = await meta.get(tokenKey(pharmacyId, local.id));
  if (tok && tok.expires > Date.now()) {
    State.token = tok.token;
    State.tokenExpires = tok.expires;
    State.readOnly = false;
  } else {
    // التوكن منتهٍ: قراءة فقط بدل منع الصيدلية من مخزونها
    State.token = null;
    State.readOnly = true;
  }
  State.pharmacyId = pharmacyId;
  State.user = { id: local.id, name: local.name, role: local.role };
  await afterLogin();
}

async function attemptLogin() {
  const idInput = $('pharmacy-id-input');
  const pharmacyId = lockMode ? State.pharmacyId : idInput.value.trim().toUpperCase();
  const pin = pinBuffer;

  if (!pharmacyId) { toast('أدخل رمز الصيدلية', 'error'); return; }
  if (pin.length < 4) { toast('الرقم السري ٤ خانات على الأقل', 'error'); return; }

  const btn = $('login-btn');
  btn.disabled = true;

  try {
    // (أ) محاولة محلية — تعمل بلا إنترنت، وتتحقق من مُثبِّت مشتق لا من رقم مخزّن
    const localMap = await getLocalUsers(pharmacyId);
    if (Object.keys(localMap).length) {
      const u = await matchLocalUser(pharmacyId, pin, false);   // اختبر الجميع
      if (u) {
        // توكن سارٍ ⇒ دخول فوري. منتهٍ ونحن متصلون ⇒ نكمل للسيرفر لتجديده،
        // وإلا لبقي المستخدم حبيس وضع القراءة بلا مخرج.
        if (await hasValidToken(pharmacyId, u.id) || !navigator.onLine) {
          await finishLocalLogin(pharmacyId, u);
          return;
        }
      } else if (!navigator.onLine) {
        toast('الرقم السري غير صحيح', 'error');
        clearPin();
        btn.disabled = false;
        return;
      }
    }

    if (!navigator.onLine) {
      toast('أول دخول على هذا الجهاز يحتاج اتصالاً بالإنترنت', 'error');
      clearPin();
      btn.disabled = false;
      return;
    }

    // (ب) دخول من السيرفر
    const data = await api('/api/login', {
      method: 'POST', auth: false,
      body: { pharmacy_id: pharmacyId, pin, device_id: State.deviceId },
    });

    State.pharmacyId = pharmacyId;
    State.token = data.token;
    State.tokenExpires = data.expires_at;
    State.user = data.user;
    State.readOnly = false;

    // نخزّن مُثبِّتاً مشتقاً — لا الرقم السري. والتوكن بمفتاح المستخدم،
    // وإلا لاستخدم موظفٌ توكن زميله فنُسبت فواتيره لغيره على السيرفر.
    const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
    await putLocalUser(pharmacyId, {
      id: data.user.id, name: data.user.name, role: data.user.role,
      salt, verifier: await derive(pin, salt), len: pin.length, at: Date.now(),
    });
    await meta.set(tokenKey(pharmacyId, data.user.id),
      { token: data.token, expires: data.expires_at });

    if (data.settings) {
      await db.settings.put({ ...data.settings, pharmacy_id: pharmacyId });
    }
    await afterLogin();
  } catch (e) {
    if (e.message === 'LOCKED') {
      toast(`محاولات كثيرة. انتظر ${e.data.seconds} ثانية`, 'error');
    } else if (e.message === 'SUBSCRIPTION_SUSPENDED') {
      toast('اشتراك الصيدلية موقوف. تواصل مع مزوّد الخدمة.', 'error');
    } else if (e.message === 'INVALID_CREDENTIALS') {
      toast('رمز الصيدلية أو الرقم السري غير صحيح', 'error');
    } else {
      toast('تعذّر الاتصال بالسيرفر', 'error');
    }
    clearPin();
  } finally {
    btn.disabled = false;
  }
}

async function afterLogin() {
  localStorage.setItem('last_pharmacy', State.pharmacyId);
  clearPin();
  lockMode = false;

  const s = await db.settings.get(State.pharmacyId);
  if (s) State.settings = s;

  $('login-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');

  await importLegacyIfAny();
  buildNav();
  showView('dash');
  startSyncLoop();
  resetIdleTimer();
  audit('login', 'session', State.user.id, '');
  toast(`مرحباً ${State.user.name}`, 'info');
  if (State.readOnly) toast('وضع القراءة فقط — جدّد الاشتراك أو اتصل بالإنترنت', 'error');
  checkBackupReminder();
}

/** «خروج» ينهي الجلسة على هذا الجهاز فقط، ولا يُبطل التوكن ولا يحذفه.
 *  لو حذفناه لاحتاج الموظف إنترنتاً في بداية كل وردية قبل أن يبيع،
 *  وهذا ينقض الوعد الأساسي بالعمل بلا شبكة. الحاجز هو الرقم السري.
 *  سحب صلاحية موظف يتم من الإعدادات، ويُبطل جلساته على السيرفر فوراً. */
async function logout() {
  await audit('logout', 'session', State.user ? State.user.id : '', '');
  stopSyncLoop();
  State.user = null;
  State.token = null;
  State.cart = [];          // لا تُورَّث السلة للكاشير التالي
  State.readOnly = false;
  lockMode = false;
  $('app-view').classList.add('hidden');
  $('login-view').classList.remove('hidden');
  $('lock-note').classList.add('hidden');
  $('pharmacy-id-wrap').classList.remove('hidden');
  clearPin();
}

/* ---------- قفل الخمول ---------- */
let idleTimer = null;
function resetIdleTimer() {
  clearTimeout(idleTimer);
  if (!State.user) return;
  idleTimer = setTimeout(lockScreen, CONFIG.IDLE_LOCK_MS);
}
function lockScreen() {
  if (!State.user) return;
  lockMode = true;
  $('app-view').classList.add('hidden');
  $('login-view').classList.remove('hidden');
  $('lock-note').classList.remove('hidden');
  $('pharmacy-id-wrap').classList.add('hidden');
  clearPin();
}
['click', 'keydown', 'touchstart'].forEach((ev) =>
  document.addEventListener(ev, resetIdleTimer, { passive: true }));

/* ==================== ٨. سجل التدقيق ==================== */

async function audit(action, entity, entityId, detail) {
  if (!State.pharmacyId) return;
  const rec = {
    id: uuid(), pharmacy_id: State.pharmacyId, at: Date.now(),
    user_id: State.user ? State.user.id : '', user_name: State.user ? State.user.name : '',
    action, entity, entity_id: String(entityId || ''), detail: String(detail || ''),
  };
  await db.audit.add(rec);
  await queue('audit', rec);
}

/* ==================== ٩. المزامنة ==================== */

async function queue(action, payload) {
  if (State.readOnly) return;
  await db.sync_queue.add({
    pharmacy_id: State.pharmacyId, action, payload,
    status: 'pending', at: Date.now(),
  });
}

/** كل تغيير على الكمية يمر من هنا: حركة لها معرّف فريد، لا كتابة مباشرة. */
async function applyMove({ batchId, delta, reason, refId }) {
  const move = {
    id: uuid(), pharmacy_id: State.pharmacyId, batch_id: batchId,
    delta, reason, ref_id: refId || null,
    device_id: State.deviceId, user_id: State.user ? State.user.id : '', at: Date.now(),
  };
  await db.moves.add(move);
  await db.batches.where('id').equals(batchId).modify((b) => { b.quantity = (b.quantity || 0) + delta; });
  await queue('stock_move', move);
  return move;
}

let syncTimer = null;
function startSyncLoop() {
  stopSyncLoop();
  syncTimer = setInterval(syncNow, CONFIG.SYNC_INTERVAL_MS);
  syncNow();
}
function stopSyncLoop() { clearInterval(syncTimer); syncTimer = null; }

function setNetStatus(state) {
  const dot = $('net-dot'), txt = $('net-text');
  const map = {
    online:  ['status-dot dot-online', 'متصل'],
    offline: ['status-dot dot-offline', 'غير متصل'],
    syncing: ['status-dot dot-syncing', 'مزامنة...'],
    readonly:['status-dot dot-offline', 'قراءة فقط'],
  };
  const [cls, text] = map[state] || map.offline;
  dot.className = cls;
  txt.textContent = text;
}

async function syncNow() {
  if (!State.user || State.syncing) return;
  if (!navigator.onLine) { setNetStatus('offline'); return; }
  if (State.readOnly || !State.token) { setNetStatus('readonly'); return; }

  State.syncing = true;
  setNetStatus('syncing');
  try {
    // (أ) رفع المعلّق
    const pending = await db.sync_queue
      .where('[pharmacy_id+status]').equals([State.pharmacyId, 'pending'])
      .limit(300).toArray();

    if (pending.length) {
      const res = await api('/api/sync', {
        method: 'POST',
        body: { actions: pending.map((p) => ({ id: p.qid, action: p.action, payload: p.payload })) },
      });
      const okIds = (res.results || []).filter((r) => r.ok).map((r) => r.id);
      await db.sync_queue.bulkDelete(okIds);          // نحذف بدل تعليمه — لا ينمو للأبد
      const failed = (res.results || []).filter((r) => !r.ok);
      if (failed.length) console.warn('sync failures', failed);
    }

    // (ب) سحب التحديثات — لا نرسل pharmacy_id، السيرفر يعرفه من التوكن
    const last = Number(await meta.get('last_sync_' + State.pharmacyId, 0));
    const upd = await api(`/api/get-updates?last_sync=${last}&device_id=${encodeURIComponent(State.deviceId)}`);
    await applyUpdates(upd);
    await meta.set('last_sync_' + State.pharmacyId, upd.server_time);
    setNetStatus('online');
  } catch (e) {
    if (e.message === 'UNAUTHORIZED') {
      State.readOnly = true;
      setNetStatus('readonly');
      toast('انتهت الجلسة. سجّل الدخول مجدداً للمزامنة.', 'error');
    } else if (e.message === 'SUBSCRIPTION_SUSPENDED') {
      State.readOnly = true;
      setNetStatus('readonly');
      toast('الاشتراك موقوف — وضع القراءة فقط', 'error');
    } else {
      setNetStatus('offline');
    }
  } finally {
    State.syncing = false;
  }
}

async function applyUpdates(u) {
  const ph = State.pharmacyId;
  const stamp = (arr) => (arr || []).map((r) => ({ ...r, pharmacy_id: ph }));

  if (u.products?.length) await db.products.bulkPut(stamp(u.products));
  if (u.customers?.length) await db.customers.bulkPut(stamp(u.customers));
  if (u.invoices?.length) await db.invoices.bulkPut(stamp(u.invoices));
  if (u.payments?.length) await db.payments.bulkPut(stamp(u.payments));
  if (u.settings) { await db.settings.put({ ...u.settings, pharmacy_id: ph }); State.settings = u.settings; }

  // الدفعات: أول مزامنة تأخذ اللقطة؛ بعدها الكمية تتغير بالحركات فقط
  for (const b of u.batches || []) {
    const local = await db.batches.get(b.id);
    const rec = { ...b, pharmacy_id: ph };
    rec.quantity = u.first_sync || !local ? (b.qty_snapshot || 0) : local.quantity;
    await db.batches.put(rec);
  }

  // حركات الأجهزة الأخرى — تُطبَّق مرة واحدة بحسب معرّفها
  for (const m of u.moves || []) {
    if (await db.moves.get(m.id)) continue;
    await db.moves.add({ ...m, pharmacy_id: ph });
    // في أول مزامنة الرصيد جاء من اللقطة، واللقطة تشمل هذه الحركات أصلاً.
    // نحفظها للتاريخ والتقارير، ولا نطبّقها على الكمية وإلا خُصمت مرتين.
    if (u.first_sync) continue;
    await db.batches.where('id').equals(m.batch_id).modify((b) => {
      b.quantity = (b.quantity || 0) + m.delta;
    });
  }

  if (u.products?.length || u.batches?.length || u.moves?.length) {
    if (currentView === 'inv') renderInventory();
    if (currentView === 'dash') renderDashboard();
  }
}

/* ==================== ١٠. استيراد النسخة القديمة ==================== */

async function importLegacyIfAny() {
  if (await meta.get('legacy_imported_' + State.pharmacyId)) return;
  let old;
  try {
    old = new Dexie('PharmaSaaS_DB');
    await old.open();
  } catch { await meta.set('legacy_imported_' + State.pharmacyId, true); return; }

  try {
    const ph = State.pharmacyId;
    const [prods, batches, invs, custs] = await Promise.all([
      old.table('products').where('pharmacy_id').equals(ph).toArray().catch(() => []),
      old.table('batches').where('pharmacy_id').equals(ph).toArray().catch(() => []),
      old.table('invoices').where('pharmacy_id').equals(ph).toArray().catch(() => []),
      old.table('customers').where('pharmacy_id').equals(ph).toArray().catch(() => []),
    ]);
    if (!prods.length && !batches.length && !invs.length && !custs.length) {
      await meta.set('legacy_imported_' + ph, true);
      old.close();
      return;
    }

    const now = Date.now();
    await db.products.bulkPut(prods.map((p) => ({
      id: p.id, pharmacy_id: ph, name: p.name || '', barcode: p.barcode || '',
      category: p.category || '', is_deleted: 0, updated_at: now,
    })));
    for (const b of batches) {
      await db.batches.put({
        id: b.id, pharmacy_id: ph, product_id: b.product_id,
        batch_number: b.batch_number || '', expiry_end: b.expiry_date || 0,
        sell_price_agorot: Money.toAgorot(b.sell_price),
        cost_price_agorot: Money.toAgorot(b.cost_price),
        quantity: Number(b.quantity) || 0, is_deleted: 0, updated_at: now,
      });
    }
    await db.customers.bulkPut(custs.map((c) => ({
      id: c.id, pharmacy_id: ph, name: c.name || '', phone: c.phone || '',
      debt_agorot: Money.toAgorot(c.debt), is_deleted: 0, updated_at: now,
    })));
    await db.invoices.bulkPut(invs.map((i) => ({
      id: i.id, pharmacy_id: ph, invoice_number: i.invoice_number || i.id,
      total_agorot: Money.toAgorot(i.total), user_id: i.user_id || '',
      cashier_name: i.cashier_name || '', customer_id: i.customer_id || null,
      payment_type: i.payment_type || 'cash', items_json: i.items_json || '[]',
      is_voided: i.is_voided ? 1 : 0, created_at: i.created_at || now, updated_at: now,
    })));

    await meta.set('legacy_imported_' + ph, true);
    old.close();
    toast(`تم استيراد بيانات النسخة السابقة (${prods.length} صنف)`, 'info');
  } catch (e) {
    console.warn('legacy import failed', e);
    await meta.set('legacy_imported_' + State.pharmacyId, true);
  }
}

/* ==================== ١١. التنقل والعرض ==================== */

const VIEWS = ['dash', 'pos', 'inv', 'cust', 'rep', 'set'];
const NAV = [
  { id: 'dash', label: 'الرئيسية', icon: 'home', roles: ['owner', 'pharmacist', 'cashier'] },
  { id: 'pos',  label: 'الكاشير',  icon: 'pos', roles: ['owner', 'pharmacist', 'cashier'] },
  { id: 'inv',  label: 'المخزون',  icon: 'inventory', roles: ['owner', 'pharmacist'] },
  { id: 'cust', label: 'الزبائن',  icon: 'customers', roles: ['owner', 'pharmacist', 'cashier'] },
  { id: 'rep',  label: 'التقارير', icon: 'reports', roles: ['owner'] },
  { id: 'set',  label: 'الإعدادات', icon: 'settings', roles: ['owner'] },
];
let currentView = 'dash';

function buildNav() {
  const top = $('nav-container'), bot = $('bottom-nav');
  clear(top); clear(bot);
  for (const item of NAV) {
    if (!item.roles.includes(State.user.role)) continue;
    top.append(el('button', {
      class: item.id === currentView ? 'active' : '',
      dataset: { nav: item.id }, onclick: () => showView(item.id),
    }, iconSvg(item.icon), el('span', { text: item.label })));
    bot.append(el('button', {
      class: item.id === currentView ? 'active' : '',
      dataset: { nav: item.id }, onclick: () => showView(item.id),
    }, iconSvg(item.icon), el('span', { text: item.label })));
  }
}

function showView(id) {
  currentView = id;
  VIEWS.forEach((v) => $(v + '-view').classList.toggle('hidden', v !== id));
  document.querySelectorAll('[data-nav]').forEach((b) =>
    b.classList.toggle('active', b.dataset.nav === id));
  window.scrollTo(0, 0);

  if (id === 'dash') renderDashboard();
  if (id === 'pos') { renderPosCustomers(); renderCart(); $('search-input').focus(); }
  if (id === 'inv') { State.invPage = 1; renderInventory(); renderProductsDropdown(); }
  if (id === 'cust') renderCustomers();
  if (id === 'rep') renderReports();
  if (id === 'set') renderSettings();
}

function toggleTheme() {
  const t = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  applyTheme(t);
  localStorage.setItem('theme', t);
}
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
}

/* ==================== ١٢. لوحة التحكم ==================== */

async function todayInvoices() {
  return db.invoices
    .where('[pharmacy_id+created_at]')
    .between([State.pharmacyId, startOfToday()], [State.pharmacyId, Date.now() + 1])
    .toArray();
}

async function renderDashboard() {
  const invs = (await todayInvoices()).filter((i) => !i.is_voided);
  $('stat-sales').textContent = Money.fmt(invs.reduce((s, i) => s + i.total_agorot, 0));
  $('stat-invoices').textContent = invs.length;

  const batches = await db.batches.where('pharmacy_id').equals(State.pharmacyId).toArray();
  const now = Date.now();
  const warnAt = now + CONFIG.EXPIRY_WARN_DAYS * 86400000;

  const expired = batches.filter((b) => b.expiry_end && b.expiry_end < now && b.quantity > 0);
  const soon = batches.filter((b) => b.expiry_end >= now && b.expiry_end < warnAt && b.quantity > 0);
  const lowAll = batches.filter((b) => b.quantity > 0 && b.quantity < CONFIG.LOW_STOCK_DEFAULT);
  const snoozed = await loadSnoozes();
  const low = lowAll.filter((b) => !snoozed[b.id]);
  const snoozedCount = lowAll.length - low.length;

  // العدّاد يعرض النواقص كلها. التأجيل يهدّئ القائمة ولا يغيّر الرقم،
  // وإلا صار المؤشر يكذب على المالك في أهم شاشة عنده.
  $('stat-low-stock').textContent = lowAll.length;
  $('stat-expiring').textContent = soon.length;

  // قسم التنبيهات — كان فارغاً دائماً في النسخة السابقة
  const box = $('alerts-container');
  clear(box);
  const prods = await db.products.where('pharmacy_id').equals(State.pharmacyId).toArray();
  const pMap = Object.fromEntries(prods.map((p) => [p.id, p]));
  const all = [
    ...expired.map((b) => ({ b, kind: 'expired' })),
    ...soon.map((b) => ({ b, kind: 'soon' })),
    ...low.map((b) => ({ b, kind: 'low' })),
  ];
  const SHOWN = 25;
  const rows = all.slice(0, SHOWN);

  const snoozeNote = () => {
    if (!snoozedCount) return;
    box.append(el('div', { class: 'alert-more' },
      el('span', { text: `${snoozedCount} من النواقص مؤجلة مؤقتًا. ` }),
      el('button', {
        class: 'btn-ghost btn-sm', text: 'إظهارها',
        onclick: async () => { await clearSnoozes(); renderDashboard(); },
      })));
  };

  if (!rows.length) {
    box.append(emptyState('✅', 'لا توجد تنبيهات',
      snoozedCount ? 'لا تنبيهات نشطة الآن.' : 'المخزون سليم ولا توجد أصناف قاربت على الانتهاء.'));
    snoozeNote();
    return;
  }
  for (const { b, kind } of rows) {
    const name = pMap[b.product_id]?.name || 'صنف محذوف';
    const cfg = {
      expired: ['alert-expiry', 'منتهي الصلاحية', `دفعة ${b.batch_number} • انتهت ${fmtMonth(b.expiry_end)} • متبقٍ ${b.quantity}`],
      soon:    ['alert-expiry', 'قارب على الانتهاء', `دفعة ${b.batch_number} • ينتهي ${fmtMonth(b.expiry_end)} • متبقٍ ${b.quantity}`],
      low:     ['alert-low', 'كمية منخفضة', `دفعة ${b.batch_number} • متبقٍ ${b.quantity} فقط`],
    }[kind];
    // التنبيه ليس رسالة تُقرأ فتُخفى، بل وضع قائم. الصنف المنتهي يخرج من
    // القائمة حين يخرج من الرصيد فعلًا، فيكون الزر هو طريقة إغلاق التنبيه.
    let action;
    if (kind === 'expired' && !State.readOnly) {
      action = el('button', {
        class: 'btn-danger btn-sm', text: 'إتلاف',
        onclick: async () => {
          if (await writeOffBatch(b.id, 'expired')) { renderDashboard(); renderInventory(); }
        },
      });
    } else if (kind === 'low') {
      // النقص قرار شراء قد لا يمكن تنفيذه اليوم، فيُؤجَّل بتاريخ ويعود وحده.
      action = el('button', {
        class: 'btn-ghost btn-sm', text: 'تأجيل 7 أيام',
        onclick: async () => { await snoozeBatch(b.id, 7); renderDashboard(); },
      });
    } else {
      action = el('span', { class: 'badge badge-danger', text: 'صلاحية' });
    }
    box.append(el('div', { class: 'alert-item ' + cfg[0] },
      el('div', {}, el('div', { class: 't', text: `${name} — ${cfg[1]}` }),
                     el('div', { class: 'd', text: cfg[2] })),
      action));
  }
  // القطع الصامت يخفي تنبيهات دون أن يعرف المستخدم أنها موجودة.
  if (all.length > SHOWN) {
    box.append(el('div', { class: 'alert-more', text: `و${all.length - SHOWN} تنبيهًا آخر — راجع شاشة المخزون.` }));
  }
  snoozeNote();
}

/* ==================== ١٣. نقطة البيع ==================== */

function expiryInfo(batch) {
  const now = Date.now();
  if (!batch.expiry_end) return { state: 'unknown', label: 'بلا تاريخ', cls: 'badge-warn' };
  if (batch.expiry_end < now) return { state: 'expired', label: 'منتهية', cls: 'badge-danger' };
  if (batch.expiry_end < now + CONFIG.EXPIRY_WARN_DAYS * 86400000)
    return { state: 'soon', label: 'ينتهي ' + fmtMonth(batch.expiry_end), cls: 'badge-warn' };
  return { state: 'ok', label: fmtMonth(batch.expiry_end), cls: 'badge-ok' };
}

let searchTimer = null;
function liveSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(doSearch, 150);      // debounce — كان يمسح القاعدة كل ضغطة
}

async function doSearch() {
  const q = $('search-input').value.trim().toLowerCase();
  const dd = $('search-dropdown');
  State.kbIndex = -1;
  if (!q) {
    dd.classList.add('hidden');
    $('search-input').setAttribute('aria-expanded', 'false');
    State.searchResults = [];
    return;
  }

  const prods = await db.products.where('pharmacy_id').equals(State.pharmacyId).toArray();
  const hits = prods.filter((p) =>
    !p.is_deleted && ((p.name || '').toLowerCase().includes(q) || (p.barcode || '') === q));

  clear(dd);
  if (!hits.length) {
    dd.append(el('div', { class: 'search-item' }, el('div', { class: 'nm', text: 'لا توجد نتائج' })));
    dd.classList.remove('hidden');
    $('search-input').setAttribute('aria-expanded', 'true');
    State.searchResults = [];
    return;
  }

  const pMap = Object.fromEntries(hits.map((p) => [p.id, p]));
  let batches = await db.batches.where('[pharmacy_id+product_id]')
    .anyOf(hits.map((p) => [State.pharmacyId, p.id])).toArray();

  // FEFO — الأقرب انتهاءً أولاً بين القابل للبيع فقط.
  // المنتهي والنافد يهبطان لآخر القائمة معطّلَين حتى لا يتصدّرا نتيجة الفرز.
  const now = Date.now();
  const blockedRank = (b) => (b.quantity <= 0 || (b.expiry_end && b.expiry_end < now) ? 1 : 0);
  batches = batches.filter((b) => !b.is_deleted).sort((a, b) =>
    blockedRank(a) - blockedRank(b) ||
    (a.expiry_end || Infinity) - (b.expiry_end || Infinity));

  State.searchResults = [];
  batches.forEach((b) => {
    const info = expiryInfo(b);
    const out = b.quantity <= 0;
    const blocked = out || info.state === 'expired';
    if (!blocked) State.searchResults.push(b.id);

    const row = el(blocked ? 'div' : 'button', {
      class: 'search-item' + (blocked ? ' disabled' : ''),
      type: blocked ? null : 'button',
      role: blocked ? null : 'option',
      'aria-label': blocked ? null : `${pMap[b.product_id]?.name || 'صنف'}، دفعة ${b.batch_number || 'غير معروفة'}، متوفر ${b.quantity}`,
      dataset: blocked ? {} : { batchId: b.id },
    },
      el('div', {},
        el('div', { class: 'nm', text: pMap[b.product_id]?.name || '—' }),
        el('div', { class: 'meta' },
          el('span', { text: `دفعة ${b.batch_number || '—'}` }),
          el('span', { text: `متوفر ${b.quantity}` }),
          el('span', { class: 'badge ' + info.cls, text: info.label }),
          out ? el('span', { class: 'badge badge-danger', text: 'نفد' }) : null)),
      el('div', { class: 'price', text: Money.fmt(b.sell_price_agorot) + ' ' + State.settings.currency }));
    dd.append(row);
  });
  dd.classList.remove('hidden');
  $('search-input').setAttribute('aria-expanded', 'true');
}

// تفويض حدث واحد — لا onclick مضمّن، فلا مسار لحقن الكود
$('search-dropdown')?.addEventListener('click', (e) => {
  const row = e.target.closest('[data-batch-id]');
  if (row) selectBatch(row.dataset.batchId);
});

async function selectBatch(batchId) {
  const b = await db.batches.get(batchId);
  if (!b) return;
  const p = await db.products.get(b.product_id);
  addToCart(p, b);
  $('search-input').value = '';
  $('search-dropdown').classList.add('hidden');
  $('search-input').setAttribute('aria-expanded', 'false');
  $('search-input').focus();
}

function addToCart(product, batch) {
  const info = expiryInfo(batch);
  if (info.state === 'expired') { toast('لا يمكن بيع دفعة منتهية الصلاحية', 'error'); return; }
  if (batch.quantity <= 0) { toast('الكمية غير متوفرة', 'error'); return; }

  const ex = State.cart.find((i) => i.batch_id === batch.id);
  if (ex) {
    if (ex.qty >= batch.quantity) { toast('لا توجد كمية إضافية في هذه الدفعة', 'error'); return; }
    ex.qty++;
  } else {
    State.cart.push({
      batch_id: batch.id, product_id: batch.product_id,
      product_name: product ? product.name : '—',
      batch_number: batch.batch_number, expiry_end: batch.expiry_end,
      price_agorot: batch.sell_price_agorot, cost_agorot: batch.cost_price_agorot,
      qty: 1, available: batch.quantity,
    });
  }
  renderCart();
}

function renderCart() {
  const area = $('cart-area');
  clear(area);
  if (!State.cart.length) {
    area.append(emptyState('🛒', 'السلة فارغة', 'ابحث بالاسم أو امسح الباركود لإضافة صنف.'));
  } else {
    for (const i of State.cart) {
      const info = expiryInfo({ expiry_end: i.expiry_end });
      area.append(el('div', { class: 'cart-item' },
        el('div', {},
          el('h3', { text: i.product_name }),
          el('div', { class: 'sub', text: `دفعة ${i.batch_number || '—'} • ${info.label} • ${Money.fmt(i.price_agorot)} للوحدة` })),
        el('div', { style: 'display:flex;align-items:center;gap:10px;' },
          el('div', { class: 'qty-control' },
            el('button', { text: '−', 'aria-label': 'إنقاص', onclick: () => changeQty(i.batch_id, -1) }),
            el('input', {
              type: 'number', min: '1', value: String(i.qty), inputmode: 'numeric',
              'aria-label': `كمية ${i.product_name}`,
              onchange: (e) => setQty(i.batch_id, parseInt(e.target.value, 10)),
            }),
            el('button', { text: '+', 'aria-label': 'زيادة', onclick: () => changeQty(i.batch_id, 1) })),
          el('div', { class: 'price', text: Money.fmt(i.price_agorot * i.qty) }))));
    }
  }
  const total = State.cart.reduce((s, i) => s + i.price_agorot * i.qty, 0);
  $('grand-total').textContent = Money.fmt(total);
  $('currency-label').textContent = State.settings.currency;
}

function changeQty(batchId, d) {
  const i = State.cart.find((x) => x.batch_id === batchId);
  if (!i) return;
  setQty(batchId, i.qty + d);
}
function setQty(batchId, qty) {
  const i = State.cart.find((x) => x.batch_id === batchId);
  if (!i) return;
  if (!Number.isFinite(qty) || qty <= 0) {
    State.cart = State.cart.filter((x) => x.batch_id !== batchId);
  } else if (qty > i.available) {
    toast(`المتوفر ${i.available} فقط`, 'error');
    i.qty = i.available;
  } else {
    i.qty = Math.trunc(qty);
  }
  renderCart();
}

async function renderPosCustomers() {
  const sel = $('pos-customer');
  const cur = sel.value;
  const cs = await db.customers.where('pharmacy_id').equals(State.pharmacyId).toArray();
  clear(sel);
  sel.append(el('option', { value: 'walk_in', text: 'زبون عادي (كاشير)' }));
  cs.filter((c) => !c.is_deleted).forEach((c) =>
    sel.append(el('option', { value: c.id, text: c.name })));
  sel.value = cur || 'walk_in';
}

async function nextInvoiceNumber() {
  const seq = Number(await meta.get('inv_seq_' + State.pharmacyId, 0)) + 1;
  await meta.set('inv_seq_' + State.pharmacyId, seq);
  const dev = State.deviceId.slice(0, 4).toUpperCase();
  return `${State.pharmacyId}-${dev}-${String(seq).padStart(6, '0')}`;
}

async function checkout(print = false) {
  if (State.readOnly) { toast('وضع القراءة فقط — لا يمكن البيع', 'error'); return; }
  if (!State.cart.length) { toast('السلة فارغة', 'error'); return; }

  const customerId = $('pos-customer').value;
  const paymentType = $('pos-payment').value;
  if (paymentType === 'debt' && customerId === 'walk_in') {
    toast('اختر زبوناً مسجّلاً للبيع الآجل', 'error');
    return;
  }

  // تحقق أخير من الكميات والصلاحية قبل الإثبات
  for (const i of State.cart) {
    const b = await db.batches.get(i.batch_id);
    if (!b || b.quantity < i.qty) { toast(`الكمية غير كافية: ${i.product_name}`, 'error'); return; }
    if (b.expiry_end && b.expiry_end < Date.now()) { toast(`دفعة منتهية: ${i.product_name}`, 'error'); return; }
  }

  const id = uuid();
  const number = await nextInvoiceNumber();
  const total = State.cart.reduce((s, i) => s + i.price_agorot * i.qty, 0);
  const items = State.cart.map((i) => ({
    batch_id: i.batch_id, product_name: i.product_name, batch_number: i.batch_number,
    qty: i.qty, price_agorot: i.price_agorot, cost_agorot: i.cost_agorot,
  }));

  const invoice = {
    id, pharmacy_id: State.pharmacyId, invoice_number: number, total_agorot: total,
    user_id: State.user.id, cashier_name: State.user.name,
    customer_id: customerId === 'walk_in' ? null : customerId,
    payment_type: paymentType, items_json: JSON.stringify(items),
    is_voided: 0, created_at: Date.now(), updated_at: Date.now(),
  };

  await db.transaction('rw', db.invoices, db.customers, db.batches, db.moves, db.sync_queue, async () => {
    await db.invoices.add(invoice);
    await queue('create_invoice', invoice);

    for (const i of items) {
      await applyMove({ batchId: i.batch_id, delta: -i.qty, reason: 'sale', refId: id });
    }
    // الدين — كان لا يُسجَّل إطلاقاً في النسخة السابقة
    if (paymentType === 'debt') {
      await db.customers.where('id').equals(customerId).modify((c) => {
        c.debt_agorot = (c.debt_agorot || 0) + total;
        c.updated_at = Date.now();
      });
      const c = await db.customers.get(customerId);
      if (c) await queue('upsert_customer', c);
    }
  });

  await audit('sale', 'invoice', id, `${number} • ${Money.fmt(total)} • ${paymentType}`);

  State.cart = [];
  renderCart();
  if (print) printReceipt(invoice, items);
  toast(`تم البيع • ${number}`, 'success');
  syncNow();
  $('search-input').focus();
}

function printReceipt(invoice, items) {
  const c = State.settings.currency;
  const line = (a, b) => `<div class="r"><span>${escapeHtml(a)}</span><span>${escapeHtml(b)}</span></div>`;
  const html = `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
<title>${escapeHtml(invoice.invoice_number)}</title><style>
body{font-family:monospace;width:76mm;margin:0;padding:4mm;font-size:12px;color:#000}
h1{text-align:center;font-size:15px;margin:0 0 2px}
.c{text-align:center;font-size:11px;margin:0}
.r{display:flex;justify-content:space-between;margin:3px 0;gap:8px}
hr{border:none;border-top:1px dashed #000;margin:6px 0}
.tot{border-top:2px solid #000;margin-top:6px;padding-top:6px;font-weight:bold;font-size:14px}
.f{text-align:center;font-size:10px;margin-top:8px}
</style></head><body>
<h1>${escapeHtml(State.settings.name || 'صيدلية')}</h1>
<p class="c">${escapeHtml(State.settings.address || '')}</p>
<p class="c">${escapeHtml(State.settings.phone || '')}</p><hr>
${line('فاتورة', invoice.invoice_number)}
${line('التاريخ', fmtDateTime(invoice.created_at))}
${line('البائع', invoice.cashier_name)}
${line('الدفع', invoice.payment_type === 'debt' ? 'آجل (دين)' : 'نقدي')}<hr>
${items.map((i) => line(`${i.product_name} × ${i.qty}`, `${Money.fmt(i.price_agorot * i.qty)} ${c}`)
  + `<div style="font-size:10px;color:#444">وحدة ${Money.fmt(i.price_agorot)} ${c} • دفعة ${escapeHtml(i.batch_number || '—')}</div>`).join('')}
<div class="tot">${line('الإجمالي', Money.fmt(invoice.total_agorot) + ' ' + c)}</div>
<p class="f">الاسترجاع خلال ٣ أيام بالفاتورة<br>لا تُسترجع الأدوية المبرّدة</p>
</body></html>`;
  const f = $('print-frame');
  f.srcdoc = html;
  f.onload = () => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch { /* تجاهل */ } };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

/* ---------- تدفق لوحة المفاتيح وماسح الباركود ---------- */

function initPosKeyboard() {
  const input = $('search-input');
  input.addEventListener('input', liveSearch);
  input.addEventListener('keydown', async (e) => {
    const dd = $('search-dropdown');
    const rows = [...dd.querySelectorAll('[data-batch-id]')];

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      State.kbIndex = e.key === 'ArrowDown'
        ? Math.min(State.kbIndex + 1, rows.length - 1)
        : Math.max(State.kbIndex - 1, 0);
      rows.forEach((r, idx) => r.classList.toggle('kb-active', idx === State.kbIndex));
      rows[State.kbIndex].scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Escape') { dd.classList.add('hidden'); return; }
    if (e.key !== 'Enter') return;

    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;

    // مسدس الباركود يكتب الرقم ثم Enter — تطابق دقيق يضيف مباشرة
    const prod = await db.products.where('[pharmacy_id+barcode]')
      .equals([State.pharmacyId, q]).first();
    if (prod) {
      const bs = (await db.batches.where('[pharmacy_id+product_id]')
        .equals([State.pharmacyId, prod.id]).toArray())
        .filter((b) => !b.is_deleted && b.quantity > 0 &&
                       (!b.expiry_end || b.expiry_end >= Date.now()))
        .sort((a, b) => (a.expiry_end || Infinity) - (b.expiry_end || Infinity));
      if (bs.length) {
        addToCart(prod, bs[0]);          // FEFO تلقائياً
        input.value = '';
        $('search-dropdown').classList.add('hidden');
        $('search-input').setAttribute('aria-expanded', 'false');
        return;
      }
      toast('لا توجد دفعة صالحة لهذا الصنف', 'error');
      return;
    }
    if (State.kbIndex >= 0 && rows[State.kbIndex]) {
      selectBatch(rows[State.kbIndex].dataset.batchId);
    } else if (State.searchResults.length === 1) {
      selectBatch(State.searchResults[0]);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (!State.user) return;
    if (e.key === 'F2' && currentView === 'pos') { e.preventDefault(); checkout(false); }
    if (e.key === 'F4') { e.preventDefault(); showView('pos'); $('search-input').focus(); }
    if (e.key === 'F9' && currentView === 'pos') { e.preventDefault(); checkout(true); }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrapper')) {
      $('search-dropdown').classList.add('hidden');
      $('search-input').setAttribute('aria-expanded', 'false');
    }
  });
}

/* ---------- الماسح ---------- */

let scanner = null;
async function startScanner(targetId) {
  if (scanner) return;
  if (typeof Html5Qrcode === 'undefined') {
    const ok = await loadScript('vendor/html5-qrcode.min.js');
    if (!ok) { toast('مكتبة الماسح غير متوفرة — أدخل الباركود يدوياً', 'error'); return; }
  }
  const dlg = el('dialog', { id: 'scan-dialog' },
    el('h3', { text: 'مسح الباركود' }),
    el('div', { id: 'reader' }),
    el('div', { class: 'dialog-actions' },
      el('button', { class: 'btn-ghost', text: 'إغلاق', onclick: stopScanner })));
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener('cancel', stopScanner);

  try {
    scanner = new Html5Qrcode('reader');
    await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: 250 }, (text) => {
      const t = $(targetId);
      t.value = text;
      stopScanner();
      if (targetId === 'search-input') {
        t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
    });
  } catch {
    toast('تعذّر فتح الكاميرا', 'error');
    stopScanner();
  }
}

async function stopScanner() {
  if (scanner) { try { await scanner.stop(); scanner.clear(); } catch { /* تجاهل */ } scanner = null; }
  const d = $('scan-dialog');
  if (d) { d.close(); d.remove(); }
}

function loadScript(src) {
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.append(s);
  });
}

/* ==================== ١٤. المخزون ==================== */

async function addProduct() {
  const name = $('med-name').value.trim();
  if (!name) { toast('أدخل اسم الدواء', 'error'); return; }
  const rec = {
    id: uuid(), pharmacy_id: State.pharmacyId, name,
    barcode: $('med-barcode').value.trim(), category: $('med-category').value.trim(),
    is_deleted: 0, updated_at: Date.now(),
  };
  await db.products.add(rec);
  await queue('upsert_product', rec);
  await audit('add_product', 'product', rec.id, name);
  ['med-name', 'med-barcode', 'med-category'].forEach((i) => ($(i).value = ''));
  toast('تمت إضافة الصنف');
  renderProductsDropdown();
  renderInventory();
  syncNow();
}

async function addBatch() {
  const pid = $('batch-product-id').value;
  const ym = $('batch-expiry').value;
  const qty = parseInt($('batch-qty').value, 10);
  if (!pid) { toast('اختر الدواء', 'error'); return; }
  if (!ym) { toast('أدخل تاريخ الصلاحية', 'error'); return; }
  if (!Number.isFinite(qty) || qty <= 0) { toast('أدخل كمية صحيحة', 'error'); return; }

  const expiry = monthEnd(ym);
  if (expiry < Date.now()) {
    const go = await confirmDialog({
      title: 'دفعة منتهية الصلاحية',
      message: 'تاريخ الصلاحية المُدخل في الماضي. ستُضاف للجرد لكن لن يمكن بيعها. متابعة؟',
      confirmText: 'إضافة', danger: true,
    });
    if (!go) return;
  }

  const rec = {
    id: uuid(), pharmacy_id: State.pharmacyId, product_id: pid,
    batch_number: $('batch-number').value.trim() || '—',
    expiry_end: expiry,
    sell_price_agorot: Money.toAgorot($('batch-price').value),
    cost_price_agorot: Money.toAgorot($('batch-cost').value),
    quantity: 0, is_deleted: 0, updated_at: Date.now(),
  };
  await db.batches.add(rec);
  await queue('upsert_batch', rec);
  await applyMove({ batchId: rec.id, delta: qty, reason: 'opening', refId: null });
  await audit('add_batch', 'batch', rec.id, `كمية ${qty}`);

  ['batch-number', 'batch-qty', 'batch-cost', 'batch-price', 'batch-expiry']
    .forEach((i) => ($(i).value = ''));
  toast('تمت إضافة الدفعة');
  renderInventory();
  renderDashboard();
  syncNow();
}

async function renderProductsDropdown() {
  const sel = $('batch-product-id');
  const ps = (await db.products.where('pharmacy_id').equals(State.pharmacyId).toArray())
    .filter((p) => !p.is_deleted);
  clear(sel);
  if (!ps.length) { sel.append(el('option', { value: '', text: 'أضف صنفاً أولاً' })); return; }
  ps.forEach((p) => sel.append(el('option', { value: p.id, text: p.name })));
}

async function renderInventory() {
  const body = $('inv-body');
  const wrap = $('inv-wrap');
  clear(body);

  const q = ($('inv-search').value || '').trim().toLowerCase();
  const prods = await db.products.where('pharmacy_id').equals(State.pharmacyId).toArray();
  const pMap = Object.fromEntries(prods.map((p) => [p.id, p]));
  let batches = (await db.batches.where('pharmacy_id').equals(State.pharmacyId).toArray())
    .filter((b) => !b.is_deleted);

  if (q) {
    batches = batches.filter((b) => {
      const p = pMap[b.product_id];
      return (p?.name || '').toLowerCase().includes(q) ||
             (p?.barcode || '') === q ||
             (b.batch_number || '').toLowerCase().includes(q);
    });
  }
  batches.sort((a, b) => (a.expiry_end || Infinity) - (b.expiry_end || Infinity));

  const oldMore = $('inv-more');
  if (oldMore) oldMore.remove();

  if (!batches.length) {
    wrap.append(emptyState('📦', 'لا توجد أصناف', q ? 'لا نتائج مطابقة للبحث.' : 'أضف صنفاً ثم دفعة لبدء العمل.'));
    return;
  }

  const shown = batches.slice(0, State.invPage * CONFIG.PAGE_SIZE);
  for (const b of shown) {
    const info = expiryInfo(b);
    const p = pMap[b.product_id];
    let stateBadge;
    if (b.quantity <= 0) stateBadge = el('span', { class: 'badge badge-danger', text: 'نفد' });
    else if (info.state === 'expired') stateBadge = el('span', { class: 'badge badge-danger', text: 'منتهية' });
    else if (b.quantity < CONFIG.LOW_STOCK_DEFAULT) stateBadge = el('span', { class: 'badge badge-warn', text: 'منخفض' });
    else stateBadge = el('span', { class: 'badge badge-ok', text: 'متوفر' });

    body.append(el('tr', {},
      el('td', { dataset: { label: 'الدواء' }, text: p?.name || 'صنف محذوف' }),
      el('td', { dataset: { label: 'الصنف' }, text: p?.category || '—' }),
      el('td', { dataset: { label: 'الدفعة' }, text: b.batch_number || '—' }),
      el('td', { dataset: { label: 'الصلاحية' } }, el('span', { class: 'badge ' + info.cls, text: fmtMonth(b.expiry_end) })),
      el('td', { class: 'num', dataset: { label: 'الكمية' }, text: String(b.quantity) }),
      el('td', { class: 'num', dataset: { label: 'السعر' }, text: Money.fmt(b.sell_price_agorot) }),
      el('td', { dataset: { label: 'الحالة' } }, stateBadge),
      el('td', { dataset: { label: 'إجراء' } },
        el('button', { class: 'btn-info', text: 'تسوية', onclick: () => adjustQty(b.id) }),
        b.quantity > 0
          ? el('button', {
              class: 'btn-danger btn-sm', text: 'إخراج',
              onclick: async () => {
                if (await writeOffBatch(b.id, info.state === 'expired' ? 'expired' : 'damaged')) {
                  renderInventory(); renderDashboard();
                }
              },
            })
          : null)));
  }

  if (batches.length > shown.length) {
    wrap.append(el('div', { class: 'list-more', id: 'inv-more' },
      el('button', {
        class: 'btn-ghost',
        text: `عرض المزيد (${batches.length - shown.length} متبقٍ)`,
        onclick: () => { State.invPage++; renderInventory(); },
      })));
  }
}

/**
 * إخراج كمية من دفعة بسبب مصنّف. هذا هو الإجراء الصحيح للصنف المنتهي:
 * البيع ممنوع أصلًا، وبدون إخراج تبقى العلبة في الرصيد فتضخّم قيمة المخزون
 * وتلوّث التنبيهات إلى الأبد. الحذف ليس بديلًا — الدواء المنتهي نفاية
 * خاضعة للرقابة ويجب أن يبقى أثر لما أُتلف ومتى.
 */
async function writeOffBatch(batchId, defaultReason = 'expired') {
  if (State.readOnly) { toast(readOnlyReason(), 'error'); return false; }
  const batch = await db.batches.get(batchId);
  if (!batch) return false;
  if ((batch.quantity || 0) <= 0) { toast('لا توجد كمية لإخراجها', 'error'); return false; }
  const product = await db.products.get(batch.product_id);

  const result = await writeOffDialog({
    title: 'إخراج من المخزون',
    productName: product?.name || 'صنف محذوف',
    batchNumber: batch.batch_number,
    maxQty: batch.quantity,
    defaultQty: batch.quantity,
    defaultReason,
  });
  if (!result) return false;

  const cfg = WRITE_OFF_REASONS[result.reason];
  const value = (batch.cost_price_agorot || 0) * result.qty;
  const confirmed = await confirmDialog({
    title: cfg.loss ? 'تأكيد الإتلاف' : 'تأكيد الإرجاع',
    message: `${result.qty} وحدة • ${cfg.label} • بتكلفة ${Money.fmt(value)}.`
      + (cfg.loss ? ' ستُحتسب خسارة في تقرير الهدر.' : ' تُحتسب استردادًا لا خسارة.'),
    confirmText: 'تأكيد',
    danger: true,
  });
  if (!confirmed) return false;

  await applyMove({ batchId, delta: -result.qty, reason: result.reason, refId: null });
  await audit('write_off', 'batch', batchId,
    `${result.qty} × ${product?.name || batchId} • ${cfg.label}${result.note ? ' • ' + result.note : ''}`);
  toast(cfg.loss ? 'تم الإتلاف وسُجّل في تقرير الهدر' : 'تم تسجيل الإرجاع');
  syncNow();
  return true;
}

async function adjustQty(batchId) {
  if (State.readOnly) { toast(readOnlyReason(), 'error'); return; }
  const b = await db.batches.get(batchId);
  if (!b) return;

  const val = await promptDialog({
    title: 'تسوية الكمية',
    message: `الكمية الحالية: ${b.quantity}. أدخل الكمية الصحيحة بعد الجرد.`,
    type: 'number', value: String(b.quantity),
  });
  if (val === '' || val == null) return;

  const n = parseInt(val, 10);
  if (!Number.isInteger(n) || n < 0) { toast('أدخل عدداً صحيحاً موجباً', 'error'); return; }
  if (n === b.quantity) return;

  const reason = await promptDialog({
    title: 'سبب التسوية',
    message: 'السبب إجباري ويُسجَّل في سجل التدقيق.',
    placeholder: 'تلف / انتهاء / خطأ جرد / مرتجع',
  });
  if (!reason || !reason.trim()) { toast('التسوية تتطلب سبباً', 'error'); return; }

  const delta = n - b.quantity;
  await applyMove({ batchId, delta, reason: 'adjust:' + reason.trim().slice(0, 40), refId: null });
  await audit('adjust_stock', 'batch', batchId, `${b.quantity} ← ${n} • ${reason.trim()}`);
  toast('تمت التسوية');
  renderInventory();
  renderDashboard();
  syncNow();
}

/* ==================== ١٤ب. الاستيراد من إكسل ==================== */

// أسماء الأعمدة المقبولة. المطابقة تتجاهل المسافات و«ال» التعريف،
// فلا يفشل الاستيراد بسبب اختلاف بسيط في صياغة العنوان.
const COLUMN_MAP = {
  name:    ['اسمالدواء', 'اسمالصنف', 'الاسم', 'اسم', 'الدواء', 'الصنف', 'name', 'product'],
  category:['الفئة', 'فئة', 'التصنيف', 'تصنيف', 'category'],
  barcode: ['الباركود', 'باركود', 'الرمز', 'barcode', 'code'],
  batch:   ['رقمالدفعة', 'الدفعة', 'دفعة', 'batch', 'lot'],
  expiry:  ['الصلاحية', 'تاريخالصلاحية', 'الانتهاء', 'expiry', 'exp'],
  qty:     ['الكمية', 'كمية', 'العدد', 'qty', 'quantity'],
  cost:    ['سعرالتكلفة', 'التكلفة', 'سعرالشراء', 'cost'],
  price:   ['سعرالبيع', 'البيع', 'السعر', 'price'],
};

const normHeader = (s) =>
  String(s ?? '').trim().toLowerCase()
    .replace(/[\s_\-.]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/^ال/, '');

function mapColumns(headerRow) {
  const found = {};
  headerRow.forEach((h, idx) => {
    const n = normHeader(h);
    for (const [key, names] of Object.entries(COLUMN_MAP)) {
      if (found[key] !== undefined) continue;
      if (names.some((v) => normHeader(v) === n)) { found[key] = idx; break; }
    }
  });
  return found;
}

/** يقبل تاريخ إكسل، و"2027-05"، و"05/2027"، و"5-2027". يعيد نهاية الشهر. */
function parseExpiry(v) {
  if (v == null || v === '') return 0;
  if (v instanceof Date && !isNaN(v)) return monthEnd(`${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}`);
  const s = toLatinDigits(v).trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})$/);            // 2027-05
  if (m) return monthEnd(`${m[1]}-${String(m[2]).padStart(2, '0')}`);
  m = s.match(/^(\d{1,2})[-/](\d{4})$/);                 // 05/2027
  if (m) return monthEnd(`${m[2]}-${String(m[1]).padStart(2, '0')}`);
  m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);    // 2027-05-31
  if (m) return monthEnd(`${m[1]}-${String(m[2]).padStart(2, '0')}`);
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);    // 31/05/2027
  if (m) return monthEnd(`${m[3]}-${String(m[2]).padStart(2, '0')}`);
  return 0;
}

async function loadXlsx() {
  if (typeof XLSX !== 'undefined') return true;
  return loadScript('vendor/xlsx.min.js');
}

async function downloadTemplate() {
  if (!(await loadXlsx())) { toast('تعذّر تحميل مكتبة إكسل', 'error'); return; }
  const rows = [
    ['اسم الدواء', 'الفئة', 'الباركود', 'رقم الدفعة', 'الصلاحية', 'الكمية', 'سعر التكلفة', 'سعر البيع'],
    ['باراسيتامول 500مغ', 'مسكنات', '6281000123456', 'B-1001', '2027-08', 120, 3.50, 5.00],
    ['أموكسيسيلين 250مغ', 'مضادات حيوية', '6281000987654', 'B-2044', '2026-12', 60, 8.25, 12.00],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 24 }, { wch: 16 }, { wch: 16 }, { wch: 12 }, { wch: 11 }, { wch: 9 }, { wch: 12 }, { wch: 11 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'الأصناف');
  XLSX.writeFile(wb, 'نموذج-استيراد-الأصناف.xlsx');
  toast('نُزّل النموذج — املأه ثم ارفعه');
}

async function handleExcelFile(evt) {
  const file = evt.target.files[0];
  evt.target.value = '';
  if (!file) return;
  if (State.readOnly) { toast(readOnlyReason(), 'error'); return; }
  if (!(await loadXlsx())) { toast('تعذّر تحميل مكتبة إكسل', 'error'); return; }

  let rows;
  try {
    const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
  } catch {
    toast('تعذّر قراءة الملف — تأكد أنه إكسل صالح', 'error');
    return;
  }
  if (!rows.length) { toast('الملف فارغ', 'error'); return; }

  const cols = mapColumns(rows[0]);
  if (cols.name === undefined) {
    toast('لم أجد عمود «اسم الدواء» — استخدم النموذج', 'error');
    return;
  }

  const cell = (r, key) => (cols[key] === undefined ? '' : r[cols[key]]);
  const ok = [], bad = [], warn = [];
  const seenBarcodes = new Set();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const lineNo = i + 1;                       // رقم السطر كما يراه في إكسل
    const name = String(cell(r, 'name') ?? '').trim();
    if (!name) continue;                        // سطر فارغ — تجاهل بصمت

    const qtyRaw = toLatinDigits(cell(r, 'qty')).trim();
    const qty = qtyRaw === '' ? 0 : Number(qtyRaw);
    const expiry = parseExpiry(cell(r, 'expiry'));
    const barcode = String(cell(r, 'barcode') ?? '').trim();
    const price = Money.toAgorot(cell(r, 'price'));
    const cost = Money.toAgorot(cell(r, 'cost'));

    if (!Number.isInteger(qty) || qty < 0) { bad.push(`سطر ${lineNo}: الكمية «${qtyRaw}» ليست عدداً صحيحاً`); continue; }
    if (!expiry) { bad.push(`سطر ${lineNo}: تاريخ صلاحية غير مفهوم «${cell(r, 'expiry')}»`); continue; }
    if (barcode && seenBarcodes.has(barcode)) warn.push(`سطر ${lineNo}: باركود مكرر داخل الملف`);
    if (barcode) seenBarcodes.add(barcode);
    if (price <= 0) warn.push(`سطر ${lineNo}: سعر البيع صفر`);
    if (expiry < Date.now()) warn.push(`سطر ${lineNo}: الصلاحية منتهية — لن يُسمح ببيعها`);

    ok.push({
      name, barcode,
      category: String(cell(r, 'category') ?? '').trim(),
      batch: String(cell(r, 'batch') ?? '').trim() || '—',
      expiry, qty, price, cost,
    });
  }

  if (!ok.length) {
    await importReport({ ok: [], bad, warn, confirmable: false });
    return;
  }
  const go = await importReport({ ok, bad, warn, confirmable: true });
  if (go) await commitImport(ok);
}

/** ملخص قبل الحفظ. لا يُكتب شيء في المخزون قبل موافقة صريحة. */
function importReport({ ok, bad, warn, confirmable }) {
  return new Promise((resolve) => {
    const dlg = el('dialog', { style: 'width:min(94vw,560px)' });
    const list = (title, items, cls) =>
      items.length
        ? el('div', { style: 'margin-block-start:12px' },
            el('div', { style: `font-weight:700;font-size:13.5px;margin-block-end:6px;color:var(--${cls})`,
                        text: `${title} (${items.length})` }),
            el('div', { style: 'max-height:150px;overflow:auto;font-size:12.5px;line-height:1.9;color:var(--muted)' },
              ...items.slice(0, 40).map((t) => el('div', { text: '• ' + t })),
              items.length > 40 ? el('div', { text: `… و${items.length - 40} أخرى` }) : null))
        : null;

    dlg.append(
      el('h3', { text: 'مراجعة الاستيراد' }),
      el('p', { text: ok.length
        ? `${ok.length} صنفاً جاهزاً للإضافة.`
        : 'لا يوجد أي سطر صالح للاستيراد.' }),
      list('أسطر مرفوضة — لن تُستورد', bad, 'danger'),
      list('تنبيهات — ستُستورد رغم ذلك', warn, 'warning'),
      el('div', { class: 'dialog-actions' },
        el('button', { class: 'btn-ghost', text: confirmable ? 'إلغاء' : 'إغلاق',
                       onclick: () => dlg.close('cancel') }),
        confirmable
          ? el('button', { class: 'btn-primary', text: `استيراد ${ok.length} صنفاً`,
                           onclick: () => dlg.close('ok') })
          : null)
    );
    dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'ok'); dlg.remove(); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

async function commitImport(rows) {
  const ph = State.pharmacyId;
  const now = Date.now();

  // الأصناف الموجودة: نطابق بالباركود أولاً ثم بالاسم، فلا تتكرر الأصناف
  const existing = await db.products.where('pharmacy_id').equals(ph).toArray();
  const byBarcode = new Map(existing.filter((p) => p.barcode).map((p) => [p.barcode, p]));
  const byName = new Map(existing.map((p) => [p.name.trim().toLowerCase(), p]));

  const newProducts = [], newBatches = [], newMoves = [], queueRows = [];
  let reused = 0;

  for (const r of rows) {
    let prod = (r.barcode && byBarcode.get(r.barcode)) || byName.get(r.name.toLowerCase());
    if (prod) {
      reused++;
    } else {
      prod = { id: uuid(), pharmacy_id: ph, name: r.name, barcode: r.barcode,
               category: r.category, is_deleted: 0, updated_at: now };
      newProducts.push(prod);
      if (r.barcode) byBarcode.set(r.barcode, prod);
      byName.set(r.name.toLowerCase(), prod);
      queueRows.push({ pharmacy_id: ph, action: 'upsert_product', payload: prod, status: 'pending', at: now });
    }

    const batch = {
      id: uuid(), pharmacy_id: ph, product_id: prod.id, batch_number: r.batch,
      expiry_end: r.expiry, sell_price_agorot: r.price, cost_price_agorot: r.cost,
      quantity: r.qty, is_deleted: 0, updated_at: now,
    };
    newBatches.push(batch);
    queueRows.push({ pharmacy_id: ph, action: 'upsert_batch',
                     payload: { ...batch, quantity: undefined }, status: 'pending', at: now });

    if (r.qty > 0) {
      const move = { id: uuid(), pharmacy_id: ph, batch_id: batch.id, delta: r.qty,
                     reason: 'import', ref_id: null, device_id: State.deviceId,
                     user_id: State.user.id, at: now };
      newMoves.push(move);
      queueRows.push({ pharmacy_id: ph, action: 'stock_move', payload: move, status: 'pending', at: now });
    }
  }

  try {
    await db.transaction('rw', db.products, db.batches, db.moves, db.sync_queue, async () => {
      if (newProducts.length) await db.products.bulkAdd(newProducts);
      if (newBatches.length) await db.batches.bulkAdd(newBatches);
      if (newMoves.length) await db.moves.bulkAdd(newMoves);
      if (queueRows.length) await db.sync_queue.bulkAdd(queueRows);
    });
  } catch (e) {
    toast('فشل الاستيراد: ' + e.message, 'error');
    return;
  }

  await audit('import_excel', 'inventory', '',
    `${newBatches.length} دفعة • ${newProducts.length} صنف جديد • ${reused} صنف موجود`);
  toast(`تم استيراد ${newBatches.length} دفعة (${newProducts.length} صنف جديد)`, 'success');
  State.invPage = 1;
  renderInventory();
  renderProductsDropdown();
  renderDashboard();
  syncNow();
}

/* ==================== ١٥. الزبائن والديون ==================== */

async function addCustomer() {
  const name = $('cust-name').value.trim();
  if (!name) { toast('أدخل اسم الزبون', 'error'); return; }
  const rec = {
    id: uuid(), pharmacy_id: State.pharmacyId, name,
    phone: $('cust-phone').value.trim(), debt_agorot: 0,
    is_deleted: 0, updated_at: Date.now(),
  };
  await db.customers.add(rec);
  await queue('upsert_customer', rec);
  $('cust-name').value = ''; $('cust-phone').value = '';
  toast('تمت إضافة الزبون');
  renderCustomers();
  renderPosCustomers();
  syncNow();
}

async function renderCustomers() {
  const body = $('cust-body'), wrap = $('cust-wrap');
  clear(body);
  const old = $('cust-empty'); if (old) old.remove();

  const cs = (await db.customers.where('pharmacy_id').equals(State.pharmacyId).toArray())
    .filter((c) => !c.is_deleted)
    .sort((a, b) => (b.debt_agorot || 0) - (a.debt_agorot || 0));

  if (!cs.length) {
    const e = emptyState('👥', 'لا يوجد زبائن', 'أضف زبوناً لتتمكن من البيع الآجل وتتبع الديون.');
    e.id = 'cust-empty';
    wrap.append(e);
    return;
  }
  for (const c of cs) {
    const hasDebt = (c.debt_agorot || 0) > 0;
    body.append(el('tr', {},
      el('td', { dataset: { label: 'الاسم' }, text: c.name }),
      el('td', { dataset: { label: 'الهاتف' }, text: c.phone || '—' }),
      el('td', { class: 'num', dataset: { label: 'الدين' } },
        el('span', {
          class: 'badge ' + (hasDebt ? 'badge-danger' : 'badge-ok'),
          text: Money.fmt(c.debt_agorot || 0) + ' ' + State.settings.currency,
        })),
      el('td', { dataset: { label: 'إجراء' } },
        hasDebt
          ? el('button', { class: 'btn-info', text: 'تسجيل سداد', onclick: () => payDebt(c.id) })
          : el('span', { text: '—' }))));
  }
}

async function payDebt(customerId) {
  if (State.readOnly) { toast(readOnlyReason(), 'error'); return; }
  const c = await db.customers.get(customerId);
  if (!c) return;

  const val = await promptDialog({
    title: 'تسجيل سداد',
    message: `الدين الحالي: ${Money.fmt(c.debt_agorot)} ${State.settings.currency}. أدخل المبلغ المدفوع (يمكن أن يكون جزئياً).`,
    type: 'text', value: Money.fmt(c.debt_agorot),
  });
  if (!val) return;

  const amount = Money.toAgorot(val);
  if (amount <= 0) { toast('أدخل مبلغاً صحيحاً', 'error'); return; }
  if (amount > c.debt_agorot) { toast('المبلغ أكبر من الدين المستحق', 'error'); return; }

  const payment = {
    id: uuid(), pharmacy_id: State.pharmacyId, customer_id: customerId,
    amount_agorot: amount, user_id: State.user.id, at: Date.now(), updated_at: Date.now(),
  };
  await db.payments.add(payment);
  await queue('create_payment', payment);
  await db.customers.where('id').equals(customerId).modify((x) => {
    x.debt_agorot = Math.max(0, (x.debt_agorot || 0) - amount);
    x.updated_at = Date.now();
  });
  const updated = await db.customers.get(customerId);
  await queue('upsert_customer', updated);
  await audit('payment', 'customer', customerId, `${Money.fmt(amount)} من ${c.name}`);

  toast('تم تسجيل السداد');
  renderCustomers();
  syncNow();
}

/* ==================== ١٦. التقارير ==================== */

/**
 * تقرير الهدر. هذا ما يحوّل الإتلاف من إجراء إداري إلى معلومة تجارية:
 * حين يرى المالك أنه أتلف مبلغًا معيّنًا من صنف واحد، يصحّح كمية طلبه التالي.
 * يُحسب من الحركات لا من عدّاد منفصل، فلا يمكن أن يختلف عن الرصيد.
 */
async function renderWaste(days = 30) {
  const since = Date.now() - days * 86400000;
  // جدول الحركات مفهرس على [pharmacy_id+at] فقط، فالمدى يُقرأ من الفهرس
  // بدل تحميل كل حركات الصيدلية ثم تصفيتها في الذاكرة.
  const moves = (await db.moves
    .where('[pharmacy_id+at]')
    .between([State.pharmacyId, since], [State.pharmacyId, Dexie.maxKey])
    .toArray())
    .filter((m) => isWriteOff(m.reason) && m.delta < 0);

  const batches = await db.batches.where('pharmacy_id').equals(State.pharmacyId).toArray();
  const bMap = Object.fromEntries(batches.map((b) => [b.id, b]));
  const prods = await db.products.where('pharmacy_id').equals(State.pharmacyId).toArray();
  const pMap = Object.fromEntries(prods.map((p) => [p.id, p]));

  let lossTotal = 0;
  let recoveredTotal = 0;
  const byProduct = new Map();
  for (const m of moves) {
    const batch = bMap[m.batch_id];
    const qty = Math.abs(m.delta);
    const value = (batch?.cost_price_agorot || 0) * qty;
    if (WRITE_OFF_REASONS[m.reason].loss) lossTotal += value; else recoveredTotal += value;

    const productId = batch?.product_id || m.batch_id;
    const row = byProduct.get(productId) || { name: pMap[productId]?.name || 'صنف محذوف', qty: 0, value: 0, times: 0, reasons: new Set() };
    row.qty += qty;
    row.times += 1;
    row.reasons.add(writeOffLabel(m.reason));
    if (WRITE_OFF_REASONS[m.reason].loss) row.value += value;
    byProduct.set(productId, row);
  }

  $('waste-loss').textContent = Money.fmt(lossTotal);
  $('waste-recovered').textContent = Money.fmt(recoveredTotal);
  $('waste-count').textContent = String(moves.length);

  const body = $('waste-body');
  clear(body);
  const oldEmpty = $('waste-empty');
  if (oldEmpty) oldEmpty.remove();

  if (!byProduct.size) {
    const e = emptyState('♻️', 'لا يوجد هدر مسجّل', `لم تُخرج أي كمية خلال آخر ${days} يومًا.`);
    e.id = 'waste-empty';
    $('waste-wrap').append(e);
    return;
  }
  // الأغلى أولًا: الصنف الذي يستنزف المال هو الذي يستحق تغيير سياسة شرائه.
  const rows = [...byProduct.values()].sort((a, b) => b.value - a.value);
  for (const r of rows) {
    body.append(el('tr', {},
      el('td', { dataset: { label: 'الصنف' }, text: r.name }),
      el('td', { class: 'num', dataset: { label: 'الكمية' }, text: String(r.qty) }),
      el('td', { dataset: { label: 'السبب' }, text: [...r.reasons].join('، ') }),
      el('td', { class: 'num', dataset: { label: 'مرات' }, text: String(r.times) }),
      el('td', { class: 'num', dataset: { label: 'الخسارة' }, text: Money.fmt(r.value) })));
  }
  if (rows.length > 1 && rows[0].value > 0 && rows[0].value >= lossTotal * 0.3) {
    body.append(el('tr', {},
      el('td', { colspan: '5', class: 'waste-hint',
                 text: `«${rows[0].name}» وحده يمثّل ${Math.round((rows[0].value / lossTotal) * 100)}% من الخسارة. راجع كمية الطلب أو مدة الصلاحية عند الشراء.` })));
  }
}

async function renderReports() {
  const invs = await todayInvoices();
  const live = invs.filter((i) => !i.is_voided);
  await renderWaste(Number($('waste-range')?.value) || 30);

  const cash = live.filter((i) => i.payment_type === 'cash').reduce((s, i) => s + i.total_agorot, 0);
  const debt = live.filter((i) => i.payment_type === 'debt').reduce((s, i) => s + i.total_agorot, 0);
  let profit = 0;
  for (const i of live) {
    try {
      for (const it of JSON.parse(i.items_json || '[]')) {
        profit += (it.price_agorot - it.cost_agorot) * it.qty;
      }
    } catch { /* فاتورة تالفة — تُتجاهل في الربح */ }
  }
  $('rep-cash').textContent = Money.fmt(cash);
  $('rep-debts').textContent = Money.fmt(debt);
  $('rep-profit').textContent = Money.fmt(profit);

  const body = $('rep-invoices-body'), wrap = $('rep-wrap');
  clear(body);
  const old = $('rep-empty'); if (old) old.remove();

  if (!invs.length) {
    const e = emptyState('🧾', 'لا توجد فواتير اليوم', 'ستظهر فواتير اليوم هنا فور إتمام أول عملية بيع.');
    e.id = 'rep-empty';
    wrap.append(e);
    return;
  }
  for (const i of [...invs].reverse()) {
    body.append(el('tr', {},
      el('td', { dataset: { label: 'الفاتورة' }, text: i.invoice_number }),
      el('td', { dataset: { label: 'الوقت' }, text: new Date(i.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) }),
      el('td', { dataset: { label: 'البائع' }, text: i.cashier_name || '—' }),
      el('td', { dataset: { label: 'الدفع' }, text: i.payment_type === 'debt' ? 'آجل' : 'نقدي' }),
      el('td', { class: 'num', dataset: { label: 'الإجمالي' }, text: Money.fmt(i.total_agorot) }),
      el('td', { dataset: { label: 'إجراء' } },
        i.is_voided
          ? el('span', { class: 'badge badge-danger', text: 'مُبطلة' })
          : el('button', { class: 'btn-danger', text: 'إبطال', onclick: () => voidInvoice(i.id) }))));
  }
}

async function voidInvoice(invoiceId) {
  if (!can('owner')) { toast('الإبطال للمالك فقط', 'error'); return; }
  const inv = await db.invoices.get(invoiceId);
  if (!inv || inv.is_voided) return;

  const reason = await promptDialog({
    title: 'إبطال الفاتورة',
    message: `سيُعاد المخزون وتُلغى قيمة ${Money.fmt(inv.total_agorot)}. السبب إجباري.`,
    placeholder: 'سبب الإبطال',
  });
  if (!reason || !reason.trim()) { toast('الإبطال يتطلب سبباً', 'error'); return; }

  const items = JSON.parse(inv.items_json || '[]');
  await db.invoices.update(invoiceId, {
    is_voided: 1, void_reason: reason.trim(), updated_at: Date.now(),
  });
  await queue('void_invoice', { id: invoiceId, void_reason: reason.trim() });

  // قيد عكسي — لا حذف
  for (const it of items) {
    await applyMove({ batchId: it.batch_id, delta: it.qty, reason: 'void', refId: invoiceId });
  }
  if (inv.payment_type === 'debt' && inv.customer_id) {
    await db.customers.where('id').equals(inv.customer_id).modify((c) => {
      c.debt_agorot = Math.max(0, (c.debt_agorot || 0) - inv.total_agorot);
      c.updated_at = Date.now();
    });
    const c = await db.customers.get(inv.customer_id);
    if (c) await queue('upsert_customer', c);
  }
  await audit('void_invoice', 'invoice', invoiceId, `${inv.invoice_number} • ${reason.trim()}`);
  toast('تم إبطال الفاتورة');
  renderReports();
  renderDashboard();
  syncNow();
}

async function printEOD() {
  const invs = (await todayInvoices()).filter((i) => !i.is_voided);
  const voided = (await todayInvoices()).filter((i) => i.is_voided);
  const cash = invs.filter((i) => i.payment_type === 'cash').reduce((s, i) => s + i.total_agorot, 0);
  const debt = invs.filter((i) => i.payment_type === 'debt').reduce((s, i) => s + i.total_agorot, 0);
  const payments = await db.payments.where('[pharmacy_id+at]')
    .between([State.pharmacyId, startOfToday()], [State.pharmacyId, Date.now() + 1]).toArray();
  const collected = payments.reduce((s, p) => s + p.amount_agorot, 0);
  const c = State.settings.currency;

  const row = (a, b) => `<div class="r"><span>${escapeHtml(a)}</span><span>${escapeHtml(b)}</span></div>`;
  const html = `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>Z-Report</title><style>
body{font-family:monospace;width:76mm;margin:0;padding:4mm;font-size:12px;color:#000}
h1{text-align:center;font-size:15px;margin:0 0 6px}
.r{display:flex;justify-content:space-between;margin:4px 0}
hr{border:none;border-top:1px dashed #000;margin:6px 0}
.tot{border-top:2px solid #000;margin-top:6px;padding-top:6px;font-weight:bold}
</style></head><body>
<h1>تقرير إغلاق اليوم</h1>
${row('الصيدلية', State.settings.name || '')}
${row('التاريخ', new Date().toLocaleDateString('ar-EG'))}
${row('أُصدر بواسطة', State.user.name)}<hr>
${row('عدد الفواتير', String(invs.length))}
${row('فواتير مُبطلة', String(voided.length))}<hr>
${row('مبيعات نقدية', Money.fmt(cash) + ' ' + c)}
${row('مبيعات آجلة', Money.fmt(debt) + ' ' + c)}
${row('تحصيل ديون سابقة', Money.fmt(collected) + ' ' + c)}
<div class="tot">${row('النقدي المتوقع بالصندوق', Money.fmt(cash + collected) + ' ' + c)}</div>
<p style="text-align:center;margin-top:10px;font-size:10px">توقيع: ____________</p>
</body></html>`;

  const f = $('print-frame');
  f.srcdoc = html;
  f.onload = () => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch { /* تجاهل */ } };
  await meta.set('last_eod_' + State.pharmacyId, Date.now());
  await audit('eod_close', 'report', '', `نقدي ${Money.fmt(cash + collected)}`);
  toast('تم إصدار تقرير الإغلاق');
}

/* ==================== ١٧. الإعدادات والموظفون ==================== */

async function renderSettings() {
  const s = await db.settings.get(State.pharmacyId);
  if (s) {
    $('set-name').value = s.name || '';
    $('set-phone').value = s.phone || '';
    $('set-address').value = s.address || '';
    $('set-currency').value = s.currency || '₪';
  }
  renderEmployees();
  refreshBackupInfo();
}

async function saveSettings() {
  const rec = {
    pharmacy_id: State.pharmacyId,
    name: $('set-name').value.trim(),
    phone: $('set-phone').value.trim(),
    address: $('set-address').value.trim(),
    currency: $('set-currency').value.trim() || '₪',
    updated_at: Date.now(),
  };
  await db.settings.put(rec);
  await queue('upsert_settings', rec);
  State.settings = rec;
  toast('تم حفظ الإعدادات');
  syncNow();
}

async function addEmployee() {
  const name = $('emp-name').value.trim();
  const pin = $('emp-pin').value.trim();
  if (!name) { toast('أدخل اسم الموظف', 'error'); return; }
  if (!/^\d{4,6}$/.test(pin)) { toast('الرقم السري من ٤ إلى ٦ أرقام', 'error'); return; }
  if (/^(\d)\1+$/.test(pin) || ['1234', '0000', '1111', '123456'].includes(pin)) {
    toast('رقم سري ضعيف — اختر رقماً غير متوقع', 'error');
    return;
  }

  const id = uuid();                          // معرّف واحد — كان يُولَّد مرتين بقيمتين مختلفتين
  const role = $('emp-role').value;
  await db.users.put({ id, pharmacy_id: State.pharmacyId, name, role, is_active: 1, updated_at: Date.now() });
  await queue('upsert_user', { id, name, role, pin });
  await audit('add_user', 'user', id, `${name} • ${role}`);

  $('emp-name').value = ''; $('emp-pin').value = '';
  toast('تمت إضافة الموظف — سيعمل بعد المزامنة');
  renderEmployees();
  syncNow();
}

async function renderEmployees() {
  const body = $('emp-body');
  clear(body);
  const emps = (await db.users.where('pharmacy_id').equals(State.pharmacyId).toArray())
    .filter((u) => u.is_active !== 0);
  const roleAr = { owner: 'مالك', pharmacist: 'صيدلي', cashier: 'كاشير' };

  for (const e of emps) {
    body.append(el('tr', {},
      el('td', { dataset: { label: 'الاسم' }, text: e.name }),
      el('td', { dataset: { label: 'الصلاحية' }, text: roleAr[e.role] || e.role }),
      // لا يُعرض أي رقم سري — ولا يُخزَّن أصلاً
      el('td', { dataset: { label: 'الرقم السري' } },
        el('button', { class: 'btn-info', text: 'تغيير الرقم', onclick: () => changeEmpPin(e.id, e.name, e.role) })),
      el('td', { dataset: { label: 'إجراء' } },
        e.role === 'owner'
          ? el('span', { text: '—' })
          : el('button', { class: 'btn-danger', text: 'تعطيل', onclick: () => disableEmp(e.id, e.name) }))));
  }
}

async function changeEmpPin(id, name, role) {
  const pin = await promptDialog({
    title: 'تغيير الرقم السري',
    message: `الموظف: ${name}. من ٤ إلى ٦ أرقام.`,
    type: 'password', placeholder: '••••',
  });
  if (!pin) return;
  if (!/^\d{4,6}$/.test(pin)) { toast('الرقم السري من ٤ إلى ٦ أرقام', 'error'); return; }
  await queue('upsert_user', { id, name, role, pin });
  await audit('change_pin', 'user', id, name);
  toast('سيُحدَّث الرقم بعد المزامنة');
  syncNow();
}

async function disableEmp(id, name) {
  const ok = await confirmDialog({
    title: 'تعطيل الموظف',
    message: `سيُمنع ${name} من الدخول. الفواتير السابقة تبقى منسوبة إليه.`,
    confirmText: 'تعطيل', danger: true,
  });
  if (!ok) return;
  await db.users.update(id, { is_active: 0, updated_at: Date.now() });
  await queue('delete_user', { id });
  await audit('disable_user', 'user', id, name);
  renderEmployees();
  syncNow();
}

/* ==================== ١٨. النسخ الاحتياطي ==================== */

async function refreshBackupInfo() {
  const last = Number(await meta.get('last_backup_' + State.pharmacyId, 0));
  $('backup-status').textContent = last
    ? `آخر نسخة: ${fmtDateTime(last)}`
    : 'لم تُنشئ نسخة احتياطية بعد.';
}

async function checkBackupReminder() {
  const last = Number(await meta.get('last_backup_' + State.pharmacyId, 0));
  if (Date.now() - last > 7 * 86400000 && can('owner')) {
    toast('مرّ أسبوع دون نسخة احتياطية — أنشئ واحدة من الإعدادات', 'error');
  }
}

/** تصدير مشفّر فعلياً (AES-GCM). كلمة المرور إجبارية. */
async function exportBackup() {
  const pass = await promptDialog({
    title: 'كلمة مرور النسخة',
    message: 'ستُشفَّر النسخة بهذه الكلمة. بدونها لا يمكن استعادتها — احفظها في مكان آمن.',
    type: 'password', placeholder: '٨ أحرف على الأقل',
  });
  if (!pass) return;
  if (pass.length < 8) { toast('كلمة المرور ٨ أحرف على الأقل', 'error'); return; }

  $('backup-status').textContent = 'جاري التجهيز...';
  const ph = State.pharmacyId;
  const pick = (rows) => rows.map((r) => ({ ...r }));

  // ملاحظة: users تُصدَّر بلا أي بيانات اعتماد. لا مُثبِّتات ولا أرقام سرية.
  const payload = {
    format: 'pharmagaza-backup',
    version: 2,
    pharmacy_id: ph,
    exported_at: Date.now(),
    data: {
      products:  pick(await db.products.where('pharmacy_id').equals(ph).toArray()),
      batches:   pick(await db.batches.where('pharmacy_id').equals(ph).toArray()),
      moves:     pick(await db.moves.where('[pharmacy_id+at]').between([ph, 0], [ph, Date.now() + 1]).toArray()),
      customers: pick(await db.customers.where('pharmacy_id').equals(ph).toArray()),
      invoices:  pick(await db.invoices.where('[pharmacy_id+created_at]').between([ph, 0], [ph, Date.now() + 1]).toArray()),
      payments:  pick(await db.payments.where('[pharmacy_id+at]').between([ph, 0], [ph, Date.now() + 1]).toArray()),
      settings:  await db.settings.get(ph),
      users:     (await db.users.where('pharmacy_id').equals(ph).toArray())
                   .map((u) => ({ id: u.id, name: u.name, role: u.role, is_active: u.is_active })),
    },
  };

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyMat = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: CONFIG.PBKDF2_ITER, hash: 'SHA-256' },
    keyMat, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload)));

  const file = JSON.stringify({
    format: 'pharmagaza-backup-encrypted', version: 2, pharmacy_id: ph,
    exported_at: Date.now(), kdf: { iterations: CONFIG.PBKDF2_ITER, salt: b64(salt) },
    iv: b64(iv), data: b64(cipher),
  });

  const blob = new Blob([file], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `pharma-backup-${ph}-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);

  await meta.set('last_backup_' + ph, Date.now());
  await audit('backup_export', 'system', '', '');
  refreshBackupInfo();
  toast('تم إنشاء النسخة المشفّرة');
}

async function importBackup(evt) {
  const file = evt.target.files[0];
  evt.target.value = '';
  if (!file) return;

  const ok = await confirmDialog({
    title: 'استعادة نسخة احتياطية',
    message: 'سيُستبدل كل محتوى هذه الصيدلية على هذا الجهاز بمحتوى الملف. اكتب رمز الصيدلية للتأكيد.',
    confirmText: 'استعادة', danger: true, requireText: State.pharmacyId,
  });
  if (!ok) return;

  let outer;
  try { outer = JSON.parse(await file.text()); }
  catch { toast('الملف غير صالح', 'error'); return; }

  let payload;
  if (outer.format === 'pharmagaza-backup-encrypted') {
    const pass = await promptDialog({ title: 'كلمة مرور النسخة', message: '', type: 'password' });
    if (!pass) return;
    try {
      const keyMat = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
      const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: unb64(outer.kdf.salt), iterations: outer.kdf.iterations, hash: 'SHA-256' },
        keyMat, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: unb64(outer.iv) }, key, unb64(outer.data));
      payload = JSON.parse(new TextDecoder().decode(plain));
    } catch { toast('كلمة المرور غير صحيحة أو الملف تالف', 'error'); return; }
  } else if (outer.format === 'pharmagaza-backup') {
    payload = outer;
  } else {
    toast('صيغة الملف غير معروفة', 'error');
    return;
  }

  if (payload.pharmacy_id !== State.pharmacyId) {
    toast('النسخة تخص صيدلية أخرى — لا يمكن استعادتها هنا', 'error');
    return;
  }

  const ph = State.pharmacyId;
  const d = payload.data || {};
  try {
    await db.transaction('rw',
      [db.products, db.batches, db.moves, db.customers, db.invoices, db.payments, db.settings],
      async () => {
        for (const t of ['products', 'batches', 'moves', 'customers', 'invoices', 'payments']) {
          const rows = await db[t].filter((r) => r.pharmacy_id === ph).primaryKeys();
          await db[t].bulkDelete(rows);
        }
        if (d.products?.length) await db.products.bulkPut(d.products);
        if (d.batches?.length) await db.batches.bulkPut(d.batches);
        if (d.moves?.length) await db.moves.bulkPut(d.moves);
        if (d.customers?.length) await db.customers.bulkPut(d.customers);
        if (d.invoices?.length) await db.invoices.bulkPut(d.invoices);
        if (d.payments?.length) await db.payments.bulkPut(d.payments);
        if (d.settings) await db.settings.put(d.settings);
      });
    await audit('backup_restore', 'system', '', `من ${fmtDateTime(payload.exported_at)}`);
    toast('تمت الاستعادة بنجاح');
    showView('dash');
  } catch (e) {
    toast('فشلت الاستعادة: ' + e.message, 'error');
  }
}

/* ==================== ١٩. الإقلاع ==================== */

async function boot() {
  applyTheme(localStorage.getItem('theme') || 'dark');

  let dev = localStorage.getItem('device_id');
  if (!dev) { dev = uuid(); localStorage.setItem('device_id', dev); }
  State.deviceId = dev;

  const linkedPharmacy = new URLSearchParams(window.location.search).get('pharmacy');
  $('pharmacy-id-input').value = linkedPharmacy || localStorage.getItem('last_pharmacy') || '';

  // الأحداث — كلها addEventListener، لا onclick مضمّن (شرط CSP الصارمة)
  document.querySelectorAll('[data-pin]').forEach((b) =>
    b.addEventListener('click', () => addPin(b.dataset.pin)));
  $('pin-clear').addEventListener('click', clearPin);
  $('login-btn').addEventListener('click', () => attemptLogin());
  $('pharmacy-id-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('login-btn').focus(); }
  });
  document.addEventListener('keydown', (e) => {
    if ($('login-view').classList.contains('hidden')) return;
    // لا تلتقط الأرقام أثناء الكتابة في حقل: كتابة "PHM-001" كانت
    // تُدخل 0 و0 و1 في الرقم السري أيضاً.
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (/^[0-9]$/.test(e.key)) addPin(e.key);
    if (e.key === 'Backspace') { pinBuffer = pinBuffer.slice(0, -1); updateDots(); }
    if (e.key === 'Enter' && pinBuffer.length >= 4) attemptLogin();
  });

  $('theme-btn').addEventListener('click', toggleTheme);
  $('logout-btn').addEventListener('click', () => logout());
  $('btn-scan-pos').addEventListener('click', () => startScanner('search-input'));
  $('btn-scan-inv').addEventListener('click', () => startScanner('med-barcode'));
  $('btn-checkout').addEventListener('click', () => checkout(false));
  $('btn-checkout-print').addEventListener('click', () => checkout(true));
  $('btn-add-product').addEventListener('click', addProduct);
  $('btn-add-batch').addEventListener('click', addBatch);
  $('inv-search').addEventListener('input', () => { State.invPage = 1; renderInventory(); });
  $('btn-template').addEventListener('click', downloadTemplate);
  $('btn-import-excel').addEventListener('click', () => $('excel-file').click());
  $('excel-file').addEventListener('change', handleExcelFile);
  $('btn-add-customer').addEventListener('click', addCustomer);
  $('btn-save-settings').addEventListener('click', saveSettings);
  $('btn-add-employee').addEventListener('click', addEmployee);
  $('btn-eod').addEventListener('click', printEOD);
  $('waste-range').addEventListener('change', (e) => renderWaste(Number(e.target.value) || 30));
  $('btn-backup-export').addEventListener('click', exportBackup);
  $('backup-file').addEventListener('change', importBackup);
  $('btn-backup-import').addEventListener('click', () => $('backup-file').click());

  initPosKeyboard();

  window.addEventListener('online', () => { setNetStatus('online'); syncNow(); });
  window.addEventListener('offline', () => setNetStatus('offline'));
  setNetStatus(navigator.onLine ? 'online' : 'offline');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* لا يعمل من file:// */ });
  }
}

document.addEventListener('DOMContentLoaded', boot);
