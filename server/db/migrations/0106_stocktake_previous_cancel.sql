-- Kiem ke dot 1 cai tien, 2026-11-04 (thiet ke: docs/superpowers/specs/2026-11-04-stocktake-previous-cancel-reload-design.md).
-- previous_session_id: chon tay dot "KK truoc" cho dot dang mo; NULL = tu dong (dot dong gan nhat cung co so).
-- cancelled_*: huy dot (an, chi doc, khong dung lam KK truoc / doi chieu); KHONG xoa vat ly, khoi phuc = xoa cancelled_at.
--   Dung cot rieng thay vi them gia tri status de khong dung toi cac cho dang kiem open/closed.
-- reloaded_*: lan nap lai gan nhat cua dot nap tu sheet.
ALTER TABLE stocktake_sessions
  ADD COLUMN IF NOT EXISTS previous_session_id  BIGINT REFERENCES stocktake_sessions (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancelled_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by_user_id TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_by_name    TEXT,
  ADD COLUMN IF NOT EXISTS cancel_reason        TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS reloaded_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reloaded_by_name     TEXT;

ALTER TABLE stocktake_sessions DROP CONSTRAINT IF EXISTS stocktake_sessions_previous_not_self;
ALTER TABLE stocktake_sessions ADD CONSTRAINT stocktake_sessions_previous_not_self
  CHECK (previous_session_id IS NULL OR previous_session_id <> id);

ALTER TABLE stocktake_history DROP CONSTRAINT IF EXISTS stocktake_history_action_check;
ALTER TABLE stocktake_history ADD CONSTRAINT stocktake_history_action_check CHECK (action IN (
  'session_create', 'session_update', 'session_close', 'sheet_import', 'line_edit', 'line_add', 'note', 'tag', 'paste',
  'session_cancel', 'session_restore', 'sheet_reload'));
