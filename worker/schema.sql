-- ============================================================
-- PharmaGaza SaaS — مخطط قاعدة بيانات Cloudflare D1
-- الصق هذا الملف كاملاً في: D1 > pharma-db > Console > Apply
-- آمن للتشغيل أكثر من مرة (كل الأوامر IF NOT EXISTS).
-- ============================================================

-- ---------- الصيدليات (المستأجرون) ----------
CREATE TABLE IF NOT EXISTS pharmacies (
  pharmacy_id TEXT PRIMARY KEY,
  control_tenant_id TEXT,
  name        TEXT NOT NULL,
  phone       TEXT,
  address     TEXT,
  currency    TEXT NOT NULL DEFAULT '₪',
  is_active   INTEGER NOT NULL DEFAULT 1,
  environment TEXT NOT NULL DEFAULT 'production'
              CHECK (environment IN ('demo','production')),
  plan_code TEXT NOT NULL DEFAULT '',
  trial_expires_at TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'active'
                   CHECK (lifecycle_status IN ('active','suspended','archived')),
  provisioned_at INTEGER,
  created_at  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0
);

-- ---------- المستخدمون ----------
-- لا يوجد عمود pin نصي. الرقم السري يُخزَّن مجزّأً بملح فريد.
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  pharmacy_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('owner','pharmacist','cashier')),
  pin_hash    TEXT NOT NULL,
  pin_salt    TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_users_pharmacy ON users (pharmacy_id, updated_at);

-- ---------- الجلسات ----------
-- نخزّن تجزئة التوكن لا التوكن نفسه: تسريب القاعدة لا يمنح جلسات حيّة.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  pharmacy_id TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  role        TEXT NOT NULL,
  device_id   TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- ---------- تحديد محاولات الدخول ----------
CREATE TABLE IF NOT EXISTS login_attempts (
  key          TEXT PRIMARY KEY,
  fails        INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL DEFAULT 0
);

-- ---------- Athar Media product adapter idempotency ----------
CREATE TABLE IF NOT EXISTS adapter_requests (
  request_id     TEXT PRIMARY KEY,
  action         TEXT NOT NULL,
  tenant_id      TEXT NOT NULL,
  request_hash   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'succeeded', 'failed')),
  response_json  TEXT NOT NULL DEFAULT '{}',
  error_code     TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  completed_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_adapter_requests_tenant
  ON adapter_requests(tenant_id, created_at);

-- ---------- الكتالوج ----------
CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  pharmacy_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  barcode     TEXT,
  category    TEXT,
  is_deleted  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_products_ph ON products (pharmacy_id, updated_at);

-- الدفعات: كل المبالغ أعداد صحيحة بالأغورة (١ شيكل = ١٠٠).
-- qty_snapshot = مجموع كل الحركات، يُحدَّث عند كل حركة، ويُستخدم للمزامنة الأولى فقط.
CREATE TABLE IF NOT EXISTS batches (
  id                TEXT PRIMARY KEY,
  pharmacy_id       TEXT NOT NULL,
  product_id        TEXT NOT NULL,
  batch_number      TEXT,
  expiry_end        INTEGER NOT NULL DEFAULT 0,
  sell_price_agorot INTEGER NOT NULL DEFAULT 0,
  cost_price_agorot INTEGER NOT NULL DEFAULT 0,
  qty_snapshot      INTEGER NOT NULL DEFAULT 0,
  is_deleted        INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_batches_ph ON batches (pharmacy_id, updated_at);

-- ---------- حركات المخزون ----------
-- الكمية عدّاد لا قيمة تُستبدل. نزامن الحركات لا الأرصدة،
-- فيصبح الدمج غير معتمد على الترتيب ولا يضيع بيع جهاز آخر.
CREATE TABLE IF NOT EXISTS stock_moves (
  id          TEXT PRIMARY KEY,
  pharmacy_id TEXT NOT NULL,
  batch_id    TEXT NOT NULL,
  delta       INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  ref_id      TEXT,
  device_id   TEXT,
  user_id     TEXT,
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moves_ph ON stock_moves (pharmacy_id, at);

-- ---------- الزبائن والديون ----------
CREATE TABLE IF NOT EXISTS customers (
  id           TEXT PRIMARY KEY,
  pharmacy_id  TEXT NOT NULL,
  name         TEXT NOT NULL,
  phone        TEXT,
  debt_agorot  INTEGER NOT NULL DEFAULT 0,
  is_deleted   INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_customers_ph ON customers (pharmacy_id, updated_at);

CREATE TABLE IF NOT EXISTS payments (
  id            TEXT PRIMARY KEY,
  pharmacy_id   TEXT NOT NULL,
  customer_id   TEXT NOT NULL,
  amount_agorot INTEGER NOT NULL,
  user_id       TEXT,
  at            INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_payments_ph ON payments (pharmacy_id, updated_at);

-- ---------- الفواتير ----------
-- تحفظ الأصناف والبائع ونوع الدفع والزبون — لا المجاميع وحدها،
-- حتى تكون الاستعادة من السحابة استعادة حقيقية.
CREATE TABLE IF NOT EXISTS invoices (
  id             TEXT PRIMARY KEY,
  pharmacy_id    TEXT NOT NULL,
  invoice_number TEXT NOT NULL,
  total_agorot   INTEGER NOT NULL DEFAULT 0,
  user_id        TEXT,
  cashier_name   TEXT,
  customer_id    TEXT,
  payment_type   TEXT,
  items_json     TEXT,
  is_voided      INTEGER NOT NULL DEFAULT 0,
  void_reason    TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_invoices_ph ON invoices (pharmacy_id, created_at);

-- ---------- سجل التدقيق ----------
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  pharmacy_id TEXT NOT NULL,
  at          INTEGER NOT NULL,
  user_id     TEXT,
  user_name   TEXT,
  action      TEXT NOT NULL,
  entity      TEXT,
  entity_id   TEXT,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ph ON audit_log (pharmacy_id, at);

-- ---------- الإعدادات ----------
CREATE TABLE IF NOT EXISTS settings (
  pharmacy_id TEXT PRIMARY KEY,
  name        TEXT,
  phone       TEXT,
  address     TEXT,
  currency    TEXT DEFAULT '₪',
  updated_at  INTEGER NOT NULL DEFAULT 0
);
