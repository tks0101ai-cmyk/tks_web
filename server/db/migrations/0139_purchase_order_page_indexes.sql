-- Cover the active purchase grid's common page filters and sort orders.
CREATE INDEX IF NOT EXISTS purchase_orders_active_page_idx
  ON purchase_orders(container_id ASC NULLS FIRST, (split_from_key IS NOT NULL) DESC, split_from_key, id DESC)
  WHERE deleted_at IS NULL AND inactive_at IS NULL;

CREATE INDEX IF NOT EXISTS purchase_orders_active_listed_idx
  ON purchase_orders(listed_at DESC NULLS LAST, id DESC)
  WHERE deleted_at IS NULL AND inactive_at IS NULL;

CREATE INDEX IF NOT EXISTS purchase_orders_active_code_idx
  ON purchase_orders(product_code, id DESC)
  WHERE deleted_at IS NULL AND inactive_at IS NULL;

CREATE INDEX IF NOT EXISTS purchase_orders_active_region_idx
  ON purchase_orders(region_id, listed_at DESC NULLS LAST, id DESC)
  WHERE deleted_at IS NULL AND inactive_at IS NULL;

CREATE INDEX IF NOT EXISTS purchase_orders_active_buyer_idx
  ON purchase_orders(buyer_employee_id, listed_at DESC NULLS LAST, id DESC)
  WHERE deleted_at IS NULL AND inactive_at IS NULL;
