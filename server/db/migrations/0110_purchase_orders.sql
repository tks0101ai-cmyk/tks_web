-- Thu mua. Additive only: no seed/cutover; Sheets remains the writer by default.
-- No branch on purchase rows: HN buys; SG receives transfers (explicit business exception).
-- product_containers is the canonical SHARED container, not a second purchase-only container.
CREATE TABLE IF NOT EXISTS purchase_settings (
 id SMALLINT PRIMARY KEY CHECK(id=1), source_mode TEXT NOT NULL DEFAULT 'sheets' CHECK(source_mode IN ('sheets','web'))
);
INSERT INTO purchase_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE SEQUENCE IF NOT EXISTS purchase_order_key_seq;
CREATE TABLE IF NOT EXISTS product_containers (
 id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL CHECK(btrim(name)<>''),
 name_key TEXT NOT NULL UNIQUE, status SMALLINT NOT NULL DEFAULT 1 CHECK(status BETWEEN 1 AND 4),
 truck_name TEXT NOT NULL DEFAULT '', max_ton NUMERIC NOT NULL DEFAULT 32 CHECK(max_ton>0),
 m3_min NUMERIC NOT NULL DEFAULT 160, m3_max NUMERIC NOT NULL DEFAULT 170 CHECK(m3_max>=m3_min),
 freight NUMERIC CHECK(freight>=0), carrier TEXT NOT NULL DEFAULT '', loader TEXT NOT NULL DEFAULT '',
 name_cn TEXT NOT NULL DEFAULT '', loading TEXT NOT NULL DEFAULT '', arrival_note TEXT NOT NULL DEFAULT '',
 arrival_date DATE, arrival_warehouse TEXT, arrival_by TEXT,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS purchase_orders (
 id BIGSERIAL PRIMARY KEY, row_key TEXT NOT NULL UNIQUE CHECK(row_key ~ '^D[0-9]{5,}(\.(01|02))*$'),
 root_key TEXT NOT NULL CHECK(root_key ~ '^D[0-9]{5,}$'), split_from_key TEXT, container_id BIGINT REFERENCES product_containers(id),
  product_code TEXT,
  product_name TEXT,
  product_name_cn TEXT,
  supplier TEXT,
  color TEXT,
  sale_note TEXT,
  vat_note TEXT,
  buy_note TEXT,
  buyer TEXT,
  payment_note TEXT,
  listed_at TIMESTAMP WITHOUT TIME ZONE,
  ordered_note TEXT,
  shipped_note TEXT,
  eta_note TEXT,
  arrived_note TEXT,
  qty_per_carton NUMERIC NOT NULL CHECK (qty_per_carton >= 0),
  carton_count NUMERIC NOT NULL CHECK (carton_count >= 0),
  unit_price_cny NUMERIC CHECK (unit_price_cny >= 0),
  freight_prepaid NUMERIC CHECK (freight_prepaid >= 0),
  fx_rate NUMERIC CHECK (fx_rate >= 0),
  freight_postpaid NUMERIC CHECK (freight_postpaid >= 0),
  kg_per_carton NUMERIC CHECK (kg_per_carton >= 0),
  m3_per_carton NUMERIC CHECK (m3_per_carton >= 0),
  freight_amount NUMERIC CHECK (freight_amount >= 0),
  tax_amount NUMERIC CHECK (tax_amount >= 0),
  extra_note TEXT,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(split_part(row_key,'.',1)=root_key),
 CHECK(split_from_key IS NULL OR row_key=split_from_key||'.01' OR row_key=split_from_key||'.02'),
 CHECK(product_code IS NOT NULL AND btrim(product_code)<>''), CHECK(product_name IS NOT NULL AND btrim(product_name)<>''),
 CHECK(qty_per_carton>0 AND qty_per_carton=trunc(qty_per_carton)), CHECK(carton_count>0 AND carton_count=trunc(carton_count))
);
CREATE INDEX IF NOT EXISTS purchase_orders_container_idx ON purchase_orders(container_id,id);
CREATE INDEX IF NOT EXISTS purchase_orders_root_idx ON purchase_orders(root_key,id);
CREATE INDEX IF NOT EXISTS purchase_orders_latest_idx ON purchase_orders(lower(product_code),listed_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS purchase_key_history (
 row_key TEXT PRIMARY KEY, order_id BIGINT NOT NULL, root_key TEXT NOT NULL, retired_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS purchase_history (
 id BIGSERIAL PRIMARY KEY, action TEXT NOT NULL, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL,
 summary JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS purchase_departures (
 id BIGSERIAL PRIMARY KEY, container_id BIGINT NOT NULL REFERENCES product_containers(id),
 snapshot JSONB NOT NULL, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS purchase_import_previews (
 token UUID PRIMARY KEY, actor_id TEXT NOT NULL, payload JSONB NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '30 minutes', result JSONB
);
-- Ephemeral, per-connection leases; never stores filters or drafts.
CREATE TABLE IF NOT EXISTS purchase_presence (
 connection_id UUID PRIMARY KEY, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS purchase_presence_expiry_idx ON purchase_presence(expires_at);
CREATE OR REPLACE FUNCTION purchase_immutable_guard() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'Purchase audit records are immutable'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS purchase_history_guard ON purchase_history;
CREATE TRIGGER purchase_history_guard BEFORE UPDATE OR DELETE ON purchase_history FOR EACH ROW EXECUTE FUNCTION purchase_immutable_guard();
DROP TRIGGER IF EXISTS purchase_departures_guard ON purchase_departures;
CREATE TRIGGER purchase_departures_guard BEFORE UPDATE OR DELETE ON purchase_departures FOR EACH ROW EXECUTE FUNCTION purchase_immutable_guard();
DROP TRIGGER IF EXISTS purchase_keys_guard ON purchase_key_history;
CREATE TRIGGER purchase_keys_guard BEFORE UPDATE OR DELETE ON purchase_key_history FOR EACH ROW EXECUTE FUNCTION purchase_immutable_guard();
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='reporting_readonly') THEN
REVOKE ALL ON product_containers,purchase_orders,purchase_history,purchase_departures,purchase_key_history,purchase_import_previews,purchase_settings,purchase_presence FROM reporting_readonly;
END IF; END $$;
