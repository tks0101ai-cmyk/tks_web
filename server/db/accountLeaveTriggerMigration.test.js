'use strict';
// Chạy SQL migration thật trên PGlite: 0016 → 0042 (trigger cũ dựa trên HR) rồi 0081, 0082 (tài khoản hóa).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const DIR = path.join(__dirname, 'migrations');
const U1 = '11111111-1111-1111-1111-111111111111'; // liên kết HR #1, HR nói Sài Gòn/KHO nhưng tài khoản là Hà Nội/Sale HN
const U2 = '22222222-2222-2222-2222-222222222222'; // không liên kết HR
const U3 = '33333333-3333-3333-3333-333333333333'; // bị khóa
const U4 = '44444444-4444-4444-4444-444444444444'; // đã xóa
const U5 = '55555555-5555-5555-5555-555555555555'; // chưa có cơ sở công tác
const U6 = '66666666-6666-6666-6666-666666666666'; // dùng chung HR #2 với U7 (lịch cũ phải sao sang cả hai)
const U7 = '77777777-7777-7777-7777-777777777777';

const run = (db, file) => db.exec(fs.readFileSync(path.join(DIR, file), 'utf8'));

async function fixture() {
  const db = new PGlite();
  await db.exec(`CREATE ROLE reporting_readonly;
    CREATE TABLE hr_employees(id BIGINT PRIMARY KEY, bo_phan TEXT, branch TEXT, is_active BOOLEAN DEFAULT true, ho_ten TEXT DEFAULT 'A', updated_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE app_users(id UUID PRIMARY KEY, username TEXT, ho_ten TEXT DEFAULT '', is_deleted BOOLEAN DEFAULT false, vai_tro TEXT,
      trang_thai TEXT, feature_permissions JSONB DEFAULT '{}', hr_employee_id BIGINT, telegram_id TEXT DEFAULT '',
      hr_managed BOOLEAN DEFAULT false, vai_tro_override TEXT DEFAULT '', sheet_vai_tro TEXT DEFAULT '',
      co_so TEXT DEFAULT 'both', co_so_override TEXT DEFAULT '', sheet_co_so TEXT DEFAULT '', updated_at TIMESTAMPTZ DEFAULT now());
    INSERT INTO hr_employees(id,bo_phan,branch) VALUES (1,'KHO','saigon'),(2,'Kế toán','hanoi');
    INSERT INTO app_users(id,username,vai_tro,trang_thai,hr_employee_id,is_deleted,co_so) VALUES
      ('${U1}','u1','Nhân viên kho','Đang hoạt động',1,false,'both'),
      ('${U2}','u2','Nhân viên sale','Đang hoạt động',NULL,false,'hanoi'),
      ('${U3}','u3','Nhân viên sale','Đã khóa',NULL,false,'hanoi'),
      ('${U4}','u4','Nhân viên sale','Đang hoạt động',NULL,true,'hanoi'),
      ('${U5}','u5','Nhân viên sale','Đang hoạt động',NULL,false,'both'),
      ('${U6}','u6','Kế toán','Đang hoạt động',2,false,'hanoi'),
      ('${U7}','u7','Kế toán','Đang hoạt động',2,false,'hanoi');`);
  for (const f of ['0016_hr_leave_telegram.sql', '0029_hr_manager_telegram.sql', '0030_drop_leave_provisional_status.sql',
    '0031_hr_leave_approval_scope.sql', '0038_hr_leave_deadlines.sql', '0042_hr_leave_unlinked_accounts.sql']) await run(db, f);
  // Dữ liệu trước khi tách: lịch theo hồ sơ HR và một đơn cũ đã duyệt.
  await db.exec(`INSERT INTO hr_leave_work_schedules(employee_id,work_date,morning_start,afternoon_start) VALUES (2,'2030-01-07','09:00','14:00');
    INSERT INTO hr_leave_requests(request_id,user_id,branch,start_date,start_session,end_date,end_session,tong_buoi_nghi)
      VALUES ('OLD','${U6}','hanoi','2030-01-07','Sáng','2030-01-07','Chiều',2);
    UPDATE hr_leave_requests SET trang_thai='Đã duyệt' WHERE request_id='OLD';`);
  await run(db, '0081_account_hr_decoupling.sql');
  // Sau 0081: cơ sở/bộ phận công tác do tài khoản quyết định (khác HR để chứng minh không đọc HR).
  await db.exec(`UPDATE app_users SET work_branch='hanoi', bo_phan='Sale HN' WHERE id='${U1}';
    UPDATE app_users SET work_branch='hanoi', bo_phan='Marketing' WHERE id IN ('${U2}','${U3}','${U4}');
    UPDATE app_users SET work_branch='', bo_phan='Marketing' WHERE id='${U5}';
    UPDATE hr_employees SET bo_phan='KHO SG ĐÃ ĐỔI', branch='saigon' WHERE id=1;`);
  await run(db, '0082_hr_leave_account_schedules.sql');
  return db;
}

const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const insert = (id, user, { branch = 'hanoi', date = '2030-01-07', extra = {} } = {}) => {
  const cols = { request_id: `'${id}'`, branch: `'${branch}'`, start_date: `'${date}'`, start_session: "'Sáng'", end_date: `'${date}'`, end_session: "'Chiều'", tong_buoi_nghi: '2', source: "'web'", ...extra };
  if (user) cols.user_id = `'${user}'`;
  return `INSERT INTO hr_leave_requests(${Object.keys(cols).join(',')}) VALUES (${Object.values(cols).join(',')})`;
};

test('0081+0082: đơn mới lấy cơ sở/bộ phận từ app_users, lịch theo user_id, lịch sử ghi user_id', async () => {
  const db = await fixture();
  try {
    await db.exec(`INSERT INTO hr_leave_work_schedules(user_id,work_date,morning_start,afternoon_start) VALUES ('${U1}','2030-01-08','08:30','13:30')`);
    await db.exec(insert('N1', U1, { date: '2030-01-08' }));
    const row = await one(db, "SELECT * FROM hr_leave_requests WHERE request_id='N1'");
    assert.equal(row.bo_phan, 'Sale HN', 'bộ phận lấy từ tài khoản, không lấy từ HR');
    assert.equal(row.branch, 'hanoi');
    assert.equal(row.schedule_start, '08:30:00', 'giờ bắt đầu tra theo user_id + ngày');
    assert.equal(String(row.schedule_version), '1');
    assert.equal(row.hr_employee_id, null, 'đơn mới không suy ra hr_employee_id từ liên kết HR');
    assert.equal(row.submission_revision, 1);
    assert.equal(row.timing_status, 'Đúng hạn');
    const history = await one(db, "SELECT user_id, submission_revision FROM hr_leave_submissions WHERE request_id='N1'");
    assert.equal(history.user_id, U1);

    // Tài khoản không có HR vẫn xin nghỉ được; không có lịch riêng thì dùng giờ mặc định.
    await db.exec(insert('N2', U2, { date: '2030-01-09' }));
    const n2 = await one(db, "SELECT bo_phan, schedule_start, schedule_version FROM hr_leave_requests WHERE request_id='N2'");
    assert.deepEqual([n2.bo_phan, n2.schedule_start, String(n2.schedule_version)], ['Marketing', '07:45:00', '0']);

    // Lịch chỉ theo employee_id (dữ liệu cũ) không quyết định đơn mới.
    await db.exec(`INSERT INTO hr_leave_work_schedules(employee_id,work_date,morning_start) VALUES (1,'2030-01-10','10:00')`);
    await db.exec(insert('N3', U1, { date: '2030-01-10' }));
    assert.equal((await one(db, "SELECT schedule_start FROM hr_leave_requests WHERE request_id='N3'")).schedule_start, '07:45:00');
  } finally { await db.close(); }
});

test('0082: chặn tài khoản khóa/đã xóa/chưa có cơ sở công tác và đơn khác cơ sở công tác', async () => {
  const db = await fixture();
  try {
    for (const user of [U3, U4, U5]) {
      await assert.rejects(db.exec(insert(`X-${user.slice(0, 2)}`, user)), /LEAVE_IDENTITY_MISMATCH/);
    }
    await assert.rejects(db.exec(insert('XB', U1, { branch: 'saigon' })), /LEAVE_IDENTITY_MISMATCH/, 'HR nói Sài Gòn nhưng tài khoản làm ở Hà Nội');
    await assert.rejects(db.exec(insert('XN', null, { extra: { source: "'telegram'" } })), /LEAVE_IDENTITY_MISMATCH/, 'đơn mới phải có tài khoản');
    assert.equal((await one(db, "SELECT count(*)::int AS n FROM hr_leave_submissions WHERE request_id LIKE 'X%'")).n, 0);
  } finally { await db.close(); }
});

test('0082: bot Telegram (chat id hoặc hr_employee_id cũ) được quy về tài khoản đang hoạt động', async () => {
  const db = await fixture();
  try {
    await db.exec(`INSERT INTO hr_telegram_links(user_id,status,link_method,telegram_chat_id,linked_at) VALUES ('${U2}','linked','manual','999',now())`);
    await db.exec(insert('T1', null, { extra: { source: "'telegram'", telegram_chat_id: "'999'" } }));
    const t1 = await one(db, "SELECT user_id, bo_phan FROM hr_leave_requests WHERE request_id='T1'");
    assert.deepEqual([t1.user_id, t1.bo_phan], [U2, 'Marketing']);

    await db.exec(insert('T2', null, { extra: { source: "'telegram'", hr_employee_id: '1' } }));
    const t2 = await one(db, "SELECT user_id, hr_employee_id, bo_phan FROM hr_leave_requests WHERE request_id='T2'");
    assert.deepEqual([t2.user_id, String(t2.hr_employee_id), t2.bo_phan], [U1, '1', 'Sale HN'], 'giữ hr_employee_id bot gửi, phạm vi lấy từ tài khoản');

    // HR #2 có hai tài khoản liên kết: không đoán được người gửi.
    await assert.rejects(db.exec(insert('T3', null, { extra: { source: "'telegram'", hr_employee_id: '2' } })), /LEAVE_IDENTITY_MISMATCH/);
  } finally { await db.close(); }
});

test('0082: sửa đơn tính lại theo lịch user_id, tăng revision, giữ định danh và hr_employee_id lịch sử', async () => {
  const db = await fixture();
  try {
    // Đơn cũ trước tách có hr_employee_id=2; lịch HR cũ đã được sao sang cả hai tài khoản liên kết.
    const old = await one(db, "SELECT hr_employee_id, bo_phan, trang_thai, submission_revision FROM hr_leave_requests WHERE request_id='OLD'");
    assert.deepEqual([String(old.hr_employee_id), old.bo_phan, old.trang_thai, old.submission_revision], ['2', 'Kế toán', 'Đã duyệt', 1]);
    for (const user of [U6, U7]) {
      const s = await one(db, `SELECT morning_start::text AS m FROM hr_leave_work_schedules WHERE user_id='${user}' AND work_date='2030-01-07'`);
      assert.equal(s && s.m, '09:00:00', `lịch cũ sao sang tài khoản ${user}`);
    }
    assert.equal((await one(db, "SELECT count(*)::int AS n FROM hr_leave_work_schedules WHERE employee_id=2 AND work_date='2030-01-07'")).n, 1, 'dòng lịch cũ theo employee_id vẫn còn');

    await db.exec(`UPDATE app_users SET work_branch='hanoi', bo_phan='Kế toán' WHERE id='${U6}'`);
    await db.exec(`INSERT INTO hr_leave_work_schedules(user_id,work_date,afternoon_start) VALUES ('${U6}','2030-01-11','15:00')`);
    await db.exec("UPDATE hr_leave_requests SET start_date='2030-01-11', start_session='Chiều', end_date='2030-01-11', end_session='Chiều', user_id=NULL, hr_employee_id=NULL WHERE request_id='OLD'");
    const row = await one(db, "SELECT * FROM hr_leave_requests WHERE request_id='OLD'");
    assert.equal(row.user_id, U6, 'định danh không đổi khi sửa');
    assert.equal(String(row.hr_employee_id), '2', 'hr_employee_id lịch sử được giữ');
    assert.equal(row.schedule_start, '15:00:00');
    assert.equal(row.submission_revision, 2);
    assert.equal(row.trang_thai, 'Chưa duyệt');
    assert.equal(row.bo_phan, 'Kế toán', 'snapshot bộ phận không đổi khi sửa');
    const history = (await db.query("SELECT submission_revision, user_id FROM hr_leave_submissions WHERE request_id='OLD' ORDER BY 1")).rows;
    assert.deepEqual(history.map(h => [h.submission_revision, h.user_id]), [[1, null], [2, U6]]);

    // Sửa khi tài khoản đã bị khóa thì bị chặn.
    await db.exec(`UPDATE app_users SET trang_thai='Đã khóa' WHERE id='${U6}'`);
    await assert.rejects(db.exec("UPDATE hr_leave_requests SET start_date='2030-01-12', end_date='2030-01-12' WHERE request_id='OLD'"), /LEAVE_IDENTITY_MISMATCH/);
  } finally { await db.close(); }
});

test('0082: trigger snapshot bộ phận không còn đọc hr_employees', async () => {
  const db = await fixture();
  try {
    const fn = await one(db, "SELECT prosrc FROM pg_proc WHERE proname='hr_leave_department_snapshot'");
    assert.doesNotMatch(fn.prosrc, /hr_employees/);
    const fn2 = await one(db, "SELECT prosrc FROM pg_proc WHERE proname='hr_leave_submission_snapshot'");
    assert.doesNotMatch(fn2.prosrc, /FROM hr_employees/);
  } finally { await db.close(); }
});

test('resubmitLeaveRequest thật: kiểm tra phiên bản, chủ đơn, tài khoản đang hoạt động và cơ sở công tác; không dựa vào hr_employee_id', async () => {
  const db = await fixture();
  try {
    const { createHrLeaveRepository } = require('../hr/hrLeaveRepository');
    const repo = createHrLeaveRepository({ pool: db });
    await db.exec(`INSERT INTO hr_leave_work_schedules(user_id,work_date,morning_start,afternoon_start) VALUES ('${U1}','2030-01-14','08:15','13:00')`);
    const created = await repo.createLeaveRequest({ user_id: U1, source: 'web', start_date: '2030-01-14', start_session: 'Sáng', end_date: '2030-01-14', end_session: 'Chiều', tong_buoi_nghi: 2 }, 'Hà Nội');
    assert.ok(!created.hr_employee_id, 'đơn mới không có hr_employee_id');
    const payload = { userId: U1, expectedVersion: '0', start_date: '2030-01-14', start_session: 'Sáng', end_date: '2030-01-14', end_session: 'Chiều', leave_sessions: created.leave_sessions, ly_do: 'Lý do mới', nguoi_ban_giao: '' };
    const resent = await repo.resubmitLeaveRequest(created.request_id, payload, 'Hà Nội');
    assert.equal(resent.submission_revision, 2);
    assert.equal(resent.decision_version, '1');
    assert.equal((await repo.getSubmissionHistory(created.request_id)).length, 2);
    await assert.rejects(repo.resubmitLeaveRequest(created.request_id, payload, 'Hà Nội'), { statusCode: 409 }, 'phiên bản cũ');
    await assert.rejects(repo.resubmitLeaveRequest(created.request_id, { ...payload, userId: U2, expectedVersion: '1' }, 'Hà Nội'), { statusCode: 409 }, 'không phải chủ đơn');

    // Đổi liên kết HR không còn ảnh hưởng: định danh là tài khoản.
    await db.exec(`UPDATE app_users SET hr_employee_id=2 WHERE id='${U1}'`);
    const again = await repo.resubmitLeaveRequest(created.request_id, { ...payload, expectedVersion: '1', ly_do: 'Lần 3' }, 'Hà Nội');
    assert.equal(again.submission_revision, 3);

    await db.exec(`UPDATE app_users SET work_branch='saigon' WHERE id='${U1}'`);
    await assert.rejects(repo.resubmitLeaveRequest(created.request_id, { ...payload, expectedVersion: '2' }, 'Hà Nội'), { statusCode: 409 }, 'đổi cơ sở công tác');
    await db.exec(`UPDATE app_users SET work_branch='hanoi', trang_thai='Đã khóa' WHERE id='${U1}'`);
    await assert.rejects(repo.resubmitLeaveRequest(created.request_id, { ...payload, expectedVersion: '2' }, 'Hà Nội'), { statusCode: 409 }, 'tài khoản bị khóa');
    assert.equal((await repo.getSubmissionHistory(created.request_id)).length, 3);
  } finally { await db.close(); }
});

test('hrLeaveWorkSchedulesRepository thật trên schema 0082: tài khoản, lịch theo user_id và lịch cũ theo employee_id', async () => {
  const db = await fixture();
  try {
    const repo = require('../hr/hrLeaveWorkSchedulesRepository').createHrLeaveWorkSchedulesRepository({ pool: db });
    const account = await repo.getAccount(U1);
    assert.deepEqual([account.user_id, account.branch, account.bo_phan], [U1, 'hanoi', 'Sale HN']);
    for (const user of [U3, U4, U5]) assert.equal(await repo.getAccount(user), null, 'khóa/xóa/chưa có cơ sở công tác');
    assert.equal((await repo.resolveAccount({ username: 'U2' })).user_id, U2);
    assert.equal((await repo.resolveAccount({ employeeId: 1 })).user_id, U1);
    assert.equal(await repo.resolveAccount({ employeeId: 2 }), null, 'hồ sơ có hai tài khoản liên kết không đoán');
    const listed = (await repo.listAccounts()).map(a => a.user_id);
    assert.ok(listed.includes(U1) && listed.includes(U2));
    assert.ok(!listed.includes(U3) && !listed.includes(U5));

    const saved = await repo.setScheduleForUser(U2, { date: '2030-02-01', morningStart: '08:00', afternoonStart: null });
    assert.deepEqual([saved.userId, saved.morningStart, saved.afternoonStart, saved.version], [U2, '08:00', '12:30', '1']);
    const updated = await repo.setScheduleForUser(U2, { date: '2030-02-01', morningStart: '09:00', afternoonStart: '13:00' });
    assert.equal(updated.version, '2');
    assert.equal((await repo.getScheduleForUser(U2, '2030-02-01')).morningStart, '09:00');
    // Hàm cũ theo employee_id vẫn chạy trên chỉ mục một phần mới (đọc/sửa dữ liệu lịch sử).
    const legacy = await repo.setSchedule('1', { date: '2030-02-02', morningStart: '08:30', afternoonStart: null });
    assert.equal(legacy.morningStart, '08:30');
    assert.equal((await repo.setSchedule('1', { date: '2030-02-02', morningStart: null, afternoonStart: null })).version, '2');
  } finally { await db.close(); }
});

test('0120: ghi đè nhãn thời hạn theo tài khoản', async () => {
  const db = await fixture();
  try {
    await run(db, '0120_hr_leave_timing_overrides.sql');
    await db.exec(`INSERT INTO hr_leave_timing_overrides(user_id) VALUES ('${U2}')`);
    const vn = async offset => (await one(db, `SELECT to_char((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + ${offset}, 'YYYY-MM-DD') AS d`)).d;
    const tomorrow = await vn(1); // quá hạn (hạn = hết ngày trước đó 1 ngày) nhưng chưa tới giờ bắt đầu → "Xin muộn"
    const yesterday = await vn(-1); // đã qua giờ bắt đầu → "Vi phạm"
    await db.exec(insert('L1', U1, { date: tomorrow }));
    await db.exec(insert('L2', U2, { date: tomorrow }));
    await db.exec(insert('V1', U1, { date: yesterday }));
    await db.exec(insert('V2', U2, { date: yesterday }));
    const st = async id => (await one(db, `SELECT timing_status FROM hr_leave_requests WHERE request_id='${id}'`)).timing_status;
    assert.equal(await st('L1'), 'Xin muộn', 'tài khoản không có ghi đè');
    assert.equal(await st('L2'), 'Đúng hạn', 'tài khoản có ghi đè');
    assert.equal(await st('V1'), 'Vi phạm');
    assert.equal(await st('V2'), 'Vi phạm', 'Vi phạm không bị ghi đè');
    assert.equal((await one(db, "SELECT timing_status FROM hr_leave_submissions WHERE request_id='L2'")).timing_status, 'Đúng hạn', 'lịch sử ghi nhãn sau ghi đè');

    // Sửa đơn (đổi lịch → revision tăng) vẫn áp ghi đè; UPDATE thường không đổi nhãn.
    await db.exec(`UPDATE hr_leave_requests SET start_date='${await vn(2)}', end_date='${await vn(2)}' WHERE request_id='L2'`);
    assert.equal(await st('L2'), 'Đúng hạn');
    await db.exec("UPDATE hr_leave_requests SET ly_do='đổi lý do' WHERE request_id='L1'");
    assert.equal(await st('L1'), 'Xin muộn');
  } finally { await db.close(); }
});
