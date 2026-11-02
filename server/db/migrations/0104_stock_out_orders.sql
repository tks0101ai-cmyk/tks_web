-- Don xuat kho (VT Ha Noi / VT Sai Gon, 2026-11-02): phieu tam dung chung cua moi co so, ghi lai hang da boc that
-- (theo ten, ghi chu thung) ma chua tru ton. Chi khi "Chot don" moi tru ton VT (cho phep ra SL am), moi vi tri ghi 1 dong
-- stock_position_history (action 'stock_out', summary { source: 'order', orderId, orderCode }) de bam ma don xem chi tiet.
--
-- Moi co so co DUNG MOT don tam (draft) dang mo; chot xong don khoa lai va don tam moi duoc tao khi can.
-- Ma don XK-HN-00001 / XK-SG-00001: cap luc tao don tam, dem rieng tung co so (max + 1 duoi khoa advisory cua co so).
-- Dong VT khong co khoa ngoai (giong stock_position_history): dong vi tri co the bi xoa khi het hang, lich su don van con.
-- Khong dung ON CONFLICT DO UPDATE (xem SCHEMA.md, su co Supabase IO 2026-09-28).

CREATE TABLE IF NOT EXISTS stock_out_orders (
  id                   BIGSERIAL PRIMARY KEY,
  branch               TEXT        NOT NULL CHECK (branch IN ('HN', 'SG')),
  code                 TEXT        NOT NULL CHECK (btrim(code) <> ''),
  status               TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  version              INTEGER     NOT NULL DEFAULT 1,
  created_by_user_id   TEXT,
  created_by_name      TEXT        NOT NULL DEFAULT '',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_by_user_id TEXT,
  confirmed_by_name    TEXT,
  confirmed_at         TIMESTAMPTZ,
  summary              JSONB,
  UNIQUE (branch, code)
);

-- Mot don tam cho moi co so.
CREATE UNIQUE INDEX IF NOT EXISTS stock_out_orders_one_draft_idx ON stock_out_orders (branch) WHERE status = 'draft';
CREATE INDEX IF NOT EXISTS stock_out_orders_confirmed_idx ON stock_out_orders (branch, confirmed_at DESC) WHERE status = 'confirmed';

CREATE TABLE IF NOT EXISTS stock_out_order_lines (
  id                 BIGSERIAL PRIMARY KEY,
  order_id           BIGINT      NOT NULL REFERENCES stock_out_orders (id) ON DELETE CASCADE,
  sort_order         INTEGER     NOT NULL DEFAULT 0,
  code               TEXT        NOT NULL CHECK (btrim(code) <> ''),
  name               TEXT        NOT NULL DEFAULT '',
  location           TEXT        NOT NULL DEFAULT '',
  notes              TEXT        NOT NULL DEFAULT '',
  source             TEXT        NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'excel')),
  version            INTEGER     NOT NULL DEFAULT 1,
  created_by_user_id TEXT,
  created_by_name    TEXT        NOT NULL DEFAULT '',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Ghi luc chot: { before, after, quantity, negative, created } cua vi tri bi tru (ghi chu truoc/sau).
  result             JSONB
);

CREATE INDEX IF NOT EXISTS stock_out_order_lines_order_idx ON stock_out_order_lines (order_id, sort_order, id);

-- Ten nguoi dung nam trong bang nen chi doc qua API (nhu stock_position_history).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reporting_readonly') THEN
    REVOKE ALL ON stock_out_orders FROM reporting_readonly;
    REVOKE ALL ON stock_out_order_lines FROM reporting_readonly;
  END IF;
END $$;
