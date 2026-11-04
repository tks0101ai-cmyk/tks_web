-- Go bo 0109_stocktake_previous_cancel.sql (chon dot KK truoc, huy dot, nap lai sheet).
-- CHAY TAY, KHONG nam trong db/migrations nen db/migrate.js khong bao gio tu chay file nay.
-- Lich su (stocktake_history) chi them, khong xoa duoc: neu da co action session_cancel / session_restore / sheet_reload
-- thi buoc tra CHECK cu se THAT BAI va ca file rollback (BEGIN..COMMIT) khong doi gi. Khi do giu 0109.
-- Dot dang bi huy se hien lai binh thuong sau khi go (mat cot cancelled_at).
BEGIN;
ALTER TABLE stocktake_history DROP CONSTRAINT IF EXISTS stocktake_history_action_check;
ALTER TABLE stocktake_history ADD CONSTRAINT stocktake_history_action_check CHECK (action IN (
  'session_create', 'session_update', 'session_close', 'sheet_import', 'line_edit', 'line_add', 'note', 'tag', 'paste'));
ALTER TABLE stocktake_sessions DROP CONSTRAINT IF EXISTS stocktake_sessions_previous_not_self;
ALTER TABLE stocktake_sessions
  DROP COLUMN IF EXISTS previous_session_id,
  DROP COLUMN IF EXISTS cancelled_at,
  DROP COLUMN IF EXISTS cancelled_by_user_id,
  DROP COLUMN IF EXISTS cancelled_by_name,
  DROP COLUMN IF EXISTS cancel_reason,
  DROP COLUMN IF EXISTS reloaded_at,
  DROP COLUMN IF EXISTS reloaded_by_name;
DELETE FROM schema_migrations WHERE filename = '0109_stocktake_previous_cancel.sql';
COMMIT;
