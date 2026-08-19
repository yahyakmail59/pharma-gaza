import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

let baseUrl = process.env.PHARMA_TEST_URL || 'http://pharma.test';
const vars = Object.fromEntries(
  readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => line.split(/=(.*)/s).slice(0, 2)),
);
const secret = vars.ATHAR_ADAPTER_SECRET;
assert.ok(secret, 'ATHAR_ADAPTER_SECRET is required in worker/.dev.vars');

let miniflare;
let dispatch = fetch;
if (!process.env.PHARMA_TEST_URL) {
  miniflare = new Miniflare(convertV4MiniflareOptions({
    port: 0,
    name: 'pharma-integration',
    modules: true,
    script: readFileSync(new URL('../worker.js', import.meta.url), 'utf8'),
    compatibilityDate: '2026-08-19',
    bindings: {
      ATHAR_ADAPTER_SECRET: secret,
      PUBLIC_APP_URL: 'https://pharma.example.test/',
      ALLOWED_ORIGINS: '',
      ADMIN_PASSWORD: 'integration-admin-only',
    },
    d1Databases: { DB: randomUUID() },
  }));
  const database = await miniflare.getD1Database('DB');
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
    .replace(/^\s*--.*$/gm, '')
    .trim();
  for (const statement of schema.split(';').map((value) => value.trim()).filter(Boolean)) {
    await database.prepare(statement).run();
  }
  dispatch = (url, init) => miniflare.dispatchFetch(url, init);
}

async function signedRequest(method, path, requestId, body) {
  const rawBody = body ? JSON.stringify(body) : '';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  const canonical = `${timestamp}\n${requestId}\n${method}\n${path}\n${bodyHash}`;
  const signature = createHmac('sha256', secret).update(canonical).digest('hex');
  return dispatch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Athar-Timestamp': timestamp,
      'X-Athar-Request-Id': requestId,
      'X-Athar-Signature': signature,
    },
    body: method === 'GET' ? undefined : rawBody,
  });
}

async function responseJson(response) {
  const payload = await response.json();
  assert.equal(payload.ok, true, JSON.stringify(payload));
  return payload;
}

try {
const tenantId = randomUUID();
const createRequestId = randomUUID();
const createBody = {
  request_id: createRequestId,
  tenant_id: tenantId,
  slug: `integration-${tenantId.slice(0, 8)}`,
  display_name: 'صيدلية اختبار التكامل',
  environment: 'demo',
  plan_code: 'standard',
  brand_kit_code: 'default',
  trial_expires_at: '2026-09-30',
  config: { phone: '0599000000', address: 'غزة', currency: 'ILS' },
};

const createdResponse = await signedRequest('POST', '/internal/v1/tenants', createRequestId, createBody);
assert.equal(createdResponse.status, 201);
const created = await responseJson(createdResponse);
assert.match(created.external_tenant_id, /^ATH_[A-Z0-9_-]{3,28}$/);
assert.match(created.credentials.owner_pin, /^\d{6}$/);

const replayResponse = await signedRequest('POST', '/internal/v1/tenants', createRequestId, createBody);
assert.equal(replayResponse.status, 200);
const replayed = await responseJson(replayResponse);
assert.equal(replayed.replayed, true);
assert.equal(replayed.credentials.owner_pin, created.credentials.owner_pin);

const loginResponse = await dispatch(`${baseUrl}/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pharmacy_id: created.external_tenant_id, pin: created.credentials.owner_pin, device_id: 'integration-test' }),
});
assert.equal(loginResponse.status, 200);
const login = await loginResponse.json();
assert.ok(login.token);

const updatesResponse = await dispatch(`${baseUrl}/api/get-updates?last_sync=0&device_id=integration-test`, {
  headers: { Authorization: `Bearer ${login.token}` },
});
assert.equal(updatesResponse.status, 200);
const updates = await updatesResponse.json();
// بيانات العرض يجب أن تكفي لعرض تقديمي حقيقي، لا ثلاثة أصناف.
assert.ok(updates.products.length >= 30, `demo products too few: ${updates.products.length}`);
assert.equal(updates.batches.length, updates.products.length);
assert.ok(updates.customers.length >= 10, `demo customers too few: ${updates.customers.length}`);
assert.ok(updates.batches.every((batch) => batch.qty_snapshot > 0));
assert.ok(updates.batches.every((batch) => batch.sell_price_agorot > batch.cost_price_agorot));
assert.ok(new Set(updates.products.map((p) => p.category)).size >= 8, 'demo needs several categories');
assert.ok(new Set(updates.products.map((p) => p.barcode)).size === updates.products.length, 'barcodes must be unique');

// الأصناف المنتهية وقريبة الانتهاء موجودة عمدًا: بدونها لا تظهر قيمة شاشة التنبيهات.
const nowMs = Date.now();
assert.ok(updates.batches.some((b) => b.expiry_end < nowMs), 'demo needs an expired batch');
assert.ok(
  updates.batches.some((b) => b.expiry_end > nowMs && b.expiry_end < nowMs + 180 * 24 * 3600 * 1000),
  'demo needs a near-expiry batch',
);
assert.ok(updates.batches.some((b) => b.qty_snapshot <= 10), 'demo needs a low-stock batch');
assert.ok(updates.customers.some((c) => c.debt_agorot > 0), 'demo needs a customer with debt');
assert.ok(updates.invoices.length >= 30, `demo invoices too few: ${updates.invoices.length}`);

// اللقطة هي حقيقة الرصيد عند أول مزامنة، فيجب أن تساوي مجموع الحركات بالضبط.
// لولا ذلك يرى العميل مخزونًا أكبر من الواقع بمقدار كل ما بيع.
const movedByBatch = new Map();
for (const move of updates.moves) {
  movedByBatch.set(move.batch_id, (movedByBatch.get(move.batch_id) || 0) + move.delta);
}
for (const batch of updates.batches) {
  assert.equal(
    batch.qty_snapshot, movedByBatch.get(batch.id) ?? 0,
    `batch ${batch.id}: snapshot ${batch.qty_snapshot} != sum of moves ${movedByBatch.get(batch.id)}`,
  );
}

// تاريخ إخراج مصنّف حتى لا يفتح العميل تقرير الهدر على شاشة فارغة.
const writeOffReasons = new Set(updates.moves.filter((m) => m.delta < 0).map((m) => m.reason));
for (const reason of ['expired', 'damaged', 'return_supplier']) {
  assert.ok(writeOffReasons.has(reason), `demo needs a '${reason}' stock move`);
}

const suspendRequestId = randomUUID();
const suspendBody = { request_id: suspendRequestId, tenant_id: tenantId, action: 'suspend' };
const suspendedResponse = await signedRequest('POST', `/internal/v1/tenants/${tenantId}/status`, suspendRequestId, suspendBody);
assert.equal(suspendedResponse.status, 200);
const suspended = await responseJson(suspendedResponse);
assert.equal(suspended.status, 'suspended');

const blockedLogin = await dispatch(`${baseUrl}/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pharmacy_id: created.external_tenant_id, pin: created.credentials.owner_pin, device_id: 'integration-test-2' }),
});
assert.equal(blockedLogin.status, 403);

const resumeRequestId = randomUUID();
const resumeBody = { request_id: resumeRequestId, tenant_id: tenantId, action: 'resume' };
const resumedResponse = await signedRequest('POST', `/internal/v1/tenants/${tenantId}/status`, resumeRequestId, resumeBody);
assert.equal(resumedResponse.status, 200);
const resumed = await responseJson(resumedResponse);
assert.equal(resumed.status, 'active');

const healthRequestId = randomUUID();
const healthResponse = await signedRequest('GET', `/internal/v1/tenants/${tenantId}/health`, healthRequestId);
assert.equal(healthResponse.status, 200);
const health = await responseJson(healthResponse);
assert.equal(health.status, 'active');
assert.equal(health.active, true);

// إعادة تعيين رقم المالك: الرقم القديم يبطل، والجديد يعمل، والبيانات تبقى.
const resetRequestId = randomUUID();
const resetResponse = await signedRequest(
  'POST', `/internal/v1/tenants/${tenantId}/reset-owner-pin`, resetRequestId,
  { request_id: resetRequestId, tenant_id: tenantId },
);
assert.equal(resetResponse.status, 200);
const reset = await responseJson(resetResponse);
assert.match(reset.credentials.owner_pin, /^\d{6}$/);
assert.notEqual(reset.credentials.owner_pin, created.credentials.owner_pin);

const oldPinLogin = await dispatch(`${baseUrl}/api/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pharmacy_id: created.external_tenant_id, pin: created.credentials.owner_pin, device_id: 'old-pin' }),
});
assert.equal(oldPinLogin.status, 401, 'the old PIN must stop working');

const newPinLogin = await dispatch(`${baseUrl}/api/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pharmacy_id: created.external_tenant_id, pin: reset.credentials.owner_pin, device_id: 'new-pin' }),
});
assert.equal(newPinLogin.status, 200);
const newPinSession = await newPinLogin.json();
const afterReset = await dispatch(`${baseUrl}/api/get-updates?last_sync=0&device_id=new-pin`, {
  headers: { Authorization: `Bearer ${newPinSession.token}` },
});
assert.equal((await afterReset.json()).products.length, updates.products.length, 'reset must not touch stock');

// إعادة الإرسال بنفس المعرّف تعيد الرقم نفسه بدل قفل المالك خارج صيدليته.
const replayReset = await signedRequest(
  'POST', `/internal/v1/tenants/${tenantId}/reset-owner-pin`, resetRequestId,
  { request_id: resetRequestId, tenant_id: tenantId },
);
assert.equal((await responseJson(replayReset)).credentials.owner_pin, reset.credentials.owner_pin);

const productionTenantId = randomUUID();
const productionRequestId = randomUUID();
const productionBody = {
  ...createBody,
  request_id: productionRequestId,
  tenant_id: productionTenantId,
  slug: `production-${productionTenantId.slice(0, 8)}`,
  display_name: 'صيدلية إنتاج اختبارية',
  environment: 'production',
  trial_expires_at: null,
};
const productionResponse = await signedRequest('POST', '/internal/v1/tenants', productionRequestId, productionBody);
assert.equal(productionResponse.status, 201);
const production = await responseJson(productionResponse);
const productionLoginResponse = await dispatch(`${baseUrl}/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    pharmacy_id: production.external_tenant_id,
    pin: production.credentials.owner_pin,
    device_id: 'production-integration-test',
  }),
});
assert.equal(productionLoginResponse.status, 200);
const productionLogin = await productionLoginResponse.json();
const productionUpdatesResponse = await dispatch(
  `${baseUrl}/api/get-updates?last_sync=0&device_id=production-integration-test`,
  { headers: { Authorization: `Bearer ${productionLogin.token}` } },
);
assert.equal(productionUpdatesResponse.status, 200);
const productionUpdates = await productionUpdatesResponse.json();
assert.equal(productionUpdates.products.length, 0);
assert.equal(productionUpdates.batches.length, 0);
assert.equal(productionUpdates.customers.length, 0);

const archiveRequestId = randomUUID();
const archiveBody = { request_id: archiveRequestId, tenant_id: tenantId, action: 'archive' };
const archivedResponse = await signedRequest('POST', `/internal/v1/tenants/${tenantId}/status`, archiveRequestId, archiveBody);
assert.equal(archivedResponse.status, 200);
const archived = await responseJson(archivedResponse);
assert.equal(archived.status, 'archived');

// الحذف النهائي مرفوض قبل الأرشفة، حتى لا تُفقد بيانات مساحة نشطة بالخطأ.
const earlyPurgeResponse = await signedRequest('DELETE', `/internal/v1/tenants/${productionTenantId}`, randomUUID());
assert.equal(earlyPurgeResponse.status, 409);
assert.equal((await earlyPurgeResponse.json()).error, 'TENANT_NOT_ARCHIVED');

// الاستعادة تُخرج المستأجر من الأرشيف وتتركه موقوفًا لا نشطًا.
const restoreRequestId = randomUUID();
const restoredResponse = await signedRequest(
  'POST', `/internal/v1/tenants/${tenantId}/status`, restoreRequestId,
  { request_id: restoreRequestId, tenant_id: tenantId, action: 'restore' },
);
assert.equal(restoredResponse.status, 200);
assert.equal((await responseJson(restoredResponse)).status, 'suspended');

// إعادة الأرشفة ثم الحذف النهائي: لا تبقى صفوف تشغيلية لهذه الصيدلية.
const reArchiveRequestId = randomUUID();
await responseJson(await signedRequest(
  'POST', `/internal/v1/tenants/${tenantId}/status`, reArchiveRequestId,
  { request_id: reArchiveRequestId, tenant_id: tenantId, action: 'archive' },
));

const purgeResponse = await signedRequest('DELETE', `/internal/v1/tenants/${tenantId}`, randomUUID());
assert.equal(purgeResponse.status, 200);
assert.equal((await responseJson(purgeResponse)).status, 'deleted');

if (miniflare) {
  const database = await miniflare.getD1Database('DB');
  for (const table of ['pharmacies', 'users', 'products', 'batches', 'customers', 'settings', 'sessions']) {
    const row = await database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE pharmacy_id = ?`)
      .bind(created.external_tenant_id).first();
    assert.equal(Number(row.count), 0, `${table} still holds purged tenant rows`);
  }
  // الحذف لا يمس المستأجر الآخر في القاعدة نفسها.
  const survivor = await database.prepare('SELECT COUNT(*) AS count FROM pharmacies WHERE pharmacy_id = ?')
    .bind(production.external_tenant_id).first();
  assert.equal(Number(survivor.count), 1, 'purge must not touch other tenants');
}

// الحذف idempotent: تكراره لا يفشل بعد اختفاء السجل.
const repeatPurgeResponse = await signedRequest('DELETE', `/internal/v1/tenants/${tenantId}`, randomUUID());
assert.equal(repeatPurgeResponse.status, 200);

const goneHealthResponse = await signedRequest('GET', `/internal/v1/tenants/${tenantId}/health`, randomUUID());
assert.equal(goneHealthResponse.status, 404);

console.log('adapter-integration-ok');
} finally {
  if (miniflare) await miniflare.dispose();
}
