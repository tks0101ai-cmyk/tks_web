-- The list date may contain multiple dates after merging order rows.
-- Remove timestamp-based indexes before changing the column type.
DROP INDEX IF EXISTS purchase_orders_latest_idx;
DROP INDEX IF EXISTS purchase_orders_active_listed_idx;
DROP INDEX IF EXISTS purchase_orders_active_region_idx;
DROP INDEX IF EXISTS purchase_orders_active_buyer_idx;

ALTER TABLE purchase_orders
  ALTER COLUMN listed_at TYPE TEXT
  USING CASE
    WHEN listed_at IS NULL THEN NULL
    ELSE to_char(listed_at, 'YYYY-MM-DD')
  END;

CREATE INDEX purchase_orders_latest_idx
  ON purchase_orders(lower(product_code), (regexp_replace(listed_at, '^.* [+] ', '')) DESC NULLS LAST, id DESC);

CREATE INDEX purchase_orders_active_listed_idx
  ON purchase_orders((regexp_replace(listed_at, '^.* [+] ', '')) DESC NULLS LAST, id DESC)
  WHERE deleted_at IS NULL AND inactive_at IS NULL;

CREATE INDEX purchase_orders_active_region_idx
  ON purchase_orders(region_id, (regexp_replace(listed_at, '^.* [+] ', '')) DESC NULLS LAST, id DESC)
  WHERE deleted_at IS NULL AND inactive_at IS NULL;

CREATE INDEX purchase_orders_active_buyer_idx
  ON purchase_orders(buyer_employee_id, (regexp_replace(listed_at, '^.* [+] ', '')) DESC NULLS LAST, id DESC)
  WHERE deleted_at IS NULL AND inactive_at IS NULL;
