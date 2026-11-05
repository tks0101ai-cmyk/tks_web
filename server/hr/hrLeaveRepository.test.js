'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHrLeaveRepository, LEAVE_STATUS, LEAVE_TYPE } = require('./hrLeaveRepository');

const USER_ID = '11111111-1111-1111-1111-111111111111';

function dbRow(overrides = {}) {
  return {
    request_id: 'NP-20260819-0001',
    telegram_chat_id: '',
    telegram_username: '',
    web_username: 'a@example.com',
    ho_ten: 'Nguyễn Văn A',
    chuc_vu: 'Nhân viên kho · Hà Nội',
    ly_do: 'Việc gia đình',
    loai_yeu_cau: LEAVE_TYPE.REQUEST,
    thoi_gian_gui: new Date('2026-08-19T08:00:00.000Z'),
    start_date: '2026-08-22',
    start_session: 'Sáng',
    end_date: '2026-08-24',
    end_session: 'Chiều',
    tong_buoi_nghi: 6,
    tong_ngay_nghi: '3.0',
    nguoi_ban_giao: '',
    trang_thai: LEAVE_STATUS.PENDING,
    nguoi_duyet: '',
    thoi_diem_duyet: null,
    ghi_chu_duyet: '',
    co_nghi_gap: false,
    co_tu_y_nghi: false,
    created_at: new Date('2026-08-19T08:00:01.000Z'),
    updated_at: new Date('2026-08-19T08:00:01.000Z'),
    tin_nhan: '',
    branch: 'hanoi',
    bo_phan: 'KHO',
    ...overrides
  };
}

function fakePool(rows = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows };
    }
  };
}

test('getLeaveRequests ánh xạ hàng DB về hình dạng cũ (mốc nghỉ dạng chuỗi, boolean, ISO)', async () => {
  const pool = fakePool([dbRow({ co_nghi_gap: true })]);
  const [item] = await createHrLeaveRepository({ pool }).getLeaveRequests({}, 'Hà Nội');

  assert.equal(item.thoi_gian_bat_dau, 'Sáng 22/08/2026');
  assert.equal(item.thoi_gian_ket_thuc, 'Chiều 24/08/2026');
  assert.equal(item.start_date, '2026-08-22');
  assert.equal(item.start_session, 'Sáng');
  assert.equal(item.end_date, '2026-08-24');
  assert.equal(item.end_session, 'Chiều');
  assert.equal(item.thoi_gian_gui, '2026-08-19T08:00:00.000Z');
  assert.equal(item.thoi_diem_duyet, '');
  assert.equal(item.tong_buoi_nghi, 6);
  assert.equal(item.tong_ngay_nghi, 3);
  assert.equal(item.co_nghi_gap, true);
  assert.equal(item.co_tu_y_nghi, false);
  assert.equal(item.co_so, 'Hà Nội');
  assert.equal(item.bo_phan, 'KHO');
});

test('getLeaveRequests lọc cơ sở/trạng thái/khoảng nghỉ trong SQL và cơ sở đổi sang mã', async () => {
  const pool = fakePool([]);
  await createHrLeaveRepository({ pool }).getLeaveRequests(
    { status: LEAVE_STATUS.APPROVED, from: '2026-08-01', to: '2026-08-31T00:00:00Z' },
    'Sài Gòn'
  );

  const { sql, params } = pool.calls[0];
  assert.deepEqual(params, [['saigon'], 'Đã duyệt', '2026-08-01', '2026-08-31']);
  assert.match(sql, /branch = ANY\(\$1::text\[\]\)/);
  assert.match(sql, /trang_thai = \$2/);
  assert.match(sql, /end_date >= \$3::date/);
  assert.match(sql, /start_date <= \$4::date/);
});

test('getLeaveRequests lọc "Vi phạm" theo nhãn thời hạn (và bản ghi cũ), không so với trạng thái duyệt', async () => {
  const pool = fakePool([]);
  await createHrLeaveRepository({ pool }).getLeaveRequests({ status: 'Vi phạm' }, 'Hà Nội');

  const { sql, params } = pool.calls[0];
  assert.deepEqual(params, [['hanoi']]);
  assert.match(sql, /timing_status = 'Vi phạm'/);
  assert.match(sql, /trang_thai = 'Vi phạm'/);
});

test('getLeaveRequests mặc định Hà Nội và từ chối cơ sở/ngày không hợp lệ', async () => {
  const pool = fakePool([]);
  const repo = createHrLeaveRepository({ pool });
  await repo.getLeaveRequests({});
  assert.deepEqual(pool.calls[0].params[0], ['hanoi']);

  await assert.rejects(repo.getLeaveRequests({}, 'Đà Nẵng'), err => err.code === 'INVALID_BRANCH');
  await assert.rejects(repo.getLeaveRequests({ from: '22/08/2026' }, 'Hà Nội'), err => err.code === 'INVALID_DATE');
  assert.equal(pool.calls.length, 1, 'không được chạy SQL khi tham số sai');
});

test('getLeaveRequests nhận danh sách cơ sở (Tất cả cơ sở) và gộp thành một truy vấn', async () => {
  const pool = fakePool([
    dbRow({ request_id: 'HN1', branch: 'hanoi' }),
    dbRow({ request_id: 'SG1', branch: 'saigon' })
  ]);
  const items = await createHrLeaveRepository({ pool }).getLeaveRequests({}, ['Hà Nội', 'Sài Gòn']);

  assert.equal(pool.calls.length, 1);
  assert.deepEqual(pool.calls[0].params[0], ['hanoi', 'saigon']);
  assert.deepEqual(items.map(i => i.co_so), ['Hà Nội', 'Sài Gòn']);
  await assert.rejects(
    createHrLeaveRepository({ pool }).getLeaveRequests({}, ['Hà Nội', 'Đà Nẵng']),
    err => err.code === 'INVALID_BRANCH'
  );
});

test('getLeaveRequests lọc theo phòng ban (không phân biệt hoa thường/khoảng trắng)', async () => {
  const pool = fakePool([
    dbRow({ request_id: 'A', bo_phan: 'KHO' }),
    dbRow({ request_id: 'B', bo_phan: 'TRỢ LÝ' }),
    dbRow({ request_id: 'C', bo_phan: null })
  ]);
  const repo = createHrLeaveRepository({ pool });

  assert.deepEqual((await repo.getLeaveRequests({ department: ' kho ' }, 'Hà Nội')).map(r => r.request_id), ['A']);
  assert.deepEqual((await repo.getLeaveRequests({ department: 'Trợ Lý' }, 'Hà Nội')).map(r => r.request_id), ['B']);
  assert.deepEqual((await repo.getLeaveRequests({ department: '' }, 'Hà Nội')).map(r => r.request_id), ['A', 'B', 'C']);
  assert.doesNotMatch(pool.calls[0].sql, /FROM hr_employees e/, 'phòng ban đọc từ snapshot của đơn, không đổi theo hồ sơ hiện tại');
});

test('getLeaveRequests lọc tên nhân viên gần đúng: bỏ dấu, hoa thường, khớp nguyên cụm xếp trước', async () => {
  const pool = fakePool([
    dbRow({ request_id: 'A', ho_ten: 'Nguyễn  Văn A', web_username: '' }),
    dbRow({ request_id: 'B', ho_ten: 'Trần Thị B', web_username: 'nguyenvana' })
  ]);
  const repo = createHrLeaveRepository({ pool });

  // Từ khóa có dấu phải khớp đúng dấu: B (username không dấu nguyenvana) không hiện. Gõ không dấu thì B hiện nhưng xếp sau A khớp nguyên cụm.
  assert.deepEqual((await repo.getLeaveRequests({ employee: ' nguyễn văn a ' }, 'Hà Nội')).map(r => r.request_id), ['A']);
  assert.deepEqual((await repo.getLeaveRequests({ employee: ' nguyen van a ' }, 'Hà Nội')).map(r => r.request_id), ['A', 'B']);
  assert.deepEqual((await repo.getLeaveRequests({ employee: 'tran zzz' }, 'Hà Nội')).map(r => r.request_id), []);
  assert.deepEqual((await repo.getLeaveRequests({ employee: 'NGUYENVANA' }, 'Hà Nội')).map(r => r.request_id), ['B']);
});

test('getLeaveRequestById trả null khi không có và có ràng buộc cơ sở', async () => {
  const pool = fakePool([]);
  const repo = createHrLeaveRepository({ pool });
  assert.equal(await repo.getLeaveRequestById('NP-X', 'Hà Nội'), null);
  assert.deepEqual(pool.calls[0].params, ['NP-X', ['hanoi']]);
});

test('createLeaveRequest ghi khoảng nghỉ dạng cấu trúc và để DB sinh mã/số ngày quy đổi', async () => {
  const pool = fakePool([dbRow({ trang_thai: LEAVE_STATUS.VIOLATION, tong_buoi_nghi: 4, tong_ngay_nghi: '2.0' })]);
  const record = await createHrLeaveRepository({ pool }).createLeaveRequest({
    ho_ten: 'Nguyễn A',
    start_date: '2026-08-22', start_session: 'Sáng',
    end_date: '2026-08-24', end_session: 'Chiều',
    tong_buoi_nghi: 4,
    trang_thai: LEAVE_STATUS.VIOLATION
  }, 'Hà Nội');

  const { sql, params } = pool.calls[0];
  assert.doesNotMatch(sql.split('VALUES')[0], /request_id/, 'request_id do DB sinh, không truyền từ app');
  assert.equal(params[0], 'hanoi');
  assert.equal(params[1], 'web');
  assert.deepEqual(params.slice(13, 18), ['2026-08-22', 'Sáng', '2026-08-24', 'Chiều', 4]);
  assert.equal(record.tong_ngay_nghi, 2);
  assert.equal(record.trang_thai, 'Vi phạm');
});

test('createLeaveRequest chặn dữ liệu sai trước khi chạm DB', async () => {
  const pool = fakePool([dbRow()]);
  const repo = createHrLeaveRepository({ pool });
  const valid = { start_date: '2026-08-22', start_session: 'Sáng', end_date: '2026-08-22', end_session: 'Chiều', tong_buoi_nghi: 2 };

  await assert.rejects(repo.createLeaveRequest({ ...valid, tong_buoi_nghi: 0 }), err => err.code === 'INVALID_TOTAL_SESSIONS');
  await assert.rejects(repo.createLeaveRequest({ ...valid, tong_buoi_nghi: 1.5 }), err => err.code === 'INVALID_TOTAL_SESSIONS');
  await assert.rejects(repo.createLeaveRequest({ ...valid, end_session: 'Tối' }), err => err.code === 'INVALID_LEAVE_RANGE');
  await assert.rejects(repo.createLeaveRequest({ ...valid, start_date: '22/08/2026' }), err => err.code === 'INVALID_DATE');
  assert.equal(pool.calls.length, 0);
});

test('createLeaveRequest chỉ lưu user_id dạng UUID (admin cứng có id khác định dạng)', async () => {
  const pool = fakePool([dbRow()]);
  const repo = createHrLeaveRepository({ pool });
  const valid = { start_date: '2026-08-22', start_session: 'Sáng', end_date: '2026-08-22', end_session: 'Chiều', tong_buoi_nghi: 2 };

  await repo.createLeaveRequest({ ...valid, user_id: 'admin', approver_user_id: USER_ID });
  assert.equal(pool.calls[0].params[2], null);
  assert.equal(pool.calls[0].params[20], USER_ID);
});

test('createLeaveRequest bản ghi đã duyệt sẵn được đánh dấu là đã báo (bot không nhắn lại)', async () => {
  const pool = fakePool([dbRow()]);
  await createHrLeaveRepository({ pool }).createLeaveRequest({
    start_date: '2026-08-22', start_session: 'Sáng', end_date: '2026-08-22', end_session: 'Chiều', tong_buoi_nghi: 2,
    trang_thai: LEAVE_STATUS.APPROVED, thoi_diem_duyet: '2026-08-22T01:00:00.000Z'
  });
  assert.match(pool.calls[0].sql, /CASE WHEN \$22::timestamptz IS NOT NULL THEN now\(\) END/);
  assert.equal(pool.calls[0].params[21], '2026-08-22T01:00:00.000Z');
});

test('updateLeaveRequestStatus cập nhật theo mã + cơ sở, 404 khi không có, 400 khi trạng thái lạ', async () => {
  const pool = fakePool([dbRow({ trang_thai: LEAVE_STATUS.APPROVED, thoi_diem_duyet: new Date('2026-08-20T01:00:00.000Z') })]);
  const repo = createHrLeaveRepository({ pool });

  const updated = await repo.updateLeaveRequestStatus(
    'NP-20260819-0001',
    { status: LEAVE_STATUS.APPROVED, approver: 'Quản lý', approverUserId: USER_ID, note: null },
    'Hà Nội'
  );
  assert.deepEqual(pool.calls[0].params, ['NP-20260819-0001', ['hanoi'], 'Đã duyệt', 'Quản lý', USER_ID, null]);
  assert.equal(updated.thoi_diem_duyet, '2026-08-20T01:00:00.000Z');

  // Ly do tu choi luu vao ghi_chu_duyet; khong co note thi xoa ly do cu ve ''.
  assert.match(pool.calls[0].sql, /ghi_chu_duyet = COALESCE\(\$6, ''\)/);
  await repo.updateLeaveRequestStatus(
    'NP-20260819-0001',
    { status: LEAVE_STATUS.REJECTED, approver: 'Quản lý', approverUserId: USER_ID, note: 'Thiếu người trực ca' },
    'Hà Nội'
  );
  assert.deepEqual(pool.calls[1].params, ['NP-20260819-0001', ['hanoi'], 'Từ chối', 'Quản lý', USER_ID, 'Thiếu người trực ca']);

  await assert.rejects(
    repo.updateLeaveRequestStatus('X', { status: 'Lạ' }, 'Hà Nội'),
    err => err.code === 'INVALID_STATUS' && err.statusCode === 400
  );
  await assert.rejects(
    createHrLeaveRepository({ pool: fakePool([]) }).updateLeaveRequestStatus('NP-404', { status: LEAVE_STATUS.REJECTED }, 'Hà Nội'),
    err => err.code === 'LEAVE_REQUEST_NOT_FOUND' && err.statusCode === 404
  );
});

test('getUrgentFlagSummary gộp theo nhân viên và đánh dấu vượt ngưỡng', async () => {
  const CONFIG = require('../config');
  const over = CONFIG.HR_URGENT_FLAG_MONTHLY_THRESHOLD + 1;
  const rows = Array.from({ length: over }, () => ({ web_username: 'a@example.com', ho_ten: 'A' }));
  rows.push({ web_username: '', ho_ten: 'B' });
  const pool = fakePool(rows);

  const summary = await createHrLeaveRepository({ pool }).getUrgentFlagSummary('2026-08', 'Hà Nội');
  assert.deepEqual(pool.calls[0].params, [['hanoi'], '2026-08']);
  assert.equal(summary.length, 2);
  assert.equal(summary.find(e => e.ho_ten === 'A').count, over);
  assert.equal(summary.find(e => e.ho_ten === 'A').isOverThreshold, true);
  assert.equal(summary.find(e => e.ho_ten === 'B').isOverThreshold, false);
  assert.equal(summary[0].month, '2026-08');

  await assert.rejects(
    createHrLeaveRepository({ pool: fakePool([]) }).getUrgentFlagSummary('08/2026', 'Hà Nội'),
    err => err.code === 'INVALID_MONTH'
  );
});

test('leave row exposes decision_version without losing bigint precision', async () => {
  const pool = fakePool([dbRow({ decision_version: '9007199254740993' })]);
  const item = await createHrLeaveRepository({ pool }).getLeaveRequestById('NP-TEST', 'Hà Nội');
  assert.equal(item.decision_version, '9007199254740993');
});

test('manager decision adds atomic version and final-status guards without changing normal web updates', async () => {
  const pool = fakePool([dbRow({ decision_version: '8' })]);
  const repo = createHrLeaveRepository({ pool });
  await repo.updateLeaveRequestStatus('NP-TEST', { status: LEAVE_STATUS.APPROVED, expectedVersion: '7', lockFinal: true }, 'Hà Nội');
  assert.match(pool.calls[0].sql, /decision_version = \$7::bigint/);
  assert.match(pool.calls[0].sql, /trang_thai NOT IN \('Đã duyệt', 'Từ chối'\)/);
  assert.equal(pool.calls[0].params[6], '7');
  await repo.updateLeaveRequestStatus('NP-TEST', { status: LEAVE_STATUS.REJECTED }, 'Hà Nội');
  assert.doesNotMatch(pool.calls[1].sql.split('WHERE')[1].split('RETURNING')[0], /decision_version|NOT IN/);
});

test('manager conflict is 409 for an existing request and remains 404 for an absent request', async () => {
  const pool = { async query(sql) { return { rows: /^SELECT/.test(sql.trim()) ? [{ request_id: 'NP-TEST' }] : [] }; } };
  await assert.rejects(createHrLeaveRepository({ pool }).updateLeaveRequestStatus('NP-TEST',
    { status: LEAVE_STATUS.APPROVED, expectedVersion: '0', lockFinal: true }, 'Hà Nội'),
  err => err.code === 'LEAVE_DECISION_CONFLICT' && err.statusCode === 409);
  await assert.rejects(createHrLeaveRepository({ pool: fakePool([]) }).updateLeaveRequestStatus('NP-ABSENT',
    { status: LEAVE_STATUS.APPROVED, expectedVersion: '0', lockFinal: true }, 'Hà Nội'),
  err => err.code === 'LEAVE_REQUEST_NOT_FOUND' && err.statusCode === 404);
});

test('self listing filters user identity in SQL and reads stored snapshot instead of current HR', async () => {
 const pool=fakePool([dbRow({user_id:USER_ID,hr_employee_id:'7',bo_phan:'Kho cũ'})]);
 const rows=await createHrLeaveRepository({pool}).getLeaveRequests({userId:USER_ID},['Hà Nội','Sài Gòn']);
 assert.match(pool.calls[0].sql,/user_id = \$2::uuid/);
 assert.doesNotMatch(pool.calls[0].sql,/SELECT e.bo_phan/);
 assert.equal(rows[0].user_id,USER_ID); assert.equal(rows[0].hr_employee_id,'7');
 assert.equal(rows[0].bo_phan,'Kho cũ');
});
test('self creation persists trusted HR identity and department snapshot', async () => {
 const pool=fakePool([dbRow()]);await createHrLeaveRepository({pool}).createLeaveRequest({
  user_id:USER_ID,hr_employee_id:'7',bo_phan:'KHO',start_date:'2026-10-06',start_session:'Sáng',end_date:'2026-10-06',end_session:'Chiều',tong_buoi_nghi:2
 },'Hà Nội');
 assert.match(pool.calls[0].sql,/bo_phan, hr_employee_id/);assert.deepEqual(pool.calls[0].params.slice(25,27),['KHO','7']);
});
test('approval repository refuses timing violation as an approval status',async()=>{
 const pool=fakePool([]);await assert.rejects(createHrLeaveRepository({pool}).updateLeaveRequestStatus('NP-1',{status:'Vi phạm'},'Hà Nội'),{statusCode:400,code:'INVALID_STATUS'});assert.equal(pool.calls.length,0);
});
