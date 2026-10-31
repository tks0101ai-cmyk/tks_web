'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { createPickAssignmentsService, mergeOrderLines } = require('./pickAssignmentsService');

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

function order(overrides = {}) {
  return {
    branch: 'HN', orderCode: 'DH001', customerName: 'Khách A', saleName: 'Sale B', saleTelegramId: '555', orderDate: '27/10/2026 09:00',
    status: { code: 'SENT_TO_ACCOUNTANT', label: 'Đơn đã gửi kế toán' }, invoiceDiscount: 0,
    lines: [{ productCode: 'AAA1', productName: 'Hàng A', quantity: 250, price: 10, discount: 0, note: '' }],
    ...overrides
  };
}

async function fixture({ orders = { DH001: order() }, positions, orderEditor } = {}) {
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
    ...(orderEditor ? { orderEditor } : {}),
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

test('SL can nhat sua tay duoc ghi len Kiot roi doc lai don; chi dinh dung SL moi, khong con lech Kiot',async()=>{
  const orders={DH001:order()};const calls=[];
  const orderEditor={
    setQuantities:async arg=>{calls.push(['set',arg]);orders.DH001=order({lines:[{productCode:'AAA1',productName:'Hàng A',quantity:200,price:10,discount:0,note:''}]});return {changed:true};},
    removeLine:async()=>{throw new Error('khong duoc goi');}
  };
  const {db,service}=await fixture({orders,orderEditor});
  try{
    const {assignment}=await service.assign(ctx(),assignBody([{productCode:'AAA1',positionId:1,qty:200}],{needs:{AAA1:200}}));
    assert.deepEqual(calls.map(call=>call[0]),['set']);
    assert.equal(calls[0][1].branch,'HN');assert.equal(calls[0][1].orderCode,'DH001');assert.deepEqual(calls[0][1].quantities,{AAA1:200});
    assert.equal(assignment.snapshot.lines[0].quantity,200);
    assert.equal(assignment.snapshot.lines[0].kiotQuantity,undefined);
  }finally{await db.close();}
});

test('Kiot tu choi ghi SL -> assign loi va khong tao chi dinh',async()=>{
  const orderEditor={setQuantities:async()=>{throw Object.assign(new Error('Kiot tu choi'),{statusCode:502,code:'KIOT_REJECTED'});}};
  const {db,service}=await fixture({orderEditor});
  try{
    await assert.rejects(()=>service.assign(ctx(),assignBody([{productCode:'AAA1',positionId:1,qty:200}],{needs:{AAA1:200}})),{code:'KIOT_REJECTED'});
    assert.equal(Number((await db.query('SELECT count(*) FROM order_pick_assignments')).rows[0].count),0);
  }finally{await db.close();}
});

test('SL khong sua (needs trung Kiot) khong cham Kiot',async()=>{
  let touched=0;const orderEditor={setQuantities:async()=>{touched++;return {};}};
  const {db,service}=await fixture({orderEditor});
  try{
    await service.assign(ctx(),assignBody([{productCode:'AAA1',positionId:1,qty:250}],{needs:{AAA1:250}}));
    assert.equal(touched,0);
  }finally{await db.close();}
});

test('removeLine goi bo ghi Kiot voi nguoi thao tac va tra chi dinh moi nhat; thieu ma hang -> 400',async()=>{
  const calls=[];const orderEditor={removeLine:async arg=>{calls.push(arg);return {changed:true};}};
  const {db,service}=await fixture({orderEditor});
  try{
    const result=await service.removeLine(ctx(),{branch:'HN',orderCode:'DH001',productCode:' AAA1 '});
    assert.equal(result.changed,true);assert.equal(result.assignment,null);
    assert.equal(calls[0].productCode,'AAA1');assert.equal(calls[0].orderCode,'DH001');assert.equal(calls[0].branch,'HN');
    await assert.rejects(()=>service.removeLine(ctx(),{branch:'HN',orderCode:'DH001',productCode:''}),{code:'VALIDATION'});
    await assert.rejects(()=>service.removeLine(ctx(),{branch:'XX',orderCode:'DH001',productCode:'AAA1'}));
  }finally{await db.close();}
});
