'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { createPickAssignmentsService, mergeOrderLines, applyRemovals } = require('./pickAssignmentsService');

const MIGRATIONS = path.join(__dirname, '../db/migrations');
const migration = file => fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');

function poolFor(db) {
  const query = (sql, params) => db.query(sql, params);
  return { query, connect: async () => ({ query, release() {} }) };
}

const QL = { id: 'ql-1', hoTen: 'Quản Lý A - 123456789', username: 'ql' };
const ctx = (scope) => ({ user: QL, ...(scope ? { scope } : {}) });

test('old print snapshots receive seller contact without changing stored history or existing phones',async()=>{
 const snapshot={saleName:'Sale',sellerPhone:''};let lookups=0;
 const db={query:async(sql)=>({rows:sql.includes('SELECT id FROM')?[{id:1}]:sql.includes('SELECT * FROM order_pick_assignments')?[{id:1,branch:'SG',order_code:'DH1',order_snapshot:snapshot}]:[]})};
 const service=createPickAssignmentsService({getDb:()=>db,loadSellerPhone:async(pool,branch,code)=>{lookups++;assert.equal(pool,db);assert.equal(branch,'SG');assert.equal(code,'DH1');return '0901234567';}});
 const result=await service.get(ctx(),{branch:'SG',orderCode:'DH1'});
 assert.equal(result.assignment.snapshot.sellerPhone,'0901234567');assert.equal(snapshot.sellerPhone,'');
 snapshot.sellerPhone='0907654321';
 assert.equal((await service.get(ctx(),{branch:'SG',orderCode:'DH1'})).assignment.snapshot.sellerPhone,'0907654321');assert.equal(lookups,1);
});

test('readLatest: 1 truy van dau chi dinh; dong, lich su va SDT sale doc song song', async () => {
  const head = { id: 5, branch: 'HN', order_code: 'DH1', status: 'picking', version: 1, order_snapshot: { sellerPhone: '' } };
  const seen = [];
  const gates = [];
  const db = { query: sql => {
    seen.push(sql);
    if (sql.includes('FROM order_pick_assignments')) return Promise.resolve({ rows: [head] });
    return new Promise(resolve => gates.push(() => resolve({ rows: [] })));
  } };
  let phoneStarted = false, releasePhone;
  const service = createPickAssignmentsService({ getDb: () => db, loadOrder: async () => null,
    loadSellerPhone: () => { phoneStarted = true; return new Promise(resolve => { releasePhone = () => resolve('0901'); }); } });
  const pending = service.get(ctx(), { branch: 'HN', orderCode: 'DH1' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(seen.filter(sql => sql.includes('FROM order_pick_assignments')).length, 1, 'chi 1 truy van dau chi dinh');
  assert.equal(gates.length, 2, 'dong va lich su cung dang cho');
  assert.equal(phoneStarted, true, 'SDT cung dang cho');
  gates.forEach(open => open());
  releasePhone();
  const { assignment } = await pending;
  assert.equal(assignment.id, 5);
  assert.equal(assignment.status, 'picking');
  assert.equal(assignment.snapshot.sellerPhone, '0901');
});

function order(overrides = {}) {
  return {
    branch: 'HN', orderCode: 'DH001', customerName: 'Khách A', saleName: 'Sale B', saleTelegramId: '555', orderDate: '27/10/2026 09:00',
    status: { code: 'SENT_TO_ACCOUNTANT', label: 'Đơn đã gửi kế toán' }, invoiceDiscount: 0,
    lines: [{ productCode: 'AAA1', productName: 'Hàng A', quantity: 250, price: 10, discount: 0, note: '' }],
    ...overrides
  };
}

async function fixture({ orders = { DH001: order() }, positions } = {}) {
  const db = new PGlite();
  await db.exec(migration('0001_core_master_data.sql'));
  await db.exec(migration('0064_sheet_snapshots.sql'));
  await db.exec(migration('0095_stock_positions.sql'));
  await db.exec(migration('0096_order_pick_assignments.sql'));
  await db.exec(migration('0097_order_pick_assignment_snapshots.sql'));
  await db.exec(migration('0098_order_pick_history_mismatch_ack.sql'));
  const seed = positions || [
    { code: 'AAA1', location: 'A01', notes: '3T x 100' }, // id 1: 300
    { code: 'AAA1', location: 'B02', notes: '2T x 100' }, // id 2: 200
    { code: 'BBB2', location: 'C03', notes: '5T x 10' } // id 3
  ];
  for (const row of seed) {
    await db.query(`INSERT INTO stock_positions (branch, code, name, notes, location) VALUES ($1, $2, $3, $4, $5)`,
      [row.branch || 'HN', row.code, row.name || 'Tên ' + row.code, row.notes, row.location]);
  }
  const service = createPickAssignmentsService({
    getDb: () => poolFor(db),
    loadOrder: async ({ branch, orderCode }) => {
      const found = orders[orderCode];
      return found && found.branch === branch ? found : null;
    }
  });
  const notesOf = async id => (await db.query('SELECT notes FROM stock_positions WHERE id = $1', [id])).rows[0]?.notes;
  return { db, service, notesOf };
}

const assignBody = (allocations, extra = {}) => ({ branch: 'HN', orderCode: 'DH001', allocations, ...extra });

test('reject fractional source lines before merging and fractional allocations', async () => {
  for (const quantities of [[0.4], [0.6], [0.4, 0.6], [-1], [0]]) {
    const {db,service}=await fixture({orders:{DH001:order({lines:quantities.map(quantity=>({productCode:'AAA1',quantity,price:10}))})}});
    try {
      await assert.rejects(()=>service.assign(ctx(),assignBody([{productCode:'AAA1',positionId:1,qty:1}])),{code:'VALIDATION'});
      assert.equal(Number((await db.query('SELECT count(*) FROM order_pick_assignments')).rows[0].count),0);
      const view=await service.candidates(ctx(),{branch:'HN',orderCode:'DH001'});
      assert.equal(view.order.eligible,false);
      assert.ok(view.order.validationErrors.length);
    } finally { await db.close(); }
  }
  const {db,service}=await fixture();
  try { await assert.rejects(()=>service.assign(ctx(),assignBody([{productCode:'AAA1',positionId:1,qty:0.6}])),{code:'VALIDATION'}); }
  finally { await db.close(); }
});

test('confirm rejects moved or repacked positions and rolls back every line',async()=>{
  for(const change of ["location='B99'", "notes='3Tx50'", "code='OTHER'"]){
    const {db,service,notesOf}=await fixture();
    try{
      const {assignment}=await service.assign(ctx(),assignBody([{productCode:'AAA1',positionId:1,qty:200},{productCode:'AAA1',positionId:2,qty:50}]));
      await db.query('UPDATE stock_positions SET '+change+', version=version+1 WHERE id=2');
      await assert.rejects(()=>service.confirm(ctx(),assignment.id,{version:1}),{code:'STOCK_CHANGED'});
      assert.equal(await notesOf(1),'3T x 100');
      assert.equal((await service.get(ctx(),{branch:'HN',orderCode:'DH001'})).assignment.status,'picking');
      assert.equal(Number((await db.query("SELECT count(*) FROM stock_position_history WHERE action='pick'")).rows[0].count),0);
    }finally{await db.close();}
  }
});

test('Đã bốc là trạng thái cuối: cancel chỉ định confirmed trả 409 ALREADY_CONFIRMED, không hoàn thùng, không ghi lịch sử',async()=>{
  const {db,service,notesOf}=await fixture();
  try{
    const {assignment}=await service.assign(ctx(),assignBody([{productCode:'AAA1',positionId:1,qty:200},{productCode:'AAA1',positionId:2,qty:50}]));
    await service.confirm(ctx(),assignment.id,{version:1});
    await assert.rejects(()=>service.cancel(ctx(),assignment.id,{version:2}),{statusCode:409,code:'ALREADY_CONFIRMED'});
    // Sai version vẫn báo VERSION_CONFLICT trước (khóa lạc quan), còn đúng version thì bị chặn vì đã bốc.
    await assert.rejects(()=>service.cancel(ctx(),assignment.id,{version:9}),{statusCode:409,code:'VERSION_CONFLICT'});
    const after=(await service.get(ctx(),{branch:'HN',orderCode:'DH001'})).assignment;
    assert.deepEqual([after.status,after.version],['confirmed',2]);
    assert.deepEqual(after.history.map(h=>h.action),['assign','confirm']);
    assert.equal(await notesOf(1),'1T x 100','thùng đã trừ giữ nguyên');
    assert.equal(await notesOf(2),'2T x 100 - 50');
    assert.equal(Number((await db.query(`SELECT count(*) FROM stock_position_history WHERE action = 'pick_revert'`)).rows[0].count),0);
  }finally{await db.close();}
});

test('two orders share stock safely after depletion; confirmed cannot cancel, old picking can cancel only',async()=>{
  const orders={
    DH001:order({lines:[{productCode:'AAA1',quantity:100,price:10}]}),
    DH002:order({orderCode:'DH002',lines:[{productCode:'AAA1',quantity:100,price:10}]}),
    DH003:order({orderCode:'DH003',lines:[{productCode:'AAA1',quantity:100,price:10}]})
  };
  const {db,service,notesOf}=await fixture({orders});
  try{
    const first=(await service.assign(ctx(),assignBody([{productCode:'AAA1',positionId:1,qty:100}]))).assignment;
    const second=(await service.assign(ctx(),assignBody([{productCode:'AAA1',positionId:1,qty:100}],{orderCode:'DH002'}))).assignment;
    await service.confirm(ctx(),first.id,{version:1});
    await service.confirm(ctx(),second.id,{version:1});
    assert.equal(require('../public/shared/carton').parseSpec(await notesOf(1)).quantity,100);
    await assert.rejects(()=>service.cancel(ctx(),first.id,{version:2}),{code:'ALREADY_CONFIRMED'});
    const third=(await service.assign(ctx(),assignBody([{productCode:'AAA1',positionId:1,qty:100}],{orderCode:'DH003'}))).assignment;
    await db.query('UPDATE order_pick_lines SET allocation_snapshot=NULL WHERE assignment_id=$1',[third.id]);
    await assert.rejects(()=>service.confirm(ctx(),third.id,{version:1}),{code:'STOCK_CHANGED'});
    await service.cancel(ctx(),third.id,{version:1});
    assert.equal(require('../public/shared/carton').parseSpec(await notesOf(1)).quantity,100,'đơn Đã bốc không hoàn thùng; đơn Đang bốc hủy không đụng tồn');
  }finally{await db.close();}
});

test('order snapshot keeps original duplicate-code lines and exact total',async()=>{
  const lines=[{productCode:'AAA1',quantity:10000,price:10,discount:0},{productCode:'aaa1',quantity:1,price:11,discount:0}];
  const {db,service}=await fixture({orders:{DH001:order({lines})},positions:[{code:'AAA1',location:'A01',notes:'101Tx100'}]});
  try{
    const {assignment}=await service.assign(ctx(),assignBody([{productCode:'AAA1',positionId:1,qty:10001}]));
    assert.equal(assignment.snapshot.schemaVersion,2);
    assert.equal(assignment.snapshot.lines.length,2);
    assert.equal(assignment.snapshot.goodsTotal,'100011');
    lines[0].price=99;
    assert.equal((await service.get(ctx(),{branch:'HN',orderCode:'DH001'})).assignment.snapshot.goodsTotal,'100011');
  }finally{await db.close();}
});

test('mergeOrderLines: gop theo ma (khong phan biet hoa/thuong), bo dong dich vu va VAT, binh quan gia khi khac gia', () => {
  const merged = mergeOrderLines([
    { productCode: 'AAA1', productName: 'Hàng A', quantity: 100, price: 10, discount: 0, note: '15th' },
    { productCode: 'aaa1', productName: '', quantity: 50, price: 10, discount: 0, note: ' full vat ' },
    { productCode: 'AAA1', productName: '', quantity: 5, price: 10, discount: 0, note: '15th' },
    { productCode: 'BBB2', productName: 'B', quantity: 10, price: 10, discount: 2 },
    { productCode: 'bbb2', productName: 'B', quantity: 30, price: 20, discount: 2 },
    { productCode: 'VAT8', productName: 'Thuế', quantity: 1, price: 5 },
    { productCode: 'DV1', productName: 'Phí', quantity: 1, price: 5, isService: true },
    { productCode: 'ZERO', productName: 'Không SL', quantity: 0, price: 1 }
  ]);
  assert.deepEqual(merged, [
    { productCode: 'AAA1', productName: 'Hàng A', quantity: 155, price: 10, discount: 0, note: '15th; full vat' },
    { productCode: 'BBB2', productName: 'B', quantity: 40, price: 17.5, discount: 2, note: '' }
  ]);
});

test('candidates: ung vien theo ma kem onHand / held (chi chi dinh dang nhat cua DON KHAC) / available, chi dinh moi nhat cua don', async () => {
  const { db, service } = await fixture({ orders: {
    DH001: order(),
    DH002: order({ orderCode: 'DH002', lines: [{ productCode: 'aaa1', productName: 'Hàng A', quantity: 120, price: 10 }] })
  } });
  try {
    let result = await service.candidates(ctx(), { branch: 'HN', orderCode: 'DH001' });
    assert.equal(result.order.eligible, true);
    assert.deepEqual(result.order.lines, [{ productCode: 'AAA1', productName: 'Hàng A', quantity: 250, price: 10, discount: 0, note: '' }]);
    assert.deepEqual(result.candidates.aaa1.map(c => [c.positionId, c.location, c.onHand, c.held, c.available]), [[1, 'A01', 300, 0, 300], [2, 'B02', 200, 0, 200]]);
    assert.equal(result.assignment, null);
    await service.assign(ctx(), assignBody([{ productCode: 'AAA1', positionId: 1, qty: 200 }, { productCode: 'AAA1', positionId: 2, qty: 50 }]));
    // Don khac thay giu cho cua DH001; chinh DH001 thi khong bi tru giu cho cua minh.
    result = await service.candidates(ctx(), { branch: 'HN', orderCode: 'DH002' });
    assert.deepEqual(result.candidates.aaa1.map(c => [c.positionId, c.held, c.available]), [[1, 200, 100], [2, 50, 150]]);
    result = await service.candidates(ctx(), { branch: 'HN', orderCode: 'DH001' });
    assert.deepEqual(result.candidates.aaa1.map(c => [c.positionId, c.held, c.available]), [[1, 0, 300], [2, 0, 200]]);
    assert.equal(result.assignment.status, 'picking');
    await assert.rejects(() => service.candidates(ctx(), { branch: 'HN', orderCode: 'KHONGCO' }), { statusCode: 404, code: 'NOT_FOUND' });
    await assert.rejects(() => service.candidates(ctx(['SG']), { branch: 'HN', orderCode: 'DH001' }), { statusCode: 403, code: 'BRANCH_OUT_OF_SCOPE' });
  } finally { await db.close(); }
});

test('candidates: ghi chu sai dinh dang -> onHand/available null kem canh bao', async () => {
  const { db, service } = await fixture({ positions: [{ code: 'AAA1', location: 'A01', notes: 'rác' }] });
  try {
    const { candidates } = await service.candidates(ctx(), { branch: 'HN', orderCode: 'DH001' });
    assert.deepEqual(candidates.aaa1.map(c => [c.onHand, c.available, c.warnings]), [[null, null, ['unreadable']]]);
  } finally { await db.close(); }
});

test('assign: tao chi dinh Dang nhat, giu cho (chua doi ghi chu), tinh ST, luu snapshot don + lich su', async () => {
  const { db, service, notesOf } = await fixture();
  try {
    const { assignment } = await service.assign(ctx(), assignBody([{ productCode: 'aaa1', positionId: 1, qty: 200 }, { productCode: 'AAA1', positionId: 2, qty: 50 }]));
    assert.equal(assignment.status, 'picking');
    assert.equal(assignment.version, 1);
    assert.equal(assignment.branch, 'HN');
    assert.equal(assignment.orderCode, 'DH001');
    assert.equal(assignment.assignedByName, 'Quản Lý A');
    assert.equal(assignment.snapshot.customerName, 'Khách A');
    assert.equal(assignment.snapshot.saleTelegramId, '555');
    assert.deepEqual(assignment.snapshot.lines, [{ productCode: 'AAA1', productName: 'Hàng A', quantity: 250, price: 10, discount: 0, note: '', unitPrice: '10', amount: '2500' }]);
    assert.equal(assignment.snapshot.schemaVersion, 2);
    assert.deepEqual(assignment.lines.map(l => [l.positionId, l.location, l.plannedQty, l.reservedQty, l.stCartons, l.stText, l.pickedQty]),
      [[1, 'A01', 200, 200, 2, '2Tx100', null], [2, 'B02', 50, 50, 1, '1Tx100-50', null]]);
    assert.deepEqual(assignment.history.map(h => [h.action, h.actorName]), [['assign', 'Quản Lý A']]);
    assert.equal(await notesOf(1), '3T x 100', 'giu cho khong doi ghi chu');
    assert.equal(await notesOf(2), '2T x 100');
  } finally { await db.close(); }
});

test('assign: loi 404 / 409 don khong du dieu kien / 400 thieu SL, vi tri la, ma ngoai don / 409 vuot ton / 409 da chi dinh', async () => {
  const { db, service } = await fixture({ orders: {
    DH001: order(),
    DH003: order({ orderCode: 'DH003', status: { code: 'NOT_SENT', label: 'Đơn chưa gửi kế toán' } }),
    DH004: order({ orderCode: 'DH004', lines: [{ productCode: 'AAA1', productName: 'Hàng A', quantity: 250, price: 10 }] }),
    DH005: order({ orderCode: 'DH005', lines: [] })
  } });
  try {
    const A = (positionId, qty, productCode = 'AAA1') => ({ productCode, positionId, qty });
    await assert.rejects(() => service.assign(ctx(), { branch: 'HN', orderCode: 'KHONGCO', allocations: [A(1, 1)] }), { statusCode: 404, code: 'NOT_FOUND' });
    await assert.rejects(() => service.assign(ctx(), { branch: 'XX', orderCode: 'DH001', allocations: [] }), { statusCode: 400, code: 'INVALID_BRANCH' });
    await assert.rejects(() => service.assign(ctx(), { branch: 'HN', orderCode: '  ', allocations: [A(1, 1)] }), { statusCode: 400, code: 'VALIDATION' });
    await assert.rejects(() => service.assign(ctx(), assignBody([])), { statusCode: 400, code: 'VALIDATION' });
    await assert.rejects(() => service.assign(ctx(), { branch: 'HN', orderCode: 'DH005', allocations: [A(1, 1)] }), { statusCode: 400, code: 'VALIDATION' });
    await assert.rejects(() => service.assign(ctx(), assignBody([A(1, 100)])), { statusCode: 400, code: 'VALIDATION' }); // thieu SL (100/250)
    await assert.rejects(() => service.assign(ctx(), assignBody([A(99, 250)])), { statusCode: 400, code: 'VALIDATION' }); // vi tri khong ton tai
    await assert.rejects(() => service.assign(ctx(), assignBody([A(3, 250)])), { statusCode: 400, code: 'VALIDATION' }); // vi tri cua ma khac
    await assert.rejects(() => service.assign(ctx(), assignBody([A(1, 250, 'ZZZ')])), { statusCode: 400, code: 'VALIDATION' }); // ma khong co trong don
    await assert.rejects(() => service.assign(ctx(), assignBody([A(1, -5), A(2, 255)])), { statusCode: 400, code: 'VALIDATION' });
    await assert.rejects(() => service.assign(ctx(), assignBody([A(2, 250)])), { statusCode: 409, code: 'INSUFFICIENT_AVAILABLE' }); // vi tri 2 chi co 200
    // Giu cho cua don khac lam het kha dung -> don sau bi chan.
    await service.assign(ctx(), assignBody([A(1, 250)]));
    await assert.rejects(() => service.assign(ctx(), { branch: 'HN', orderCode: 'DH004', allocations: [A(1, 100), A(2, 150)] }), { statusCode: 409, code: 'INSUFFICIENT_AVAILABLE' });
    const ok = await service.assign(ctx(), { branch: 'HN', orderCode: 'DH004', allocations: [A(1, 50), A(2, 200)] });
    assert.equal(ok.assignment.status, 'picking');
    await assert.rejects(() => service.assign(ctx(), assignBody([A(2, 250)])), { statusCode: 409, code: 'ALREADY_ASSIGNED' });
    await assert.rejects(() => service.assign(ctx(['SG']), assignBody([A(1, 250)])), { statusCode: 403, code: 'BRANCH_OUT_OF_SCOPE' });
  } finally { await db.close(); }
});

test('assign: cung vi tri chi dinh nhieu lan trong 1 yeu cau duoc gop thanh 1 dong', async () => {
  const { db, service } = await fixture();
  try {
    const { assignment } = await service.assign(ctx(), assignBody([{ productCode: 'AAA1', positionId: 1, qty: 100 }, { productCode: 'AAA1', positionId: 1, qty: 150 }]));
    assert.deepEqual(assignment.lines.map(l => [l.positionId, l.plannedQty]), [[1, 250]]);
  } finally { await db.close(); }
});

test('assign: nhat tron thung duoc vuot SL can it hon 1 thung (roundedUp), hai lan gui lien tiep chi tao 1 chi dinh', async () => {
  const { db, service } = await fixture({ orders: { DH001: order({ lines: [{ productCode: 'AAA1', productName: 'Hàng A', quantity: 250, price: 10 }] }) } });
  try {
    const first = await service.assign(ctx(), assignBody([{ productCode: 'AAA1', positionId: 1, qty: 300 }]));
    assert.equal(first.assignment.lines[0].plannedQty, 300);
    await assert.rejects(() => service.assign(ctx(), assignBody([{ productCode: 'AAA1', positionId: 2, qty: 250 }])), { code: 'ALREADY_ASSIGNED' });
    assert.equal((await db.query('SELECT count(*)::int AS n FROM order_pick_assignments')).rows[0].n, 1);
  } finally { await db.close(); }
});

test('confirm: tru thung that (3T x 100 tru 200 -> 1T x 100), ghi lich su pick, version + 1; xac nhan lai / sai version bi chan', async () => {
  const { db, service, notesOf } = await fixture();
  try {
    const { assignment } = await service.assign(ctx(), assignBody([{ productCode: 'AAA1', positionId: 1, qty: 200 }, { productCode: 'AAA1', positionId: 2, qty: 50 }]));
    await assert.rejects(() => service.confirm(ctx(), assignment.id, { version: 9 }), error => error.code === 'VERSION_CONFLICT' && error.statusCode === 409 && error.latest.id === assignment.id);
    await assert.rejects(() => service.confirm(ctx(), assignment.id, {}), { statusCode: 400, code: 'VALIDATION' });
    await assert.rejects(() => service.confirm(ctx(), 9999, { version: 1 }), { statusCode: 404, code: 'NOT_FOUND' });
    await assert.rejects(() => service.confirm(ctx(['SG']), assignment.id, { version: 1 }), { statusCode: 403, code: 'BRANCH_OUT_OF_SCOPE' });
    const done = (await service.confirm(ctx(), assignment.id, { version: 1 })).assignment;
    assert.equal(done.status, 'confirmed');
    assert.equal(done.version, 2);
    assert.equal(done.confirmedByName, 'Quản Lý A');
    assert.deepEqual(done.lines.map(l => [l.pickedQty, l.specBefore, l.specAfter]), [[200, '3T x 100', '1T x 100'], [50, '2T x 100', '2T x 100 - 50']]);
    assert.deepEqual(done.history.map(h => h.action), ['assign', 'confirm']);
    assert.equal(await notesOf(1), '1T x 100');
    assert.equal(await notesOf(2), '2T x 100 - 50');
    const log = (await db.query(`SELECT position_id, action, old_value, new_value, summary FROM stock_position_history WHERE action = 'pick' ORDER BY id`)).rows;
    assert.deepEqual(log.map(r => [Number(r.position_id), r.old_value, r.new_value, r.summary.orderCode, r.summary.picked]), [[1, '3T x 100', '1T x 100', 'DH001', 200], [2, '2T x 100', '2T x 100 - 50', 'DH001', 50]]);
    const version = (await db.query('SELECT version FROM stock_positions WHERE id = 1')).rows[0].version;
    assert.equal(version, 2);
    await assert.rejects(() => service.confirm(ctx(), assignment.id, { version: 2 }), { statusCode: 409, code: 'INVALID_STATE' });
  } finally { await db.close(); }
});

test('confirm: ton vi tri da doi (khong con du / het hang / bi xoa) -> 409 STOCK_CHANGED va khong tru dong nao', async () => {
  for (const change of [
    db => db.query(`UPDATE stock_positions SET notes = '1T x 100' WHERE id = 2`),
    db => db.query(`UPDATE stock_positions SET notes = 'rác' WHERE id = 2`),
    db => db.query(`DELETE FROM stock_positions WHERE id = 2`)
  ]) {
    const { db, service, notesOf } = await fixture();
    try {
      const { assignment } = await service.assign(ctx(), assignBody([{ productCode: 'AAA1', positionId: 1, qty: 100 }, { productCode: 'AAA1', positionId: 2, qty: 150 }]));
      await change(db);
      await assert.rejects(() => service.confirm(ctx(), assignment.id, { version: 1 }), { statusCode: 409, code: 'STOCK_CHANGED' });
      assert.equal(await notesOf(1), '3T x 100', 'rollback: dong 1 khong bi tru');
      assert.equal((await service.get(ctx(), { branch: 'HN', orderCode: 'DH001' })).assignment.status, 'picking');
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM stock_position_history WHERE action = 'pick'`)).rows[0].n, 0);
    } finally { await db.close(); }
  }
});

test('cancel khi dang nhat: tra giu cho, khong dong vao ton; huy 2 lan bi chan; sau do co the chi dinh lai', async () => {
  const { db, service, notesOf } = await fixture({ orders: {
    DH001: order(),
    DH002: order({ orderCode: 'DH002', lines: [{ productCode: 'AAA1', productName: 'Hàng A', quantity: 300, price: 10 }] })
  } });
  try {
    const { assignment } = await service.assign(ctx(), assignBody([{ productCode: 'AAA1', positionId: 1, qty: 250 }]));
    await assert.rejects(() => service.assign(ctx(), { branch: 'HN', orderCode: 'DH002', allocations: [{ productCode: 'AAA1', positionId: 1, qty: 300 }] }), { code: 'INSUFFICIENT_AVAILABLE' });
    const cancelled = (await service.cancel(ctx(), assignment.id, { version: 1 })).assignment;
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.cancelledByName, 'Quản Lý A');
    assert.deepEqual(cancelled.history.map(h => h.action), ['assign', 'cancel']);
    assert.equal(await notesOf(1), '3T x 100');
    await assert.rejects(() => service.cancel(ctx(), assignment.id, { version: 2 }), { statusCode: 409, code: 'INVALID_STATE' });
    // Giu cho da tra: chinh don nay chi dinh lai duoc (ban ghi cu giu lai, ban moi nhat la picking) ...
    const again = (await service.assign(ctx(), assignBody([{ productCode: 'AAA1', positionId: 2, qty: 200 }, { productCode: 'AAA1', positionId: 1, qty: 50 }]))).assignment;
    assert.equal(again.status, 'picking');
    assert.notEqual(again.id, assignment.id);
    assert.deepEqual((await db.query(`SELECT status FROM order_pick_assignments WHERE order_code = 'DH001' ORDER BY id`)).rows.map(r => r.status), ['cancelled', 'picking']);
    assert.equal((await service.get(ctx(), { branch: 'HN', orderCode: 'DH001' })).assignment.id, again.id, 'get tra chi dinh MOI NHAT');
    // ... va don khac chi lay duoc phan con lai (vi tri 1: 300 - 50 dang giu cho).
    await assert.rejects(() => service.assign(ctx(), { branch: 'HN', orderCode: 'DH002', allocations: [{ productCode: 'AAA1', positionId: 1, qty: 300 }] }), { code: 'INSUFFICIENT_AVAILABLE' });
  } finally { await db.close(); }
});

test('latestStatuses: trang thai chi dinh MOI NHAT theo (co so, ma don chu thuong); chua ap migration thi tra Map rong', async () => {
  const { db, service } = await fixture({ orders: {
    DH001: order(),
    DH002: order({ orderCode: 'DH002', lines: [{ productCode: 'BBB2', productName: 'B', quantity: 20, price: 1 }] })
  } });
  try {
    assert.equal((await service.latestStatuses()).size, 0);
    const first = (await service.assign(ctx(), assignBody([{ productCode: 'AAA1', positionId: 1, qty: 250 }]))).assignment;
    await service.assign(ctx(), { branch: 'HN', orderCode: 'DH002', allocations: [{ productCode: 'BBB2', positionId: 3, qty: 20 }] });
    await service.confirm(ctx(), (await service.get(ctx(), { branch: 'HN', orderCode: 'DH002' })).assignment.id, { version: 1 });
    await service.cancel(ctx(), first.id, { version: 1 });
    await service.assign(ctx(), assignBody([{ productCode: 'AAA1', positionId: 2, qty: 200 }, { productCode: 'AAA1', positionId: 1, qty: 50 }]));
    const map = await service.latestStatuses();
    assert.deepEqual([...map].sort(), [['HN|dh001', 'picking'], ['HN|dh002', 'confirmed']]);
    await service.cancel(ctx(), (await service.get(ctx(), { branch: 'HN', orderCode: 'DH001' })).assignment.id, { version: 1 });
    assert.equal((await service.latestStatuses()).get('HN|dh001'), 'cancelled');
    await db.exec('DROP TABLE order_pick_lines; DROP TABLE order_pick_history; DROP TABLE order_pick_assignments;');
    assert.equal((await service.latestStatuses()).size, 0);
  } finally { await db.close(); }
});

test('lich su chi dinh va lich su VT la bat bien (trigger chan sua/xoa)', async () => {
  const { db, service } = await fixture();
  try {
    await service.assign(ctx(), assignBody([{ productCode: 'AAA1', positionId: 1, qty: 250 }]));
    await assert.rejects(() => db.query(`UPDATE order_pick_history SET actor_name = 'x'`), /immutable/);
    await assert.rejects(() => db.query(`DELETE FROM order_pick_history`), /immutable/);
  } finally { await db.close(); }
});


test('empty allocation can be saved with mismatch acknowledgement without reserving stock', async () => {
  const { db, service } = await fixture();
  try {
    await assert.rejects(() => service.assign(ctx(), assignBody([])), { code: 'VALIDATION' });
    const { assignment: result } = await service.assign(ctx(), { ...assignBody([]), allowMismatch: true });
    assert.equal(result.status, 'picking');
    assert.deepEqual(result.lines, []);
    const candidates = await service.candidates(ctx(), { branch: 'HN', orderCode: 'DH001' });
    assert.ok(candidates.candidates.aaa1.every(row => row.held === 0));
  } finally { await db.close(); }
});

test('chi dinh duoc o MOI trang thai vong doi (ke ca chua gui ke toan); don da huy nhat chi dinh lai duoc', async () => {
  const orders = { DH001: order() };
  const { db, service } = await fixture({ orders });
  try {
    const first = await service.assign(ctx(), assignBody([{ productCode: 'AAA1', positionId: 1, qty: 250 }]));
    await service.cancel(ctx(), first.assignment.id, { version: first.assignment.version });
    for (const code of ['NOT_SENT', 'SENT_TO_ACCOUNTANT', 'DELIVERING', 'DELIVERED', 'SHIP_RECEIVED', 'SIGNED', 'COMPLETED', 'CANCELLED', 'EXCEPTION']) {
      orders.DH001 = order({ status: { code, label: code } });
      assert.equal((await service.candidates(ctx(), { branch: 'HN', orderCode: 'DH001' })).order.eligible, true, code);
    }
    orders.DH001 = order({ status: { code: 'NOT_SENT', label: 'Đơn chưa gửi kế toán' } });
    const again = await service.assign(ctx(), assignBody([{ productCode: 'AAA1', positionId: 1, qty: 250 }]));
    assert.equal(again.assignment.status, 'picking');
  } finally { await db.close(); }
});

test('SL can nhat sua tay chi luu trong chi dinh (snapshot quantity + kiotQuantity), khong ghi Kiot va khong sua don nguon',async()=>{
  const source=order();const orders={DH001:source};
  const {db}=await fixture({orders});
  let editorCalls=0;let loads=0;
  const spy=async()=>{editorCalls++;};
  // orderEditor khong con la tham so cua service: truyen vao cung bi bo qua.
  const service=createPickAssignmentsService({getDb:()=>poolFor(db),orderEditor:{setQuantities:spy,removeLine:spy,updateOrder:spy},
    loadOrder:async({branch,orderCode})=>{loads++;const found=orders[orderCode];return found&&found.branch===branch?found:null;}});
  try{
    const {assignment}=await service.assign(ctx(),assignBody([{productCode:'AAA1',positionId:1,qty:200}],{needs:{AAA1:200}}));
    assert.equal(editorCalls,0);assert.equal(loads,1,'chi doc don 1 lan, khong doc lai sau khi ghi');
    assert.equal(assignment.snapshot.lines[0].quantity,200);
    assert.equal(assignment.snapshot.lines[0].kiotQuantity,250);
    assert.equal(source.lines[0].quantity,250,'don nguon khong bi sua');
    assert.equal(typeof service.removeLine,'undefined','da bo removeLine');
  }finally{await db.close();}
});

test('applyRemovals: bo ma khoi dong gop va moi dong goc cung ma (khong phan biet hoa/thuong); khong co removed thi giu nguyen',()=>{
  const source=order({lines:[{productCode:'AAA1',productName:'Hàng A',quantity:100,price:10,discount:0},{productCode:'BBB2',productName:'Hàng B',quantity:20,price:5,discount:0},{productCode:'aaa1',productName:'Hàng A',quantity:150,price:10,discount:0}]});
  const lines=mergeOrderLines(source.lines);
  for(const removed of [undefined,null]){
    const same=applyRemovals(source,lines,removed);
    assert.equal(same.lines,lines);assert.equal(same.order,source);
  }
  const empty=applyRemovals(source,lines,[]);
  assert.equal(empty.lines,lines);assert.equal(empty.order,source);
  const result=applyRemovals(source,lines,[' aaa1 ']);
  assert.deepEqual(result.lines.map(line=>line.productCode),['BBB2']);
  assert.deepEqual(result.order.lines.map(line=>line.productCode),['BBB2'],'ca hai dong goc AAA1/aaa1 bi bo');
  assert.equal(source.lines.length,3,'khong sua don nguon');
  assert.equal(result.order.orderCode,'DH001');
});

test('applyRemovals: ma khong co trong don / ma trong / bo het dong / khong phai mang -> 400 VALIDATION field removed',()=>{
  const source=order({lines:[{productCode:'AAA1',quantity:250,price:10,discount:0},{productCode:'BBB2',quantity:20,price:5,discount:0}]});
  const lines=mergeOrderLines(source.lines);
  for(const removed of [['ZZZ9'],[''],[null],['AAA1','BBB2'],['aaa1','bbb2','AAA1'],'AAA1',{AAA1:true},5]){
    assert.throws(()=>applyRemovals(source,lines,removed),error=>error.statusCode===400&&error.code==='VALIDATION'&&error.field==='removed',JSON.stringify(removed));
  }
});

test('assign removed: snapshot khong con ma da bo, tong tien tinh lai; phan bo / SL sua cho ma da bo -> 400; khong tao chi dinh khi loi',async()=>{
  const orders={DH001:order({lines:[{productCode:'AAA1',productName:'Hàng A',quantity:250,price:10,discount:0,note:''},{productCode:'BBB2',productName:'Hàng B',quantity:20,price:5,discount:0,note:''}]})};
  const {db,service}=await fixture({orders});
  try{
    await assert.rejects(()=>service.assign(ctx(),assignBody([{productCode:'AAA1',positionId:1,qty:250},{productCode:'BBB2',positionId:3,qty:20}],{removed:['bbb2']})),{statusCode:400,code:'VALIDATION'});
    await assert.rejects(()=>service.assign(ctx(),assignBody([{productCode:'AAA1',positionId:1,qty:250}],{removed:['BBB2'],needs:{BBB2:10}})),{statusCode:400,code:'VALIDATION'});
    await assert.rejects(()=>service.assign(ctx(),assignBody([{productCode:'AAA1',positionId:1,qty:250}],{removed:['ZZZ9']})),{statusCode:400,code:'VALIDATION'});
    await assert.rejects(()=>service.assign(ctx(),assignBody([],{removed:['AAA1','BBB2']})),{statusCode:400,code:'VALIDATION'});
    assert.equal(Number((await db.query('SELECT count(*) FROM order_pick_assignments')).rows[0].count),0);
    const {assignment}=await service.assign(ctx(),assignBody([{productCode:'AAA1',positionId:1,qty:250}],{removed:['bbb2']}));
    assert.deepEqual(assignment.snapshot.lines.map(line=>line.productCode),['AAA1']);
    assert.equal(assignment.snapshot.goodsTotal,'2500');
    assert.deepEqual(assignment.lines.map(line=>line.productCode),['AAA1']);
    assert.equal(orders.DH001.lines.length,2,'don nguon giu nguyen');
  }finally{await db.close();}
});

test('sửa VT trong hộp Chỉ định: chỉ mã trong đơn, thêm trùng thì cộng dồn, đơn mình giữ thì sửa được, đơn khác giữ thì không hạ dưới, Đã bốc thì chặn',async()=>{
  const orders={
    DH001:order(),
    DH002:order({orderCode:'DH002',lines:[{productCode:'AAA1',quantity:100,price:10,discount:0}]})
  };
  const {db,service,notesOf}=await fixture({orders});
  try{
    // Dong VT doc cot format_ack (0099); 0096 dung lai CHECK lich su cu nen nap lai 0101.
    await db.exec(migration('0099_stock_position_ack_and_history_purge.sql'));
    await db.exec(migration('0101_stock_position_stock_out_action.sql'));
    await db.query(`INSERT INTO products (branch, id, code, name, raw) VALUES ('hanoi', 1, 'AAA1', 'Hàng A', '{}'), ('hanoi', 2, 'BBB2', 'Hàng B', '{}')`);
    const scope={branch:'HN',orderCode:'DH001'};
    // Ma ngoai don -> 400 productCode; dong VT cua ma ngoai don -> 403.
    await assert.rejects(()=>service.createPosition(ctx(),{...scope,productCode:'BBB2',location:'Z1',notes:'1T x 5'}),{statusCode:400,code:'VALIDATION',field:'productCode'});
    await assert.rejects(()=>service.updatePosition(ctx(),3,{...scope,notes:'1T x 1',version:1}),{statusCode:403,code:'NOT_IN_ORDER'});
    await assert.rejects(()=>service.removePosition(ctx(),3,{...scope,version:1}),{code:'NOT_IN_ORDER'});
    await assert.rejects(()=>service.updatePosition(ctx(),1,{...scope,notes:'1T x 1'}),{code:'VALIDATION',field:'version'});
    await assert.rejects(()=>service.createPosition(ctx(),{branch:'HN',orderCode:'KHONGCO',productCode:'AAA1',location:'A01',notes:'1T x 1'}),{code:'NOT_FOUND'});
    // Them trung (ma, vi tri) -> cong don ghi chu, lich su VT ghi theo don.
    const added=await service.createPosition(ctx(),{...scope,productCode:'aaa1',location:'a01',notes:'1T x 100'});
    assert.equal(added.merged,true);assert.equal(added.row.id,1);assert.equal(added.row.notes,'4T x 100');
    const fresh=await service.createPosition(ctx(),{...scope,productCode:'AAA1',location:'D04',notes:'1T x 30'});
    assert.equal(fresh.merged,false);assert.equal(fresh.row.code,'AAA1');
    const vtHistory=(await db.query(`SELECT action, summary FROM stock_position_history ORDER BY id DESC LIMIT 2`)).rows;
    assert.deepEqual(vtHistory.map(h=>[h.action,h.summary.source,h.summary.orderCode]),[['create','pick','DH001'],['edit','pick','DH001']]);

    // DH001 Dang boc giu 200 (id 1) + 50 (id 2): chinh don nay sua duoi phan minh giu duoc.
    await service.assign(ctx(),assignBody([{productCode:'AAA1',positionId:1,qty:200},{productCode:'AAA1',positionId:2,qty:50}]));
    const own=await service.updatePosition(ctx(),2,{...scope,notes:'1T x 20',version:1,extra:'bo qua'});
    assert.equal(own.row.notes,'1T x 20');
    // DH002 giu 100 o id 1: DH001 khong ha id 1 duoi 100, khong xoa duoc.
    const second=(await service.assign(ctx(),{branch:'HN',orderCode:'DH002',allocations:[{productCode:'AAA1',positionId:1,qty:100}]})).assignment;
    await assert.rejects(()=>service.updatePosition(ctx(),1,{...scope,notes:'1T x 50',version:2}),
      e=>e.code==='BELOW_HELD'&&e.held===100&&JSON.stringify(e.orders)==='["DH002"]');
    await assert.rejects(()=>service.removePosition(ctx(),1,{...scope,version:2}),e=>e.code==='POSITION_HELD'&&JSON.stringify(e.orders)==='["DH002"]');
    assert.equal(await notesOf(1),'4T x 100');
    // Ve 0 tren dong chi minh giu: hoi xac nhan roi tu xoa.
    await assert.rejects(()=>service.updatePosition(ctx(),2,{...scope,notes:'',version:2}),{code:'WOULD_AUTO_DELETE'});
    assert.deepEqual(await service.updatePosition(ctx(),2,{...scope,notes:'',version:2,confirmEmpty:true}),{deleted:true,id:2});
    // DH002 Da boc -> hop chi xem.
    await service.confirm(ctx(),second.id,{version:second.version});
    await assert.rejects(()=>service.createPosition(ctx(),{branch:'HN',orderCode:'DH002',productCode:'AAA1',location:'A01',notes:'1T x 1'}),{statusCode:409,code:'INVALID_STATE'});
    await assert.rejects(()=>service.updatePosition(ctx(),1,{branch:'HN',orderCode:'DH002',notes:'1T x 1',version:3}),{code:'INVALID_STATE'});
  }finally{await db.close();}
});
