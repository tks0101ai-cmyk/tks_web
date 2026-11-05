-- Recoverable purchase actions. No cutover, seed or production writes.
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS buyer_employee_id BIGINT;
CREATE TABLE IF NOT EXISTS purchase_operations (
 id UUID PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), undone_by UUID UNIQUE
);
CREATE TABLE IF NOT EXISTS purchase_operation_rows (
 operation_id UUID NOT NULL REFERENCES purchase_operations(id), row_id BIGINT NOT NULL, before_row JSONB, after_row JSONB,
 PRIMARY KEY(operation_id,row_id)
);
CREATE OR REPLACE FUNCTION purchase_capture_row() RETURNS trigger AS $$
DECLARE op TEXT;
BEGIN
 op := current_setting('purchase.operation_id',true);
 IF op IS NULL OR op='' THEN RETURN COALESCE(NEW,OLD); END IF;
 INSERT INTO purchase_operation_rows(operation_id,row_id,before_row,after_row)
 VALUES(op::uuid,COALESCE(NEW.id,OLD.id),CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END)
 ON CONFLICT(operation_id,row_id) DO UPDATE SET after_row=EXCLUDED.after_row;
 RETURN COALESCE(NEW,OLD);
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS purchase_capture_row ON purchase_orders;
CREATE TRIGGER purchase_capture_row AFTER INSERT OR UPDATE OR DELETE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION purchase_capture_row();
CREATE INDEX IF NOT EXISTS purchase_operations_actor_idx ON purchase_operations(actor_id,created_at DESC);
CREATE TABLE IF NOT EXISTS purchase_undo_expected (
 operation_id UUID NOT NULL REFERENCES purchase_operations(id),row_id BIGINT NOT NULL,expected_row JSONB NOT NULL,PRIMARY KEY(operation_id,row_id)
);
