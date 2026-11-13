'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VIETQR_BANKS, findBank } = require('./vietqrBanks');
const vatDraftConfig = require('./vatDraftConfig');
const { isValidAccountNo } = require('./vietqr');

test('findBank: khop code / shortName / bin, khong phan biet hoa thuong, bo khoang trang', () => {
  assert.equal(findBank('VCB').bin, '970436');
  assert.equal(findBank(' vietcombank ').bin, '970436');
  assert.equal(findBank('970422').code, 'MB');
  assert.equal(findBank('mbbank').code, 'MB');
  assert.equal(findBank('Vietinbank').code, 'ICB');
  assert.equal(findBank('VCB/x'), null);
  assert.equal(findBank('KHONGCO'), null);
  assert.equal(findBank(''), null);
  assert.equal(findBank(undefined), null);
});

test('moi tai khoan cau hinh dung ma ngan hang co trong danh sach VietQR', () => {
  for (const account of vatDraftConfig.vietqr.accounts) {
    assert.ok(findBank(account.bankId), `${account.key}: ${account.bankId}`);
    assert.ok(isValidAccountNo(account.accountNo), `${account.key}: so tai khoan ${account.accountNo}`);
  }
  assert.equal(new Set(VIETQR_BANKS.map(b => b.bin)).size, VIETQR_BANKS.length, 'bin khong trung');
});
