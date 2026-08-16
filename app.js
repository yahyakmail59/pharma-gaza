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
  // ← غيّر هذا إلى رابط الـ Worker الخاص بك
  WORKER_URL: 'https://pharma-sync-api.yahyakmail59.workers.dev',
  SYNC_INTERVAL_MS: 30000,
  IDLE_LOCK_MS: 10 * 60 * 1000,
  EXPIRY_WARN_DAYS: 90,
  LOW_STOCK_DEFAULT: 10,
  PAGE_SIZE: 50,
  PBKDF2_ITER: 100000,
};

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

const uuid = () =>
  crypto.randomUUID ? crypto.randomUUID()
    : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);

/** المال: أعداد صحيحة بالأغورة. ١ شيكل = ١٠٠ أغورة. */
const Money = {
  toAgorot(input) {
    let s = String(input ?? '').trim();
    if (!s) return 0;
    s = s.replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
         .replace(/[٫,]/g, '.').replace(/[^\d.]/g, '');
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

function emptyState(emoji, title, desc) {
  return el('div', { class: 'empty-state' },
    el('span', { class: 'em', text: emoji }),
    el('div', { class: 't', text: title }),
    el('div', { class: 'd', text: desc }));
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
function addPin(n) {
  if (pinBuffer.length >= 6) return;
  pinBuffer += n;
  updateDots();
  if (pinBuffer.length === 4) attemptLogin({ soft: true });
}
function clearPin() { pinBuffer = ''; updateDots(); }

async function attemptLogin({ soft = false } = {}) {
  const idInput = $('pharmacy-id-input');
  const pharmacyId = lockMode ? State.pharmacyId : idInput.value.trim().toUpperCase();
  const pin = pinBuffer;

  if (!pharmacyId) { if (!soft) toast('أدخل رمز الصيدلية', 'error'); return; }
  if (pin.length < 4) { if (!soft) toast('الرقم السري ٤ خانات على الأقل', 'error'); return; }

  const btn = $('login-btn');
  btn.disabled = true;

  try {
    // (أ) محاولة محلية — تعمل بلا إنترنت، وتتحقق من مُثبِّت مشتق لا من رقم مخزّن
    const local = await meta.get('local_user_' + pharmacyId);
    if (local) {
      const v = await derive(pin, local.salt);
      if (v === local.verifier) {
        const tok = await meta.get('token_' + pharmacyId);
        if (tok && tok.expires > Date.now()) {
          State.token = tok.token;
          State.tokenExpires = tok.expires;
          State.readOnly = false;
        } else {
          // التوكن منتهٍ: نسمح بالعمل للقراءة فقط بدل منع الصيدلية من مخزونها
          State.token = null;
          State.readOnly = true;
        }
        State.pharmacyId = pharmacyId;
        State.user = { id: local.id, name: local.name, role: local.role };
        await afterLogin();
        return;
      }
      if (!navigator.onLine) {
        if (!soft) toast('الرقم السري غير صحيح', 'error');
        clearPin();
        btn.disabled = false;
        return;
      }
    }

    if (!navigator.onLine) {
      if (!soft) toast('أول دخول على هذا الجهاز يحتاج اتصالاً بالإنترنت', 'error');
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

    // نخزّن مُثبِّتاً مشتقاً — لا الرقم السري
    const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
    await meta.set('local_user_' + pharmacyId, {
      id: data.user.id, name: data.user.name, role: data.user.role,
      salt, verifier: await derive(pin, salt),
    });
    await meta.set('token_' + pharmacyId, { token: data.token, expires: data.expires_at });

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
      if (!soft) toast('رمز الصيدلية أو الرقم السري غير صحيح', 'error');
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

async function logout(full = true) {
  if (full && State.token && navigator.onLine) {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* تجاهل */ }
  }
  stopSyncLoop();
  audit('logout', 'session', State.user ? State.user.id : '', '');
  State.user = null;
  State.token = null;
  State.cart = [];          // لا تُورَّث السلة للكاشير التالي
  State.readOnly = false;
  if (full) await meta.set('token_' + State.pharmacyId, null);
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
  { id: 'dash', label: 'الرئيسية', icon: '🏠', roles: ['owner', 'pharmacist', 'cashier'] },
  { id: 'pos',  label: 'الكاشير',  icon: '🛒', roles: ['owner', 'pharmacist', 'cashier'] },
  { id: 'inv',  label: 'المخزون',  icon: '📦', roles: ['owner', 'pharmacist'] },
  { id: 'cust', label: 'الزبائن',  icon: '👥', roles: ['owner', 'pharmacist', 'cashier'] },
  { id: 'rep',  label: 'التقارير', icon: '📊', roles: ['owner'] },
  { id: 'set',  label: 'الإعدادات', icon: '⚙️', roles: ['owner'] },
];
let currentView = 'dash';

function buildNav() {
  const top = $('nav-container'), bot = $('bottom-nav');
  clear(top); clear(bot);
  for (const item of NAV) {
    if (!item.roles.includes(State.user.role)) continue;
    top.append(el('button', {
      class: item.id === currentView ? 'active' : '', text: item.label,
      dataset: { nav: item.id }, onclick: () => showView(item.id),
    }));
    bot.append(el('button', {
      class: item.id === currentView ? 'active' : '',
      dataset: { nav: item.id }, onclick: () => showView(item.id),
    }, el('span', { class: 'ic', text: item.icon }), el('span', { text: item.label })));
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
  $('theme-btn').textContent = t === 'light' ? '🌙' : '☀️';   // كانت لا تُحدَّث عند التحميل
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
  const low = batches.filter((b) => b.quantity > 0 && b.quantity < CONFIG.LOW_STOCK_DEFAULT);

  $('stat-low-stock').textContent = low.length;
  $('stat-expiring').textContent = soon.length;

  // قسم التنبيهات — كان فارغاً دائماً في النسخة السابقة
  const box = $('alerts-container');
  clear(box);
  const prods = await db.products.where('pharmacy_id').equals(State.pharmacyId).toArray();
  const pMap = Object.fromEntries(prods.map((p) => [p.id, p]));
  const rows = [
    ...expired.map((b) => ({ b, kind: 'expired' })),
    ...soon.map((b) => ({ b, kind: 'soon' })),
    ...low.map((b) => ({ b, kind: 'low' })),
  ].slice(0, 25);

  if (!rows.length) {
    box.append(emptyState('✅', 'لا توجد تنبيهات', 'المخزون سليم ولا توجد أصناف قاربت على الانتهاء.'));
    return;
  }
  for (const { b, kind } of rows) {
    const name = pMap[b.product_id]?.name || 'صنف محذوف';
    const cfg = {
      expired: ['alert-expiry', 'منتهي الصلاحية', `دفعة ${b.batch_number} • انتهت ${fmtMonth(b.expiry_end)} • متبقٍ ${b.quantity}`],
      soon:    ['alert-expiry', 'قارب على الانتهاء', `دفعة ${b.batch_number} • ينتهي ${fmtMonth(b.expiry_end)} • متبقٍ ${b.quantity}`],
      low:     ['alert-low', 'كمية منخفضة', `دفعة ${b.batch_number} • متبقٍ ${b.quantity} فقط`],
    }[kind];
    box.append(el('div', { class: 'alert-item ' + cfg[0] },
      el('div', {}, el('div', { class: 't', text: `${name} — ${cfg[1]}` }),
                     el('div', { class: 'd', text: cfg[2] })),
      el('span', { class: 'badge ' + (kind === 'low' ? 'badge-warn' : 'badge-danger'),
                   text: kind === 'low' ? 'نواقص' : 'صلاحية' })));
  }
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
  if (!q) { dd.classList.add('hidden'); State.searchResults = []; return; }

  const prods = await db.products.where('pharmacy_id').equals(State.pharmacyId).toArray();
  const hits = prods.filter((p) =>
    !p.is_deleted && ((p.name || '').toLowerCase().includes(q) || (p.barcode || '') === q));

  clear(dd);
  if (!hits.length) {
    dd.append(el('div', { class: 'search-item' }, el('div', { class: 'nm', text: 'لا توجد نتائج' })));
    dd.classList.remove('hidden');
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

    const row = el('div', {
      class: 'search-item' + (blocked ? ' disabled' : ''),
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
    if (!e.target.closest('.search-wrapper')) $('search-dropdown').classList.add('hidden');
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
        el('button', { class: 'btn-info', text: 'تسوية', onclick: () => adjustQty(b.id) }))));
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

async function adjustQty(batchId) {
  if (State.readOnly) { toast('وضع القراءة فقط', 'error'); return; }
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
  if (State.readOnly) { toast('وضع القراءة فقط', 'error'); return; }
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

async function renderReports() {
  const invs = await todayInvoices();
  const live = invs.filter((i) => !i.is_voided);

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

  $('pharmacy-id-input').value = localStorage.getItem('last_pharmacy') || '';

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
    if (/^[0-9]$/.test(e.key)) addPin(e.key);
    if (e.key === 'Backspace' && document.activeElement !== $('pharmacy-id-input')) {
      pinBuffer = pinBuffer.slice(0, -1); updateDots();
    }
    if (e.key === 'Enter' && pinBuffer.length >= 4) attemptLogin();
  });

  $('theme-btn').addEventListener('click', toggleTheme);
  $('logout-btn').addEventListener('click', () => logout(true));
  $('btn-scan-pos').addEventListener('click', () => startScanner('search-input'));
  $('btn-scan-inv').addEventListener('click', () => startScanner('med-barcode'));
  $('btn-checkout').addEventListener('click', () => checkout(false));
  $('btn-checkout-print').addEventListener('click', () => checkout(true));
  $('btn-add-product').addEventListener('click', addProduct);
  $('btn-add-batch').addEventListener('click', addBatch);
  $('inv-search').addEventListener('input', () => { State.invPage = 1; renderInventory(); });
  $('btn-add-customer').addEventListener('click', addCustomer);
  $('btn-save-settings').addEventListener('click', saveSettings);
  $('btn-add-employee').addEventListener('click', addEmployee);
  $('btn-eod').addEventListener('click', printEOD);
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
