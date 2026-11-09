'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const UID = '11111111-1111-1111-1111-111111111111';
const dir = path.join(__dirname, '../db/migrations');

async function fixture() {
  const db = new PGlite();
  await db.exec(`CREATE ROLE reporting_readonly;
 CREATE TABLE hr_employees(id BIGINT PRIMARY KEY,bo_phan TEXT,branch TEXT,is_active BOOLEAN DEFAULT true,ho_ten TEXT DEFAULT 'A');
 CREATE TABLE app_users(id UUID PRIMARY KEY,username TEXT,is_deleted BOOLEAN DEFAULT false,vai_tro TEXT,trang_thai TEXT,feature_permissions JSONB DEFAULT '{}',hr_employee_id BIGINT,telegram_id TEXT DEFAULT '',updated_at TIMESTAMPTZ DEFAULT now());
 INSERT INTO hr_employees(id,bo_phan,branch,is_active) VALUES(1,'KHO','hanoi',true);
 INSERT INTO app_users(id,username,vai_tro,trang_thai,hr_employee_id) VALUES('${UID}','a','Nhân viên kho','Đang hoạt động',1);`);
  for (const f of ['0016_hr_leave_telegram.sql', '0029_hr_manager_telegram.sql', '0030_drop_leave_provisional_status.sql', '0031_hr_leave_approval_scope.sql']) {
    await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
  // Đơn cũ chèn TRƯỚC 0038 (không có nhãn): thoi_gian_gui đặt tay để kiểm từng nhãn.
  const legacy = (id, start, session, total, sent, extra = '') => `INSERT INTO hr_leave_requests(request_id,user_id,branch,start_date,start_session,end_date,end_session,tong_buoi_nghi,thoi_gian_gui,trang_thai,bo_phan ${extra ? ',' + extra.split('|')[0] : ''}) VALUES('${id}','${UID}','hanoi','${start}','${session}','${start}','Chiều',${total},'${sent}','Đã duyệt','KHO' ${extra ? ',' + extra.split('|')[1] : ''});`;
  await db.exec(legacy('ONTIME', '2026-10-10', 'Sáng', 2, '2026-10-07T02:00:00Z'));          // hạn 08/10 hết ngày → còn trước hạn
  await db.exec(legacy('LATE', '2026-10-10', 'Sáng', 2, '2026-10-08T20:00:00Z'));            // 09/10 03:00 VN → sau hạn, trước giờ nghỉ
  await db.exec(legacy('VIOL', '2026-10-10', 'Sáng', 2, '2026-10-10T01:00:00Z'));            // 08:00 VN ≥ 07:45 → vi phạm
  await db.exec(legacy('LONG', '2026-10-10', 'Sáng', 4, '2026-10-06T16:59:59Z'));            // >2 buổi: hạn 07/10; 23:59:59 VN 06/10
  await db.exec(legacy('MANUAL', '2026-10-10', 'Sáng', 2, '2026-10-12T00:00:00Z', "loai_yeu_cau|'Tự ý nghỉ (HR ghi nhận)'"));
  await db.exec(fs.readFileSync(path.join(dir, '0038_hr_leave_deadlines.sql'), 'utf8'));
  return db;
}

test('0119 điền nhãn + hạn đăng ký cho đơn cũ mà không đổi giờ gửi, trạng thái duyệt, lịch sử gửi', async () => {
  const db = await fixture();
  try {
    const before = Object.fromEntries((await db.query(`SELECT request_id,thoi_gian_gui,trang_thai,decision_version,submission_revision,bo_phan,updated_at FROM hr_leave_requests`)).rows.map(r => [r.request_id, r]));
    const historyBefore = (await db.query('SELECT count(*)::int AS n FROM hr_leave_submissions')).rows[0].n;
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM hr_leave_requests WHERE timing_status IS NOT NULL`)).rows[0].n, 0);

    const sql = fs.readFileSync(path.join(dir, '0119_hr_leave_backfill_timing.sql'), 'utf8');
    await db.exec(sql);

    const rows = Object.fromEntries((await db.query(`SELECT request_id,timing_status,registration_deadline_date::text AS d,thoi_gian_gui,trang_thai,decision_version,submission_revision,bo_phan FROM hr_leave_requests`)).rows.map(r => [r.request_id, r]));
    assert.equal(rows.ONTIME.timing_status, 'Đúng hạn');
    assert.equal(rows.ONTIME.d, '2026-10-08');
    assert.equal(rows.LATE.timing_status, 'Xin muộn');
    assert.equal(rows.VIOL.timing_status, 'Vi phạm');
    assert.equal(rows.LONG.d, '2026-10-07');
    assert.equal(rows.LONG.timing_status, 'Đúng hạn');
    assert.equal(rows.MANUAL.timing_status, null, 'Tự ý nghỉ không có hạn đăng ký');
    assert.equal(rows.MANUAL.d, null);

    for (const id of Object.keys(before)) {
      assert.deepEqual(rows[id].thoi_gian_gui, before[id].thoi_gian_gui, id + ': giờ gửi giữ nguyên');
      assert.equal(rows[id].trang_thai, before[id].trang_thai, id + ': trạng thái duyệt giữ nguyên');
      assert.equal(rows[id].decision_version, before[id].decision_version, id + ': decision_version giữ nguyên');
      assert.equal(rows[id].submission_revision, 0, id + ': vẫn revision 0');
      assert.equal(rows[id].bo_phan, before[id].bo_phan);
    }
    assert.equal((await db.query('SELECT count(*)::int AS n FROM hr_leave_submissions')).rows[0].n, historyBefore, 'không ghi thêm lịch sử gửi');

    // Trigger phải được bật lại: UPDATE thường không được tự đổi nhãn nữa.
    await db.exec(`UPDATE hr_leave_requests SET timing_status='Vi phạm' WHERE request_id='ONTIME'`);
    assert.equal((await db.query(`SELECT timing_status FROM hr_leave_requests WHERE request_id='ONTIME'`)).rows[0].timing_status, 'Đúng hạn');

    // Chạy lại không đổi gì.
    await db.exec(sql);
    assert.equal((await db.query(`SELECT timing_status FROM hr_leave_requests WHERE request_id='LATE'`)).rows[0].timing_status, 'Xin muộn');
  } finally { await db.close(); }
});
