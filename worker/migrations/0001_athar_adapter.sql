-- Athar Media control-plane adapter metadata.
-- Apply once to an existing Pharma Gaza D1 database before deploying the adapter code.

ALTER TABLE pharmacies ADD COLUMN control_tenant_id TEXT;
ALTER TABLE pharmacies ADD COLUMN environment TEXT NOT NULL DEFAULT 'production';
ALTER TABLE pharmacies ADD COLUMN plan_code TEXT NOT NULL DEFAULT '';
ALTER TABLE pharmacies ADD COLUMN trial_expires_at TEXT;
ALTER TABLE pharmacies ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE pharmacies ADD COLUMN provisioned_at INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pharmacies_control_tenant
  ON pharmacies(control_tenant_id)
  WHERE control_tenant_id IS NOT NULL AND control_tenant_id != '';

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
