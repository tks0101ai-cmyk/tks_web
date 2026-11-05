-- Nhat ky GHI NGUOC len don dat hang KiotViet tu hop "Chi dinh vi tri" (2026-10-30): xoa dong hang / sua so luong can nhat.
-- Chi them, khong sua/xoa (trigger chan). Khong co khoa ngoai; `summary` luu dong truoc/sau de doi chieu va khoi phuc tay.
CREATE TABLE IF NOT EXISTS order_kiot_edit_log (
  id            BIGSERIAL PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  branch        TEXT        NOT NULL CHECK (branch IN ('HN', 'SG')),
  order_code    TEXT        NOT NULL,
  action        TEXT        NOT NULL CHECK (action IN ('remove_line', 'set_quantity', 'rollback')),
  summary       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id TEXT,
  actor_name    TEXT        NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS order_kiot_edit_log_order_idx ON order_kiot_edit_log (branch, lower(btrim(order_code)), id);

CREATE OR REPLACE FUNCTION order_kiot_edit_log_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Order Kiot edit log is immutable';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS order_kiot_edit_log_guard ON order_kiot_edit_log;
CREATE TRIGGER order_kiot_edit_log_guard BEFORE UPDATE OR DELETE ON order_kiot_edit_log
  FOR EACH ROW EXECUTE FUNCTION order_kiot_edit_log_guard();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reporting_readonly') THEN
    REVOKE ALL ON order_kiot_edit_log FROM reporting_readonly;
  END IF;
END $$;
