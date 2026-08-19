-- Minimal pre-adapter schema used only by the local migration smoke test.
CREATE TABLE IF NOT EXISTS pharmacies (
  pharmacy_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  currency TEXT NOT NULL DEFAULT 'ILS',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
