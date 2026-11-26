-- Free-form external order identifier entered by the purchase team.
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS order_code TEXT;
