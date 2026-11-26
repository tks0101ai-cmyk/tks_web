-- A missing purchase-row exchange rate defaults to 3900, matching the
-- postpaid-freight conversion fallback. Backfill existing rows and queue a
-- shared projection refresh when their calculated NET values may change.
WITH defaulted AS (
  UPDATE purchase_orders
  SET fx_rate = 3900
  WHERE fx_rate IS NULL
  RETURNING id
)
INSERT INTO purchase_projection_queue(requested_at)
SELECT now()
WHERE EXISTS (SELECT 1 FROM defaulted);

ALTER TABLE purchase_orders
  ALTER COLUMN fx_rate SET DEFAULT 3900,
  ALTER COLUMN fx_rate SET NOT NULL;
