-- Hàng hóa 90 ngày: 26 business columns, merged HN/SG; snapshot ends yesterday.
-- product_key is a technical key; monetary/quantity/count values stay NUMERIC.
CREATE TABLE IF NOT EXISTS product_90d_report (
  product_key TEXT PRIMARY KEY,
  product_code TEXT NOT NULL,
  product_name TEXT NOT NULL,
  qty_61_90d NUMERIC NOT NULL DEFAULT 0,
  revenue_61_90d NUMERIC NOT NULL DEFAULT 0,
  avg_price_61_90d NUMERIC,
  customer_count_61_90d NUMERIC NOT NULL DEFAULT 0,
  invoice_count_61_90d NUMERIC NOT NULL DEFAULT 0,
  top_customers_61_90d JSONB NOT NULL DEFAULT '[]',
  qty_31_60d NUMERIC NOT NULL DEFAULT 0,
  revenue_31_60d NUMERIC NOT NULL DEFAULT 0,
  avg_price_31_60d NUMERIC,
  customer_count_31_60d NUMERIC NOT NULL DEFAULT 0,
  invoice_count_31_60d NUMERIC NOT NULL DEFAULT 0,
  top_customers_31_60d JSONB NOT NULL DEFAULT '[]',
  qty_1_30d NUMERIC NOT NULL DEFAULT 0,
  revenue_1_30d NUMERIC NOT NULL DEFAULT 0,
  avg_price_1_30d NUMERIC,
  customer_count_1_30d NUMERIC NOT NULL DEFAULT 0,
  invoice_count_1_30d NUMERIC NOT NULL DEFAULT 0,
  top_customers_1_30d JSONB NOT NULL DEFAULT '[]',
  qty_1_90d NUMERIC NOT NULL DEFAULT 0,
  revenue_1_90d NUMERIC NOT NULL DEFAULT 0,
  avg_price_1_90d NUMERIC,
  customer_count_1_90d NUMERIC NOT NULL DEFAULT 0,
  invoice_count_1_90d NUMERIC NOT NULL DEFAULT 0,
  top_customers_1_90d JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS product_90d_report_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  as_of_date DATE NOT NULL,
  window_start DATE NOT NULL,
  window_end DATE NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL,
  row_count NUMERIC NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  CHECK(window_start=as_of_date-90 AND window_end=as_of_date-1)
);

-- Application routes will enforce feature access; do not expose this report
-- automatically through Supabase's public API or the generic reporting role.
ALTER TABLE product_90d_report ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_90d_report_state ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='reporting_readonly') THEN
    REVOKE ALL ON product_90d_report, product_90d_report_state FROM reporting_readonly;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON product_90d_report, product_90d_report_state FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON product_90d_report, product_90d_report_state FROM authenticated;
  END IF;
END $$;
