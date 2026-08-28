/* ============================================================
 * PharmaGaza SaaS — Cloudflare Worker
 * ============================================================
 * لا يوجد أي سر مكتوب في هذا الملف. كل الأسرار من متغيرات البيئة:
 *
 *   ADMIN_PASSWORD   (Secret)  كلمة مرور لوحة المدير
 *   ALLOWED_ORIGINS  (Var)     نطاقات مسموحة، مفصولة بفواصل
 *                              مثال: https://your-site.netlify.app
 *
 * الربط المطلوب: D1 database باسم المتغير  DB  ← pharma-db
 * ============================================================ */

// عدد دورات اشتقاق المفتاح للرقم السري.
// الخطة المجانية (10ms CPU) قد ترفض القيمة العالية بخطأ 1102.
// لو ظهر الخطأ عند تسجيل الدخول: خفّض إلى 10000.
// الخطة المدفوعة ($5) تتحمل 200000 بلا مشكلة.
const PBKDF2_ITER = 50000;

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // ٧ أيام — تعمل أيضاً كمهلة اشتراك
const ADMIN_TTL_MS = 8 * 60 * 60 * 1000;          // ٨ ساعات
const MAX_FAILS = 5;
const LOCK_STEPS_MS = [60e3, 5 * 60e3, 15 * 60e3, 60 * 60e3];

/* ---------------- أدوات التشفير ---------------- */

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const enc = (s) => new TextEncoder().encode(s);

async function sha256b64(text) {
  return b64(await crypto.subtle.digest("SHA-256", enc(text)));
}

async function derivePin(pin, saltB64) {
  const key = await crypto.subtle.importKey("raw", enc(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: unb64(saltB64), iterations: PBKDF2_ITER, hash: "SHA-256" },
    key,
    256
  );
  return b64(bits);
}

function newSalt() {
  return b64(crypto.getRandomValues(new Uint8Array(16)));
}

function newToken() {
  return b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, "");
}

// مقارنة ثابتة الزمن — لا تكشف طول التطابق عبر توقيت الرد
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------------- أدوات الرد ---------------- */

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get("Origin") || "";
  // لو لم تُضبط ALLOWED_ORIGINS نسمح بالمصدر الطالب (وضع التطوير فقط).
  const allow = allowed.length === 0 ? origin || "*" : allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
    "Content-Type": "application/json; charset=utf-8",
  };
}

const json = (data, status, headers) =>
  new Response(JSON.stringify(data), { status, headers });

/* ---------------- Athar Media product adapter ---------------- */

const ADAPTER_MAX_BODY_BYTES = 64 * 1024;
const ADAPTER_CLOCK_SKEW_SECONDS = 5 * 60;

class AdapterHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "AdapterHttpError";
    this.status = status;
    this.code = code;
  }
}

const adapterHeaders = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const adapterJson = (data, status = 200) => json(data, status, adapterHeaders);

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256HexBytes(bytes) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

async function sha256HexText(text) {
  return sha256HexBytes(enc(text));
}

async function hmacBytes(secret, text) {
  const key = await crypto.subtle.importKey(
    "raw", enc(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc(text)));
}

async function hmacHex(secret, text) {
  return bytesToHex(await hmacBytes(secret, text));
}

async function readBoundedBody(request) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > ADAPTER_MAX_BODY_BYTES) {
    throw new AdapterHttpError(413, "BODY_TOO_LARGE", "Request body exceeds the adapter limit.");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > ADAPTER_MAX_BODY_BYTES) {
      await reader.cancel("body too large");
      throw new AdapterHttpError(413, "BODY_TOO_LARGE", "Request body exceeds the adapter limit.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function verifyAdapterRequest(request, env) {
  const secret = env.ATHAR_ADAPTER_SECRET;
  if (!secret) throw new AdapterHttpError(500, "ADAPTER_NOT_CONFIGURED", "Product adapter is not configured.");

  const timestamp = request.headers.get("X-Athar-Timestamp") || "";
  const requestId = request.headers.get("X-Athar-Request-Id") || "";
  const signature = (request.headers.get("X-Athar-Signature") || "").toLowerCase();
  if (!/^\d{10}$/.test(timestamp) || !/^[0-9a-f-]{36}$/.test(requestId) || !/^[0-9a-f]{64}$/.test(signature)) {
    throw new AdapterHttpError(401, "ADAPTER_UNAUTHORIZED", "Adapter authentication failed.");
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > ADAPTER_CLOCK_SKEW_SECONDS) {
    throw new AdapterHttpError(401, "ADAPTER_TIMESTAMP_EXPIRED", "Adapter request timestamp is outside the accepted window.");
  }

  const bodyBytes = await readBoundedBody(request);
  const requestHash = await sha256HexBytes(bodyBytes);
  const pathname = new URL(request.url).pathname;
  const canonical = `${timestamp}\n${requestId}\n${request.method.toUpperCase()}\n${pathname}\n${requestHash}`;
  if (!safeEqual(await hmacHex(secret, canonical), signature)) {
    throw new AdapterHttpError(401, "ADAPTER_UNAUTHORIZED", "Adapter authentication failed.");
  }

  let body = {};
  if (bodyBytes.byteLength) {
    const contentType = request.headers.get("Content-Type") || "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      throw new AdapterHttpError(415, "JSON_REQUIRED", "Adapter requests must use JSON.");
    }
    try {
      body = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      throw new AdapterHttpError(400, "INVALID_JSON", "Adapter request JSON is invalid.");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AdapterHttpError(400, "INVALID_JSON", "Adapter request JSON must be an object.");
    }
    if (body.request_id !== requestId) {
      throw new AdapterHttpError(400, "REQUEST_ID_MISMATCH", "Body and header request IDs must match.");
    }
  }
  return { requestId, requestHash, body };
}

function adapterRequired(value, code, max = 160) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > max) {
    throw new AdapterHttpError(422, code, "A required adapter field is invalid.");
  }
  return normalized;
}

async function beginAdapterRequest(db, requestId, action, tenantId, requestHash) {
  const existing = await db.prepare(
    "SELECT request_hash, status, response_json FROM adapter_requests WHERE request_id = ?"
  ).bind(requestId).first();
  if (existing) {
    if (!safeEqual(String(existing.request_hash), requestHash)) {
      throw new AdapterHttpError(409, "IDEMPOTENCY_CONFLICT", "This request ID was already used for different data.");
    }
    if (existing.status === "succeeded") {
      return { replay: true, result: JSON.parse(existing.response_json || "{}") };
    }
    if (existing.status === "pending") {
      throw new AdapterHttpError(409, "REQUEST_IN_PROGRESS", "This adapter request is already in progress.");
    }
    await db.prepare(
      "UPDATE adapter_requests SET status = 'pending', error_code = '', completed_at = NULL WHERE request_id = ?"
    ).bind(requestId).run();
    return { replay: false };
  }
  const claimed = await db.prepare(
    `INSERT OR IGNORE INTO adapter_requests
     (request_id, action, tenant_id, request_hash, status, response_json, error_code, created_at)
     VALUES (?, ?, ?, ?, 'pending', '{}', '', ?)`
  ).bind(requestId, action, tenantId, requestHash, Date.now()).run();
  if (Number(claimed.meta?.changes || 0) === 0) {
    return beginAdapterRequest(db, requestId, action, tenantId, requestHash);
  }
  return { replay: false };
}

async function markAdapterFailed(db, requestId, code) {
  await db.prepare(
    "UPDATE adapter_requests SET status = 'failed', error_code = ?, completed_at = ? WHERE request_id = ?"
  ).bind(code, Date.now(), requestId).run();
}

async function externalPharmacyId(slug, tenantId) {
  const suffix = (await sha256HexText(tenantId)).slice(0, 8);
  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 19) || "pharmacy";
  return `ATH_${safeSlug}_${suffix}`.toUpperCase();
}

async function ownerPin(secret, requestId, tenantId) {
  const bytes = await hmacBytes(secret, `credential\n${requestId}\n${tenantId}`);
  const number = ((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3];
  return String(100000 + (number % 900000));
}

function publicPharmacyUrl(env, pharmacyId) {
  const base = String(env.PUBLIC_APP_URL || "").trim();
  if (!base) return "";
  try {
    const url = new URL(base);
    url.searchParams.set("pharmacy", pharmacyId);
    return url.toString();
  } catch {
    return "";
  }
}

// كتالوج العرض. الأعمدة: المفتاح، الاسم، التصنيف، سعر التكلفة، سعر البيع (بالأغورة)،
// الكمية، عدد الأشهر حتى انتهاء الصلاحية. القيم السالبة تعني صنفًا منتهيًا فعلًا.
// الهدف صيدلية تبدو حقيقية: أصناف تكفي للبحث، ونواقص وقرب انتهاء تُظهر قيمة التنبيهات.
const DEMO_CATALOG = [
  ["paracetamol", "باراسيتامول 500 مجم", "مسكنات وخافضات حرارة", 240, 350, 180, 26],
  ["ibuprofen", "إيبوبروفين 400 مجم", "مسكنات وخافضات حرارة", 320, 500, 96, 19],
  ["aspirin", "أسبرين 100 مجم", "مسكنات وخافضات حرارة", 190, 300, 64, 31],
  ["diclofenac-gel", "جل ديكلوفيناك", "مسكنات وخافضات حرارة", 900, 1400, 22, 14],
  ["amoxicillin", "أموكسيسيلين 500 مجم", "مضادات حيوية", 1100, 1650, 48, 11],
  ["azithromycin", "أزيثرومايسين 250 مجم", "مضادات حيوية", 1800, 2600, 30, 16],
  ["cefixime", "سيفيكسيم 400 مجم", "مضادات حيوية", 2200, 3200, 8, 5],
  ["augmentin-syrup", "شراب أوجمنتين للأطفال", "مضادات حيوية", 2400, 3400, 14, 7],
  ["vitamin-c", "فيتامين C 1000 مجم", "فيتامينات ومكملات", 500, 750, 88, 21],
  ["vitamin-d", "فيتامين D3 5000 وحدة", "فيتامينات ومكملات", 1600, 2400, 41, 24],
  ["iron-folic", "حديد + حمض فوليك", "فيتامينات ومكملات", 950, 1450, 36, 18],
  ["calcium", "كالسيوم + ماغنيسيوم", "فيتامينات ومكملات", 1250, 1900, 27, 20],
  ["omega3", "أوميغا 3 زيت سمك", "فيتامينات ومكملات", 2800, 4200, 19, 15],
  ["metformin", "ميتفورمين 850 مجم", "أدوية مزمنة", 700, 1100, 72, 23],
  ["amlodipine", "أملوديبين 5 مجم", "أدوية مزمنة", 620, 950, 58, 17],
  ["atorvastatin", "أتورفاستاتين 20 مجم", "أدوية مزمنة", 1350, 2000, 44, 13],
  ["insulin-pen", "قلم إنسولين", "أدوية مزمنة", 5400, 7500, 6, 4],
  ["salbutamol", "بخاخ سالبوتامول", "أدوية تنفسية", 1900, 2800, 25, 12],
  ["cough-syrup", "شراب مهدئ للسعال", "أدوية تنفسية", 850, 1300, 33, 9],
  ["nasal-spray", "بخاخ أنف ملحي", "أدوية تنفسية", 700, 1050, 47, 22],
  ["loratadine", "لوراتادين 10 مجم", "مضادات حساسية", 480, 750, 61, 25],
  ["eye-drops", "قطرة عين مرطبة", "عناية وعيون", 1100, 1700, 29, 10],
  ["antiseptic", "مطهر جروح 100 مل", "إسعافات أولية", 620, 950, 52, 28],
  ["gauze", "شاش طبي معقم", "إسعافات أولية", 180, 300, 140, 34],
  ["plaster", "لاصق جروح - علبة", "إسعافات أولية", 300, 500, 76, 30],
  ["thermometer", "ميزان حرارة رقمي", "مستلزمات طبية", 2200, 3500, 11, 60],
  ["bp-monitor", "جهاز ضغط رقمي", "مستلزمات طبية", 12000, 18000, 4, 60],
  ["baby-milk", "حليب أطفال مرحلة 1", "أمومة وطفل", 3200, 4400, 23, 8],
  ["baby-diapers", "حفاضات أطفال - كبير", "أمومة وطفل", 2600, 3600, 18, 40],
  ["sunscreen", "واقٍ شمسي SPF50", "عناية وعيون", 3400, 4900, 9, 3],
  ["expired-syrup", "شراب فيتامينات - دفعة قديمة", "فيتامينات ومكملات", 800, 1200, 5, -2],
  ["expired-cream", "كريم مرطب - دفعة قديمة", "عناية وعيون", 1400, 2100, 3, -5],
];

const DEMO_CUSTOMERS = [
  ["ahmad", "أحمد الشوا", "0599123401", 0],
  ["huda", "هدى النجار", "0599123402", 4500],
  ["mahmoud", "محمود أبو ندى", "0599123403", 0],
  ["samar", "سمر الحلبي", "0599123404", 12800],
  ["khaled", "خالد مشتهى", "0599123405", 0],
  ["fatima", "فاطمة الأغا", "0599123406", 3200],
  ["yousef", "يوسف الدحدوح", "0599123407", 0],
  ["nour", "نور شعث", "0599123408", 7600],
  ["clinic", "عيادة النور - حساب آجل", "0599123409", 21500],
  ["walid", "وليد السقا", "0599123410", 0],
];

const DEMO_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const DEMO_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * مولّد شبه عشوائي ثابت البذرة. النتيجة نفسها لكل صيدلية عرض، فالعرض التقديمي
 * لا يتغيّر بين مرة وأخرى، ويمكن وصف ما سيراه العميل قبل فتح الشاشة.
 */
function demoRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

/**
 * بيانات العرض. تُبنى على مرحلتين عمدًا: تُولَّد الحركات أولًا ويُحسب أثرها،
 * ثم تُكتب الدفعات بالرصيد الصافي. السبب أن العميل عند أول مزامنة يأخذ
 * `qty_snapshot` بوصفه الحقيقة الحالية، فلو كانت اللقطة هي رصيد الافتتاح
 * لظهر مخزون أكبر من الواقع بمقدار كل ما بيع.
 */
function demoSeedStatements(db, pharmacyId, now) {
  const statements = [];
  const random = demoRandom(20260820);
  const ownerId = `owner_${pharmacyId}`;
  const moveStatements = [];
  const stock = new Map();
  const sellable = [];

  const stockMove = (id, batchId, delta, reason, refId, at) =>
    db.prepare(
      `INSERT INTO stock_moves (id, pharmacy_id, batch_id, delta, reason, ref_id, device_id, user_id, at)
       VALUES (?, ?, ?, ?, ?, ?, 'demo-seed', ?, ?)`
    ).bind(id, pharmacyId, batchId, delta, reason, refId, ownerId, at);

  for (const [key, name, category, cost, sell, quantity, expiryMonths] of DEMO_CATALOG) {
    const productId = `${pharmacyId}_demo_${key}`;
    const batchId = `${productId}_batch`;
    const barcode = `628${String(Math.floor(random() * 1e9)).padStart(9, "0")}`;
    statements.push(
      db.prepare(
        "INSERT INTO products (id, pharmacy_id, name, barcode, category, is_deleted, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?)"
      ).bind(productId, pharmacyId, name, barcode, category, now)
    );
    // حركة الشراء الافتتاحية: الرصيد ناتج حركات لا رقمًا مكتوبًا يدويًا.
    moveStatements.push(stockMove(`${batchId}_open`, batchId, quantity, "purchase", null, now - 120 * DEMO_DAY_MS));
    stock.set(batchId, {
      key, batchId, productId, name, cost, sell, quantity,
      expiry: now + expiryMonths * DEMO_MONTH_MS,
      barcode, remaining: quantity,
    });
    if (expiryMonths > 0) sellable.push(batchId);
  }

  for (const [key, name, phone, debt] of DEMO_CUSTOMERS) {
    statements.push(
      db.prepare(
        `INSERT INTO customers (id, pharmacy_id, name, phone, debt_agorot, is_deleted, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`
      ).bind(`${pharmacyId}_demo_cust_${key}`, pharmacyId, name, phone, debt, now)
    );
  }

  // إخراجات سابقة حتى يفتح العميل تقرير الهدر فيجده يحكي قصة، لا صفرًا.
  // «حليب أطفال» متكرر عمدًا: هذا بالضبط ما يجب أن يكشفه التقرير للمالك.
  const wasteHistory = [
    ["baby-milk", 4, "expired", 78],
    ["baby-milk", 3, "expired", 47],
    ["baby-milk", 3, "expired", 12],
    ["cough-syrup", 3, "expired", 25],
    ["eye-drops", 2, "damaged", 9],
    ["insulin-pen", 1, "damaged", 33],
    ["augmentin-syrup", 4, "return_supplier", 18],
  ];
  wasteHistory.forEach(([key, qty, reason, daysAgo], index) => {
    const batchId = `${pharmacyId}_demo_${key}_batch`;
    const entry = stock.get(batchId);
    if (!entry || entry.remaining < qty) return;
    entry.remaining -= qty;
    moveStatements.push(stockMove(
      `${pharmacyId}_demo_waste_${index}`, batchId, -qty, reason, null, now - daysAgo * DEMO_DAY_MS
    ));
  });

  // فواتير موزّعة على آخر ٣٠ يومًا حتى تمتلئ شاشات المبيعات والتقارير بحركة حقيقية.
  for (let index = 0; index < 45; index += 1) {
    const daysAgo = Math.floor(random() * 30);
    const at = now - daysAgo * DEMO_DAY_MS - Math.floor(random() * 10 * 60 * 60 * 1000);
    const lineCount = 1 + Math.floor(random() * 3);
    const items = [];
    let total = 0;
    for (let line = 0; line < lineCount; line += 1) {
      const entry = stock.get(sellable[Math.floor(random() * sellable.length)]);
      const qty = 1 + Math.floor(random() * 3);
      // لا نبيع أكثر مما اشترينا: الرصيد السالب يجعل العرض غير قابل للتصديق.
      if (!entry || entry.remaining < qty + 2) continue;
      entry.remaining -= qty;
      total += entry.sell * qty;
      items.push({ batch_id: entry.batchId, name: entry.name, qty, price_agorot: entry.sell, cost_agorot: entry.cost });
      moveStatements.push(stockMove(
        `${pharmacyId}_demo_mv_${index}_${line}`, entry.batchId, -qty, "sale",
        `${pharmacyId}_demo_inv_${index}`, at
      ));
    }
    if (!items.length) continue;
    const onCredit = random() < 0.2;
    const customer = DEMO_CUSTOMERS[Math.floor(random() * DEMO_CUSTOMERS.length)];
    statements.push(
      db.prepare(
        `INSERT INTO invoices
         (id, pharmacy_id, invoice_number, total_agorot, user_id, cashier_name, customer_id,
          payment_type, items_json, is_voided, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      ).bind(
        `${pharmacyId}_demo_inv_${index}`, pharmacyId, `INV-${String(1001 + index)}`, total,
        ownerId, "المالك", onCredit ? `${pharmacyId}_demo_cust_${customer[0]}` : null,
        onCredit ? "debt" : "cash", JSON.stringify(items), at, at
      )
    );
  }

  // الدفعات تُكتب الآن بالرصيد الصافي بعد البيع والإتلاف.
  for (const entry of stock.values()) {
    statements.push(
      db.prepare(
        `INSERT INTO batches
         (id, pharmacy_id, product_id, batch_number, expiry_end, sell_price_agorot,
          cost_price_agorot, qty_snapshot, is_deleted, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
      ).bind(
        entry.batchId, pharmacyId, entry.productId, `LOT-${entry.barcode.slice(-5)}`,
        entry.expiry, entry.sell, entry.cost, entry.remaining, now
      )
    );
  }
  statements.push(...moveStatements);

  // تسديدات جزئية على الحسابات الآجلة حتى تظهر شاشة الديون بحركة لا بأرصدة ساكنة.
  let paymentIndex = 0;
  for (const [key, , , debt] of DEMO_CUSTOMERS) {
    if (debt <= 0) continue;
    statements.push(
      db.prepare(
        `INSERT INTO payments (id, pharmacy_id, customer_id, amount_agorot, user_id, at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        `${pharmacyId}_demo_pay_${paymentIndex}`, pharmacyId, `${pharmacyId}_demo_cust_${key}`,
        Math.round(debt / 2), ownerId, now - (5 + paymentIndex) * DEMO_DAY_MS, now
      )
    );
    paymentIndex += 1;
  }

  return statements;
}

async function provisionFromAthar(env, signed) {
  const db = env.DB;
  const body = signed.body;
  const tenantId = adapterRequired(body.tenant_id, "INVALID_TENANT_ID", 80);
  const slug = adapterRequired(body.slug, "INVALID_SLUG", 40);
  const displayName = adapterRequired(body.display_name, "INVALID_DISPLAY_NAME", 160);
  const environment = body.environment === "demo" ? "demo" : body.environment === "production" ? "production" : "";
  if (!environment) throw new AdapterHttpError(422, "INVALID_ENVIRONMENT", "Environment must be demo or production.");
  const planCode = adapterRequired(body.plan_code, "INVALID_PLAN_CODE", 80);
  const config = body.config && typeof body.config === "object" && !Array.isArray(body.config) ? body.config : {};
  const phone = String(config.phone || "").trim().slice(0, 40);
  const address = String(config.address || "").trim().slice(0, 300);
  const requestedCurrency = String(config.currency || "ILS").trim().toUpperCase().slice(0, 8);
  const currency = requestedCurrency === "ILS" ? "\u20aa" : requestedCurrency;

  const started = await beginAdapterRequest(db, signed.requestId, "create", tenantId, signed.requestHash);
  const pin = await ownerPin(env.ATHAR_ADAPTER_SECRET, signed.requestId, tenantId);
  if (started.replay) {
    return adapterJson({
      ...started.result,
      credentials: credentialPayload(started.result.external_tenant_id, pin),
      replayed: true,
    });
  }

  try {
    const mapped = await db.prepare("SELECT pharmacy_id FROM pharmacies WHERE control_tenant_id = ?").bind(tenantId).first();
    if (mapped) throw new AdapterHttpError(409, "TENANT_ALREADY_EXISTS", "This Athar tenant is already mapped to a pharmacy.");

    const pharmacyId = await externalPharmacyId(slug, tenantId);
    const salt = newSalt();
    const pinHash = await derivePin(pin, salt);
    const now = Date.now();
    const publicUrl = publicPharmacyUrl(env, pharmacyId);
    const result = {
      ok: true, request_id: signed.requestId, tenant_id: tenantId,
      external_tenant_id: pharmacyId, status: "active", environment, public_url: publicUrl,
    };
    const statements = [
      db.prepare(
        `INSERT INTO pharmacies
         (pharmacy_id, control_tenant_id, name, phone, address, currency, is_active, environment,
          plan_code, trial_expires_at, lifecycle_status, provisioned_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'active', ?, ?, ?)`
      ).bind(pharmacyId, tenantId, displayName, phone, address, currency, environment, planCode,
        body.trial_expires_at || null, now, now, now),
      db.prepare(
        "INSERT INTO settings (pharmacy_id, name, phone, address, currency, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(pharmacyId, displayName, phone, address, currency, now),
      db.prepare(
        `INSERT INTO users (id, pharmacy_id, name, role, pin_hash, pin_salt, is_active, updated_at)
         VALUES (?, ?, ?, 'owner', ?, ?, 1, ?)`
      ).bind(`owner_${pharmacyId}`, pharmacyId, "\u0627\u0644\u0645\u0627\u0644\u0643", pinHash, salt, now),
    ];
    if (environment === "demo") statements.push(...demoSeedStatements(db, pharmacyId, now));
    statements.push(
      db.prepare(
        `UPDATE adapter_requests SET status = 'succeeded', response_json = ?, error_code = '', completed_at = ?
         WHERE request_id = ?`
      ).bind(JSON.stringify(result), now, signed.requestId)
    );
    await db.batch(statements);
    console.log(JSON.stringify({ event: "adapter.provision", request_id: signed.requestId, tenant_id: tenantId, status: "succeeded" }));
    return adapterJson({ ...result, credentials: credentialPayload(pharmacyId, pin) }, 201);
  } catch (error) {
    await markAdapterFailed(db, signed.requestId, error instanceof AdapterHttpError ? error.code : "PROVISIONING_FAILED");
    throw error;
  }
}

async function changeAtharTenantStatus(env, signed, tenantIdFromPath) {
  const db = env.DB;
  const tenantId = adapterRequired(tenantIdFromPath, "INVALID_TENANT_ID", 80);
  const action = String(signed.body.action || "");
  if (!["suspend", "resume", "archive", "restore"].includes(action)) {
    throw new AdapterHttpError(422, "INVALID_ACTION", "Lifecycle action is invalid.");
  }
  const started = await beginAdapterRequest(db, signed.requestId, action, tenantId, signed.requestHash);
  if (started.replay) return adapterJson({ ...started.result, replayed: true });

  try {
    const pharmacy = await db.prepare(
      "SELECT pharmacy_id, lifecycle_status FROM pharmacies WHERE control_tenant_id = ?"
    ).bind(tenantId).first();
    if (!pharmacy) throw new AdapterHttpError(404, "TENANT_NOT_FOUND", "Product tenant was not found.");
    const current = String(pharmacy.lifecycle_status || "active");
    if (current === "archived" && action !== "archive" && action !== "restore") {
      throw new AdapterHttpError(409, "TENANT_ARCHIVED", "An archived tenant must be restored before other changes.");
    }
    if (action === "restore" && current !== "archived") {
      throw new AdapterHttpError(409, "TENANT_NOT_ARCHIVED", "Only an archived tenant can be restored.");
    }
    // الاستعادة تُخرج المستأجر من الأرشيف فقط وتتركه موقوفًا؛ عودة الخدمة قرار
    // منفصل يتخذه المشغّل عبر resume، فلا يعود الاشتراك تلقائيًا بالحذف الملغى.
    const next = action === "resume"
      ? "active"
      : action === "suspend" || action === "restore" ? "suspended" : "archived";
    const active = next === "active" ? 1 : 0;
    const now = Date.now();
    const result = {
      ok: true, request_id: signed.requestId, tenant_id: tenantId,
      external_tenant_id: pharmacy.pharmacy_id, status: next,
    };
    const statements = [
      db.prepare(
        "UPDATE pharmacies SET is_active = ?, lifecycle_status = ?, updated_at = ? WHERE control_tenant_id = ?"
      ).bind(active, next, now, tenantId),
      db.prepare(
        `UPDATE adapter_requests SET status = 'succeeded', response_json = ?, error_code = '', completed_at = ?
         WHERE request_id = ?`
      ).bind(JSON.stringify(result), now, signed.requestId),
    ];
    if (!active) statements.push(db.prepare("DELETE FROM sessions WHERE pharmacy_id = ?").bind(pharmacy.pharmacy_id));
    await db.batch(statements);
    console.log(JSON.stringify({ event: `adapter.${action}`, request_id: signed.requestId, tenant_id: tenantId, status: "succeeded" }));
    return adapterJson(result);
  } catch (error) {
    await markAdapterFailed(db, signed.requestId, error instanceof AdapterHttpError ? error.code : "LIFECYCLE_FAILED");
    throw error;
  }
}

/**
 * رقم سري جديد للمالك. يُشتق من معرّف الطلب نفسه، فإعادة إرسال الطلب
 * بالمعرّف ذاته تعيد الرقم نفسه ولا تقفل المالك خارج صيدليته.
 * الرقم القديم يبطل فورًا، وتُلغى الجلسات القائمة حتى لا يبقى جهاز مفتوحًا برقم مسروق.
 */
/**
 * شكل بيانات الدخول الموحّد بين المحركات. `login_id/username/secret` هو ما
 * تقرأه لوحة أثر، فلا تحتاج أن تعرف أن هذا المنتج يسمّيه PIN وذاك كلمة مرور.
 * المفاتيح القديمة تبقى للتوافق مع أي مستهلك لم يُحدَّث بعد.
 */
/**
 * تحديث هوية الصيدلية من لوحة أثر.
 *
 * الاسم يملكه السجل التجاري: هو الاسم الذي بيع عليه الاشتراك. يُحدَّث في
 * موضعين — صف الصيدلية وجدول `settings` الذي تقرؤه الواجهة وتزامنه الأجهزة.
 * تحديث أحدهما وحده يترك الشاشات على الاسم القديم.
 */
/**
 * تغيير الباقة من لوحة أثر. الصيدلية بباقة واحدة اليوم، لكن المسار موجود
 * ليبقى العقد موحّدًا بين المحركات: اللوحة تنادي المسار نفسه لكل منتج،
 * ولا تحمل استثناءً لكل محرك.
 */
async function changePharmacyPlan(env, signed, tenantIdFromPath) {
  const db = env.DB;
  const tenantId = adapterRequired(tenantIdFromPath, "INVALID_TENANT_ID", 80);
  const planCode = adapterRequired(signed.body.plan_code, "INVALID_PLAN_CODE", 80);
  const started = await beginAdapterRequest(db, signed.requestId, "change_plan", tenantId, signed.requestHash);
  if (started.replay) return adapterJson({ ...started.result, replayed: true });

  try {
    const pharmacy = await db.prepare(
      "SELECT pharmacy_id FROM pharmacies WHERE control_tenant_id = ?"
    ).bind(tenantId).first();
    if (!pharmacy) throw new AdapterHttpError(404, "TENANT_NOT_FOUND", "Product tenant was not found.");
    const now = Date.now();
    const result = {
      ok: true, request_id: signed.requestId, tenant_id: tenantId,
      external_tenant_id: pharmacy.pharmacy_id, plan_code: planCode,
    };
    await db.batch([
      db.prepare("UPDATE pharmacies SET plan_code = ?, updated_at = ? WHERE control_tenant_id = ?")
        .bind(planCode, now, tenantId),
      db.prepare(
        `UPDATE adapter_requests SET status = 'succeeded', response_json = ?, error_code = '', completed_at = ?
         WHERE request_id = ?`
      ).bind(JSON.stringify(result), now, signed.requestId),
    ]);
    return adapterJson(result);
  } catch (error) {
    await markAdapterFailed(db, signed.requestId, error instanceof AdapterHttpError ? error.code : "PLAN_CHANGE_FAILED");
    throw error;
  }
}

async function updatePharmacyProfile(env, signed, tenantIdFromPath) {
  const db = env.DB;
  const tenantId = adapterRequired(tenantIdFromPath, "INVALID_TENANT_ID", 80);
  const started = await beginAdapterRequest(db, signed.requestId, "update_profile", tenantId, signed.requestHash);
  if (started.replay) return adapterJson({ ...started.result, replayed: true });

  try {
    const pharmacy = await db.prepare(
      "SELECT pharmacy_id, name FROM pharmacies WHERE control_tenant_id = ?"
    ).bind(tenantId).first();
    if (!pharmacy) throw new AdapterHttpError(404, "TENANT_NOT_FOUND", "Product tenant was not found.");

    const nextName = signed.body.display_name === undefined
      ? String(pharmacy.name)
      : adapterRequired(signed.body.display_name, "INVALID_DISPLAY_NAME", 160);
    const now = Date.now();
    const result = {
      ok: true, request_id: signed.requestId, tenant_id: tenantId,
      external_tenant_id: pharmacy.pharmacy_id, display_name: nextName,
    };
    await db.batch([
      db.prepare("UPDATE pharmacies SET name = ?, updated_at = ? WHERE control_tenant_id = ?")
        .bind(nextName, now, tenantId),
      db.prepare("UPDATE settings SET name = ?, updated_at = ? WHERE pharmacy_id = ?")
        .bind(nextName, now, pharmacy.pharmacy_id),
      db.prepare(
        `UPDATE adapter_requests SET status = 'succeeded', response_json = ?, error_code = '', completed_at = ?
         WHERE request_id = ?`
      ).bind(JSON.stringify(result), now, signed.requestId),
    ]);
    return adapterJson(result);
  } catch (error) {
    await markAdapterFailed(db, signed.requestId, error instanceof AdapterHttpError ? error.code : "PROFILE_UPDATE_FAILED");
    throw error;
  }
}

function credentialPayload(pharmacyId, pin) {
  return {
    login_id: pharmacyId,
    username: "owner",
    secret: pin,
    secret_label: "الرقم السري للمالك",
    pharmacy_id: pharmacyId,
    owner_pin: pin,
  };
}

async function resetOwnerPin(env, signed, tenantIdFromPath) {
  const db = env.DB;
  const tenantId = adapterRequired(tenantIdFromPath, "INVALID_TENANT_ID", 80);
  const started = await beginAdapterRequest(db, signed.requestId, "reset_owner_pin", tenantId, signed.requestHash);
  const pin = await ownerPin(env.ATHAR_ADAPTER_SECRET, signed.requestId, tenantId);
  if (started.replay) {
    return adapterJson({
      ...started.result,
      credentials: credentialPayload(started.result.external_tenant_id, pin),
      replayed: true,
    });
  }

  try {
    const pharmacy = await db.prepare(
      "SELECT pharmacy_id, lifecycle_status FROM pharmacies WHERE control_tenant_id = ?"
    ).bind(tenantId).first();
    if (!pharmacy) throw new AdapterHttpError(404, "TENANT_NOT_FOUND", "Product tenant was not found.");
    if (String(pharmacy.lifecycle_status) === "archived") {
      throw new AdapterHttpError(409, "TENANT_ARCHIVED", "An archived tenant cannot receive a new PIN.");
    }
    const owner = await db.prepare(
      "SELECT id FROM users WHERE pharmacy_id = ? AND role = 'owner' ORDER BY id LIMIT 1"
    ).bind(pharmacy.pharmacy_id).first();
    if (!owner) throw new AdapterHttpError(404, "OWNER_NOT_FOUND", "This tenant has no owner account.");

    const salt = newSalt();
    const pinHash = await derivePin(pin, salt);
    const now = Date.now();
    const result = {
      ok: true, request_id: signed.requestId, tenant_id: tenantId,
      external_tenant_id: pharmacy.pharmacy_id, status: "pin_reset",
    };
    await db.batch([
      db.prepare(
        "UPDATE users SET pin_hash = ?, pin_salt = ?, is_active = 1, updated_at = ? WHERE id = ?"
      ).bind(pinHash, salt, now, owner.id),
      db.prepare("DELETE FROM sessions WHERE pharmacy_id = ?").bind(pharmacy.pharmacy_id),
      db.prepare(
        `UPDATE adapter_requests SET status = 'succeeded', response_json = ?, error_code = '', completed_at = ?
         WHERE request_id = ?`
      ).bind(JSON.stringify(result), now, signed.requestId),
    ]);
    console.log(JSON.stringify({ event: "adapter.reset_owner_pin", request_id: signed.requestId, tenant_id: tenantId, status: "succeeded" }));
    return adapterJson({ ...result, credentials: credentialPayload(pharmacy.pharmacy_id, pin) });
  } catch (error) {
    await markAdapterFailed(db, signed.requestId, error instanceof AdapterHttpError ? error.code : "PIN_RESET_FAILED");
    throw error;
  }
}

// كل جدول تشغيلي يحمل pharmacy_id. الحذف النهائي يمر على هذه القائمة كاملة
// ثم يحذف سجل الصيدلية نفسه، فلا تبقى صفوف يتيمة بعد Purge.
const PHARMACY_SCOPED_TABLES = [
  "sessions", "users", "settings", "stock_moves", "batches",
  "products", "payments", "invoices", "customers", "audit_log",
];

async function purgeAtharTenant(env, signed, tenantIdFromPath) {
  const db = env.DB;
  const tenantId = adapterRequired(tenantIdFromPath, "INVALID_TENANT_ID", 80);
  const started = await beginAdapterRequest(db, signed.requestId, "purge", tenantId, signed.requestHash);
  if (started.replay) return adapterJson({ ...started.result, replayed: true });

  try {
    const pharmacy = await db.prepare(
      "SELECT pharmacy_id, lifecycle_status FROM pharmacies WHERE control_tenant_id = ?"
    ).bind(tenantId).first();
    if (!pharmacy) {
      // الحذف idempotent: غياب السجل يعني أن عملية سابقة أتمت المهمة.
      const done = { ok: true, request_id: signed.requestId, tenant_id: tenantId, external_tenant_id: "", status: "deleted" };
      await db.prepare(
        `UPDATE adapter_requests SET status = 'succeeded', response_json = ?, error_code = '', completed_at = ?
         WHERE request_id = ?`
      ).bind(JSON.stringify(done), Date.now(), signed.requestId).run();
      return adapterJson(done);
    }
    if (String(pharmacy.lifecycle_status) !== "archived") {
      throw new AdapterHttpError(409, "TENANT_NOT_ARCHIVED", "A tenant must be archived before it is purged.");
    }

    const now = Date.now();
    const result = {
      ok: true, request_id: signed.requestId, tenant_id: tenantId,
      external_tenant_id: pharmacy.pharmacy_id, status: "deleted",
    };
    const statements = PHARMACY_SCOPED_TABLES.map((table) =>
      db.prepare(`DELETE FROM ${table} WHERE pharmacy_id = ?`).bind(pharmacy.pharmacy_id)
    );
    statements.push(
      db.prepare("DELETE FROM pharmacies WHERE control_tenant_id = ?").bind(tenantId),
      db.prepare(
        `UPDATE adapter_requests SET status = 'succeeded', response_json = ?, error_code = '', completed_at = ?
         WHERE request_id = ?`
      ).bind(JSON.stringify(result), now, signed.requestId)
    );
    await db.batch(statements);
    console.log(JSON.stringify({ event: "adapter.purge", request_id: signed.requestId, tenant_id: tenantId, status: "succeeded" }));
    return adapterJson(result);
  } catch (error) {
    await markAdapterFailed(db, signed.requestId, error instanceof AdapterHttpError ? error.code : "PURGE_FAILED");
    throw error;
  }
}

async function atharTenantHealth(env, requestId, tenantIdFromPath) {
  const tenantId = adapterRequired(tenantIdFromPath, "INVALID_TENANT_ID", 80);
  const pharmacy = await env.DB.prepare(
    `SELECT pharmacy_id, environment, lifecycle_status, is_active
     FROM pharmacies WHERE control_tenant_id = ?`
  ).bind(tenantId).first();
  if (!pharmacy) throw new AdapterHttpError(404, "TENANT_NOT_FOUND", "Product tenant was not found.");
  return adapterJson({
    ok: true, request_id: requestId, tenant_id: tenantId,
    external_tenant_id: pharmacy.pharmacy_id, environment: pharmacy.environment,
    status: pharmacy.lifecycle_status, active: Boolean(pharmacy.is_active), checked_at: new Date().toISOString(),
  });
}

async function handleAtharAdapter(request, env) {
  let signed;
  try {
    signed = await verifyAdapterRequest(request, env);
    const path = new URL(request.url).pathname;
    if (path === "/internal/v1/tenants" && request.method === "POST") return await provisionFromAthar(env, signed);
    const statusMatch = path.match(/^\/internal\/v1\/tenants\/([^/]+)\/status$/);
    if (statusMatch && request.method === "POST") {
      return await changeAtharTenantStatus(env, signed, decodeURIComponent(statusMatch[1]));
    }
    const healthMatch = path.match(/^\/internal\/v1\/tenants\/([^/]+)\/health$/);
    if (healthMatch && request.method === "GET") {
      return await atharTenantHealth(env, signed.requestId, decodeURIComponent(healthMatch[1]));
    }
    // المسار الموحّد لكل المحركات. `reset-owner-pin` اسم قديم يبقى مقبولاً
    // حتى لا ينكسر طلب قيد التنفيذ، والجديد هو المذكور في العقد.
    const credentialMatch = path.match(
      /^\/internal\/v1\/tenants\/([^/]+)\/(?:reset-owner-credential|reset-owner-pin)$/
    );
    if (credentialMatch && request.method === "POST") {
      return await resetOwnerPin(env, signed, decodeURIComponent(credentialMatch[1]));
    }
    const planMatch = path.match(/^\/internal\/v1\/tenants\/([^/]+)\/plan$/);
    if (planMatch && request.method === "POST") {
      return await changePharmacyPlan(env, signed, decodeURIComponent(planMatch[1]));
    }
    const profileMatch = path.match(/^\/internal\/v1\/tenants\/([^/]+)\/profile$/);
    if (profileMatch && request.method === "POST") {
      return await updatePharmacyProfile(env, signed, decodeURIComponent(profileMatch[1]));
    }
    const purgeMatch = path.match(/^\/internal\/v1\/tenants\/([^/]+)$/);
    if (purgeMatch && request.method === "DELETE") {
      return await purgeAtharTenant(env, signed, decodeURIComponent(purgeMatch[1]));
    }
    throw new AdapterHttpError(404, "NOT_FOUND", "Adapter route was not found.");
  } catch (error) {
    const status = error instanceof AdapterHttpError ? error.status : 500;
    const code = error instanceof AdapterHttpError ? error.code : "SERVER_ERROR";
    const message = error instanceof AdapterHttpError ? error.message : "Unexpected product adapter failure.";
    console.error(JSON.stringify({
      event: "adapter.error",
      request_id: signed?.requestId || "",
      code,
      status,
      error_name: error instanceof Error ? error.name : "UnknownError",
      error_message: String(error instanceof Error ? error.message : error).slice(0, 300),
    }));
    return adapterJson({ ok: false, error: code, message, request_id: signed?.requestId || "" }, status);
  }
}

/* ---------------- تحديد المحاولات ---------------- */

async function checkLock(db, key) {
  const row = await db.prepare("SELECT fails, locked_until FROM login_attempts WHERE key = ?").bind(key).first();
  if (row && row.locked_until > Date.now()) {
    return Math.ceil((row.locked_until - Date.now()) / 1000);
  }
  return 0;
}

async function noteFail(db, key) {
  const row = await db.prepare("SELECT fails FROM login_attempts WHERE key = ?").bind(key).first();
  const fails = (row ? row.fails : 0) + 1;
  let lockedUntil = 0;
  if (fails >= MAX_FAILS) {
    const step = Math.min(Math.floor(fails / MAX_FAILS) - 1, LOCK_STEPS_MS.length - 1);
    lockedUntil = Date.now() + LOCK_STEPS_MS[step];
  }
  await db
    .prepare(
      `INSERT INTO login_attempts (key, fails, locked_until, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET fails = ?, locked_until = ?, updated_at = ?`
    )
    .bind(key, fails, lockedUntil, Date.now(), fails, lockedUntil, Date.now())
    .run();
}

async function clearFails(db, key) {
  await db.prepare("DELETE FROM login_attempts WHERE key = ?").bind(key).run();
}

/* ---------------- المصادقة ---------------- */

// يُرجع الجلسة أو null. هذه الدالة هي مصدر الحقيقة الوحيد
// لهوية الصيدلية — لا نثق أبداً بـ pharmacy_id القادم من المتصفح.
async function getSession(request, db) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const hash = await sha256b64(auth.slice(7));
  const s = await db
    .prepare("SELECT pharmacy_id, user_id, role, expires_at FROM sessions WHERE token_hash = ?")
    .bind(hash)
    .first();
  if (!s || s.expires_at < Date.now()) return null;
  return s;
}

async function isAdmin(request, db) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  const hash = await sha256b64(auth.slice(7));
  const s = await db.prepare("SELECT expires_at FROM admin_sessions WHERE token_hash = ?").bind(hash).first();
  return !!s && s.expires_at >= Date.now();
}

/* ---------------- المزامنة ---------------- */

// جدول القيود: أي عملية غير مدرجة هنا تُرفض.
// الدور يأتي من الجلسة لا من الحمولة.
const SYNC_RULES = {
  upsert_product: ["owner", "pharmacist"],
  upsert_batch: ["owner", "pharmacist"],
  stock_move: ["owner", "pharmacist", "cashier"],
  create_invoice: ["owner", "pharmacist", "cashier"],
  void_invoice: ["owner"],
  upsert_customer: ["owner", "pharmacist", "cashier"],
  create_payment: ["owner", "pharmacist", "cashier"],
  upsert_settings: ["owner"],
  upsert_user: ["owner"],
  delete_user: ["owner"],
  audit: ["owner", "pharmacist", "cashier"],
};

const num = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
const str = (v, max = 200) => (v == null ? null : String(v).slice(0, max));

async function applyAction(db, session, act) {
  const ph = session.pharmacy_id; // ← دائماً من الجلسة
  const now = Date.now();
  const p = act.payload || {};
  const allowed = SYNC_RULES[act.action];
  if (!allowed) return { id: act.id, ok: false, error: "UNKNOWN_ACTION" };
  if (!allowed.includes(session.role)) return { id: act.id, ok: false, error: "FORBIDDEN" };

  switch (act.action) {
    case "upsert_product":
      await db
        .prepare(
          `INSERT INTO products (id, pharmacy_id, name, barcode, category, is_deleted, updated_at)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET name=excluded.name, barcode=excluded.barcode,
             category=excluded.category, is_deleted=excluded.is_deleted, updated_at=excluded.updated_at
           WHERE excluded.updated_at > products.updated_at`
        )
        .bind(str(p.id), ph, str(p.name), str(p.barcode, 64), str(p.category, 64), num(p.is_deleted), now)
        .run();
      return { id: act.id, ok: true };

    case "upsert_batch":
      await db
        .prepare(
          `INSERT INTO batches (id, pharmacy_id, product_id, batch_number, expiry_end,
             sell_price_agorot, cost_price_agorot, qty_snapshot, is_deleted, updated_at)
           VALUES (?,?,?,?,?,?,?,0,?,?)
           ON CONFLICT(id) DO UPDATE SET batch_number=excluded.batch_number,
             expiry_end=excluded.expiry_end, sell_price_agorot=excluded.sell_price_agorot,
             cost_price_agorot=excluded.cost_price_agorot, is_deleted=excluded.is_deleted,
             updated_at=excluded.updated_at
           WHERE excluded.updated_at > batches.updated_at`
        )
        .bind(
          str(p.id), ph, str(p.product_id), str(p.batch_number, 64), num(p.expiry_end),
          num(p.sell_price_agorot), num(p.cost_price_agorot), num(p.is_deleted), now
        )
        .run();
      return { id: act.id, ok: true };

    case "stock_move": {
      // معرّف الحركة فريد من الجهاز ⇒ إعادة الإرسال لا تُضاعف الأثر
      const exists = await db.prepare("SELECT id FROM stock_moves WHERE id = ?").bind(str(p.id)).first();
      if (exists) return { id: act.id, ok: true, dup: true };
      await db.batch([
        db
          .prepare(
            `INSERT INTO stock_moves (id, pharmacy_id, batch_id, delta, reason, ref_id, device_id, user_id, at)
             VALUES (?,?,?,?,?,?,?,?,?)`
          )
          .bind(str(p.id), ph, str(p.batch_id), num(p.delta), str(p.reason, 40), str(p.ref_id),
                str(p.device_id, 40), session.user_id, num(p.at) || now),
        db
          .prepare("UPDATE batches SET qty_snapshot = qty_snapshot + ?, updated_at = ? WHERE id = ? AND pharmacy_id = ?")
          .bind(num(p.delta), now, str(p.batch_id), ph),
      ]);
      return { id: act.id, ok: true };
    }

    case "create_invoice": {
      const exists = await db.prepare("SELECT id FROM invoices WHERE id = ?").bind(str(p.id)).first();
      if (exists) return { id: act.id, ok: true, dup: true };
      await db
        .prepare(
          `INSERT INTO invoices (id, pharmacy_id, invoice_number, total_agorot, user_id, cashier_name,
             customer_id, payment_type, items_json, is_voided, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`
        )
        .bind(
          str(p.id), ph, str(p.invoice_number, 64), num(p.total_agorot), session.user_id,
          str(p.cashier_name), str(p.customer_id), str(p.payment_type, 20),
          str(p.items_json, 100000), num(p.created_at) || now, now
        )
        .run();
      return { id: act.id, ok: true };
    }

    case "void_invoice":
      await db
        .prepare("UPDATE invoices SET is_voided = 1, void_reason = ?, updated_at = ? WHERE id = ? AND pharmacy_id = ?")
        .bind(str(p.void_reason, 300), now, str(p.id), ph)
        .run();
      return { id: act.id, ok: true };

    case "upsert_customer":
      await db
        .prepare(
          `INSERT INTO customers (id, pharmacy_id, name, phone, debt_agorot, is_deleted, updated_at)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone,
             debt_agorot=excluded.debt_agorot, is_deleted=excluded.is_deleted, updated_at=excluded.updated_at
           WHERE excluded.updated_at > customers.updated_at`
        )
        .bind(str(p.id), ph, str(p.name), str(p.phone, 40), num(p.debt_agorot), num(p.is_deleted), now)
        .run();
      return { id: act.id, ok: true };

    case "create_payment": {
      const exists = await db.prepare("SELECT id FROM payments WHERE id = ?").bind(str(p.id)).first();
      if (exists) return { id: act.id, ok: true, dup: true };
      await db
        .prepare(
          `INSERT INTO payments (id, pharmacy_id, customer_id, amount_agorot, user_id, at, updated_at)
           VALUES (?,?,?,?,?,?,?)`
        )
        .bind(str(p.id), ph, str(p.customer_id), num(p.amount_agorot), session.user_id, num(p.at) || now, now)
        .run();
      return { id: act.id, ok: true };
    }

    case "upsert_settings":
      await db
        .prepare(
          `INSERT INTO settings (pharmacy_id, name, phone, address, currency, updated_at)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(pharmacy_id) DO UPDATE SET name=excluded.name, phone=excluded.phone,
             address=excluded.address, currency=excluded.currency, updated_at=excluded.updated_at`
        )
        .bind(ph, str(p.name), str(p.phone, 40), str(p.address, 300), str(p.currency, 8), now)
        .run();
      return { id: act.id, ok: true };

    case "upsert_user": {
      // المالك لا يُنشأ من هنا أبداً — فقط من لوحة المدير.
      const role = ["pharmacist", "cashier"].includes(p.role) ? p.role : "cashier";
      if (!p.pin || !/^\d{4,8}$/.test(String(p.pin))) return { id: act.id, ok: false, error: "BAD_PIN" };
      const salt = newSalt();
      const hash = await derivePin(String(p.pin), salt);
      await db
        .prepare(
          `INSERT INTO users (id, pharmacy_id, name, role, pin_hash, pin_salt, is_active, updated_at)
           VALUES (?,?,?,?,?,?,1,?)
           ON CONFLICT(id) DO UPDATE SET name=excluded.name, role=excluded.role,
             pin_hash=excluded.pin_hash, pin_salt=excluded.pin_salt, updated_at=excluded.updated_at`
        )
        .bind(str(p.id), ph, str(p.name), role, hash, salt, now)
        .run();
      return { id: act.id, ok: true };
    }

    case "delete_user":
      // التعطيل يجب أن يُبطل الجلسات القائمة فوراً، وإلا بقي توكن الموظف
      // المسحوبة صلاحيته صالحاً حتى انتهائه (٧ أيام).
      await db.batch([
        db.prepare("UPDATE users SET is_active = 0, updated_at = ? WHERE id = ? AND pharmacy_id = ? AND role != 'owner'")
          .bind(now, str(p.id), ph),
        db.prepare("DELETE FROM sessions WHERE user_id = ? AND pharmacy_id = ?")
          .bind(str(p.id), ph),
      ]);
      return { id: act.id, ok: true };

    case "audit":
      await db
        .prepare(
          `INSERT OR IGNORE INTO audit_log (id, pharmacy_id, at, user_id, user_name, action, entity, entity_id, detail)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .bind(str(p.id), ph, num(p.at) || now, session.user_id, str(p.user_name),
              str(p.action, 60), str(p.entity, 40), str(p.entity_id), str(p.detail, 1000))
        .run();
      return { id: act.id, ok: true };
  }
  return { id: act.id, ok: false, error: "UNHANDLED" };
}

/* ============================================================
 *                        المسارات
 * ============================================================ */

/**
 * يكتب اسم الصيدلية في الصفحة قبل إرسالها.
 *
 * الرابط يُرسَل على واتساب، والزاحف الذي يبني المعاينة لا يشغّل جافاسكربت —
 * فالتعديل بعد التحميل لا يصل إليه. وكان كل رابط يُعرض باسم «PharmaGaza»
 * مهما كان اسم الصيدلية.
 *
 * وبصمة الأصول تُنزَع: تحسبها الطبقة على الملف الأصلي **قبل** الوسم، فهي
 * نفسها لكل الصيدليات — والمتصفّح يعيد التحقّق فيأخذ 304 ويُعيد نسخته
 * القديمة، فصيدلية تُغيّر اسمها لا ترى الجديد أبدًا.
 */
function brandPharmacyPage(response, pharmacy) {
  const title = `${pharmacy.name} — نظام إدارة الصيدلية`;
  const headers = new Headers(response.headers);
  headers.delete("ETag");
  headers.delete("Last-Modified");
  headers.set("Cache-Control", "private, no-store");
  const fresh = new Response(response.body, { status: response.status, headers });

  return new HTMLRewriter()
    .on("title", { element(node) { node.setInnerContent(title); } })
    .on('meta[name="description"]', { element(node) { node.setAttribute("content", title); } })
    .on('meta[property="og:title"]', { element(node) { node.setAttribute("content", pharmacy.name); } })
    .on('meta[property="og:description"]', { element(node) { node.setAttribute("content", title); } })
    .on("html", { element(node) { node.setAttribute("data-pharmacy-name", pharmacy.name); } })
    // العنوان المرئي في شاشة الدخول أيضًا: كان محفورًا «PharmaGaza»، فيفتح
    // الصيدلاني رابطه فيقرأ اسم منتجٍ لا اسم صيدليته. ويُكتب هنا لا
    // بجافاسكربت، كي يصل قبل أي تحميل ويظهر للزاحف كما يظهر للزائر.
    .on("#login-brand", { element(node) { node.setInnerContent(pharmacy.name); } })
    .transform(fresh);
}

/**
 * كعكة الصيدلية.
 *
 * ليست سرًّا ولا تمنح صلاحية — الرمز نفسه ظاهر في الرابط. مهمّتها أن تتذكّر
 * الصفحة أيّ صيدلية تخدم حين يفتح صاحبها رابطًا بلا `?pharmacy=`.
 */
function pharmacyCookie(code, url) {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `pharmacy_code=${encodeURIComponent(code)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}

function readPharmacyCookie(request) {
  const jar = request.headers.get("Cookie") || "";
  const match = jar.match(/(?:^|;\s*)pharmacy_code=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const H = corsHeaders(request, env);
    const db = env.DB;

    if (url.pathname.startsWith("/internal/v1/")) {
      return handleAtharAdapter(request, env);
    }

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: H });

    try {
      /* ---------- تسجيل دخول الصيدلية ---------- */
      if (url.pathname === "/api/login" && request.method === "POST") {
        const { pharmacy_id, pin, device_id } = await request.json();
        if (!pharmacy_id || !pin) return json({ error: "BAD_REQUEST" }, 400, H);

        const ip = request.headers.get("CF-Connecting-IP") || "0";
        const lockKey = `${pharmacy_id}|${ip}`;
        const locked = await checkLock(db, lockKey);
        if (locked) return json({ error: "LOCKED", seconds: locked }, 429, H);

        const pharmacy = await db
          .prepare("SELECT pharmacy_id, is_active FROM pharmacies WHERE pharmacy_id = ?")
          .bind(pharmacy_id)
          .first();
        if (!pharmacy) {
          await noteFail(db, lockKey);
          return json({ error: "INVALID_CREDENTIALS" }, 401, H);
        }
        if (!pharmacy.is_active) return json({ error: "SUBSCRIPTION_SUSPENDED" }, 403, H);

        const users = await db
          .prepare("SELECT id, name, role, pin_hash, pin_salt FROM users WHERE pharmacy_id = ? AND is_active = 1")
          .bind(pharmacy_id)
          .all();

        let match = null;
        for (const u of users.results || []) {
          const h = await derivePin(String(pin), u.pin_salt);
          if (safeEqual(h, u.pin_hash)) { match = u; break; }
        }
        if (!match) {
          await noteFail(db, lockKey);
          return json({ error: "INVALID_CREDENTIALS" }, 401, H);
        }
        await clearFails(db, lockKey);

        const token = newToken();
        const expires = Date.now() + SESSION_TTL_MS;
        await db
          .prepare(
            `INSERT INTO sessions (token_hash, pharmacy_id, user_id, role, device_id, created_at, expires_at)
             VALUES (?,?,?,?,?,?,?)`
          )
          .bind(await sha256b64(token), pharmacy_id, match.id, match.role, str(device_id, 40), Date.now(), expires)
          .run();

        const settings = await db.prepare("SELECT * FROM settings WHERE pharmacy_id = ?").bind(pharmacy_id).first();

        return json(
          {
            token,
            expires_at: expires,
            user: { id: match.id, name: match.name, role: match.role },
            settings: settings || { pharmacy_id, name: "صيدلية", phone: "", address: "", currency: "₪" },
          },
          200, H
        );
      }

      /* ---------- خروج ---------- */
      if (url.pathname === "/api/logout" && request.method === "POST") {
        const auth = request.headers.get("Authorization") || "";
        if (auth.startsWith("Bearer ")) {
          await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256b64(auth.slice(7))).run();
        }
        return json({ ok: true }, 200, H);
      }

      /* ---------- رفع التغييرات ---------- */
      if (url.pathname === "/api/sync" && request.method === "POST") {
        const session = await getSession(request, db);
        if (!session) return json({ error: "UNAUTHORIZED" }, 401, H);

        const active = await db
          .prepare("SELECT is_active FROM pharmacies WHERE pharmacy_id = ?")
          .bind(session.pharmacy_id)
          .first();
        if (!active || !active.is_active) return json({ error: "SUBSCRIPTION_SUSPENDED" }, 403, H);

        const { actions } = await request.json();
        if (!Array.isArray(actions)) return json({ error: "BAD_REQUEST" }, 400, H);

        const results = [];
        for (const act of actions.slice(0, 500)) {
          try {
            results.push(await applyAction(db, session, act));
          } catch (e) {
            results.push({ id: act.id, ok: false, error: String(e).slice(0, 200) });
          }
        }
        return json({ results, server_time: Date.now() }, 200, H);
      }

      /* ---------- سحب التحديثات ---------- */
      if (url.pathname === "/api/get-updates" && request.method === "GET") {
        const session = await getSession(request, db);
        if (!session) return json({ error: "UNAUTHORIZED" }, 401, H);

        const ph = session.pharmacy_id;                       // ← من الجلسة، لا من الرابط
        const since = num(url.searchParams.get("last_sync"));
        const deviceId = url.searchParams.get("device_id") || "";
        const now = Date.now();

        const q = (sql, ...b) => db.prepare(sql).bind(...b).all();

        const [products, batches, customers, invoices, payments, users, settings] = await Promise.all([
          q("SELECT * FROM products   WHERE pharmacy_id = ? AND updated_at > ? LIMIT 2000", ph, since),
          q("SELECT * FROM batches    WHERE pharmacy_id = ? AND updated_at > ? LIMIT 2000", ph, since),
          q("SELECT * FROM customers  WHERE pharmacy_id = ? AND updated_at > ? LIMIT 2000", ph, since),
          q("SELECT * FROM invoices   WHERE pharmacy_id = ? AND updated_at > ? LIMIT 1000", ph, since),
          q("SELECT * FROM payments   WHERE pharmacy_id = ? AND updated_at > ? LIMIT 1000", ph, since),
          q("SELECT id, name, role, is_active, updated_at FROM users WHERE pharmacy_id = ? AND updated_at > ?", ph, since),
          db.prepare("SELECT * FROM settings WHERE pharmacy_id = ?").bind(ph).first(),
        ]);

        // الحركات من الأجهزة الأخرى فقط — حركاتنا مطبّقة محلياً أصلاً
        const moves = await db
          .prepare("SELECT * FROM stock_moves WHERE pharmacy_id = ? AND at > ? AND IFNULL(device_id,'') != ? ORDER BY at LIMIT 3000")
          .bind(ph, since, deviceId)
          .all();

        return json(
          {
            first_sync: since === 0,
            products: products.results || [],
            batches: batches.results || [],
            moves: moves.results || [],
            customers: customers.results || [],
            invoices: invoices.results || [],
            payments: payments.results || [],
            users: users.results || [],
            settings: settings || null,
            server_time: now,
          },
          200, H
        );
      }

      /* ================= لوحة المدير ================= */

      if (url.pathname === "/api/admin/login" && request.method === "POST") {
        const { password } = await request.json();
        const expected = env.ADMIN_PASSWORD;
        if (!expected) return json({ error: "ADMIN_PASSWORD_NOT_SET" }, 500, H);

        const ip = request.headers.get("CF-Connecting-IP") || "0";
        const lockKey = `admin|${ip}`;
        const locked = await checkLock(db, lockKey);
        if (locked) return json({ error: "LOCKED", seconds: locked }, 429, H);

        // نقارن التجزئتين لا النصين: زمن ثابت وطول ثابت
        const ok = safeEqual(await sha256b64(String(password || "")), await sha256b64(expected));
        if (!ok) {
          await noteFail(db, lockKey);
          return json({ error: "UNAUTHORIZED" }, 401, H);
        }
        await clearFails(db, lockKey);

        const token = newToken();
        const expires = Date.now() + ADMIN_TTL_MS;
        await db
          .prepare("INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?,?,?)")
          .bind(await sha256b64(token), Date.now(), expires)
          .run();
        return json({ token, expires_at: expires }, 200, H);
      }

      if (url.pathname.startsWith("/api/admin/")) {
        if (!(await isAdmin(request, db))) return json({ error: "UNAUTHORIZED" }, 401, H);

        /**
         * الصيدلية التي أنشأتها لوحة أثر تُدار من أثر وحدها.
         * الحذف من هنا كان يمحو الصف بينما تبقى أثر تظنها نشطة، فتفشل كل
         * عملية لاحقة بـTENANT_NOT_FOUND بلا مخرج. لوحتان تحكمان البيانات
         * نفسها تعنيان انحرافًا مؤكدًا لا احتمال انحراف.
         */
        const atharManaged = async (pharmacyId) => {
          const row = await db
            .prepare("SELECT control_tenant_id FROM pharmacies WHERE pharmacy_id = ?")
            .bind(String(pharmacyId || ""))
            .first();
          return Boolean(row && String(row.control_tenant_id || ""));
        };
        const managedError = () => json({
          error: "MANAGED_BY_ATHAR",
          message: "هذه الصيدلية تُدار من لوحة أثر. نفّذ العملية من هناك.",
        }, 409, H);

        if (url.pathname === "/api/admin/pharmacies" && request.method === "GET") {
          const rows = await db
            .prepare(
              `SELECT p.pharmacy_id, p.name, p.phone, p.address, p.currency, p.is_active, p.created_at,
                      (SELECT COUNT(*) FROM users u WHERE u.pharmacy_id = p.pharmacy_id AND u.is_active = 1) AS users_count
               FROM pharmacies p ORDER BY p.created_at DESC`
            )
            .all();
          return json(rows.results || [], 200, H);
        }

        if (url.pathname === "/api/admin/create-pharmacy" && request.method === "POST") {
          const { pharmacy_id, name, phone, address, currency, owner_pin } = await request.json();
          if (!/^[A-Za-z0-9_-]{3,32}$/.test(String(pharmacy_id || "")))
            return json({ error: "BAD_ID" }, 400, H);
          if (!/^\d{4,8}$/.test(String(owner_pin || ""))) return json({ error: "BAD_PIN" }, 400, H);

          const salt = newSalt();
          const hash = await derivePin(String(owner_pin), salt);
          const now = Date.now();
          await db.batch([
            db.prepare(
                `INSERT INTO pharmacies (pharmacy_id, name, phone, address, currency, is_active, created_at, updated_at)
                 VALUES (?,?,?,?,?,1,?,?)`
              ).bind(pharmacy_id, str(name), str(phone, 40), str(address, 300), str(currency, 8) || "₪", now, now),
            db.prepare(
                `INSERT INTO settings (pharmacy_id, name, phone, address, currency, updated_at)
                 VALUES (?,?,?,?,?,?)`
              ).bind(pharmacy_id, str(name), str(phone, 40), str(address, 300), str(currency, 8) || "₪", now),
            db.prepare(
                `INSERT INTO users (id, pharmacy_id, name, role, pin_hash, pin_salt, is_active, updated_at)
                 VALUES (?,?,?,'owner',?,?,1,?)`
              ).bind("owner_" + pharmacy_id, pharmacy_id, "المالك", hash, salt, now),
          ]);
          return json({ ok: true }, 200, H);
        }

        if (url.pathname === "/api/admin/set-status" && request.method === "POST") {
          const { pharmacy_id, is_active } = await request.json();
          // حالة الاشتراك يملكها سجل أثر التجاري؛ تغييرها هنا يجعل اللوحتين تتناقضان.
          if (await atharManaged(pharmacy_id)) return managedError();
          await db
            .prepare("UPDATE pharmacies SET is_active = ?, updated_at = ? WHERE pharmacy_id = ?")
            .bind(is_active ? 1 : 0, Date.now(), pharmacy_id)
            .run();
          // إيقاف الاشتراك يُبطل الجلسات القائمة فوراً
          if (!is_active) {
            await db.prepare("DELETE FROM sessions WHERE pharmacy_id = ?").bind(pharmacy_id).run();
          }
          return json({ ok: true }, 200, H);
        }

        if (url.pathname === "/api/admin/reset-pin" && request.method === "POST") {
          const { pharmacy_id, new_pin } = await request.json();
          if (!/^\d{4,8}$/.test(String(new_pin || ""))) return json({ error: "BAD_PIN" }, 400, H);
          const salt = newSalt();
          const hash = await derivePin(String(new_pin), salt);
          await db
            .prepare("UPDATE users SET pin_hash = ?, pin_salt = ?, updated_at = ? WHERE pharmacy_id = ? AND role = 'owner'")
            .bind(hash, salt, Date.now(), pharmacy_id)
            .run();
          await db.prepare("DELETE FROM sessions WHERE pharmacy_id = ?").bind(pharmacy_id).run();
          return json({ ok: true }, 200, H);
        }

        if (url.pathname === "/api/admin/delete-pharmacy" && request.method === "POST") {
          const { pharmacy_id, confirm } = await request.json();
          // تأكيد مزدوج: يجب أن يطابق النص رمز الصيدلية حرفياً
          if (confirm !== pharmacy_id) return json({ error: "CONFIRM_MISMATCH" }, 400, H);
          if (await atharManaged(pharmacy_id)) return managedError();
          const tables = ["users", "sessions", "products", "batches", "stock_moves", "customers",
                          "payments", "invoices", "audit_log", "settings"];
          await db.batch([
            ...tables.map((t) => db.prepare(`DELETE FROM ${t} WHERE pharmacy_id = ?`).bind(pharmacy_id)),
            db.prepare("DELETE FROM pharmacies WHERE pharmacy_id = ?").bind(pharmacy_id),
          ]);
          return json({ ok: true }, 200, H);
        }

        return json({ error: "NOT_FOUND" }, 404, H);
      }

      // ما ليس `/api` ولا `/internal` فهو أصل: الصفحة أو ملفاتها.
      //
      // كل الطلبات تمرّ بالـWorker الآن (`run_worker_first: true`)، فيطلب
      // الأصول بنفسه ويكتب هوية الصيدلية في الصفحة قبل إرسالها.
      if (!url.pathname.startsWith("/api/")) {
        if (!env.ASSETS) return json({ error: "ASSETS_NOT_BOUND" }, 500, H);
        const asset = await env.ASSETS.fetch(request);

        const code = (url.searchParams.get("pharmacy") || readPharmacyCookie(request) || "").trim();
        const isHtml = (asset.headers.get("Content-Type") || "").includes("text/html");
        if (code && isHtml && asset.ok) {
          const pharmacy = await db
            .prepare("SELECT name FROM pharmacies WHERE pharmacy_id = ?")
            .bind(code.slice(0, 80))
            .first();
          // صيدلية مجهولة تُترك بلا تعديل: كتابة اسم فارغ أسوأ من الافتراضي.
          if (pharmacy?.name) {
            const branded = brandPharmacyPage(asset, pharmacy);
            const headers = new Headers(branded.headers);
            headers.append("Set-Cookie", pharmacyCookie(code.slice(0, 80), url));
            return new Response(branded.body, { status: branded.status, headers });
          }
        }
        return asset;
      }

      return json({ error: "NOT_FOUND" }, 404, H);
    } catch (e) {
      return json({ error: "SERVER_ERROR", detail: String(e).slice(0, 300) }, 500, H);
    }
  },

  // تنظيف دوري للجلسات المنتهية (اختياري — يحتاج Cron Trigger)
  async scheduled(event, env) {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
      env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at < ?").bind(now),
      env.DB.prepare("DELETE FROM login_attempts WHERE locked_until < ? AND updated_at < ?").bind(now, now - 86400000),
    ]);
  },
};
