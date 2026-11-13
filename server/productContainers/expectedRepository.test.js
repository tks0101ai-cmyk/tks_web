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

// ── Toi uu 13/11/2026: SQL doc cot truc tiep + cache trang theo version (queryCache) ──────────────────────
const { EventEmitter } = require('node:events');

// Dem cau SQL thuc chay (state 1 dong vs cau trang nang) de kiem cache / gom request.
function countingPool(db) {
  const calls = { state: 0, page: 0, sql: [] };
  return {
    calls,
    query(sql, params) {
      calls.sql.push(sql);
      if (/^SELECT version::text AS version, computed_at, row_count/.test(sql)) calls.state++;
      else if (/^WITH base AS/.test(sql)) calls.page++;
      return db.query(sql, params);
    }
  };
}

test('SQL trang doc cot tuy chon truc tiep (khong to_jsonb tung dong); DB cu thieu cot van chay qua ban du phong', async t => {
  const { db } = await fixture(t);
  const pool = countingPool(db);
  const repo = createExpectedRepository({ pool });
  await db.exec(`UPDATE product_container_expected SET other_note='ghi chu',listed_at='15/10',unit_price_cny=1.5,vietnam_price=26000 WHERE source_row=1`);
  const result = await repo.queryExpected({ pageSize: 1 }, { fullAccess: true, otherNoteAccess: true });
  assert.deepEqual([result.rows[0].otherNote, result.rows[0].listedAt, result.rows[0].unitPriceCny, result.rows[0].vietnamPrice], ['ghi chu', '15/10', 1.5, 26000]);
  assert.equal(pool.calls.page, 1);
  assert.doesNotMatch(pool.calls.sql.join('\n'), /to_jsonb\(e\)/);

  const legacy = await fixture(t, true);
  const legacyPool = countingPool(legacy.db);
  const legacyRepo = createExpectedRepository({ pool: legacyPool });
  const first = await legacyRepo.queryExpected({ pageSize: 1 }, { fullAccess: true, otherNoteAccess: true });
  assert.deepEqual([first.rows[0].otherNote, first.rows[0].unitPriceCny], ['', null]);
  await legacyRepo.queryExpected({ pageSize: 1, page: 2 });
  assert.equal(legacyPool.calls.page, 3, 'lan dau thu ban moi (loi 42703) roi nho dung ban du phong');
});

test('queryCache: cung version tra ket qua giong het SQL, khong chay lai cau nang; gom request dong thoi; quyen tach khoa', async t => {
  const { db } = await fixture(t);
  const pool = countingPool(db);
  let clock = 1000;
  const repo = createExpectedRepository({ pool, queryCache: true, now: () => clock });
  const plain = createExpectedRepository({ pool: db });
  const query = { page: '2', pageSize: '50', q: 'ao', sorts: JSON.stringify([{ key: 'tong-so-luong', dir: 'desc' }]) };

  const [a, b, c] = await Promise.all([repo.queryExpected(query), repo.queryExpected(query), repo.queryExpected({ ...query })]);
  assert.equal(pool.calls.page, 1, '3 request dong thoi cung khoa => 1 cau SQL');
  assert.equal(pool.calls.state, 1, 'doc state cung dung chung');
  assert.deepEqual(a, await plain.queryExpected(query));
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);

  clock += 5000;
  assert.deepEqual(await repo.queryExpected(query), a);
  assert.equal(pool.calls.page, 1);
  assert.equal(pool.calls.state, 1, 'trong stateTtlMs khong hoi lai DB');

  // computed_at doi ma version giu nguyen (lam moi khong doi noi dung): ket qua cache mang meta moi, giong SQL.
  await db.exec(`UPDATE product_container_expected_state SET computed_at = '2026-11-13T02:00:00Z' WHERE id = 1`);
  clock += 20000;
  const refreshedMeta = await repo.queryExpected(query);
  assert.equal(pool.calls.page, 1);
  assert.equal(pool.calls.state, 2);
  assert.deepEqual(refreshedMeta, await plain.queryExpected(query));
  assert.equal(refreshedMeta.meta.computedAt, '2026-11-13T02:00:00.000Z');

  // Khac quyen => khac khoa (khong lo cot gia / ghi chu cho nguoi khong co quyen).
  const full = await repo.queryExpected(query, { fullAccess: true, otherNoteAccess: true });
  assert.equal(pool.calls.page, 2);
  assert.deepEqual(full, await plain.queryExpected(query, { fullAccess: true, otherNoteAccess: true }));
  assert.equal('unitPriceCny' in (await repo.queryExpected(query)).rows[0], false);
  // Xuat file / dem dong khong qua cache.
  await repo.queryExpected(query, { countOnly: true });
  await repo.queryExpected(query, { countOnly: true });
  assert.equal(pool.calls.page, 4);
});

test('queryCache: doi version qua su kien => tra ban cu 1 lan va lam moi nen, request sau nhan ban moi; qua staleMaxMs thi cho ban moi', async t => {
  const { db } = await fixture(t);
  const pool = countingPool(db);
  const events = new EventEmitter();
  let clock = 1000;
  const repo = createExpectedRepository({ pool, queryCache: true, events, now: () => clock, staleMaxMs: 60000 });
  const before = await repo.queryExpected({ pageSize: 5 });
  assert.equal(before.rows[0].productName, 'Áo đỏ');

  await db.exec(`UPDATE product_container_expected SET product_name='Áo xanh'; UPDATE product_container_expected_state SET version = 10 WHERE id = 1`);
  // Chua co su kien, con trong stateTtlMs: van la ban da cache (chap nhan tre toi da 15 s neu mat su kien).
  assert.equal((await repo.queryExpected({ pageSize: 5 })).rows[0].productName, 'Áo đỏ');
  assert.equal(pool.calls.page, 1);

  events.emit('expectedArrivalsChanged', { version: 10 });
  const stale = await repo.queryExpected({ pageSize: 5 });
  assert.equal(stale.rows[0].productName, 'Áo đỏ', 'tra ban cu ngay, khong bat nguoi dung cho cau SQL');
  assert.equal(stale.meta.version, '9');
  // Hoi lai trong luc lam moi nen: van ban cu va KHONG chay them cau SQL (gom vao luot dang chay).
  let fresh = stale;
  for (let i = 0; i < 400 && fresh.meta.version === '9'; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    fresh = await repo.queryExpected({ pageSize: 5 });
  }
  assert.equal(fresh.rows[0].productName, 'Áo xanh');
  assert.equal(fresh.meta.version, '10');
  assert.equal(pool.calls.page, 2);

  // containersChanged (dong bo CONT / Thu mua) cung lam moi; ban cache qua staleMaxMs thi cho ban moi luon.
  await db.exec(`UPDATE product_container_expected SET product_name='Áo vàng'; UPDATE product_container_expected_state SET version = 11 WHERE id = 1`);
  clock += 120000;
  events.emit('containersChanged', { remote: true });
  assert.equal((await repo.queryExpected({ pageSize: 5 })).rows[0].productName, 'Áo vàng');
});

test('queryCache: getExpected (hop chi tiet) dung chung state da nho; thieu bang van rong', async t => {
  const { db } = await fixture(t);
  const pool = countingPool(db);
  const repo = createExpectedRepository({ pool, queryCache: true, now: () => 1000 });
  await repo.queryExpected({ pageSize: 5 });
  const detail = await repo.getExpected();
  assert.equal(detail.rows.length, 205);
  assert.equal((await repo.getExpected()).rows, detail.rows);
  assert.equal(pool.calls.state, 1, 'bam xem chi tiet khong ton them vong DB doc state');
  const bare = new PGlite(); t.after(() => bare.close());
  const empty = createExpectedRepository({ pool: bare, queryCache: true });
  assert.equal((await empty.queryExpected({ pageSize: 5 })).totalRows, 0);
  assert.equal((await empty.getExpected()).rows.length, 0);
});

test('tim kiem mo: bo dau 1 lan / dong (khong lap translate cho tung tu); ket qua + thu tu diem giong cach boc tung tu, ke ca ghi chu NULL', async t => {
  const { fuzzySqlParts } = require('../shared/fuzzySql');
  const { db } = await fixture(t);
  await db.exec(`UPDATE product_container_expected SET product_name = 'Quạt mini để bàn' WHERE source_row IN (7, 150);
    UPDATE product_container_expected SET color = 'Quạt', sale_note = 'mini' WHERE source_row = 20;
    UPDATE product_container_expected SET other_note = '', sale_note = 'quạt', ordered_by = 'MINI' WHERE source_row = 30;
    UPDATE product_container_expected SET other_note = 'quat mini' WHERE source_row = 40`);
  const pool = countingPool(db);
  const repo = createExpectedRepository({ pool });
  // Tham chieu = cach cu: fuzzySqlParts boc translate quanh concat_ws cac cot (other_note da COALESCE '').
  const reference = async (q, otherNoteAccess) => {
    const values = [];
    const columns = ['schedule_label', 'container_name', 'product_code', 'product_name', 'color', 'sale_note', ...(otherNoteAccess ? ["COALESCE(other_note,'')"] : []), 'ordered_by'];
    const parts = fuzzySqlParts(`concat_ws(' ',${columns.join(',')})`, q, value => { values.push(value); return '$' + values.length; });
    const { rows } = await db.query(`SELECT source_row FROM product_container_expected WHERE ${parts.where}
      ORDER BY ${parts.score} DESC, sheet_order, container_row, source_row, sheet_name`, values);
    return rows.map(row => Number(row.source_row));
  };
  for (const [q, otherNoteAccess] of [['quat mini', false], ['quat mini', true], ['QUẠT', false], ['mini quat', true], ['ao do', false], ['zzz', false]]) {
    pool.calls.sql.length = 0;
    const result = await repo.queryExpected({ q, pageSize: 500 }, { otherNoteAccess });
    assert.deepEqual(result.rows.map(row => row.sourceRow), await reference(q, otherNoteAccess), q + ' / ghi chu ' + otherNoteAccess);
    assert.equal(result.totalRows, result.rows.length);
    // Khop nguyen cum xep truoc; co quyen ghi chu: ghi chu '' chen giua "quạt" va "MINI" (dong 30) lam mat cum -> tut hang.
    if (q === 'quat mini') {
      assert.deepEqual(result.rows.map(row => row.sourceRow), otherNoteAccess ? [7, 20, 40, 150, 30] : [7, 20, 30, 150]);
    }
    const pageSql = pool.calls.sql.find(sql => /^WITH base AS/.test(sql));
    assert.equal(pageSql.split('translate(').length - 1, 1, 'chi bo dau 1 lan / dong: ' + q);
  }
});
