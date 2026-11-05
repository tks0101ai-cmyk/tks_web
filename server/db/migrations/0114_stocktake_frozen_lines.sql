-- Kiem ke: dong dot chot dong don TEAM de van sua duoc sau khi dong, ke ca khi khach TEAM / don bi xoa tren KiotViet.
-- Thiet ke: docs/superpowers/specs/2026-11-05-stocktake-close-editable-speed-design.md.
-- lines_frozen_at: thoi diem chot; NULL = dot chua dong, dot nap tu sheet hoac dot dong truoc migration nay (chi doc).
ALTER TABLE stocktake_sessions ADD COLUMN IF NOT EXISTS lines_frozen_at TIMESTAMPTZ;

-- Dong don goc luc dong dot, chua ap phan sua; phan sua van o stocktake_line_edits theo (order_id, line_no).
CREATE TABLE IF NOT EXISTS stocktake_session_lines (
  session_id   BIGINT  NOT NULL REFERENCES stocktake_sessions (id) ON DELETE CASCADE,
  order_id     BIGINT  NOT NULL,
  line_no      INTEGER NOT NULL,
  order_code   TEXT    NOT NULL DEFAULT '',
  order_status TEXT    NOT NULL DEFAULT '',
  team         TEXT    NOT NULL DEFAULT '',
  zone         TEXT    NOT NULL DEFAULT '',
  spec         TEXT    NOT NULL DEFAULT '',
  product_code TEXT    NOT NULL DEFAULT '',
  product_name TEXT    NOT NULL DEFAULT '',
  quantity     NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, order_id, line_no)
);
