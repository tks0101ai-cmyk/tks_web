ALTER TABLE purchase_settings
  ADD COLUMN IF NOT EXISTS waiting_freight_mode TEXT NOT NULL DEFAULT 'formula' CHECK (waiting_freight_mode IN ('manual','formula')),
  ADD COLUMN IF NOT EXISTS waiting_freight NUMERIC CHECK (waiting_freight IS NULL OR waiting_freight >= 0),
  ADD COLUMN IF NOT EXISTS waiting_freight_formula TEXT,
  ADD COLUMN IF NOT EXISTS waiting_freight_base NUMERIC NOT NULL DEFAULT 202000000 CHECK (waiting_freight_base >= 0),
  ADD COLUMN IF NOT EXISTS waiting_freight_capacity NUMERIC NOT NULL DEFAULT 170 CHECK (waiting_freight_capacity > 0),
  ADD COLUMN IF NOT EXISTS waiting_assumed_m3 NUMERIC CHECK (waiting_assumed_m3 IS NULL OR waiting_assumed_m3 > 0),
  ADD COLUMN IF NOT EXISTS waiting_container_fx_rate NUMERIC CHECK (waiting_container_fx_rate IS NULL OR waiting_container_fx_rate > 0),
  ADD COLUMN IF NOT EXISTS waiting_version INTEGER NOT NULL DEFAULT 1 CHECK (waiting_version > 0);
