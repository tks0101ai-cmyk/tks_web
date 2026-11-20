-- Thêm tài khoản "An Hồng Hải" vào danh sách không bị nhãn "Xin muộn" (xem 0120).
-- Chỉ bỏ nhãn "Xin muộn"; nhãn "Vi phạm" (gửi từ giờ bắt đầu buổi nghỉ đầu tiên) vẫn giữ nguyên.
INSERT INTO hr_leave_timing_overrides (user_id, note)
SELECT u.id, 'An Hồng Hải'
FROM app_users u
WHERE lower(btrim(u.ho_ten)) = lower('An Hồng Hải')
ON CONFLICT (user_id) DO NOTHING;
