ALTER TABLE product_containers
  ADD COLUMN IF NOT EXISTS money_match_status TEXT
  CHECK (money_match_status IS NULL OR money_match_status IN ('matched','unmatched'));
