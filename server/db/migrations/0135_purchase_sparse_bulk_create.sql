-- Bulk add requires only the product code and carton count. Keep blank names
-- and zero units/carton representable until the buyer fills in the details.
DO $migration$
DECLARE item RECORD;
BEGIN
  FOR item IN
    SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE conrelid = 'purchase_orders'::regclass AND contype = 'c'
  LOOP
    IF (item.definition ILIKE '%product_name%' AND item.definition ILIKE '%btrim%')
       OR (item.definition ILIKE '%qty_per_carton%' AND item.definition ILIKE '%trunc%'
          AND item.definition ILIKE '%>%') THEN
      EXECUTE format('ALTER TABLE purchase_orders DROP CONSTRAINT %I', item.conname);
    END IF;
  END LOOP;
END
$migration$;

ALTER TABLE purchase_orders
  ALTER COLUMN product_name SET DEFAULT '',
  ALTER COLUMN product_name SET NOT NULL,
  ALTER COLUMN qty_per_carton SET DEFAULT 0,
  ADD CONSTRAINT purchase_orders_sparse_create_qty_check
    CHECK (qty_per_carton >= 0 AND qty_per_carton = trunc(qty_per_carton));
