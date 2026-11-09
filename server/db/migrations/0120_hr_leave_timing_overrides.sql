-- Ghi đè nhãn thời hạn đăng ký theo tài khoản.
-- Trigger chạy sau hr_leave_00_submission, chỉ hậu xử lý timing_status cho lần gửi mới.

CREATE TABLE IF NOT EXISTS hr_leave_timing_overrides (
  user_id    UUID PRIMARY KEY REFERENCES app_users(id),
  note       TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO hr_leave_timing_overrides (user_id)
SELECT u.id
FROM app_users u
WHERE u.username IN (
  'thangnnv2003@gmail.com',
  'tuanstyle0310@gmail.com',
  'doantungduong179@gmail.com',
  'chuminhvuofficial@gmail.com',
  'TRINHQUOCDU'
)
ON CONFLICT (user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION hr_leave_timing_override() RETURNS trigger AS $$
BEGIN
  IF NEW.timing_status = 'Xin muộn'
     AND (TG_OP = 'INSERT' OR NEW.submission_revision IS DISTINCT FROM OLD.submission_revision)
     AND EXISTS (SELECT 1 FROM hr_leave_timing_overrides e WHERE e.user_id = NEW.user_id) THEN
    NEW.timing_status := 'Đúng hạn';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS hr_leave_01_timing_override ON hr_leave_requests;
CREATE TRIGGER hr_leave_01_timing_override
  BEFORE INSERT OR UPDATE ON hr_leave_requests
  FOR EACH ROW EXECUTE FUNCTION hr_leave_timing_override();
