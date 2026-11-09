-- Điền nhãn "Thời hạn đăng ký" + "Hạn đăng ký" cho các đơn xin nghỉ cũ (gửi trước migration 0038).
--
-- Vì sao cần tắt trigger: hr_leave_00_submission (0038/0082) với UPDATE không đổi lịch nghỉ sẽ
-- chép lại giá trị OLD cho timing_status/hạn đăng ký, nên UPDATE thường không ghi được.
-- Nếu ép qua đường "gửi lại" thì thoi_gian_gui bị đặt lại = bây giờ và đơn bị reset về "Chưa duyệt".
-- Ở đây chỉ ghi các cột nhãn/hạn; KHÔNG đụng thoi_gian_gui, trạng thái duyệt, submission_revision,
-- bo_phan, và KHÔNG ghi thêm dòng nào vào hr_leave_submissions (lịch sử gửi vẫn bất biến, đơn cũ vẫn revision 0).
--
-- Cách tính giống hệt hr_leave_calculate_timing, với giờ mặc định của hệ thống tại thời điểm đó
-- (Sáng 07:45, Chiều 12:30). Đơn cũ không có lịch riêng theo ngày nên đây là ước tính hợp lý nhất.
-- Chỉ động vào đơn "Xin nghỉ phép" chưa có nhãn; "Tự ý nghỉ (HR ghi nhận)" không có hạn đăng ký nên giữ NULL.
-- Chạy lại nhiều lần an toàn (chỉ chọn dòng timing_status IS NULL).

ALTER TABLE hr_leave_requests DISABLE TRIGGER hr_leave_00_submission;
ALTER TABLE hr_leave_requests DISABLE TRIGGER hr_leave_department_snapshot;

UPDATE hr_leave_requests r
SET timing_status = c.timing,
    registration_deadline_date = c.deadline_date,
    registration_deadline_exclusive_at = c.deadline_exclusive_at,
    first_session_start_at = c.first_start_at,
    schedule_start = c.session_start,
    schedule_version = COALESCE(r.schedule_version, 0)
FROM (
  SELECT x.request_id, s.session_start, t.deadline_date, t.deadline_exclusive_at, t.first_start_at, t.timing
  FROM hr_leave_requests x
  CROSS JOIN LATERAL (SELECT CASE WHEN x.start_session = 'Sáng' THEN time '07:45' ELSE time '12:30' END AS session_start) s
  CROSS JOIN LATERAL hr_leave_calculate_timing(x.start_date, s.session_start, x.tong_buoi_nghi, x.thoi_gian_gui) t
  WHERE x.timing_status IS NULL
    AND x.loai_yeu_cau = 'Xin nghỉ phép'
    AND x.start_date IS NOT NULL
    AND x.tong_buoi_nghi > 0
    AND x.thoi_gian_gui IS NOT NULL
) c
WHERE r.request_id = c.request_id;

ALTER TABLE hr_leave_requests ENABLE TRIGGER hr_leave_department_snapshot;
ALTER TABLE hr_leave_requests ENABLE TRIGGER hr_leave_00_submission;
