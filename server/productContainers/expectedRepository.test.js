'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { createExpectedRepository } = require('./expectedRepository');

async function fixture(t, legacy = false) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fs.readFileSync(path.join(__dirname, '../db/migrations/0075_product_container_expected.sql'), 'utf8'));
  if (!legacy) await db.exec(`ALTER TABLE product_container_expected ADD other_note text, ADD listed_at text, ADD unit_price_cny numeric, ADD vietnam_price numeric`);
  await db.exec(`INSERT INTO product_container_expected_state(id,version,row_count) VALUES(1,9,205)`);
  for (let i = 1; i <= 205; i++) {
    await db.query(`INSERT INTO product_container_expected(sheet_name,source_row,sheet_order,container_row,container_name,status,status_label,product_code,product_name,quantity,units_per_package)
      VALUES($1,$2,$3,1,$4,1,$5,$6,'Áo đỏ',$7,$8)`,
    [i <= 103 ? 'SECRET A' : 'SECRET B', i, i <= 103 ? 1 : 2, i % 2 ? 'A' : 'B', i % 3 ? 'Ready' : 'Wait', 'SP' + i, i / 10, i === 1 ? null : i / 100]);
  }
  return { db, repo: createExpectedRepository({ pool: db }) };
}

test('SQL pages full count/summary, clamps empty/last page, stable IDs and anonymous sources', async t => {
  const { repo } = await fixture(t);
  const first = await repo.queryExpected({ page: 1, pageSize: 100 });
  const second = await repo.queryExpected({ page: 2, pageSize: 100 });
  assert.equal(first.totalRows, 205);
  assert.equal(first.rows.length, 100);
  assert.equal(second.rows.length, 100);
  assert.equal(first.summary.quantity, 2111.5);
  assert.equal(second.rows[3].sheetName, '#2');
  assert.equal(second.rows[0].sourceRow, 101);
  assert.doesNotMatch(JSON.stringify(first), /SECRET/);
  assert.deepEqual(first.filters.sources, []);
  const last = await repo.queryExpected({ page: 900, pageSize: 100 });
  assert.equal(last.page, 3);
  assert.equal(last.rows.length, 5);
  const empty = await repo.queryExpected({ page: 900, pageSize: 100, q: 'nothing' });
  assert.equal(empty.page, 1);
  assert.equal(empty.totalRows, 0);
  assert.equal(empty.summary.quantity, 0);
});

test('SQL exact codes, fuzzy search, linked facets, numeric/null ordering and access restrictions', async t => {
  const { repo, db } = await fixture(t);
  await db.exec(`UPDATE product_container_expected SET other_note='privatenote',unit_price_cny=999 WHERE source_row=1`);
  assert.equal((await repo.queryExpected({ q: 'privatenote' })).totalRows, 0);
  assert.equal((await repo.queryExpected({ q: 'privatenote' }, { otherNoteAccess: true })).totalRows, 1);
  assert.equal((await repo.queryExpected({ q: 'ao do' })).totalRows, 205);
  assert.equal((await repo.queryExpected({ q: 'ao do xyz' })).totalRows, 0);
  const codes = await repo.queryExpected({ qmode: 'codes', q: 'sp1 SP201,missing', pageSize: 1 });
  assert.equal(codes.totalRows, 2);
  assert.deepEqual(codes.search.missingCodes, ['missing']);
  const filtered = await repo.queryExpected({ source: 'SECRET A', container: 'A', status: 'Ready' }, { fullAccess: true });
  assert.deepEqual(filtered.filters.containers, ['A', 'B']);
  assert.deepEqual(filtered.filters.statuses, ['Ready', 'Wait']);
  assert.deepEqual(filtered.filters.sources, ['SECRET A', 'SECRET B']);
  assert.equal((await repo.queryExpected({ source: 'SECRET A' })).totalRows, 205);
  const sorted = await repo.queryExpected({ sorts: JSON.stringify([{ key: 'so-cai-kien', dir: 'asc' }]), pageSize: 500 });
  assert.equal(sorted.rows[0].unitsPerPackage, .02);
  assert.equal(sorted.rows.at(-1).unitsPerPackage, null);
  const hidden = await repo.queryExpected({ sorts: JSON.stringify([{ key: 'gia-te', dir: 'desc' }]) });
  assert.equal(hidden.rows[0].sourceRow, 1);
  assert.equal('otherNote' in hidden.rows[0], false);
  assert.equal('unitPriceCny' in hidden.rows[0], false);
  const exported = await repo.queryExpected({ pageSize: 1, page: 2, qmode: 'codes', q: 'SP2 SP201', sorts: [{ key: 'tong-so-luong', dir: 'desc' }] }, { exportAll: true });
  assert.deepEqual(exported.rows.map(r => r.productCode), ['SP201', 'SP2']);
});

test('SQL legacy optional columns and missing migration are safe', async t => {
  const { repo } = await fixture(t, true);
  const result = await repo.queryExpected({ pageSize: 100 }, { fullAccess: true, otherNoteAccess: true });
  assert.equal(result.rows[0].unitPriceCny, null);
  assert.equal(result.rows[0].otherNote, '');
  const db = new PGlite(); t.after(() => db.close());
  assert.equal((await createExpectedRepository({ pool: db }).queryExpected({})).totalRows, 0);
});

test('real SQL route/export parity and complete detail beyond current page', async t => {
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||= '{}';
  process.env.JWT_SECRET ||= 'fixture';
  const { createExpectedArrivalsRouter } = require('./expectedRoutes');
  const ExcelJS = require('exceljs');
  const { repo, db } = await fixture(t);
  await db.exec(`UPDATE product_container_expected SET product_code='SP1' WHERE source_row=201`);
  const router = createExpectedArrivalsRouter({ repository: repo });
  const invoke = async (route, query, user = { vaiTro: 'Nhân viên sale' }) => {
    const res = { statusCode: 200, set() { return this; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; }, send(buffer) { this.buffer = buffer; } };
    const handler = router.stack.find(layer => layer.route && layer.route.path === route).route.stack.at(-1).handle;
    await handler({ user, query }, res);
    return res;
  };
  const query = { page: 2, pageSize: 1, qmode: 'codes', q: 'SP1 SP2', sorts: JSON.stringify([{ key: 'tong-so-luong', dir: 'desc' }]) };
  const list = await invoke('/', query);
  assert.equal(list.body.totalRows, 3);
  assert.equal(list.body.rows.length, 1);
  assert.equal(list.body.rows[0].sourceRow, 2);
  const fields = await invoke('/export/fields', query);
  assert.equal(fields.body.worksheets[0].rowCount, 3);
  const file = await invoke('/export', { ...query, columns: 'productCode,quantity' });
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(file.buffer);
  assert.deepEqual(wb.worksheets[0].getColumn(2).values.slice(2), [20.1, .2, .1]);
  const detail = await invoke('/detail', { code: ' sp1 ', source: 'SECRET A', container: 'B', status: 'Wait' });
  assert.deepEqual(detail.body.rows.map(row => row.sourceRow), [1, 201]);
  assert.deepEqual(detail.body.rows.map(row => row.sheetName), ['#1', '#2']);
  assert.equal(detail.body.fullAccess, false);
  assert.doesNotMatch(JSON.stringify(detail.body), /SECRET/);
  await db.exec(`INSERT INTO product_container_expected(sheet_name,source_row,sheet_order,container_row,status,product_code)
    SELECT 'SECRET A',n,1,1,1,'BULK' FROM generate_series(206,20005) n`);
  const largeFields = await invoke('/export/fields', {});
  assert.equal(largeFields.body.worksheets[0].rowCount, 20005);
  const tooLarge = await invoke('/export', { pageSize: 1, page: 2 });
  assert.equal(tooLarge.statusCode, 400);
  assert.equal(tooLarge.body.code, 'TOO_MANY_ROWS');
});
