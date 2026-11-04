-- NULL means the snapshot has not yet computed the rolling periods.
ALTER TABLE product_report_customers
  ADD COLUMN IF NOT EXISTS revenue_1_30d NUMERIC,
  ADD COLUMN IF NOT EXISTS revenue_31_60d NUMERIC,
  ADD COLUMN IF NOT EXISTS revenue_61_90d NUMERIC;
ALTER TABLE product_report_state ADD COLUMN IF NOT EXISTS customer_window_end DATE;
