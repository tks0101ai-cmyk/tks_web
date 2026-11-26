-- Giá tệ trống được hiểu và lưu như 0 để NET vẫn cộng được cước vận chuyển.
UPDATE purchase_orders SET unit_price_cny=0 WHERE unit_price_cny IS NULL;
ALTER TABLE purchase_orders ALTER COLUMN unit_price_cny SET DEFAULT 0;
