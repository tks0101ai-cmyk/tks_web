-- Persist the Excel-style expression used to calculate each container's freight.
ALTER TABLE product_containers
  ADD COLUMN IF NOT EXISTS freight_formula TEXT
  CHECK (freight_formula IS NULL OR length(freight_formula) <= 512);
