-- Track a container's HĐ/NHĐ lifecycle separately from its shipment status.
ALTER TABLE product_containers
  ADD COLUMN IF NOT EXISTS inactive_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS product_containers_active_idx
  ON product_containers(id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS product_containers_inactive_idx
  ON product_containers(inactive_at DESC) WHERE deleted_at IS NULL AND inactive_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS product_containers_trash_idx
  ON product_containers(deleted_at DESC) WHERE deleted_at IS NOT NULL;
