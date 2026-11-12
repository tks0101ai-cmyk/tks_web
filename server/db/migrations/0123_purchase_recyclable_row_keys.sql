-- Stable identity for a split family; display keys may be reused after deletion.
ALTER TABLE purchase_orders ADD COLUMN root_order_id BIGINT;

UPDATE purchase_orders AS row
SET root_order_id = COALESCE(
  (SELECT history.order_id FROM purchase_key_history AS history
   WHERE history.row_key = row.root_key),
  (SELECT root.id FROM purchase_orders AS root
   WHERE root.row_key = row.root_key
   ORDER BY root.id LIMIT 1),
  (SELECT min(family.id) FROM purchase_orders AS family
   WHERE family.root_key = row.root_key),
  row.id
);

ALTER TABLE purchase_orders ALTER COLUMN root_order_id SET NOT NULL;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_root_order_fk
  FOREIGN KEY (root_order_id) REFERENCES purchase_orders(id) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION purchase_default_root_order_id() RETURNS trigger AS $$
BEGIN
  NEW.root_order_id := COALESCE(NEW.root_order_id, NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER purchase_orders_default_root_order_id
  BEFORE INSERT ON purchase_orders FOR EACH ROW EXECUTE FUNCTION purchase_default_root_order_id();

ALTER TABLE purchase_orders DROP CONSTRAINT purchase_orders_row_key_key;
CREATE UNIQUE INDEX purchase_orders_active_row_key_uq
  ON purchase_orders(row_key) WHERE deleted_at IS NULL;

-- Preserve all legacy assignments and make visible codes reusable by later orders.
DROP TRIGGER purchase_keys_guard ON purchase_key_history;
ALTER TABLE purchase_key_history DROP CONSTRAINT purchase_key_history_pkey;
ALTER TABLE purchase_key_history ADD COLUMN id BIGSERIAL PRIMARY KEY;
ALTER TABLE purchase_key_history ADD COLUMN root_order_id BIGINT;
UPDATE purchase_key_history AS history
SET root_order_id = COALESCE(
  (SELECT row.root_order_id FROM purchase_orders AS row WHERE row.id = history.order_id),
  (SELECT root.root_order_id FROM purchase_orders AS root WHERE root.row_key = history.root_key ORDER BY root.id LIMIT 1),
  (SELECT min(family.root_order_id) FROM purchase_orders AS family WHERE family.root_key = history.root_key),
  history.order_id
);
DROP TRIGGER IF EXISTS purchase_keys_guard ON purchase_key_history;
CREATE TRIGGER purchase_keys_guard BEFORE UPDATE OR DELETE ON purchase_key_history
  FOR EACH ROW EXECUTE FUNCTION purchase_immutable_guard();

ALTER TABLE purchase_operation_rows ADD COLUMN root_order_id BIGINT;
UPDATE purchase_operation_rows AS snapshot
SET root_order_id = COALESCE(
  (SELECT row.root_order_id FROM purchase_orders AS row WHERE row.id = snapshot.row_id),
  (SELECT history.root_order_id FROM purchase_key_history AS history WHERE history.order_id = snapshot.row_id ORDER BY history.id DESC LIMIT 1),
  (SELECT family.root_order_id FROM purchase_orders AS family
   WHERE family.root_key = COALESCE(snapshot.before_row->>'root_key', snapshot.after_row->>'root_key')
   ORDER BY family.id LIMIT 1),
  snapshot.row_id
);
ALTER TABLE purchase_operation_rows ALTER COLUMN root_order_id SET NOT NULL;

UPDATE purchase_operation_rows
SET before_row = CASE WHEN before_row IS NULL THEN NULL ELSE before_row || jsonb_build_object('root_order_id',root_order_id) END,
    after_row = CASE WHEN after_row IS NULL THEN NULL ELSE after_row || jsonb_build_object('root_order_id',root_order_id) END;
UPDATE purchase_undo_expected AS expected
SET expected_row = expected.expected_row || jsonb_build_object('root_order_id',COALESCE(
  (SELECT snapshot.root_order_id FROM purchase_operation_rows AS snapshot
   WHERE snapshot.operation_id=expected.operation_id AND snapshot.row_id=expected.row_id),
  (SELECT history.root_order_id FROM purchase_key_history AS history WHERE history.order_id=expected.row_id ORDER BY history.id DESC LIMIT 1),
  (SELECT family.root_order_id FROM purchase_orders AS family
   WHERE family.root_key=expected.expected_row->>'root_key' ORDER BY family.id LIMIT 1),
  expected.row_id
));

-- New audit snapshots retain the family ID even if undo later removes the row.
CREATE OR REPLACE FUNCTION purchase_capture_row() RETURNS trigger AS $$
DECLARE op TEXT;
BEGIN
  op := current_setting('purchase.operation_id',true);
  IF op IS NULL OR op='' THEN RETURN COALESCE(NEW,OLD); END IF;
  INSERT INTO purchase_operation_rows(operation_id,row_id,root_order_id,before_row,after_row)
  VALUES(op::uuid,COALESCE(NEW.id,OLD.id),COALESCE(NEW.root_order_id,OLD.root_order_id,NEW.id,OLD.id),
    CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END)
  ON CONFLICT(operation_id,row_id) DO UPDATE SET root_order_id=EXCLUDED.root_order_id,after_row=EXCLUDED.after_row;
  RETURN COALESCE(NEW,OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TABLE purchase_key_pool (
  row_key TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE purchase_key_reservations (
  reservation_id UUID PRIMARY KEY,
  row_key TEXT NOT NULL UNIQUE,
  actor_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX purchase_key_reservations_expiry_idx ON purchase_key_reservations(expires_at);

-- One pool entry per fully deleted family; active families remain unavailable.
WITH inactive_families AS (
  SELECT root_order_id, min(root_key) AS root_key
  FROM purchase_orders
  GROUP BY root_order_id
  HAVING bool_or(deleted_at IS NOT NULL)
     AND NOT bool_or(deleted_at IS NULL)
)
INSERT INTO purchase_key_pool(row_key)
SELECT family.root_key
FROM inactive_families AS family
WHERE NOT EXISTS (
  SELECT 1 FROM purchase_orders AS active
  WHERE active.root_key = family.root_key AND active.deleted_at IS NULL
)
ON CONFLICT(row_key) DO NOTHING;

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='reporting_readonly') THEN
    REVOKE ALL ON purchase_key_pool,purchase_key_reservations FROM reporting_readonly;
  END IF;
END $$;
