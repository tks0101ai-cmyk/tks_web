-- Luu vet thao tac tren don xuat kho tam (2026-11-04): ai them / sua / xoa / nhap dong, luc nao, dong do truoc khi xoa la gi.
-- Ly do: don tam dung chung moi co so, xoa dong khong de lai dau vet nen khong biet ai xoa (xem CURRENT.md 04/11).
-- Moi thao tac ghi 1 dong CUNG giao dich voi thao tac; detail JSONB giu anh chup dong (code, name, location, notes) truoc/sau.
-- Khong khoa ngoai toi dong don (dong bi xoa van con vet); xoa don thi xoa vet theo (ON DELETE CASCADE).

CREATE TABLE IF NOT EXISTS stock_out_order_events (
  id          BIGSERIAL PRIMARY KEY,
  order_id    BIGINT      NOT NULL REFERENCES stock_out_orders (id) ON DELETE CASCADE,
  line_id     BIGINT,
  action      TEXT        NOT NULL CHECK (action IN ('add', 'update', 'delete', 'import', 'confirm')),
  user_id     TEXT,
  user_name   TEXT        NOT NULL DEFAULT '',
  detail      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stock_out_order_events_order_idx ON stock_out_order_events (order_id, id DESC);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reporting_readonly') THEN
    REVOKE ALL ON stock_out_order_events FROM reporting_readonly;
  END IF;
END $$;
