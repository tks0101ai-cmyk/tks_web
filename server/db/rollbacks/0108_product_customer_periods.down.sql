ALTER TABLE product_report_customers
  DROP COLUMN IF EXISTS revenue_1_30d,
  DROP COLUMN IF EXISTS revenue_31_60d,
  DROP COLUMN IF EXISTS revenue_61_90d;
ALTER TABLE product_report_state DROP COLUMN IF EXISTS customer_window_end;
