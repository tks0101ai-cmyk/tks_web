-- Store the planned container volume separately from the live volume of assigned rows.
ALTER TABLE product_containers
  ADD COLUMN IF NOT EXISTS assumed_m3 NUMERIC
  CHECK (assumed_m3 IS NULL OR assumed_m3 > 0);
