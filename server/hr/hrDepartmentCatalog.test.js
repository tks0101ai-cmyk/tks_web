'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { departmentsFor, canonicalDepartment } = require('./hrDepartmentCatalog');

test('danh sách bộ phận cố định theo cơ sở đúng file PHÒNG BAN', () => {
  assert.deepEqual(departmentsFor('hanoi'), ['Ban quản trị', 'Trợ lý', 'Đặt hàng', 'Kế toán', 'Marketing', 'Sale HN', 'Kho HN', 'Lái xe HN', 'Hậu cần - Bảo vệ']);
  assert.deepEqual(departmentsFor('saigon'), ['Quản lý-KT SG', 'Sale SG', 'Kho SG', 'Lái xe SG', 'Hậu cần - Bảo vệ']);
  assert.deepEqual(departmentsFor('khac'), []);
});

test('canonicalDepartment: không phân biệt hoa thường/dấu và nhận tên cũ theo cơ sở', () => {
  assert.equal(canonicalDepartment('hanoi', 'BAN QUẢN TRỊ'), 'Ban quản trị');
  assert.equal(canonicalDepartment('hanoi', 'ban quan tri'), 'Ban quản trị');
  assert.equal(canonicalDepartment('hanoi', 'SALE'), 'Sale HN');
  assert.equal(canonicalDepartment('saigon', 'SALE'), 'Sale SG');
  assert.equal(canonicalDepartment('saigon', 'Quản lý - KT SG'), 'Quản lý-KT SG');
  assert.equal(canonicalDepartment('saigon', 'TRƯỞNG CHI NHÁNH'), 'Quản lý-KT SG');
  assert.equal(canonicalDepartment('hanoi', 'HẬU CẦN - BẢO VỆ'), 'Hậu cần - Bảo vệ');
  assert.equal(canonicalDepartment('saigon', 'HẬU CẦN-BẢO VỆ'), 'Hậu cần - Bảo vệ');
  assert.equal(canonicalDepartment('hanoi', 'Sale SG'), null, 'bộ phận của cơ sở khác không hợp lệ');
  assert.equal(canonicalDepartment('hanoi', 'TRỰC PAGE'), null);
  assert.equal(canonicalDepartment('hanoi', ''), null);
});
