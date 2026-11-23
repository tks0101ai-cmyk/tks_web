-- Keep common title sorts paginated against the active row set without a full sort.
CREATE INDEX IF NOT EXISTS purchase_orders_active_product_name_sort_idx
  ON purchase_orders(product_name ASC NULLS LAST, id DESC)
  WHERE deleted_at IS NULL AND inactive_at IS NULL;

CREATE INDEX IF NOT EXISTS purchase_orders_active_supplier_sort_idx
  ON purchase_orders(supplier ASC NULLS LAST, id DESC)
  WHERE deleted_at IS NULL AND inactive_at IS NULL;
