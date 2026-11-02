-- Kiem ke (doi chieu), 2026-10-31. Thay tab "KIEM KE HN T10" cua sheet kiem ke.
-- So dem KHONG chep vao day: luc xem tinh truc tiep tu don dat hang cua khach "TEAM..." (orders/order_details)
-- trong khoang ngay cua dot, cong phan sua tren web (stocktake_line_edits). Ton/gia von doc tu products.
-- Dong dot -> chup bang doi chieu vao stocktake_session_results (nguon "KK truoc" cua dot sau).
-- Ma hang luu dang chuan: upper, bo moi khoang trang (giong stock_positions khi so khop).
-- branch theo quy uoc KiotViet ('hanoi'/'saigon'); so luong / tien dung NUMERIC.

CREATE TABLE IF NOT EXISTS stocktake_sessions (
  id                 BIGSERIAL PRIMARY KEY,
  branch             TEXT        NOT NULL CHECK (branch IN ('hanoi', 'saigon')),
  name               TEXT        NOT NULL CHECK (btrim(name) <> ''),
  date_from          DATE        NOT NULL,
  date_to            DATE        NOT NULL CHECK (date_to >= date_from),
  status             TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  -- 'sheet_import': dot nap mot lan tu sheet (dot T10), chi co ban chup ket qua.
  source             TEXT        NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'sheet_import')),
  source_ref         TEXT,
  -- Dot cua co so kia de doi chieu cot "Kiem SG" / "Kiem HN" (SL chenh cung ma o dot do).
  counterpart_session_id BIGINT REFERENCES stocktake_sessions (id) ON DELETE SET NULL,
  version            INTEGER     NOT NULL DEFAULT 1,
  created_by_user_id TEXT,
  created_by_name    TEXT        NOT NULL DEFAULT '',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_by_user_id  TEXT,
  closed_by_name     TEXT,
  closed_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS stocktake_sessions_branch_idx ON stocktake_sessions (branch, date_to DESC);
CREATE UNIQUE INDEX IF NOT EXISTS stocktake_sessions_source_ref_uq ON stocktake_sessions (source_ref) WHERE source_ref IS NOT NULL;

-- Sua dong dem goc (order_id + line_no) hoac dong them tay (order_id NULL).
-- Cot NULL = giu gia tri goc; removed = bo dong khoi tong kiem.
CREATE TABLE IF NOT EXISTS stocktake_line_edits (
  id                 BIGSERIAL PRIMARY KEY,
  session_id         BIGINT      NOT NULL REFERENCES stocktake_sessions (id) ON DELETE CASCADE,
  order_id           BIGINT,
  line_no            INTEGER,
  product_code       TEXT,
  team               TEXT,
  zone               TEXT,
  spec               TEXT,
  quantity           NUMERIC,
  removed            BOOLEAN     NOT NULL DEFAULT false,
  version            INTEGER     NOT NULL DEFAULT 1,
  updated_by_user_id TEXT,
  updated_by_name    TEXT        NOT NULL DEFAULT '',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((order_id IS NULL) = (line_no IS NULL)),
  CHECK (order_id IS NOT NULL OR (product_code IS NOT NULL AND btrim(product_code) <> '' AND quantity IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS stocktake_line_edits_source_uq ON stocktake_line_edits (session_id, order_id, line_no) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stocktake_line_edits_session_idx ON stocktake_line_edits (session_id);

CREATE TABLE IF NOT EXISTS stocktake_code_notes (
  session_id          BIGINT      NOT NULL REFERENCES stocktake_sessions (id) ON DELETE CASCADE,
  product_code        TEXT        NOT NULL CHECK (btrim(product_code) <> ''),
  status_text         TEXT        NOT NULL DEFAULT '',
  -- Mau danh dau trang thai (khoa trong STATUS_COLORS cua public/stocktake/stocktakePaste.js), '' = khong mau.
  status_color        TEXT        NOT NULL DEFAULT '' CHECK (status_color IN ('', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'gray')),
  reason_text         TEXT        NOT NULL DEFAULT '',
  recheck_employee_id BIGINT      REFERENCES hr_employees (id) ON DELETE SET NULL,
  -- Ten nguoi kiem lai dang chu tu sheet (biet danh "THAI KHO"...), chi dot nap tu sheet; tren web dung recheck_employee_id.
  recheck_name        TEXT        NOT NULL DEFAULT '',
  print_page          TEXT        NOT NULL DEFAULT '',
  print_time          TEXT        NOT NULL DEFAULT '',
  -- So dan tay de len so tu lay: KK truoc sai (L) va Kiem SG/HN (M). NULL = dung so tu lay.
  prev_diff_manual    NUMERIC,
  other_diff_manual   NUMERIC,
  version             INTEGER     NOT NULL DEFAULT 1,
  updated_by_user_id  TEXT,
  updated_by_name     TEXT        NOT NULL DEFAULT '',
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, product_code)
);

-- Giu qua cac dot: Cum SP (ma bi lan gom chung de cong chenh) va co Combo.
CREATE TABLE IF NOT EXISTS stocktake_product_tags (
  branch             TEXT        NOT NULL CHECK (branch IN ('hanoi', 'saigon')),
  product_code       TEXT        NOT NULL CHECK (btrim(product_code) <> ''),
  cluster            TEXT        NOT NULL DEFAULT '',
  is_combo           BOOLEAN     NOT NULL DEFAULT false,
  version            INTEGER     NOT NULL DEFAULT 1,
  updated_by_user_id TEXT,
  updated_by_name    TEXT        NOT NULL DEFAULT '',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (branch, product_code)
);

CREATE TABLE IF NOT EXISTS stocktake_session_results (
  session_id   BIGINT  NOT NULL REFERENCES stocktake_sessions (id) ON DELETE CASCADE,
  product_code TEXT    NOT NULL CHECK (btrim(product_code) <> ''),
  name         TEXT    NOT NULL DEFAULT '',
  counted      NUMERIC NOT NULL DEFAULT 0,
  stock        NUMERIC NOT NULL DEFAULT 0,
  cost         NUMERIC NOT NULL DEFAULT 0,
  diff_qty     NUMERIC NOT NULL DEFAULT 0,
  diff_value   NUMERIC NOT NULL DEFAULT 0,
  prev_diff    NUMERIC,
  other_diff   NUMERIC,
  PRIMARY KEY (session_id, product_code)
);

-- Lich su chi them, trigger chan sua/xoa giong stock_position_history (0095).
-- Khong khoa ngoai toi dot: lich su con lai ke ca khi dot bi xoa.
CREATE TABLE IF NOT EXISTS stocktake_history (
  id            BIGSERIAL PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_id    BIGINT,
  branch        TEXT        NOT NULL CHECK (branch IN ('hanoi', 'saigon')),
  product_code  TEXT        NOT NULL DEFAULT '',
  action        TEXT        NOT NULL CHECK (action IN ('session_create', 'session_update', 'session_close', 'sheet_import', 'line_edit', 'line_add', 'note', 'tag', 'paste')),
  before        JSONB,
  after         JSONB,
  actor_user_id TEXT,
  actor_name    TEXT        NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS stocktake_history_code_idx ON stocktake_history (session_id, product_code, id DESC);

CREATE OR REPLACE FUNCTION stocktake_history_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Stocktake history is immutable';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS stocktake_history_guard ON stocktake_history;
CREATE TRIGGER stocktake_history_guard BEFORE UPDATE OR DELETE ON stocktake_history
  FOR EACH ROW EXECUTE FUNCTION stocktake_history_guard();

-- Lich su + ghi chu co ten nguoi dung / nhan su nen chi doc qua API.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reporting_readonly') THEN
    REVOKE ALL ON stocktake_history, stocktake_code_notes FROM reporting_readonly;
  END IF;
END $$;
