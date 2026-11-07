'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const svc = require('./adminUserExportService');

const USERS = [
  { id: 'u1', username: 'binh', hoTen: 'Bình', email: 'b@x.com', soDienThoai: '0900000002', telegramId: '123456789012', vaiTro: 'Kế toán', coSo: 'Hà Nội', trangThai: 'Đang hoạt động', passwordHash: 'SECRET_HASH', featurePermissions: { 'reports.debt.edit': true } },
  { id: 'u2', username: 'an', hoTen: 'An', email: 'a@x.com', vaiTro: 'Nhân viên kho', coSo: 'Cả hai', trangThai: 'Khóa', lockReason: 'manual', hrManaged: true, passwordHash: '' },
  { id: 'u3', username: 'cuong', hoTen: 'Cường', vaiTro: 'Khách', coSo: 'Sài Gòn', trangThai: 'Chờ duyệt' }
];

async function load(fieldKeys, filters) {
  const { buffer, fileName } = await svc.buildUserWorkbook(USERS, filters, fieldKeys);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = wb.worksheets[0];
  const rows = [];
  sheet.eachRow((row, i) => { if (i > 1) rows.push(row.values.slice(1)); });
  return { fileName, headers: sheet.getRow(1).values.slice(1), rows };
}

test('parseFieldKeys: giữ thứ tự cột chuẩn, bỏ khóa lạ, rỗng -> null', () => {
  assert.deepEqual(svc.parseFieldKeys('email,hoTen,passwordHash,zzz'), ['hoTen', 'email']);
  assert.equal(svc.parseFieldKeys(''), null);
  assert.equal(svc.parseFieldKeys('passwordHash'), null);
  assert.equal(svc.parseFieldKeys(undefined), null);
});

test('chỉ xuất các trường được chọn, sắp theo họ tên', async () => {
  const { headers, rows } = await load(['hoTen', 'vaiTro'], {});
  assert.deepEqual(headers, ['Họ và tên', 'Vai trò']);
  assert.deepEqual(rows.map(r => r[0]), ['An', 'Bình', 'Cường']);
});

test('xuất đầy đủ mọi trường, không lộ mật khẩu', async () => {
  const { headers, rows } = await load(svc.FIELD_KEYS, {});
  assert.equal(headers.length, svc.FIELD_KEYS.length);
  assert.ok(!JSON.stringify(rows).includes('SECRET_HASH'));
  const binh = rows.find(r => r[0] === 'Bình');
  assert.ok(binh.includes('Công nợ: đổi trạng thái xử lý, kể cả các ngày cũ trong lịch sử 7 ngày của khách (cần Công nợ)'));
  assert.ok(binh.includes('123456789012'));
  const an = rows.find(r => r[0] === 'An');
  assert.ok(an.includes('Khóa thủ công'));
  assert.ok(an.includes('Đồng bộ HR'));
});

test('lọc giống trang Tài khoản: cơ sở HN gồm cả "Cả hai", trạng thái, từ khóa không dấu cách', async () => {
  assert.deepEqual((await load(['hoTen'], { coSo: 'Hà Nội' })).rows.map(r => r[0]), ['An', 'Bình']);
  assert.deepEqual((await load(['hoTen'], { coSo: 'Cả hai' })).rows.map(r => r[0]), ['An']);
  assert.deepEqual((await load(['hoTen'], { trangThai: 'Chờ duyệt' })).rows.map(r => r[0]), ['Cường']);
  assert.deepEqual((await load(['hoTen'], { q: ' BÌNH ' })).rows.map(r => r[0]), ['Bình']);
  assert.deepEqual((await load(['hoTen'], { q: 'binh' })).rows.map(r => r[0]), ['Bình']);
  assert.deepEqual((await load(['hoTen'], { q: 'binh zzz' })).rows.map(r => r[0]), []);
  assert.deepEqual((await load(['hoTen'], { role: 'Khách' })).rows.map(r => r[0]), ['Cường']);
});

test('ordered user export preserves all filtered rows and ignores unknown identifiers', async () => {
  const { rows }=await load(['username'],{orderedIds:JSON.stringify(['cuong','binh','not-authorized'])});
  assert.deepEqual(rows.map(row=>row[0]),['cuong','binh','an']);
  const filtered=await load(['username'],{role:'Kế toán',orderedIds:JSON.stringify(['cuong','binh'])});
  assert.deepEqual(filtered.rows.map(row=>row[0]),['binh']);
});
