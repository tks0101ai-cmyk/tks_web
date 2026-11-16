-- Nhật ký phiên bản Thu mua: tua ngược trạng thái bảng về một thời điểm.
-- Chỉ thêm chỉ mục, không đổi cột/bảng nào.
--
-- Cách tua ngược: với mỗi dòng, thao tác SỚM NHẤT sau mốc V có before_row chính là
-- trạng thái dòng đó tại V. Truy vấn vì vậy quét purchase_operation_rows theo thời
-- gian của thao tác rồi lấy bản ghi đầu tiên mỗi dòng — cần cả hai chỉ mục dưới đây,
-- vì chỉ mục sẵn có purchase_operations_actor_idx dẫn đầu bằng actor_id nên không
-- dùng được khi lọc theo riêng created_at.
CREATE INDEX IF NOT EXISTS purchase_operations_created_idx ON purchase_operations(created_at DESC, id);
CREATE INDEX IF NOT EXISTS purchase_operation_rows_row_idx ON purchase_operation_rows(row_id, operation_id);
-- Danh sách phiên bản cần tên người thực hiện, lấy từ purchase_history theo operationId
-- nằm trong cột summary (JSONB) — không có chỉ mục này thì mỗi lần mở tab phải quét bảng.
CREATE INDEX IF NOT EXISTS purchase_history_operation_idx ON purchase_history((summary->>'operationId'));
