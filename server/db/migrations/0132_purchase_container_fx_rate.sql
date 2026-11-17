ALTER TABLE product_containers
  ADD COLUMN IF NOT EXISTS container_fx_rate NUMERIC
  CHECK (container_fx_rate IS NULL OR container_fx_rate > 0);
