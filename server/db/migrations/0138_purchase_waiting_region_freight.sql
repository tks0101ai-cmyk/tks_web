-- 0137 was already applied on some databases before the assumed-volume and
-- FX columns were added to that migration file. Add them here as well so this
-- migration can safely upgrade those databases without rewriting 0137.
ALTER TABLE purchase_settings
  ADD COLUMN IF NOT EXISTS waiting_assumed_m3 NUMERIC CHECK (waiting_assumed_m3 IS NULL OR waiting_assumed_m3 > 0),
  ADD COLUMN IF NOT EXISTS waiting_container_fx_rate NUMERIC CHECK (waiting_container_fx_rate IS NULL OR waiting_container_fx_rate > 0);

CREATE TABLE IF NOT EXISTS purchase_waiting_configs (
  region_id BIGINT PRIMARY KEY REFERENCES purchase_regions(id) ON DELETE CASCADE,
  freight_mode TEXT NOT NULL DEFAULT 'formula' CHECK (freight_mode IN ('manual','formula')),
  freight NUMERIC CHECK (freight IS NULL OR freight >= 0),
  freight_formula TEXT,
  freight_base NUMERIC NOT NULL DEFAULT 202000000 CHECK (freight_base >= 0),
  freight_capacity NUMERIC NOT NULL DEFAULT 170 CHECK (freight_capacity > 0),
  assumed_m3 NUMERIC CHECK (assumed_m3 IS NULL OR assumed_m3 > 0),
  container_fx_rate NUMERIC CHECK (container_fx_rate IS NULL OR container_fx_rate > 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO purchase_waiting_configs (
  region_id, freight_mode, freight, freight_formula, freight_base,
  freight_capacity, assumed_m3, container_fx_rate, version
)
SELECT r.id, s.waiting_freight_mode, s.waiting_freight, s.waiting_freight_formula,
       s.waiting_freight_base, s.waiting_freight_capacity,
       s.waiting_assumed_m3, s.waiting_container_fx_rate, s.waiting_version
FROM purchase_regions r
CROSS JOIN purchase_settings s
WHERE s.id = 1
ON CONFLICT (region_id) DO NOTHING;
