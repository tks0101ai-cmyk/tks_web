-- Retire stale purchase rows without deleting their audit/history or key.
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS inactive_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS purchase_orders_inactive_idx
  ON purchase_orders(inactive_at DESC)
  WHERE inactive_at IS NOT NULL AND deleted_at IS NULL;
