'use strict';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createKiotOrdersRepository, LIFECYCLE_TO_DB_BRANCH, DB_TO_LIFECYCLE_BRANCH, __test__
} = require('./kiotOrdersRepository');

const { allocateSellable } = __test__;

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

// ---------------------------------------------------------------------------
// HAM THUAN allocateSellable — cong thuc 2026-10-02: so ban duoc = min(SL dat, TON KHO). (Truoc do
// 2026-10-01 con cong them hang dang van chuyen; nay KHONG tinh nua.)
// ---------------------------------------------------------------------------

function line(orderKey, productKey, quantity, unitPrice) {
  return { orderKey, productKey, quantity, amount: quantity * unitPrice };
}

test('allocateSellable: min(SL dat, ton kho) — A dat 500 ton 40 -> 40 (khong cong hang dieu chuyen), B dat 70 ton 800 -> 70', () => {
  const lines = [line('o1', 'a', 500, 1000), line('o1', 'b', 70, 5000)];
  const onHand = { a: 40, b: 800 };
  const parts = allocateSellable(lines, l => onHand[l.productKey] || 0);
  assert.equal(parts[0].sellableQty, 40);
  assert.equal(parts[0].sellableAmount, 40 * 1000);
  assert.equal(parts[1].sellableQty, 70);
  assert.equal(parts[1].sellableAmount, 70 * 5000);
  assert.equal(parts[0].sellableAmount + parts[1].sellableAmount, 40 * 1000 + 70 * 5000);
});

test('allocateSellable: ton du thi co ban toan bo, khong vuot SL dat; ton am hoac 0 thi 0', () => {
  const lines = [line('o1', 'a', 10, 100), line('o1', 'b', 10, 100), line('o1', 'c', 10, 100)];
  const stock = { a: 999, b: -5, c: 0 };
  const parts = allocateSellable(lines, l => stock[l.productKey]);
  assert.deepEqual(parts.map(p => p.sellableQty), [10, 0, 0]);
  assert.deepEqual(parts.map(p => p.sellableAmount), [1000, 0, 0]);
});

test('allocateSellable: cung 1 san pham o nhieu dong cua 1 don chi tinh ton 1 LAN (chia ti le)', () => {
  // Ton cap 60 cho tong 100 (40 + 60) => ti le 0,6 chia deu 2 dong.
  const lines = [line('o1', 'a', 40, 10), line('o1', 'a', 60, 20)];
  const parts = allocateSellable(lines, () => 60);
  assert.ok(Math.abs(parts[0].sellableQty - 24) < 1e-9);
  assert.ok(Math.abs(parts[1].sellableQty - 36) < 1e-9);
  assert.ok(Math.abs(parts[0].sellableQty + parts[1].sellableQty - 60) < 1e-9, 'tong dung bang ton cap');
  assert.ok(Math.abs(parts[0].sellableAmount - 240) < 1e-9);
  assert.ok(Math.abs(parts[1].sellableAmount - 720) < 1e-9);
});

test('allocateSellable: hai DON khac nhau cung san pham khong tru ton cua nhau (khong tru phieu tam khac)', () => {
  const parts = allocateSellable([line('o1', 'a', 10, 1), line('o2', 'a', 10, 1)], () => 10);
  assert.deepEqual(parts.map(p => p.sellableQty), [10, 10]);
});

test('allocateSellable: dong thue VAT* va dong khong co ma bi bo (null), khong anh huong dong khac', () => {
  const lines = [line('o1', 'vatda44', 1, 160000), line('o1', '', 5, 100), line('o1', 'a', 5, 100)];
  const parts = allocateSellable(lines, () => 5);
  assert.deepEqual(parts[0], { sellableQty: null, sellableAmount: null });
  assert.deepEqual(parts[1], { sellableQty: null, sellableAmount: null });
  assert.equal(parts[2].sellableAmount, 500);
});

test('allocateSellable: so luong le (hang ban theo can) va SL 0', () => {
  const parts = allocateSellable([line('o1', 'a', 2.5, 100), line('o1', 'b', 0, 100)], l => (l.productKey === 'a' ? 1.25 : 99));
  assert.equal(parts[0].sellableQty, 1.25);
  assert.equal(parts[0].sellableAmount, 125);
  assert.equal(parts[1].sellableQty, 0);
});

// ---------------------------------------------------------------------------
// Doc DB (pool gia): dau don MOI trang thai + dong hang cua don Phieu tam + ton thuc
// ---------------------------------------------------------------------------

// Dong dau don (ALL_ORDERS_SQL)
const HR = (extra) => ({
  branch: 'hanoi', order_id: '1', code: 'DH000001', total: 1000000,
  order_date_text: '30/09/2026 10:15', order_date_key: '2026-09-30T10:15:00',
  customer_name: 'KH A', sale_name: 'Nguyễn Văn A', kiot_status: 'Phiếu tạm', note: '',
  ...extra
});
// Dong hang cua don Phieu tam (PENDING_LINES_SQL)
const LR = (extra) => ({ branch: 'hanoi', order_id: '1', product_code: 'A', quantity: 500, amount: 500000, ...extra });

test('picking reads only matching headers and raw detail without loading stock, transit or freight',async()=>{
 const calls=[];
 const detail={code:'DH1',lines:[{productCode:'A',quantity:2,price:10}]};
 const pool={query:async(sql,params)=>{calls.push({sql,params});return {rows:[HR({code:'DH1',sale_telegram_id:'12345'})]};}};
 const repo=createKiotOrdersRepository({pool,fetchOrderDetail:async args=>{assert.equal(args.branchCode,'hanoi');assert.equal(args.code,'DH1');return detail;},readInTransit:async()=>assert.fail('no transit'),lookupMeasures:async()=>assert.fail('no measures')});
 const headers=await repo.readOrderHeaders(' dh1 ');
 assert.equal(headers[0].saleTelegramId,'12345');
 assert.equal(headers[0].branch,'HN');
 assert.equal(calls.length,1);
 assert.match(calls[0].sql,/lower\(btrim\(o\.code\)\) = \$1/);
 assert.deepEqual(calls[0].params,['dh1']);
 assert.match(calls[0].sql,/2026-10-10/);
 assert.equal(await repo.readPickingDetail({branch:'HN',code:'DH1'}),detail);
 assert.equal(calls.length,1);
 await assert.rejects(()=>repo.readPickingDetail({branch:'both',code:'DH1'}),{statusCode:400});
});

/** Pool gia: nhan ra 3 loai truy van theo noi dung SQL; dem so lan goi. */
function createFakePool({ headerRows = [], lineRows = [], onHand = {}, failOrders = false } = {}) {
  const calls = { orders: 0, lines: 0, onHand: [] };
  const state = { failOrders };
  return {
    calls,
    state,
    async query(sql, params) {
      if (sql.includes('FROM orders o') && sql.includes('LEFT JOIN staff s')) {
        calls.orders++;
        if (state.failOrders) throw new Error('db down');
        return { rows: headerRows };
      }
      if (sql.includes('FROM orders o') && sql.includes('JOIN order_details d')) {
        calls.lines++;
        return { rows: lineRows };
      }
      if (sql.includes('FROM products p') && sql.includes('jsonb_array_elements')) {
        calls.onHand.push(params);
        const branchStock = onHand[params[0]] || {};
        return { rows: params[1].filter(code => code in branchStock).map(code => ({ code, on_hand: branchStock[code] })) };
      }
      throw new Error('truy van la: ' + sql.slice(0, 60));
    }
  };
}

function repoFor(pool, extra = {}) {
  let clock = 1_000_000;
  const inTransitCalls = { n: 0 };
  const repo = createKiotOrdersRepository({
    pool,
    now: () => clock,
    ttlMs: 120_000,
    staleMs: 900_000,
    readInTransit: async () => { inTransitCalls.n++; return new Map([['a', 160]]); },
    lookupMeasures: async () => new Map(),
    ...extra
  });
  return { repo, inTransitCalls, advance: ms => { clock += ms; } };
}

test('readOrders: MOI trang thai Kiot (kem ghi chu, trang thai); gia tri co ban chi don Phieu tam theo min(SL dat, ton kho), ton theo co so cua don, moi nhat truoc', async () => {
  const pool = createFakePool({
    headerRows: [
      // Don Phieu tam HN: A SL 500 don gia 1000 (ton HN 40 -> 40; hang dieu chuyen 160 KHONG tinh); B SL 70 don gia 5000 (ton 800 -> 70)
      HR({ order_id: '1', code: 'DH000001', note: 'Giao sớm\ngọi chị Hằng' }),
      // Don Hoan thanh va Da huy: co gia tri don + trang thai nhung KHONG co gia tri co ban
      HR({ order_id: '2', code: 'DH000002', kiot_status: 'Hoàn thành', order_date_text: '29/09/2026 08:00', order_date_key: '2026-09-29T08:00:00', total: 500000 }),
      HR({ order_id: '3', code: 'DH000003', kiot_status: 'Đã hủy', order_date_text: '28/09/2026 08:00', order_date_key: '2026-09-28T08:00:00', total: 0 }),
      // Don SG cung ma DH000001 (ton SG 0 nen khong co hang)
      HR({ branch: 'saigon', order_id: '9', code: 'DH000001', order_date_text: '01/10/2026 08:00', order_date_key: '2026-10-01T08:00:00', sale_name: 'Lê Thị B', customer_name: 'KH SG' }),
      // Don Phieu tam khong co dong hang nao -> gia tri co ban 0
      HR({ order_id: '4', code: 'DH000004', order_date_text: '27/09/2026 08:00', order_date_key: '2026-09-27T08:00:00' })
    ],
    lineRows: [
      LR({ order_id: '1', product_code: 'A', quantity: 500, amount: 500000 }),
      LR({ order_id: '1', product_code: 'B', quantity: 70, amount: 350000 }),
      // Dong thue VAT cua don HN khong tinh vao gia tri co ban
      LR({ order_id: '1', product_code: 'VATDA44', quantity: 1, amount: 160000 }),
      LR({ branch: 'saigon', order_id: '9', product_code: 'A', quantity: 100, amount: 100000 })
    ],
    onHand: { hanoi: { A: 40, B: 800, VATDA44: 0 }, saigon: { A: 0 } }
  });
  const { repo, inTransitCalls } = repoFor(pool);
  const result = await repo.readOrders();

  assert.equal(result.ok, true);
  assert.equal(result.orders.length, 5, 'don Hoan thanh / Da huy van co mat (truoc day chi Phieu tam)');
  // Moi nhat truoc: SG (01/10) > HN DH000001 (30/09) > DH000002 > DH000003 > DH000004? (27/09 la cu nhat)
  assert.deepEqual(result.orders.map(o => [o.branch, o.code]), [
    ['SG', 'DH000001'], ['HN', 'DH000001'], ['HN', 'DH000002'], ['HN', 'DH000003'], ['HN', 'DH000004']
  ]);
  const byCode = (branch, code) => result.orders.find(o => o.branch === branch && o.code === code);

  const hn = byCode('HN', 'DH000001');
  assert.equal(hn.kiotStatus, 'Phiếu tạm');
  assert.equal(hn.note, 'Giao sớm\ngọi chị Hằng');
  assert.equal(hn.sellableValue, 40 * 1000 + 70 * 5000, 'A: min(500, 40) x 1000 + B: min(70, 800) x 5000, khong gom VAT, khong cong hang dieu chuyen');
  assert.equal(hn.total, 1000000);
  assert.equal(hn.customerName, 'KH A');
  assert.equal(hn.saleName, 'Nguyễn Văn A');
  assert.equal(hn.orderDate, '30/09/2026 10:15');
  assert.equal('orderDateKey' in hn, false, 'khoa sap xep noi bo khong lo ra ngoai');

  const done = byCode('HN', 'DH000002');
  assert.deepEqual([done.kiotStatus, done.sellableValue, done.total, done.note], ['Hoàn thành', null, 500000, '']);
  assert.deepEqual([byCode('HN', 'DH000003').kiotStatus, byCode('HN', 'DH000003').sellableValue], ['Đã hủy', null]);

  const sg = byCode('SG', 'DH000001');
  assert.equal(sg.sellableValue, 0, 'SG: ton 0 -> khong co hang nao (hang dieu chuyen khong tinh)');
  assert.equal(sg.customerName, 'KH SG');
  assert.equal(byCode('HN', 'DH000004').sellableValue, 0, 'Phieu tam chua co dong hang: gia tri co ban 0');

  // Ton doc rieng theo tung co so (moi co so 1 truy van, chi cac ma co trong dong hang cua don Phieu tam).
  assert.deepEqual(
    pool.calls.onHand.map(p => [p[0], [...p[1]].sort()]).sort(),
    [['hanoi', ['A', 'B', 'VATDA44']], ['saigon', ['A']]]
  );
  assert.equal(inTransitCalls.n, 0, 'danh sach khong doc hang dang van chuyen nua');
});

test('readOrders: không có đơn Phiếu tạm nào thì không đọc tồn kho; thiếu trạng thái/ghi chú thì để rỗng', async () => {
  const pool = createFakePool({ headerRows: [HR({ kiot_status: '', note: null, customer_name: '', sale_name: null })] });
  const { repo } = repoFor(pool);
  const result = await repo.readOrders();
  assert.equal(result.orders.length, 1);
  assert.deepEqual([result.orders[0].kiotStatus, result.orders[0].note, result.orders[0].sellableValue], ['', '', null]);
  assert.equal(pool.calls.onHand.length, 0);
});

test('readOrders: cache TTL 2 phut (khong doc DB lai); single-flight khi goi dong thoi; invalidate buoc doc lai', async () => {
  const pool = createFakePool({ headerRows: [HR()], lineRows: [LR()], onHand: { hanoi: { A: 1 } } });
  const { repo, advance } = repoFor(pool);

  const [first, second] = await Promise.all([repo.readOrders(), repo.readOrders()]);
  assert.equal(pool.calls.orders, 1, 'single-flight: 2 loi goi dong thoi chi 1 lan doc DB');
  assert.equal(first, second);

  advance(119_000);
  assert.equal(await repo.readOrders(), first);
  assert.equal(pool.calls.orders, 1, 'con han cache');

  repo.invalidate();
  await repo.readOrders();
  assert.equal(pool.calls.orders, 2, 'invalidate buoc doc lai');
});

test('readOrders: STALE-WHILE-REVALIDATE — het TTL thi tra NGAY ban cu va lam moi o nen; lan goi sau nhan ban moi', async () => {
  const pool = createFakePool({ headerRows: [HR()], lineRows: [LR()], onHand: { hanoi: { A: 1 } } });
  const { repo, advance } = repoFor(pool);
  const first = await repo.readOrders();

  advance(121_000); // qua TTL, con trong staleMs
  const served = await repo.readOrders();
  assert.equal(served, first, 'tra ban cu ngay, khong cho DB');
  await flush();
  assert.equal(pool.calls.orders, 2, 'lam moi o nen');

  const fresh = await repo.readOrders();
  assert.notEqual(fresh, first, 'ban moi sau khi lam moi nen xong');
  assert.equal(pool.calls.orders, 2);

  // Nhieu lan goi trong luc dang lam moi nen chi 1 lan doc DB.
  advance(121_000);
  await Promise.all([repo.readOrders(), repo.readOrders(), repo.readOrders()]);
  await flush();
  assert.equal(pool.calls.orders, 3);
});

test('readOrders: qua staleMs (15 phut) thi CHO doc lai thay vi dung ban qua cu', async () => {
  const pool = createFakePool({ headerRows: [HR()], lineRows: [LR()], onHand: { hanoi: { A: 1 } } });
  const { repo, advance } = repoFor(pool);
  const first = await repo.readOrders();
  advance(901_000);
  const next = await repo.readOrders();
  assert.notEqual(next, first);
  assert.equal(pool.calls.orders, 2, 'doc DB dong bo (khong tra ban cu qua han)');
});

test('readOrders: FAIL-SOFT — lam moi nen loi thi van tra ban cu danh dau stale, khong nem; doi 15 giay moi thu lai; qua staleMs thi {ok:false}', async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const pool = createFakePool({ headerRows: [HR()], lineRows: [LR()], onHand: { hanoi: { A: 1 } } });
    const { repo, advance } = repoFor(pool);
    const fresh = await repo.readOrders();
    assert.equal(fresh.ok, true);

    pool.state.failOrders = true;
    advance(121_000); // het TTL, con trong staleMs
    assert.equal((await repo.readOrders()).ok, true, 'lan nay van tra ban cu ngay');
    await flush();
    assert.equal(pool.calls.orders, 2, 'da thu lam moi nen va that bai');

    const stale = await repo.readOrders();
    assert.equal(stale.ok, true);
    assert.equal(stale.stale, true);
    assert.equal(stale.orders.length, 1);
    assert.equal(pool.calls.orders, 2, 'chua den 15 giay sau lan loi: khong goi lai DB dang loi');

    advance(16_000);
    await repo.readOrders();
    await flush();
    assert.equal(pool.calls.orders, 3, 'qua 15 giay thi thu lai');

    pool.state.failOrders = false;
    advance(16_000);
    await repo.readOrders();
    await flush();
    const recovered = await repo.readOrders();
    assert.equal(recovered.stale, false, 'doc lai duoc thi het stale');

    pool.state.failOrders = true;
    advance(901_000); // qua 15 phut
    const failed = await repo.readOrders();
    assert.equal(failed.ok, false);
    assert.deepEqual(failed.orders, []);
  } finally {
    console.warn = originalWarn;
  }
});

test('readOrders: chua co cache ma DB loi -> {ok:false, orders:[]} khong nem', async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const { repo } = repoFor(createFakePool({ failOrders: true }));
    const result = await repo.readOrders();
    assert.equal(result.ok, false);
    assert.deepEqual(result.orders, []);
  } finally {
    console.warn = originalWarn;
  }
});

test('truy van dau don: lay moi trang thai + ghi chu, ngay doc bang AT TIME ZONE UTC, cat ID Telegram, khong tham so hoa', () => {
  const sql = __test__.ALL_ORDERS_SQL;
  assert.match(sql, /COALESCE\(o\.raw->>'statusValue', ''\) AS kiot_status/);
  assert.match(sql, /COALESCE\(o\.raw->>'description', ''\) AS note/);
  // Chi bo don truoc 10/10/2026 TRU Phieu tam (khong loc theo trang thai khac).
  assert.match(sql, /WHERE \(o\.raw->>'statusValue' = 'Phiếu tạm'\s+OR o\.order_date IS NULL\s+OR \(o\.order_date AT TIME ZONE 'UTC'\) >= TIMESTAMP '2026-10-10 00:00:00'\)/);
  assert.match(sql, /o\.modified_date/);
  assert.equal(__test__.LIFECYCLE_ORDER_FROM, '2026-10-10');
  assert.match(sql, /o\.order_date AT TIME ZONE 'UTC'/);
  assert.match(sql, /regexp_replace\(COALESCE\(NULLIF\(o\.raw->>'soldByName', ''\), s\.name, ''\)/);
  assert.doesNotMatch(sql, /\$\d/);
});

// ---------------------------------------------------------------------------
// Lam moi TANG DAN theo modified_date
// ---------------------------------------------------------------------------

/** Pool gia co "bang orders" co the sua: ban DELTA chi tra dong modified_date >= $1 hoac NULL (nhu SQL that). */
function createDeltaPool({ orders, lines = [], onHand = {} }) {
  const state = { orders, lines, onHand, fail: false, deltaParams: [], fullCalls: 0, deltaCalls: 0 };
  return {
    state,
    async query(sql, params) {
      if (sql.includes('FROM orders o') && sql.includes('LEFT JOIN staff s')) {
        if (state.fail) throw new Error('db down');
        const isDelta = sql.includes('$1::timestamptz');
        if (!isDelta) { state.fullCalls++; return { rows: state.orders }; }
        state.deltaCalls++;
        state.deltaParams.push(params[0]);
        const since = new Date(params[0]).getTime();
        return { rows: state.orders.filter(r => r.modified_date == null || new Date(r.modified_date).getTime() >= since) };
      }
      if (sql.includes('FROM orders o') && sql.includes('JOIN order_details d')) return { rows: state.lines };
      if (sql.includes('FROM products p') && sql.includes('jsonb_array_elements')) {
        const stock = state.onHand[params[0]] || {};
        return { rows: params[1].filter(code => code in stock).map(code => ({ code, on_hand: stock[code] })) };
      }
      throw new Error('truy van la');
    }
  };
}

const T0 = '2026-10-19T03:00:00.000Z';
const minutesAfter = (iso, m) => new Date(new Date(iso).getTime() + m * 60000).toISOString();
const ttl = 121_000;

test('tang dan: lan dau doc DAY DU; lan sau doc DELTA voi $1 = watermark - 2 phut; ket qua delta == ket qua full', async () => {
  const pool = createDeltaPool({
    orders: [
      HR({ order_id: '1', code: 'DH1', order_date_key: '2026-10-14T08:00:00', modified_date: T0 }),
      HR({ order_id: '2', code: 'DH2', kiot_status: 'Hoàn thành', order_date_key: '2026-10-12T08:00:00', order_date_text: '12/10/2026 08:00', modified_date: minutesAfter(T0, -60) })
    ],
    lines: [LR({ order_id: '1', product_code: 'A', quantity: 10, amount: 10000 })],
    onHand: { hanoi: { A: 4 } }
  });
  const { repo, advance } = repoFor(pool);
  const first = await repo.readOrders();
  assert.equal(pool.state.fullCalls, 1);
  assert.equal(pool.state.deltaCalls, 0);

  // Don moi (modified sau watermark) xuat hien o lan delta.
  pool.state.orders = [...pool.state.orders,
    HR({ order_id: '3', code: 'DH3', kiot_status: 'Đã xác nhận', order_date_key: '2026-10-15T08:00:00', order_date_text: '15/10/2026 08:00', modified_date: minutesAfter(T0, 5) })];
  advance(ttl);
  repo.readOrders(); await flush();
  const delta = await repo.readOrders();
  assert.equal(pool.state.deltaCalls, 1);
  assert.equal(pool.state.fullCalls, 1);
  assert.equal(pool.state.deltaParams[0], minutesAfter(T0, -2), 'watermark - 2 phut');
  assert.deepEqual(delta.orders.map(o => o.code), ['DH3', 'DH1', 'DH2']);
  assert.notEqual(delta, first);
  assert.equal(first.orders.length, 2, 'ban cu da giao khong bi sua');

  // So voi doc day du moi tinh: giong het.
  const { repo: fresh } = repoFor(pool);
  assert.deepEqual(delta.orders, (await fresh.readOrders()).orders);
});

test('tang dan: Phieu tam -> Hoan thanh thi sellableValue ve null; ton thay doi thi gia tri co ban cua don Phieu tam khong doi modified van duoc tinh lai', async () => {
  const pool = createDeltaPool({
    orders: [
      HR({ order_id: '1', code: 'DH1', order_date_key: '2026-10-14T08:00:00', modified_date: T0 }),
      HR({ order_id: '2', code: 'DH2', order_date_key: '2026-09-29T08:00:00', modified_date: minutesAfter(T0, -600) })
    ],
    lines: [
      LR({ order_id: '1', product_code: 'A', quantity: 10, amount: 10000 }),
      LR({ order_id: '2', product_code: 'A', quantity: 10, amount: 20000 })
    ],
    onHand: { hanoi: { A: 5 } }
  });
  const { repo, advance } = repoFor(pool);
  const first = await repo.readOrders();
  assert.deepEqual(first.orders.map(o => [o.code, o.sellableValue]), [['DH1', 5000], ['DH2', 10000]]);

  // Chi ton doi (DH2 khong doi modified_date, khong nam trong delta) -> van tinh lai.
  pool.state.onHand = { hanoi: { A: 10 } };
  // DH1 chuyen Hoan thanh va hang het Phieu tam.
  pool.state.orders = [
    HR({ order_id: '1', code: 'DH1', kiot_status: 'Hoàn thành', order_date_key: '2026-10-14T08:00:00', modified_date: minutesAfter(T0, 3) }),
    pool.state.orders[1]
  ];
  pool.state.lines = [LR({ order_id: '2', product_code: 'A', quantity: 10, amount: 20000 })];
  advance(ttl);
  await repo.readOrders(); await flush();
  const next = await repo.readOrders();
  assert.equal(pool.state.deltaCalls, 1);
  assert.deepEqual(next.orders.map(o => [o.code, o.kiotStatus, o.sellableValue]), [
    ['DH1', 'Hoàn thành', null], ['DH2', 'Phiếu tạm', 20000]
  ]);
});

test('tang dan: dong modified_date NULL khong bao gio mat; don truoc 10/10 khong con Phieu tam bi bo khoi map', async () => {
  const pool = createDeltaPool({
    orders: [
      HR({ order_id: '1', code: 'DH1', kiot_status: 'Hoàn thành', order_date_key: '2026-10-14T08:00:00', modified_date: null }),
      HR({ order_id: '2', code: 'DH2', order_date_key: '2026-09-20T08:00:00', modified_date: T0 })
    ]
  });
  const { repo, advance } = repoFor(pool);
  assert.equal((await repo.readOrders()).orders.length, 2);

  // DH2 doi sang Da huy; ngay dat truoc 10/10 nen roi khoi pham vi (neu SQL van tra ve thi bi loai).
  pool.state.orders = [pool.state.orders[0], HR({ order_id: '2', code: 'DH2', kiot_status: 'Đã hủy', order_date_key: '2026-09-20T08:00:00', modified_date: minutesAfter(T0, 1) })];
  advance(ttl);
  await repo.readOrders(); await flush();
  const next = await repo.readOrders();
  assert.equal(pool.state.deltaCalls, 1);
  assert.deepEqual(next.orders.map(o => o.code), ['DH1'], 'NULL van con; DH2 roi pham vi');
});

test('tang dan: quá 30 phút kể từ lần full thì đọc FULL lại (bắt đơn bị xóa); invalidate cũng buộc full', async () => {
  const pool = createDeltaPool({ orders: [HR({ order_id: '1', code: 'DH1', order_date_key: '2026-10-14T08:00:00', modified_date: T0 }), HR({ order_id: '2', code: 'DH2', modified_date: T0 })] });
  const { repo, advance } = repoFor(pool);
  await repo.readOrders();

  advance(ttl);
  await repo.readOrders(); await flush();
  assert.equal(pool.state.deltaCalls, 1);

  pool.state.orders = [pool.state.orders[0]]; // DH2 bi xoa ben Kiot
  advance(__test__.FULL_RECONCILE_MS); // vuot 30 phut ke tu lan full dau
  await repo.readOrders(); await flush();
  assert.equal(pool.state.fullCalls, 2, 'full reconcile');
  assert.deepEqual((await repo.readOrders()).orders.map(o => o.code), ['DH1']);

  repo.invalidate();
  await repo.readOrders();
  assert.equal(pool.state.fullCalls, 3, 'invalidate -> full');
});

test('tang dan: delta loi -> tra ban cu stale, khong sua trang thai; lan thu lai ke tiep doc FULL', async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const pool = createDeltaPool({ orders: [HR({ order_id: '1', code: 'DH1', order_date_key: '2026-10-14T08:00:00', modified_date: T0 })] });
    const { repo, advance } = repoFor(pool);
    const first = await repo.readOrders();

    pool.state.fail = true;
    advance(ttl);
    assert.equal(await repo.readOrders(), first, 'tra ban cu ngay');
    await flush();
    const stale = await repo.readOrders();
    assert.equal(stale.stale, true);
    assert.equal(stale.orders.length, 1);

    pool.state.fail = false;
    pool.state.orders = [...pool.state.orders, HR({ order_id: '2', code: 'DH2', modified_date: minutesAfter(T0, 1) })];
    advance(16_000);
    await repo.readOrders(); await flush();
    assert.equal(pool.state.fullCalls, 2, 'sau loi phai doc FULL');
    const recovered = await repo.readOrders();
    assert.equal(recovered.stale, false);
    assert.equal(recovered.orders.length, 2);
  } finally {
    console.warn = originalWarn;
  }
});

test('truy van tang dan: giu nguyen dau don + them dieu kien modified_date trong ngoac, tham so $1', () => {
  const sql = __test__.DELTA_ORDERS_SQL;
  assert.ok(sql.startsWith(__test__.ALL_ORDERS_SQL));
  assert.match(sql, /\)\s+AND \(o\.modified_date >= \$1::timestamptz OR o\.modified_date IS NULL\)$/);
});

test('truy van dong hang: chi don Phieu tam, loc statusValue NGUYEN VAN (trung index mot phan 0028), khong tham so hoa', () => {
  const sql = __test__.PENDING_LINES_SQL;
  assert.match(sql, /WHERE o\.raw->>'statusValue' = 'Phiếu tạm'/);
  assert.doesNotMatch(sql, /\$\d/, 'khong tham so hoa — hang so de planner khop index mot phan');
});

test('anh xa co so Vong doi (HN/SG) <-> DB (hanoi/saigon)', () => {
  assert.deepEqual({ ...LIFECYCLE_TO_DB_BRANCH }, { HN: 'hanoi', SG: 'saigon' });
  assert.deepEqual({ ...DB_TO_LIFECYCLE_BRANCH }, { hanoi: 'HN', saigon: 'SG' });
});

// ---------------------------------------------------------------------------
// readOrderDetail
// ---------------------------------------------------------------------------

function detailFixture(status, lines) {
  return {
    kind: 'order', code: 'DH000001', date: '30/09/2026 10:15', customerName: 'KH A', customerCode: 'KH1', seller: 'Nguyễn Văn A',
    warehouse: 'Chi nhánh trung tâm', status, total: 855000, discount: 0, paid: 0, note: '', lines,
    lineCount: lines.length, totalQuantity: lines.reduce((s, l) => s + l.quantity, 0)
  };
}

const L = (productCode, quantity, price) => ({
  productCode, productName: 'Hang ' + productCode, quantity, price, discount: 0, amount: quantity * price, note: ''
});

test('readOrderDetail: don Phieu tam co ton thuc + dieu chuyen SG (chi hien thi) + so co ban = min(SL dat, ton) tung dong, VAT khong co ton', async () => {
  const pool = createFakePool({ onHand: { hanoi: { A: 40, B: 800, VATDA44: 0 } } });
  const lines = [L('A', 500, 1000), L('B', 70, 5000), L('VATDA44', 1, 160000)];
  const calls = [];
  const { repo } = repoFor(pool, {
    fetchOrderDetail: async args => { calls.push(args); return detailFixture('Phiếu tạm', lines); }
  });
  const detail = await repo.readOrderDetail({ branch: 'HN', code: 'DH000001' });

  assert.equal(calls[0].branchCode, 'hanoi');
  assert.equal(calls[0].code, 'DH000001');
  assert.equal(detail.phieuTam, true);
  assert.equal(detail.branch, 'HN');
  const [a, b, vat] = detail.lines;
  assert.deepEqual([a.onHand, a.inTransit, a.sellableQty, a.sellableAmount], [40, 160, 40, 40000], 'dieu chuyen SG 160 chi de tham khao, co ban = min(500, 40)');
  assert.deepEqual([b.onHand, b.inTransit, b.sellableQty, b.sellableAmount], [800, 0, 70, 350000]);
  assert.deepEqual([vat.isService, vat.onHand, vat.inTransit, vat.sellableQty, vat.sellableAmount], [true, null, null, null, null]);
  assert.equal(detail.sellableValue, 390000);
  assert.equal(detail.total, 855000, 'giu nguyen tong don cua Kiot (gom ca VAT)');
});

test('readOrderDetail: don KHONG con Phieu tam (vd Hoan thanh) thi cot ton/co ban la null, khong doc ton', async () => {
  const pool = createFakePool({ onHand: { hanoi: { A: 40 } } });
  const { repo } = repoFor(pool, { fetchOrderDetail: async () => detailFixture('Hoàn thành', [L('A', 5, 1000)]) });
  const detail = await repo.readOrderDetail({ branch: 'HN', code: 'DH000001' });
  assert.equal(detail.phieuTam, false);
  assert.equal(detail.sellableValue, null);
  assert.deepEqual([detail.lines[0].onHand, detail.lines[0].inTransit, detail.lines[0].sellableQty], [null, null, null]);
  assert.equal(pool.calls.onHand.length, 0);
});

test('readOrderDetail lite: khong doc ton / dang van chuyen / can do; dong hang va dau don giu nguyen', async () => {
  const pool = createFakePool({ onHand: { hanoi: { A: 40 } } });
  const measureCalls = [];
  const { repo, inTransitCalls } = repoFor(pool, {
    fetchOrderDetail: async () => detailFixture('Phiếu tạm', [L('A', 500, 1000)]),
    lookupMeasures: async codes => { measureCalls.push(codes); return new Map(); }
  });
  const detail = await repo.readOrderDetail({ branch: 'HN', code: 'DH000001', lite: true });
  assert.equal(pool.calls.onHand.length, 0, 'khong doc ton');
  assert.equal(inTransitCalls.n, 0, 'khong doc dang van chuyen');
  assert.equal(measureCalls.length, 0, 'khong doc can do');
  assert.equal(detail.branch, 'HN');
  assert.equal(detail.phieuTam, true);
  assert.equal(detail.freight, undefined);
  assert.deepEqual(detail.lines.map(l => [l.productCode, l.quantity, l.price]), [['A', 500, 1000]]);
  assert.equal(detail.lines[0].onHand, undefined);
});

test('readOrderDetail: co so khong hop le -> 400; khong tim thay don -> 404 kem ma ORDER_NOT_FOUND', async () => {
  const { repo } = repoFor(createFakePool(), {
    fetchOrderDetail: async () => { const e = new Error('Không tìm thấy đơn đặt hàng này.'); e.statusCode = 404; throw e; }
  });
  await assert.rejects(repo.readOrderDetail({ branch: 'XX', code: 'DH1' }), { statusCode: 400, code: 'INVALID_BRANCH' });
  await assert.rejects(repo.readOrderDetail({ branch: 'SG', code: 'DH1' }), { statusCode: 404, code: 'ORDER_NOT_FOUND' });
});

test('readOrderDetail: truyen dung co so SG -> saigon', async () => {
  const calls = [];
  const { repo } = repoFor(createFakePool({ onHand: { saigon: { A: 1 } } }), {
    fetchOrderDetail: async args => { calls.push(args); return detailFixture('Phiếu tạm', [L('A', 2, 10)]); }
  });
  const detail = await repo.readOrderDetail({ branch: 'SG', code: 'DH5' });
  assert.equal(calls[0].branchCode, 'saigon');
  // ton SG 1 < SL dat 2 => chi co ban 1 (hang dieu chuyen 160 khong duoc cong them)
  assert.equal(detail.lines[0].sellableQty, 1);
  assert.equal(detail.lines[0].inTransit, 160);
});

test('readOrderDetail: gan the tich theo SL dat + cuoc 3 nha xe; dong VAT bo qua', async () => {
  const pool = createFakePool({ onHand: { hanoi: { A: 40 } } });
  const lines = [L('A', 250, 1000), L('VATDA44', 1, 160000)];
  const { repo } = repoFor(pool, {
    fetchOrderDetail: async () => detailFixture('Hoàn thành', lines),
    lookupMeasures: async () => new Map([['a', { perCarton: 100, m3PerUnit: 0.01, kgPerUnit: 0.5 }]])
  });
  const detail = await repo.readOrderDetail({ branch: 'HN', code: 'DH000001' });
  assert.equal(detail.lines[0].measure.m3, 2.5);
  assert.equal(detail.lines[1].measure.status, 'service');
  assert.equal(detail.freight.totals.m3, 2.5);
  assert.equal(detail.freight.carriers.DM.total, Math.round(Math.max(2.5 * 550000, 125 * 1330)));
  assert.equal(detail.freight.carriers.VL.total, Math.round(2.5 * 465000));
  assert.equal(detail.freight.carriers.JT.total, Math.round(2.5 * 1e6 / 6000 * 4000));
  assert.equal(detail.freight.provisional, false);
});

test('readOrderDetail: partial CAN DO preserves usable measures and all provisional carrier estimates', async () => {
  const lookupCalls = [];
  const { repo } = repoFor(createFakePool({}), {
    fetchOrderDetail: async () => detailFixture('Hoàn thành', [L('A', 2, 1000), L('B', 3, 1000), L('VATDA44', 1, 1000)]),
    lookupMeasures: async codes => {
      lookupCalls.push(codes);
      return new Map([
        ['a', { m3PerUnit: null, kgPerUnit: 2 }],
        ['b', { m3PerUnit: 0.01, kgPerUnit: null }]
      ]);
    }
  });
  const detail = await repo.readOrderDetail({ branch: 'HN', code: 'DH000001' });
  assert.deepEqual(lookupCalls, [['A', 'B']]);
  assert.deepEqual(detail.freight.totals, { m3: 0.03, kg: 4 });
  assert.deepEqual(detail.freight.missingCodes, ['A', 'B']);
  assert.equal(detail.freight.provisional, true);
  assert.equal(detail.lines[0].measure.m3, null);
  assert.equal(detail.lines[0].measure.kg, 4);
  assert.equal(detail.lines[0].measure.missingVolume, true);
  assert.equal(detail.lines[1].measure.m3, 0.03);
  assert.equal(detail.lines[1].measure.kg, null);
  assert.equal(detail.lines[1].measure.missingWeight, true);
  assert.equal(detail.lines[2].measure.status, 'service');
  assert.deepEqual(Object.values(detail.freight.carriers).map(carrier => carrier.provisional), [true, true, true]);
  assert.equal(detail.freight.carriers.DM.total, 350000);
  assert.equal(detail.freight.carriers.VL.total, 700000);
  assert.equal(detail.freight.carriers.JT.total, 36000);
});

test('readOrderDetail: moi ma deu thieu CAN DO -> liet ke ma thieu va khong tao gia cuoc', async () => {
  const { repo } = repoFor(createFakePool({}), { fetchOrderDetail: async () => detailFixture('Hoàn thành', [L('ZZZ', 5, 1000)]) });
  const detail = await repo.readOrderDetail({ branch: 'HN', code: 'DH000001' });
  assert.deepEqual(detail.freight.missingCodes, ['ZZZ']);
  assert.deepEqual(detail.freight.carriers, { DM: null, VL: null, JT: null });
  assert.equal(detail.freight.provisional, true);
});

test('readOrderDetail: doc sheet loi -> fail-soft, van tra chi tiet don', async () => {
  const { repo } = repoFor(createFakePool({}), {
    fetchOrderDetail: async () => detailFixture('Hoàn thành', [L('A', 5, 1000)]),
    lookupMeasures: async () => { const e = new Error('Không đọc được sheet CÂN ĐO.'); e.statusCode = 503; e.code = 'MEASURE_SOURCE_UNAVAILABLE'; throw e; }
  });
  const detail = await repo.readOrderDetail({ branch: 'HN', code: 'DH000001' });
  assert.equal(detail.freight.unavailable, true);
  assert.match(detail.freight.message, /CÂN ĐO/);
  assert.equal(detail.lines.length, 1);
});

test('SQL vong doi don: ten khach uu tien customers.name (join theo khoa chinh), ten tren don chi la du phong', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'kiotOrdersRepository.js'), 'utf8');
  assert.match(src, /LEFT JOIN customers c ON c\.branch = o\.branch AND c\.id = o\.customer_id/);
  assert.match(src, /NULLIF\(c\.name, ''\), NULLIF\(o\.raw->>'customerName', ''\)/);
});
