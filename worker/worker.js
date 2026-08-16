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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const H = corsHeaders(request, env);
    const db = env.DB;

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
