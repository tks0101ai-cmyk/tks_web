-- Manual rollback only; removes the audit trail of draft stock-out order edits, never the orders themselves.
DROP TABLE IF EXISTS stock_out_order_events;
DELETE FROM schema_migrations WHERE filename = '0107_stock_out_order_events.sql';
