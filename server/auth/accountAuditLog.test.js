'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const accountAuditLog = require('./accountAuditLog');

function fakePool(rows = []) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/count\(\*\)/.test(sql)) return { rows: [{ total: rows.length }] };
      return { rows };
    }
  };
}

test.afterEach(() => accountAuditLog.setPool(null));

test('audit distinguishes workplace, membership and approval scope', () => {
  const changes = accountAuditLog.diffUser({}, { workCoSo: 'Hà Nội', boPhan: 'Kế toán', leaveApprovalDepartments: ['Kho HN'] });
  assert.deepEqual(changes.map(change => [change.field, change.label]), [
    ['workCoSo', 'Cơ sở công tác'], ['boPhan', 'Bộ phận trực thuộc'], ['leaveApprovalDepartments', 'Bộ phận được duyệt nghỉ']
  ]);
});

test('diffUser chỉ trả về trường thực sự đổi, chuẩn hóa chuỗi và mảng phòng ban', () => {
  const before = { hoTen: 'An ', email: 'a@x.vn', vaiTro: 'Kế toán', coSo: 'Hà Nội', leaveApprovalDepartments: ['Kho', 'Sale'], passwordHash: 'h1' };
  const after = { hoTen: 'An', email: 'b@x.vn', vaiTro: 'Kế toán', coSo: 'Sài Gòn', leaveApprovalDepartments: ['Sale', 'Kho'], passwordHash: 'h2' };
  const changes = accountAuditLog.diffUser(before, after);
  assert.deepEqual(changes.map(c => c.field), ['email', 'coSo']);
  assert.deepEqual(changes[0], { field: 'email', label: 'Email', before: 'a@x.vn', after: 'b@x.vn' });
  assert.ok(!JSON.stringify(changes).includes('h1'));
  assert.ok(!JSON.stringify(changes).includes('h2'));
});

test('initialValues bỏ trường rỗng của tài khoản mới', () => {
  const changes = accountAuditLog.initialValues({ username: 'nv1', hoTen: 'Nhân viên', vaiTro: 'Khách', email: '', passwordHash: 'x' });
  assert.deepEqual(changes.map(c => c.field), ['hoTen', 'username', 'vaiTro']);
  assert.ok(changes.every(c => c.before === ''));
});

test('diffPermissions ghi nhãn quyền thêm/bỏ theo quyền hiệu lực', () => {
  const before = { vaiTro: 'Nhân viên sale', featurePermissions: {} };
  const after = { vaiTro: 'Nhân viên sale', featurePermissions: { 'reports.export': true, 'reports.debt': false } };
  const [perm] = accountAuditLog.diffPermissions(before, after);
  assert.equal(perm.field, 'permissions');
  assert.deepEqual(perm.added, ['Xuất Excel báo cáo']);
  // Bo 'reports.debt' keo theo quyen phu thuoc 'reports.debt.saleFeedback' (requires) cua Sale.
  assert.deepEqual(perm.removed, ['Công nợ', 'Công nợ: điền Sale phản hồi (cần Công nợ)']);
  assert.deepEqual(accountAuditLog.diffPermissions(before, before), []);
});

test('record ghi đúng cột, bỏ qua update không có thay đổi', async () => {
  const pool = fakePool();
  accountAuditLog.setPool(pool);
  const actor = { id: 'a1', username: 'ql', hoTen: 'Quản lý A' };
  const target = { id: 'u1', username: 'nv', hoTen: '' };
  assert.equal(await accountAuditLog.record({ action: 'update', actor, target, changes: [] }), false);
  assert.equal(pool.calls.length, 0);
  assert.equal(await accountAuditLog.record({ action: 'reset_password', actor, target }), true);
  const { params } = pool.calls[0];
  assert.deepEqual(params, ['reset_password', 'a1', 'ql', 'Quản lý A', 'u1', 'nv', 'nv', '[]']);
});

test('record nuốt lỗi DB (best-effort, không làm hỏng thao tác)', async () => {
  accountAuditLog.setPool({ query: async () => { throw new Error('db down'); } });
  const origError = console.error;
  console.error = () => {};
  try {
    assert.equal(await accountAuditLog.record({ action: 'delete', actor: { id: 'a' }, target: { id: 'b' } }), false);
  } finally {
    console.error = origError;
  }
});

test('listEntries lọc ở SQL, escape ký tự LIKE, phân trang', async () => {
  const pool = fakePool([{ id: 5, created_at: new Date('2026-10-08T03:00:00Z'), action: 'update', actor_user_id: 'a', actor_username: 'ql', actor_name: 'QL', target_user_id: 'u', target_username: 'nv', target_name: 'NV', changes: [{ field: 'hoTen' }] }]);
  accountAuditLog.setPool(pool);
  const result = await accountAuditLog.listEntries({ q: '50%_x', action: 'update', from: '2026-10-01', to: '2026-10-08', page: '2', pageSize: '500' });
  assert.equal(result.total, 1);
  assert.equal(result.pageSize, 100);
  assert.equal(result.entries[0].createdAt, '2026-10-08T03:00:00.000Z');
  assert.equal(result.entries[0].actor.name, 'QL');
  const listCall = pool.calls[1];
  assert.match(listCall.sql, /Asia\/Ho_Chi_Minh/);
  assert.equal(listCall.params[0], '50%_x'); // tim gan dung: tu khoa la tham so, khong can escape LIKE
  assert.deepEqual(listCall.params.slice(-2), [100, 0]);
  const none = await accountAuditLog.listEntries({ action: 'drop table', from: '01/10/2026' });
  assert.equal(pool.calls[2].params.length, 0);
  assert.equal(none.page, 1);
  // Nhieu tu: moi tu + cum la tham so; SQL bo dau, yeu cau khop du so tu va xep khop nhieu tu truoc.
  await accountAuditLog.listEntries({ q: 'Nguyễn Văn' });
  const fz = pool.calls[pool.calls.length - 1];
  assert.deepEqual(fz.params.slice(0, 3), ['nguyen', 'van', 'nguyen van']);
  assert.match(fz.sql, />=2/);
  assert.match(fz.sql, /ORDER BY .*DESC, created_at DESC/s);
});

 test('audit clamps pages and applies whitelisted sort layers before LIMIT', async () => {
  const pool = fakePool([{ id: 1, created_at: '2026-01-01' }]);
  accountAuditLog.setPool(pool);
  const result = await accountAuditLog.listEntries({ page: 99, pageSize: 1, sorts: JSON.stringify([{ key: 'actor', dir: 'asc' }, { key: 'createdAt', dir: 'desc' }]) });
  assert.equal(result.page, 1);
  assert.equal(result.totalRows, 1);
  assert.deepEqual(result.rows, result.entries);
  assert.match(pool.calls[1].sql, /ORDER BY COALESCE\(NULLIF\(actor_name, ''\), actor_username\) ASC NULLS LAST, created_at DESC NULLS LAST, id DESC/);
  await assert.rejects(accountAuditLog.listEntries({ sorts: '[{"key":"drop table","dir":"asc"}]' }), { code: 'INVALID_SORT' });
 });

test('audit query executes full-result ordering/filtering/clamping in SQL', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE account_audit_log (
      id bigint, created_at timestamptz, action text, actor_user_id text, actor_username text, actor_name text,
      target_user_id text, target_username text, target_name text, changes jsonb
    );
    INSERT INTO account_audit_log
      SELECT n, '2026-11-01 10:00:00+07'::timestamptz + n * interval '1 second',
      CASE WHEN n % 2 = 0 THEN 'update' ELSE 'delete' END, 'a', 'manager',
      CASE WHEN n <= 100 THEN 'Zed' ELSE 'An' END, 'u', 'user', 'Bình', '[]'::jsonb
      FROM generate_series(1,205) n;`);
    accountAuditLog.setPool(db);
    const options = { pageSize: 50, sorts: [{ key: 'actor', dir: 'asc' }, { key: 'createdAt', dir: 'desc' }] };
    const first = await accountAuditLog.listEntries(options);
    assert.equal(first.totalRows, 205);
    assert.equal(first.rows.length, 50);
    assert.equal(first.rows[0].id, '205');
    assert.equal(first.rows[49].id, '156');
    const second = await accountAuditLog.listEntries({ ...options, page: 2 });
    assert.equal(second.rows[0].id, '155');
    const last = await accountAuditLog.listEntries({ ...options, page: 99, action: 'update' });
    assert.equal(last.page, 3);
    assert.equal(last.totalRows, 102);
    assert.deepEqual(last.rows.map(row => row.id), ['4', '2']);
    const empty = await accountAuditLog.listEntries({ targetId: 'unknown', page: 99 });
    assert.equal(empty.page, 1);
    assert.equal(empty.totalRows, 0);
    assert.deepEqual(empty.rows, []);
  } finally { await db.close(); }
});

test('audit count and page use a read-only repeatable snapshot and release connection', async () => {
  const client = fakePool([{ id: 1, created_at: '2026-11-01' }]);
  let released = 0;
  client.release = () => { released++; };
  accountAuditLog.setPool({ connect: async () => client });
  await accountAuditLog.listEntries({ page: 4 });
  assert.equal(client.calls[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(client.calls[3].sql, 'COMMIT');
  assert.equal(released, 1);
  client.query = async sql => { if(sql.startsWith('SELECT')) throw new Error('test failure'); client.calls.push({ sql }); return { rows: [] }; };
  await assert.rejects(accountAuditLog.listEntries(), /test failure/);
  assert.equal(client.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(released, 2);
});
