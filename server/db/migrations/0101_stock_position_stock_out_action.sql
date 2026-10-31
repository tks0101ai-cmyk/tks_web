-- VT Ha Noi / VT Sai Gon (2026-10-30): nut "Xuat kho" tru so luong hang loat tu file Excel/CSV.
-- Them hanh dong lich su 'stock_out' (moi dong vi tri bi tru: ghi chu cu -> moi, summary = {deducted, removed, fileName, fileRows}).
-- Chi mo rong CHECK; khong them cot/bang. Giu nguyen toan bo gia tri 0099.
ALTER TABLE stock_position_history DROP CONSTRAINT IF EXISTS stock_position_history_action_check;
ALTER TABLE stock_position_history ADD CONSTRAINT stock_position_history_action_check
  CHECK (action IN ('seed', 'create', 'edit', 'delete', 'auto_delete', 'deduct', 'import_replace', 'import_add', 'pick', 'pick_revert', 'ack', 'unack', 'history_purged', 'stock_out'));
