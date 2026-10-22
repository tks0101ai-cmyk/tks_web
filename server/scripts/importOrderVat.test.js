'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { mapOrderVatRows, insertRows, parseStatus, parseVnTimestamp, parseVnDate } = require('./importOrderVat');

const HEADER = ['Thời gian', 'Email', 'Tên Sale', 'Khách hàng', 'Mã SP Trim', 'Tên SP', 'Số lượng', 'Giá chưa VAT', 'Ghi chú', 'KT PHẢN HỒI', 'KT NOTE CHO SALE', 'NGÀY VỀ', 'TÊN MÃ KT', 'TỔNG TIỀN', 'TỒN VAT'];
const RECORDS = [
  HEADER,
  ['19/10/2026', 'tongkhogiatot555@gmail.com', 'Khánh Thịnh', 'KH A Thắng Thanh Trì', '014XOAN', 'Bát inox', '400', '11,400', 'FULL VAT', '3. Chờ khai chèn', '', '', '', '4,560,000', 'x'],
  ['X', 'X', 'X', 'LÓE', '5FD6WQ', 'Túi đựng mỹ phẩm', '2,500', '', 'x', '1. Đã xong', 'BSUNG 15/10', '17/10/2025', '', '0', '2,500'],
  ['', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['06/08/2026 09:15:00', 'GiaDungKhoSi545@gmail.com', 'Tuấn Huỳnh', 'KH A Lâm', '26RDKV', 'Khay ráo dầu', '5000', '18100', 'VAT11863', '0. Không khai được', 'sẵn', '', '#REF!', '', ''],
  ['01/07/2026', 'khac@gmail.com', 'diễm', '....', '....', '', 'X', 'X', '', '', '', 'abc', '', '', '']
];

const USERS = new Map([['giadungkhosi545@gmail.com', { id: 'u-tuan', hoTen: 'Huỳnh Tuấn' }]]);

test('doc ngay gio VN tu sheet', () => {
  assert.equal(parseVnTimestamp('19/10/2026'), '2026-10-18T17:00:00.000Z');
  assert.equal(parseVnTimestamp('06/08/2026 09:15:00'), '2026-08-06T02:15:00.000Z');
  assert.equal(parseVnTimestamp('31/02/2026'), null);
  assert.equal(parseVnTimestamp('X'), null);
  assert.equal(parseVnDate('13/10/2026'), '2026-10-13');
  assert.equal(parseVnDate('s26'), null);
});

test('map dong sheet: email -> tai khoan, X/trong -> null, Full VAT tu ghi chu, trang thai theo so dau', () => {
  const { rows, report } = mapOrderVatRows(RECORDS, { usersByEmail: USERS });
  assert.equal(rows.length, 4);
  assert.equal(report.skippedBlank, 1);
  assert.deepEqual(rows.map(r => r.legacy_row), [2, 3, 5, 6]);
  const [first, legacyX, mapped, junk] = rows;
  assert.equal(first.created_by, null);
  assert.equal(first.created_by_name, 'Khánh Thịnh');
  assert.equal(first.full_vat, true);
  assert.equal(first.status, '3');
  assert.equal(first.unit_price_excl_vat, 11400);
  assert.equal(legacyX.created_at, null);
  assert.equal(legacyX.created_by_name, '');
  assert.equal(legacyX.created_by_email, '');
  assert.equal(legacyX.unit_price_excl_vat, null);
  assert.equal(legacyX.quantity, 2500);
  assert.equal(legacyX.arrival_date, '2025-10-17');
  assert.equal(mapped.created_by, 'u-tuan');
  assert.equal(mapped.created_by_name, 'Huỳnh Tuấn');
  assert.equal(mapped.status, '0');
  assert.equal(mapped.full_vat, false);
  assert.equal(junk.status, 'pending');
  assert.equal(junk.product_code, '');
  assert.equal(junk.customer_name, '');
  assert.equal(junk.quantity, null);
  assert.equal(junk.arrival_date, null);
  assert.equal(report.mappedSale, 1);
  assert.equal(report.badTime, 1);
  assert.equal(report.unmappedEmails.get('tongkhogiatot555@gmail.com'), 1);
});

test('ghi vao DB: dong cu duoc phep thieu du lieu, chay lai khong nhan doi, co lich su import', async () => {
  const db = new PGlite();
  try {
    await db.exec(fs.readFileSync(path.join(__dirname, '../db/migrations/0076_vat_requests.sql'), 'utf8'));
    const query = (sql, params) => db.query(sql, params);
    const pool = { connect: async () => ({ query, release() {} }) };
    const { rows } = mapOrderVatRows(RECORDS, { usersByEmail: USERS });
    assert.equal(await insertRows(pool, rows), 4);
    assert.equal(await insertRows(pool, rows), 0);
    const { rows: saved } = await db.query('SELECT legacy_row, is_legacy, total_amount, created_at FROM vat_requests ORDER BY legacy_row');
    assert.equal(saved.length, 4);
    assert.ok(saved.every(r => r.is_legacy));
    assert.equal(Number(saved[0].total_amount), 4560000);
    assert.equal(saved[1].created_at, null);
    const { rows: history } = await db.query("SELECT count(*)::int AS n FROM vat_request_history WHERE action = 'import'");
    assert.equal(history[0].n, 4);
  } finally {
    await db.close();
  }
});

test('trang thai: so dau hoac chi nhan chu (sheet 22/10: "Da ve" = 1, "VAT san nhieu" = 5)', () => {
  const cases = { '': 'pending', '1. Đã xong': '1', '5. VAT sẵn nhiều': '5', 'Đã về': '1', 'Không khai được': '0', 'Đã khai - Chờ về': '2',
    'Chờ khai chèn': '3', 'Chờ cont về, tăng slg': '4', 'VAT sẵn nhiều': '5', ' ĐÃ VỀ ': '1', 'gì đó': null };
  for (const [text, status] of Object.entries(cases)) assert.equal(parseStatus(text), status, text);
});

test('--replace: xoa mem moi yeu cau dang hien (ke ca dong tao tren web), nhap lai dung so dong sheet, xep moi nhat truoc', async () => {
  const db = new PGlite();
  try {
    for (const file of ['0076_vat_requests.sql', '0079_vat_request_sort_rank.sql']) {
      await db.exec(fs.readFileSync(path.join(__dirname, '../db/migrations', file), 'utf8'));
    }
    const query = (sql, params) => db.query(sql, params);
    const pool = { connect: async () => ({ query, release() {} }) };
    const { rows } = mapOrderVatRows(RECORDS, { usersByEmail: USERS });
    await insertRows(pool, rows);
    await db.query(`INSERT INTO vat_requests (created_by, product_code, quantity, unit_price_excl_vat) VALUES ('sale-1', 'WEB1', 1, 1)`);
    const result = await insertRows(pool, rows, { replace: { label: 'Thay bằng bản xuất ORDER VAT 1 (22/10/2026)' } });
    assert.deepEqual(result, { inserted: 4, removed: 5 });
    const { rows: live } = await db.query('SELECT legacy_row, created_at FROM vat_requests WHERE NOT is_deleted ORDER BY sort_rank DESC, id DESC');
    assert.deepEqual(live.map(r => r.legacy_row).sort(), rows.map(r => r.legacy_row).sort(), 'chi con dong cua file moi');
    assert.equal(live[live.length - 1].created_at, null, 'dong thieu thoi gian xuong cuoi');
    const { rows: gone } = await db.query('SELECT count(*)::int AS n FROM vat_requests WHERE is_deleted AND legacy_row IS NULL');
    assert.equal(gone[0].n, 5);
    const { rows: history } = await db.query("SELECT count(*)::int AS n FROM vat_request_history WHERE action = 'delete' AND changed_by_name LIKE 'Thay bằng%'");
    assert.equal(history[0].n, 5);
  } finally {
    await db.close();
  }
});
