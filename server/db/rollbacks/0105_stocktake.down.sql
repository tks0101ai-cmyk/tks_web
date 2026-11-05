-- Go bo Kiem ke (migration 0105_stocktake.sql) neu thu nghiem khong dat.
-- CHAY TAY, KHONG nam trong db/migrations nen db/migrate.js khong bao gio tu chay file nay.
-- Chi xoa 6 bang stocktake_* + trigger/ham rieng cua chung; khong dung bang nao khac.
-- Mat toan bo du lieu kiem ke da nhap. Lam truoc khi revert code (hoac ngay sau khi Render rollback).
BEGIN;
DROP TABLE IF EXISTS stocktake_history;          -- trigger stocktake_history_guard bi xoa theo bang
DROP FUNCTION IF EXISTS stocktake_history_guard();
DROP TABLE IF EXISTS stocktake_session_results;
DROP TABLE IF EXISTS stocktake_code_notes;
DROP TABLE IF EXISTS stocktake_line_edits;
DROP TABLE IF EXISTS stocktake_product_tags;
DROP TABLE IF EXISTS stocktake_sessions;
DELETE FROM schema_migrations WHERE filename = '0105_stocktake.sql';
COMMIT;
