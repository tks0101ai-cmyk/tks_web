-- Manual rollback only; removes the derived snapshot, never source documents.
DROP TABLE IF EXISTS product_90d_report_state;
DROP TABLE IF EXISTS product_90d_report;
