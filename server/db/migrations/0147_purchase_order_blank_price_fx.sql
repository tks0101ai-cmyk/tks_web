-- Blank unit price and row exchange rate stay NULL. Keep existing stored values
-- unchanged because a backfilled zero/3900 cannot be distinguished from an
-- intentional value supplied by a user.
ALTER TABLE purchase_orders
  ALTER COLUMN unit_price_cny DROP DEFAULT,
  ALTER COLUMN fx_rate DROP DEFAULT,
  ALTER COLUMN fx_rate DROP NOT NULL;
