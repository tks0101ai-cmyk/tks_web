-- Số thùng có thể là số thập phân dương; SL/T vẫn là số nguyên dương.
DO $$
DECLARE constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid='purchase_orders'::regclass
      AND contype='c'
      AND pg_get_constraintdef(oid) ILIKE '%carton_count%trunc%'
  LOOP
    EXECUTE format('ALTER TABLE purchase_orders DROP CONSTRAINT %I',constraint_name);
  END LOOP;
END $$;

ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_carton_count_positive_check;
ALTER TABLE purchase_orders
  ADD CONSTRAINT purchase_orders_carton_count_positive_check CHECK (carton_count > 0);
