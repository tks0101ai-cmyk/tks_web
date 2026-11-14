-- Replace the legacy absolute tax amount with a percentage based surcharge.
ALTER TABLE purchase_orders
  DROP COLUMN IF EXISTS tax_amount,
  ADD COLUMN IF NOT EXISTS surcharge_percent NUMERIC CHECK (surcharge_percent IS NULL OR surcharge_percent >= 0);
