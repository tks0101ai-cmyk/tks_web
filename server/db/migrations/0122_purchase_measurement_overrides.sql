-- Per-row user overrides for the Cân đo đối chiếu group. Automatic values
-- remain derived from the live measurement snapshot when a key is absent.
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS measurement_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;
