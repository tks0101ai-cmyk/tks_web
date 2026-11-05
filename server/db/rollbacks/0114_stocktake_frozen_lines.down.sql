-- Go bo 0114_stocktake_frozen_lines.sql (chot dong don khi dong dot).
-- CHAY TAY, KHONG nam trong db/migrations nen db/migrate.js khong bao gio tu chay file nay.
-- Phai deploy lai ban web khong doc lines_frozen_at TRUOC khi chay, neu khong moi API Kiem ke se loi.
-- Dot da chot mat dong don da chup: chi con so tong trong stocktake_session_results va tro thanh chi doc.
BEGIN;
DROP TABLE IF EXISTS stocktake_session_lines;
ALTER TABLE stocktake_sessions DROP COLUMN IF EXISTS lines_frozen_at;
DELETE FROM schema_migrations WHERE filename = '0114_stocktake_frozen_lines.sql';
COMMIT;
