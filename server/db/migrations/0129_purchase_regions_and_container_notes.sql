CREATE TABLE IF NOT EXISTS purchase_regions (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  name_key TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#2563EB' CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  is_active BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS region_id BIGINT REFERENCES purchase_regions(id) ON DELETE SET NULL;

ALTER TABLE product_containers
  ADD COLUMN IF NOT EXISTS region_id BIGINT REFERENCES purchase_regions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS purchase_orders_region_idx ON purchase_orders(region_id, id);
CREATE INDEX IF NOT EXISTS product_containers_region_idx ON product_containers(region_id, id);
