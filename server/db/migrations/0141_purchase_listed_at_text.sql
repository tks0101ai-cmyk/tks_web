-- The list date may contain multiple dates after merging order rows.
ALTER TABLE purchase_orders
  ALTER COLUMN listed_at TYPE TEXT
  USING CASE
    WHEN listed_at IS NULL THEN NULL
    ELSE to_char(listed_at, 'YYYY-MM-DD')
  END;

DROP INDEX IF EXISTS purchase_orders_latest_idx;
CREATE INDEX purchase_orders_latest_idx
  ON purchase_orders(lower(product_code), (regexp_replace(listed_at, '^.* [+] ', '')) DESC NULLS LAST, id DESC);
