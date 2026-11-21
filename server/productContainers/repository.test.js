'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { readContainerSummary, getContainerDetails, getContainerMeta } = require('./repository');
const { resolvePermissions, hasFeature } = require('../auth/featureRegistry');
async function fixture() {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname,'../db/migrations/0018_product_report.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(__dirname,'../db/migrations/0053_product_containers.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(__dirname,'../db/migrations/0072_product_container_unit_price_cny.sql'),'utf8'));
  await db.exec(`CREATE TABLE products(code text,branch text,is_active boolean);
    INSERT INTO products VALUES ('001A','hanoi',true),('STOP','hanoi',false);
    INSERT INTO product_report(product_code,product_name) VALUES ('001A','A'),('STOP','S');`);
  return db;
}
test('summary distinguishes unavailable from empty snapshot, sums only 1/2/3', async () => {
  const db=await fixture();
  try {
    assert.equal((await readContainerSummary(db)).containerSync.available,false);
    await db.exec(`UPDATE product_container_sync SET version='00000000-0000-4000-8000-000000000001', last_success_at=now();
      INSERT INTO product_container_lines(sheet_name,sheet_order,container_row,source_row,product_code,product_key,container_name,status,status_label,quantity)
      VALUES ('YIWU',0,1,2,'001A','001a','CONT A',1,'1.Chưa có lịch',100),
      ('YIWU',0,3,4,'001A','001a','CONT A',2,'2.Chưa bốc',50),
      ('SD',3,1,2,'001A','001a','CONT A',3,'3.Đã bốc',30),
      ('SD',3,4,5,'001A','001a','CONT A',4,'4.Đã về',20),
      ('SD',3,6,7,'001A','001a','CONT A',5,'5.Đã về',10);`);
    const result=await readContainerSummary(db);
    assert.equal(result.containerSync.available,true);
    assert.deepEqual(result.totals['001a'],{unloadedQty:150,loadedQty:30});
    assert.equal(Object.hasOwn(result.containerSync,'warnings'),false);
    await db.exec('DELETE FROM product_container_lines');
    assert.deepEqual((await readContainerSummary(db)).totals,{});
  } finally {await db.close();}
});
test('detail includes statuses 1–5 for ordinary users while restricting internal fields and validating active codes',async()=>{
  const db=await fixture();
  try {
    await assert.rejects(getContainerDetails({pool:db,code:' '}),{statusCode:400});
    await assert.rejects(getContainerDetails({pool:db,code:'STOP'}),{statusCode:404});
    await assert.rejects(getContainerDetails({pool:db,code:'001A'}),{statusCode:503});
    await db.exec(`UPDATE product_container_sync SET version='00000000-0000-4000-8000-000000000001',last_success_at=now(),warnings='[{"sheetName":"YIWU","row":3,"reason":"O lỗi"}]';
      INSERT INTO product_container_lines(sheet_name,sheet_order,container_row,source_row,product_code,product_key,container_name,status,status_label,quantity,ordered_by,vietnam_price,unit_price_cny)
      VALUES ('YIWU',0,1,2,'001A','001a','CONT A',2,'2.Chưa bốc',50,'SECRET',12345,1.44),
      ('YIWU',0,3,4,'001A','001a','CONT C',1,'1.Chưa có lịch',10,'SECRET',111,NULL),
      ('YIWU',0,5,6,'001A','001a','CONT D',3,'3.Đã bốc',20,'SECRET',222,NULL),
      ('SD',3,1,2,'001A','001a','CONT B',5,'5.Đã về',9,'SECRET',999,NULL),
      ('SD',3,3,4,'001A','001a','CONT E',4,'4.Đã về',8,'SECRET',888,NULL);`);
    const sale=await getContainerDetails({pool:db,code:' 001a '});
    assert.deepEqual(sale.rows.map(row=>row.status),[2,1,3,5,4]);
    for (const row of sale.rows) {
      assert.deepEqual(Object.keys(row).sort(),['containerName','status','statusLabel','eta','color','saleNote','quantity'].sort());
    }
    assert.doesNotMatch(JSON.stringify(sale),/SECRET|12345|warnings|sheetName|sourceRow/);
    const manager=await getContainerDetails({pool:db,code:'001A',fullAccess:true});
    assert.equal(manager.rows.length,5);
    assert.equal(manager.rows[0].vietnamPrice,12345);
    assert.equal(manager.rows[0].unitPriceCny,1.44);
    assert.equal(sale.rows[0].unitPriceCny,undefined);
    assert.equal(manager.warnings[0].row,3);
  } finally {await db.close();}
});
test('missing migration is explicitly unavailable without breaking old report reads',async()=>{
  const pool={query:async()=>{const err=new Error('missing');err.code='42P01';throw err;}};
  assert.equal((await getContainerMeta({pool})).containerSync.available,false);
});
test('full detail permission defaults to manager and follows grant/revoke and parent',()=>{
  const feature='reports.overview.containers.full';
  assert.equal(hasFeature({vaiTro:'Quản lý'},feature),true);
  assert.equal(hasFeature({vaiTro:'Nhân viên sale'},feature),false);
  const granted={vaiTro:'Nhân viên sale',featurePermissions:{[feature]:true}};
  assert.ok(resolvePermissions(granted).includes(feature));
  assert.equal(hasFeature({vaiTro:'Quản lý',featurePermissions:{[feature]:false}},feature),false);
  assert.equal(hasFeature({...granted,featurePermissions:{[feature]:true,'reports.products':false}},feature),false);
});
test('migration revokes inherited SELECT from reporting_readonly for both restricted tables',async()=>{
  const db=new PGlite();
  try {
    await db.exec('CREATE ROLE reporting_readonly; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO reporting_readonly;');
    await db.exec(fs.readFileSync(path.join(__dirname,'../db/migrations/0053_product_containers.sql'),'utf8'));
    for(const name of ['product_container_lines','product_container_sync']){
      const {rows}=await db.query("SELECT has_table_privilege('reporting_readonly',$1,'SELECT') AS permitted",[name]);
      assert.equal(rows[0].permitted,false);
    }
  } finally {await db.close();}
});
test('real transaction rollback restores previous snapshot after replacement insert fails',async()=>{
  const {refreshContainers}=require('./sync');
  const {SHEET_NAMES}=require('./parser');
  const db=await fixture();
  try {
    await db.exec(`UPDATE product_container_sync SET version='00000000-0000-4000-8000-000000000001',last_success_at='2020-01-01';
      INSERT INTO product_container_lines(sheet_name,sheet_order,container_row,source_row,product_code,product_key,container_name,status,status_label,quantity)
      VALUES('YIWU',0,1,2,'001A','001a','CONT OLD',2,'2.Chưa bốc',123);`);
    const connection={release(){},query:async(sql,args)=>{
      if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
      if(sql.includes('pg_advisory_unlock'))return {rows:[{}]};
      if(sql.startsWith('INSERT INTO product_container_lines'))throw Error('simulated insert failure');
      return db.query(sql,args);
    }};
    const line=Array(25).fill('');line[0]='001A';line[15]=999;
    const result=await refreshContainers({pool:{connect:async()=>connection},spreadsheetId:'fixture',client:{listSheetTitles:async()=>SHEET_NAMES,getValues:async()=>[['CONT NEW','2.Chưa bốc'],line]},logger:{info(){},error(){}}});
    assert.equal(result.status,'failed');
    const summary=await readContainerSummary(db);
    assert.equal(summary.totals['001a'].unloadedQty,123);
    assert.equal(summary.containerSync.version,'00000000-0000-4000-8000-000000000001');
    assert.equal(summary.containerSync.stale,true);
  } finally {await db.close();}
});

// ---- Ghi khac biet tren SQL that (PGlite) ----
function sheetClient(rowsBySheet) {
  return { listSheetTitles: async () => require('./parser').SHEET_NAMES,
    getValues: async (name) => {
      const out = [['CONT '+name,'2.Chưa bốc']];
      for (const [code, qty] of rowsBySheet[name] || []) { const row = Array(25).fill(''); row[0] = code; row[15] = qty; out.push(row); }
      return out;
    } };
}
function connectionOver(db) {
  return { release() {}, query: async (sql, args) => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
    if (sql.includes('pg_advisory_unlock')) return { rows: [{}] };
    return db.query(sql, args);
  } };
}
async function runSync(db, rowsBySheet, at) {
  const { refreshContainers } = require('./sync');
  return refreshContainers({ pool: { connect: async () => connectionOver(db) }, spreadsheetId: 'fixture',
    client: sheetClient(rowsBySheet), now: () => new Date(at), logger: { info() {}, error() {} } });
}
const T0 = '2026-10-16T01:00:00Z', T1 = '2026-10-16T01:11:00Z', T2 = '2026-10-16T01:22:00Z', T3 = '2026-10-16T01:33:00Z';
const many = (n, qty = 1) => Array.from({ length: n }, (_, i) => ['SKU' + i, qty]);

const SEVEN_SHEETS = ['YIWU', 'VK-DUNG', 'HÀ BẮC', 'SD', 'GDONG', 'KHÁC', 'CONT TKS1'];
function tks1SheetClient({ missing = false, rejectedRender } = {}) {
  const calls = [];
  const product = quantity => Object.assign(Array(25).fill(''), { 0: '001A', 13: 12, 14: 15.3, 15: quantity });
  return {
    calls,
    listSheetTitles: async () => missing ? SEVEN_SHEETS.slice(0, 6) : SEVEN_SHEETS,
    getValues: async (name, options) => {
      calls.push({ name, ...options });
      if (name === 'CONT TKS1' && options.valueRenderOption === rejectedRender) throw new Error('fixture source rejected');
      if (name !== 'CONT TKS1') return [['CONT ' + name, '2.Chưa bốc'], product(1)];
      const values = [['Mã SP', 'Tên SP'], ['CONT TKS1', '1.Chưa có lịch'], product(184), product(2.5),
        ['CONT TKS1', '2.Chưa bốc'], product(7.5), ['CONT TKS1', '3.Đã bốc'], product(23),
        ['CONT TKS1', '4.Đã về'], product(10), ['END'], product(999)];
      // Displayed quantities are deliberately localized; the job must read P from the raw response.
      return options.valueRenderOption === 'FORMATTED_VALUE'
        ? values.map(row => row.map((value, col) => col === 15 ? String(value).replace('.', ',') : value)) : values;
    }
  };
}

test('seven-source sync preserves source order, raw O quantities and separate same-name CONT blocks', async () => {
  const { refreshContainers } = require('./sync');
  const db = await fixture();
  const client = tks1SheetClient();
  try {
    const result = await refreshContainers({ pool: { connect: async () => connectionOver(db) }, spreadsheetId: 'fixture',
      client, now: () => new Date(T0), logger: { info() {}, error() {} } });
    assert.equal(result.status, 'updated');
    assert.equal(result.rowCount, 11);
    assert.deepEqual(require('./parser').SHEET_NAMES, SEVEN_SHEETS);
    assert.deepEqual(client.calls, SEVEN_SHEETS.flatMap(name => [
      { name, valueRenderOption: 'UNFORMATTED_VALUE', cellRange: 'A:Y' },
      { name, valueRenderOption: 'FORMATTED_VALUE', cellRange: 'A:Y' }
    ]));
    const snapshot = (await db.query('SELECT sheet_name, sheet_order, source_row, container_row, quantity::float AS quantity FROM product_container_lines ORDER BY sheet_order, source_row')).rows;
    assert.deepEqual(snapshot.slice(0, 6).map(r => [r.sheet_name, r.sheet_order]), SEVEN_SHEETS.slice(0, 6).map((name, index) => [name, index]));
    assert.deepEqual(snapshot.slice(6).map(r => [r.sheet_name, r.sheet_order, r.source_row, r.container_row, r.quantity]), [
      ['CONT TKS1', 6, 3, 2, 184], ['CONT TKS1', 6, 4, 2, 2.5], ['CONT TKS1', 6, 6, 5, 7.5],
      ['CONT TKS1', 6, 8, 7, 23], ['CONT TKS1', 6, 10, 9, 10]
    ]);
    assert.deepEqual((await readContainerSummary(db)).totals['001a'], { unloadedQty: 200, loadedQty: 23 });
    const detail = await getContainerDetails({ pool: db, code: '001A', fullAccess: true });
    assert.deepEqual(detail.rows.slice(6).map(r => [r.containerName, r.status, r.quantity]), [
      ['CONT TKS1', 1, 186.5], ['CONT TKS1', 2, 7.5], ['CONT TKS1', 3, 23], ['CONT TKS1', 4, 10]
    ]);
  } finally { await db.close(); }
});

for (const failure of [{ missing: true }, { rejectedRender: 'UNFORMATTED_VALUE' }, { rejectedRender: 'FORMATTED_VALUE' }]) {
  test(`new source failure keeps the successful snapshot: ${JSON.stringify(failure)}`, async () => {
    const { refreshContainers } = require('./sync');
    const db = await fixture();
    try {
      await runSync(db, { YIWU: [['001A', 123]] }, T0);
      const before = (await db.query('SELECT *, ctid::text AS tuple FROM product_container_lines')).rows;
      const metaBefore = (await db.query('SELECT version, last_success_at FROM product_container_sync')).rows[0];
      const result = await refreshContainers({ pool: { connect: async () => connectionOver(db) }, spreadsheetId: 'fixture',
        client: tks1SheetClient(failure), now: () => new Date(T1), logger: { info() {}, error() {} } });
      assert.equal(result.status, 'failed');
      assert.deepEqual((await db.query('SELECT *, ctid::text AS tuple FROM product_container_lines')).rows, before);
      const after = (await db.query('SELECT version, last_success_at, last_error FROM product_container_sync')).rows[0];
      assert.deepEqual({ version: after.version, last_success_at: after.last_success_at }, metaBefore);
      assert.match(after.last_error, /đủ 7 sheet CONT/);
      assert.deepEqual((await readContainerSummary(db)).totals['001a'], { unloadedQty: 123, loadedQty: 0 });
    } finally { await db.close(); }
  });
}

test('diff-write: lan dau tao version; sheet y het => version, dong va ctid khong doi; doi 1 dong => doi dung 1 dong', async () => {
  const { __test__ } = require('./sync'); __test__.resetPendingShrink();
  const db = await fixture();
  try {
    const first = await runSync(db, { YIWU: many(5), SD: many(3) }, T0);
    assert.equal(first.status, 'updated');
    const v1 = (await db.query('SELECT version FROM product_container_sync')).rows[0].version;
    const ctids1 = (await db.query('SELECT sheet_name, source_row, ctid::text AS c FROM product_container_lines ORDER BY 1,2')).rows;

    const same = await runSync(db, { YIWU: many(5), SD: many(3) }, T1);
    assert.equal(same.status, 'unchanged');
    assert.deepEqual([same.inserted, same.deleted], [0, 0]);
    const metaSame = (await db.query('SELECT version, last_success_at FROM product_container_sync')).rows[0];
    assert.equal(metaSame.version, v1, 'version phai giu nguyen khi noi dung khong doi');
    assert.equal(new Date(metaSame.last_success_at).toISOString(), new Date(T1).toISOString(), 'moc thanh cong van duoc cap nhat');
    assert.deepEqual((await db.query('SELECT sheet_name, source_row, ctid::text AS c FROM product_container_lines ORDER BY 1,2')).rows, ctids1, 'khong dong nao bi ghi lai');

    const changedRows = { YIWU: many(5), SD: many(3) }; changedRows.SD[0] = ['SKU0', 99];
    const changed = await runSync(db, changedRows, T2);
    assert.equal(changed.status, 'updated');
    assert.deepEqual([changed.inserted, changed.deleted], [1, 1]);
    assert.notEqual((await db.query('SELECT version FROM product_container_sync')).rows[0].version, v1);
    assert.equal(String((await db.query("SELECT quantity FROM product_container_lines WHERE sheet_name='SD' AND source_row=2")).rows[0].quantity), '99');
  } finally { await db.close(); }
});

test('chot an toan: giam >30% dong bi giu lai, chi nhan o lan doc thu 2 giong het; giam nhe thi nhan ngay', async () => {
  const { __test__ } = require('./sync'); __test__.resetPendingShrink();
  const db = await fixture();
  try {
    await runSync(db, { YIWU: many(10) }, T0);
    const held = await runSync(db, { YIWU: many(2) }, T1);
    assert.equal(held.status, 'held');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM product_container_lines')).rows[0].n, 10, 'bang cu con nguyen');
    const meta = (await db.query('SELECT last_error FROM product_container_sync')).rows[0];
    assert.match(meta.last_error, /chờ xác nhận/);

    const confirmed = await runSync(db, { YIWU: many(2) }, T2);
    assert.equal(confirmed.status, 'updated');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM product_container_lines')).rows[0].n, 2);
    assert.equal((await db.query('SELECT last_error FROM product_container_sync')).rows[0].last_error, null);

    await runSync(db, { YIWU: many(10) }, T3);
    const mild = await runSync(db, { YIWU: many(8) }, '2026-10-16T01:44:00Z');
    assert.equal(mild.status, 'updated');
  } finally { await db.close(); }
});

test('chot an toan: ung vien khac nhau o 2 lan lien tiep khong duoc coi la xac nhan', async () => {
  const { __test__ } = require('./sync'); __test__.resetPendingShrink();
  const db = await fixture();
  try {
    await runSync(db, { YIWU: many(10) }, T0);
    assert.equal((await runSync(db, { YIWU: many(2) }, T1)).status, 'held');
    assert.equal((await runSync(db, { YIWU: many(3) }, T2)).status, 'held');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM product_container_lines')).rows[0].n, 10);
  } finally { await db.close(); }
});

function cachePool() {
  let queries = 0;
  let bytes = 0;
  let fail = false;
  const result = value => { bytes += Buffer.byteLength(JSON.stringify(value)); return value; };
  const pool = { query: async sql => {
    queries++;
    if (fail) throw new Error('transient');
    if (sql.includes('SELECT 1 FROM product_report')) return result({ rows: [{}] });
    return result({ rows: [{ sync: { version: 'v1', last_success_at: new Date().toISOString(), warnings: [{ reason: 'secret' }] }, items: [
      { sheetName: 'A', containerRow: 1, containerName: 'Same', quantity: 2, orderedBy: 'SECRET', packageCount: 1 },
      { sheetName: 'A', containerRow: 1, containerName: 'Same', quantity: 3, orderedBy: 'SECRET', packageCount: 2 },
      { sheetName: 'A', containerRow: 9, containerName: 'Same', quantity: 7, orderedBy: 'SECRET' }
    ] }] });
  } };
  return { pool, count: () => queries, bytes: () => bytes, setFail: value => { fail = value; } };
}
test('two tabs reuse one DB payload instead of transferring the same snapshot twice', async () => {
  const a = cachePool();
  const { invalidateContainerDetails } = require('./repository');
  await getContainerDetails({ pool:a.pool, code:'SKU' });
  const firstReadBytes = a.bytes();
  await getContainerDetails({ pool:a.pool, code:'sku', fullAccess:true });
  assert.equal(a.bytes(), firstReadBytes, 'second tab adds zero DB response bytes');
  assert.equal(a.count(), 2, 'shared cache: one eligibility + one snapshot query');
  invalidateContainerDetails(a.pool);
  await getContainerDetails({ pool:a.pool, code:'sku' });
  assert.equal(a.count(), 4, 'without reusable cache the same scenario needs four queries');
  assert.equal(a.bytes(), firstReadBytes * 2, 'serialized DB fixture payload halves for two reads');
});
test('shared detail cache coalesces requests, groups source identity, filters each permission and isolates pools', async () => {
  const a = cachePool();
  const [publicResult, privateResult] = await Promise.all([
    getContainerDetails({ pool: a.pool, code: ' SKU ' }),
    getContainerDetails({ pool: a.pool, code: 'sku', fullAccess: true })
  ]);
  assert.equal(a.count(), 2, 'one eligibility and one snapshot read for concurrent callers');
  assert.deepEqual(publicResult.rows.map(row => row.quantity), [5, 7]);
  assert.doesNotMatch(JSON.stringify(publicResult), /SECRET|warnings|sheetName|containerRow/);
  assert.equal(privateResult.rows[0].orderedBy, 'SECRET');
  assert.equal(privateResult.rows[0].packageCount, 3);
  privateResult.rows[0].quantity = 999;
  privateResult.warnings[0].reason = 'mutated';
  const again = await getContainerDetails({ pool: a.pool, code: 'SKU', fullAccess: true });
  assert.equal(again.rows[0].quantity, 5);
  assert.equal(again.warnings[0].reason, 'secret');
  assert.equal(a.count(), 2);
  const b = cachePool();
  await getContainerDetails({ pool: b.pool, code: 'sku' });
  assert.equal(b.count(), 2);
});
test('cache expires at five minutes, invalidates explicitly, and never caches failures', async () => {
  const { invalidateContainerDetails } = require('./repository');
  const a = cachePool();
  let time = 1;
  const read = () => getContainerDetails({ pool: a.pool, code: 'sku', now: () => time });
  await read();
  time += 299999;
  await read();
  assert.equal(a.count(), 2);
  time++;
  await read();
  assert.equal(a.count(), 4);
  invalidateContainerDetails(a.pool);
  a.setFail(true);
  await assert.rejects(read(), /transient/);
  a.setFail(false);
  await read();
  assert.equal(a.count(), 8);
});
test('LRU retains hot keys and bounds cache at 500 products', async () => {
  const a = cachePool();
  for (let i = 0; i < 500; i++) await getContainerDetails({ pool: a.pool, code: 'sku' + i });
  await getContainerDetails({ pool: a.pool, code: 'sku0' });
  await getContainerDetails({ pool: a.pool, code: 'sku500' });
  await getContainerDetails({ pool: a.pool, code: 'sku0' });
  assert.equal(a.count(), 1002);
  await getContainerDetails({ pool: a.pool, code: 'sku1' });
  assert.equal(a.count(), 1004);
});
test('empty container results are cached', async () => {
  let count = 0;
  const pool = { query: async sql => {
    count++;
    return sql.includes('SELECT 1 FROM product_report') ? { rows: [{}] }
      : { rows: [{ sync: { version: 'v1', last_success_at: new Date().toISOString() }, items: [] }] };
  } };
  assert.deepEqual((await getContainerDetails({ pool, code: 'sku' })).rows, []);
  await getContainerDetails({ pool, code: 'sku' });
  assert.equal(count, 2);
});

test('successful changed and unchanged syncs invalidate shared cached details', async () => {
  const { refreshContainers } = require('./sync');
  const db = await fixture();
  let snapshotReads = 0;
  const pool = {
    connect: async () => connectionOver(db),
    query: async (sql, args) => {
      if (sql.includes('jsonb_agg(item')) snapshotReads++;
      return db.query(sql, args);
    }
  };
  const sync = at => refreshContainers({ pool, spreadsheetId: 'fixture', client: sheetClient({ YIWU: [['001A', 3]] }),
    now: () => new Date(at), logger: { info() {}, error() {} } });
  try {
    assert.equal((await sync(T0)).status, 'updated');
    await getContainerDetails({ pool, code: '001A' });
    await getContainerDetails({ pool, code: '001A' });
    assert.equal(snapshotReads, 1);
    assert.equal((await sync(T1)).status, 'unchanged');
    const result = await getContainerDetails({ pool, code: '001A' });
    assert.equal(snapshotReads, 2);
    assert.equal(new Date(result.containerSync.lastSuccessAt).toISOString(), new Date(T1).toISOString());
  } finally { await db.close(); }
});
test('invalidation while a read is pending cannot repopulate old cache', async () => {
  const { invalidateContainerDetails } = require('./repository');
  const base = cachePool();
  let release;
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let first = true;
  const pool = { query: async sql => {
    if (first && sql.includes('jsonb_agg(item')) { first = false; started(); await gate; }
    return base.pool.query(sql);
  } };
  const pending = getContainerDetails({ pool, code: 'sku' });
  await waiting;
  invalidateContainerDetails(pool);
  release();
  await pending;
  await getContainerDetails({ pool, code: 'sku' });
  assert.equal(base.count(), 4);
});
