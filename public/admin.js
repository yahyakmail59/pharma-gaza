/* ============================================================
 * PharmaGaza — لوحة إدارة المنصة
 * ------------------------------------------------------------
 * لا يوجد أي سر في هذا الملف. الدخول يتم بكلمة مرور تُتحقَّق
 * على السيرفر ويُصدر توكناً مؤقتاً يُحفظ في sessionStorage
 * (ينتهي بإغلاق التبويب، ولا يبقى على القرص).
 * ============================================================ */

'use strict';

// فارغ = نفس أصل الصفحة. عنوان محفور هنا يموت مع أول تغيير نطاق، ويظهر
// العطل للمستخدم رسالةَ «فشل الاتصال بالسيرفر» لا خطأَ إعداد.
const WORKER_URL = '';

const $ = (id) => document.getElementById(id);
const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); };

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

function toast(msg, type = 'success') {
  const c = $('toast-container');
  const t = el('div', { class: `toast ${type}`, text: msg });
  c.append(t);
  setTimeout(() => t.remove(), 3200);
}

function confirmDialog({ title, message, confirmText = 'تأكيد', danger = false, requireText = null }) {
  return new Promise((resolve) => {
    const dlg = el('dialog');
    let input = null;
    const body = [el('h3', { text: title }), el('p', { text: message })];
    if (requireText) {
      input = el('input', { type: 'text', placeholder: requireText, autocomplete: 'off' });
      body.push(input);
    }
    const ok = el('button', {
      class: danger ? 'btn-danger' : 'btn-primary', text: confirmText,
      onclick: () => {
        if (requireText && input.value.trim() !== requireText) { toast('النص غير مطابق', 'error'); return; }
        dlg.close('ok');
      },
    });
    dlg.append(...body, el('div', { class: 'dialog-actions' },
      el('button', { class: 'btn-ghost', text: 'إلغاء', onclick: () => dlg.close('cancel') }), ok));
    dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'ok'); dlg.remove(); });
    document.body.append(dlg);
    dlg.showModal();
    (input || ok).focus();
  });
}

function promptDialog({ title, message, type = 'text', placeholder = '' }) {
  return new Promise((resolve) => {
    const dlg = el('dialog');
    const input = el('input', { type, placeholder, autocomplete: 'off' });
    dlg.append(el('h3', { text: title }), message ? el('p', { text: message }) : null, input,
      el('div', { class: 'dialog-actions' },
        el('button', { class: 'btn-ghost', text: 'إلغاء', onclick: () => dlg.close('') }),
        el('button', { class: 'btn-primary', text: 'حفظ', onclick: () => dlg.close(input.value) })));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') dlg.close(input.value); });
    dlg.addEventListener('close', () => { resolve(dlg.returnValue); dlg.remove(); });
    document.body.append(dlg);
    dlg.showModal();
    input.focus();
  });
}

/* ---------------- الجلسة ---------------- */

const token = {
  get: () => sessionStorage.getItem('admin_token'),
  set: (t) => sessionStorage.setItem('admin_token', t),
  clearAll: () => sessionStorage.removeItem('admin_token'),
};

async function api(path, { method = 'GET', body = null } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const t = token.get();
  if (t) headers['Authorization'] = 'Bearer ' + t;
  const res = await fetch(WORKER_URL + path, { method, headers, body: body ? JSON.stringify(body) : null });
  let data = null;
  try { data = await res.json(); } catch { /* بلا محتوى */ }
  if (!res.ok) {
    const e = new Error((data && data.error) || 'HTTP_' + res.status);
    e.status = res.status; e.data = data;
    throw e;
  }
  return data;
}

async function login() {
  const pass = $('admin-pass').value;
  if (!pass) { toast('أدخل كلمة المرور', 'error'); return; }
  const btn = $('admin-login-btn');
  btn.disabled = true;
  try {
    const r = await api('/api/admin/login', { method: 'POST', body: { password: pass } });
    token.set(r.token);
    $('admin-pass').value = '';
    openPanel();
  } catch (e) {
    if (e.message === 'LOCKED') toast(`محاولات كثيرة. انتظر ${e.data.seconds} ثانية`, 'error');
    else if (e.message === 'ADMIN_PASSWORD_NOT_SET') toast('لم تُضبط ADMIN_PASSWORD على الـ Worker', 'error');
    else toast('كلمة المرور غير صحيحة', 'error');
  } finally {
    btn.disabled = false;
  }
}

function openPanel() {
  $('gate').classList.add('hidden');
  $('panel').classList.remove('hidden');
  loadPharmacies();
}

function logout() {
  token.clearAll();
  $('panel').classList.add('hidden');
  $('gate').classList.remove('hidden');
}

/* ---------------- العمليات ---------------- */

async function loadPharmacies() {
  const body = $('pharmacies-list');
  const wrap = $('list-wrap');
  const old = $('empty-msg');
  if (old) old.remove();
  clear(body);

  let rows;
  try {
    rows = await api('/api/admin/pharmacies');
  } catch (e) {
    if (e.status === 401) { toast('انتهت الجلسة', 'error'); logout(); return; }
    toast('تعذّر جلب القائمة', 'error');
    return;
  }

  if (!rows.length) {
    const m = el('div', { class: 'empty-state', id: 'empty-msg' },
      el('span', { class: 'em', text: '🏥' }),
      el('div', { class: 't', text: 'لا توجد صيدليات بعد' }),
      el('div', { class: 'd', text: 'أنشئ أول صيدلية من النموذج أعلاه.' }));
    wrap.append(m);
    return;
  }

  for (const p of rows) {
    body.append(el('tr', {},
      el('td', { dataset: { label: 'الرمز' }, text: p.pharmacy_id }),
      el('td', { dataset: { label: 'الاسم' }, text: p.name || '—' }),
      el('td', { dataset: { label: 'الهاتف' }, text: p.phone || '—' }),
      el('td', { dataset: { label: 'المستخدمون' }, text: String(p.users_count ?? 0) }),
      el('td', { dataset: { label: 'الحالة' } },
        el('span', {
          class: 'badge ' + (p.is_active ? 'badge-ok' : 'badge-danger'),
          text: p.is_active ? 'مفعّل' : 'موقوف',
        })),
      el('td', { dataset: { label: 'إجراءات' } },
        el('div', { class: 'actions' },
          el('button', { class: 'btn-info', text: 'إعادة تعيين PIN', onclick: () => resetPin(p.pharmacy_id) }),
          el('button', {
            class: 'btn-ghost',
            text: p.is_active ? 'إيقاف' : 'تفعيل',
            onclick: () => setStatus(p.pharmacy_id, !p.is_active),
          }),
          el('button', { class: 'btn-danger', text: 'حذف', onclick: () => deletePharmacy(p.pharmacy_id) })))));
  }
}

async function createPharmacy() {
  const id = $('p-id').value.trim().toUpperCase();
  const pin = $('p-pin').value.trim();
  if (!/^[A-Z0-9_-]{3,32}$/.test(id)) { toast('الرمز: حروف إنجليزية وأرقام وشرطات، ٣ خانات فأكثر', 'error'); return; }
  if (!/^\d{4,6}$/.test(pin)) { toast('الرقم السري من ٤ إلى ٦ أرقام', 'error'); return; }
  if (/^(\d)\1+$/.test(pin) || ['1234', '0000'].includes(pin)) { toast('رقم سري ضعيف', 'error'); return; }

  const btn = $('create-btn');
  btn.disabled = true;
  try {
    await api('/api/admin/create-pharmacy', {
      method: 'POST',
      body: {
        pharmacy_id: id,
        name: $('p-name').value.trim(),
        phone: $('p-phone').value.trim(),
        address: $('p-address').value.trim(),
        currency: $('p-currency').value.trim() || '₪',
        owner_pin: pin,
      },
    });
    ['p-id', 'p-name', 'p-phone', 'p-address', 'p-pin'].forEach((i) => ($(i).value = ''));
    toast('تم إنشاء الصيدلية');
    loadPharmacies();
  } catch (e) {
    if (e.status === 401) { logout(); return; }
    toast(e.message === 'BAD_ID' ? 'رمز غير صالح' : 'تعذّر الإنشاء — قد يكون الرمز مستخدماً', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function setStatus(id, active) {
  const ok = await confirmDialog({
    title: active ? 'تفعيل الاشتراك' : 'إيقاف الاشتراك',
    message: active
      ? `سيعود ${id} للعمل والمزامنة فوراً.`
      : `سيتوقف ${id} عن المزامنة وتُلغى جلساته. تبقى بياناته المحلية على أجهزته للقراءة.`,
    confirmText: active ? 'تفعيل' : 'إيقاف',
    danger: !active,
  });
  if (!ok) return;
  try {
    await api('/api/admin/set-status', { method: 'POST', body: { pharmacy_id: id, is_active: active } });
    toast('تم تحديث الحالة');
    loadPharmacies();
  } catch (e) {
    if (e.status === 401) { logout(); return; }
    toast('فشل التحديث', 'error');
  }
}

async function resetPin(id) {
  const pin = await promptDialog({
    title: 'إعادة تعيين رقم المالك',
    message: `صيدلية ${id}. من ٤ إلى ٦ أرقام. ستُلغى كل جلسات الصيدلية.`,
    type: 'password', placeholder: '••••',
  });
  if (!pin) return;
  if (!/^\d{4,6}$/.test(pin)) { toast('الرقم السري من ٤ إلى ٦ أرقام', 'error'); return; }
  try {
    await api('/api/admin/reset-pin', { method: 'POST', body: { pharmacy_id: id, new_pin: pin } });
    toast('تم تحديث الرقم السري');
  } catch (e) {
    if (e.status === 401) { logout(); return; }
    toast('فشل التحديث', 'error');
  }
}

async function deletePharmacy(id) {
  const ok = await confirmDialog({
    title: 'حذف نهائي',
    message: `سيُحذف ${id} وكل فواتيره ومخزونه وزبائنه نهائياً ولا يمكن التراجع. اكتب رمز الصيدلية للتأكيد.`,
    confirmText: 'حذف نهائي', danger: true, requireText: id,
  });
  if (!ok) return;
  try {
    await api('/api/admin/delete-pharmacy', { method: 'POST', body: { pharmacy_id: id, confirm: id } });
    toast('تم الحذف');
    loadPharmacies();
  } catch (e) {
    if (e.status === 401) { logout(); return; }
    toast('فشل الحذف', 'error');
  }
}

/* ---------------- الإقلاع ---------------- */

document.addEventListener('DOMContentLoaded', () => {
  document.documentElement.setAttribute('data-theme', localStorage.getItem('theme') || 'dark');

  $('admin-login-btn').addEventListener('click', login);
  $('admin-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
  $('admin-logout-btn').addEventListener('click', logout);
  $('create-btn').addEventListener('click', createPharmacy);
  $('refresh-btn').addEventListener('click', loadPharmacies);

  if (token.get()) openPanel();
});
