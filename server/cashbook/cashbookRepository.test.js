'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { createRepository, groupFunds } = require('./cashbookRepository');
const { parseFilters } = require('./cashbookFilters');
const now = new Date('2026-10-06T12:00:00Z');
const f = (q) =>
  parseFilters({ from: '2026-10-01', to: '2026-10-06', ...q }, now);
let db, repo;
const queries = [];
// TK số 123 có ID 7 ở HN và ID 8 ở SG (2 retailer KiotViet); -1 chỉ còn trong phiếu.
test.before(async () => {
  db = new PGlite();
  await db.exec(`CREATE TABLE cash_flows(branch text,id bigint,code text,is_receipt boolean,amount numeric,source_missing_at timestamptz,method text,account_id bigint,status int,trans_date timestamptz,user_id bigint,description text,raw jsonb,synced_at timestamptz default now(),primary key(branch,id));CREATE TABLE staff(branch text,id bigint,name text,primary key(branch,id));CREATE TABLE cash_book_accounts(id bigint primary key,bank_name text,account_no text,description text,raw jsonb);
 CREATE TABLE sync_checkpoints(branch text,entity text,last_synced_at timestamptz);
 INSERT INTO sync_checkpoints VALUES('hanoi','cash_flows','2026-10-06T03:00:00Z'),('saigon','cash_flows','2026-10-06T04:00:00Z');
 INSERT INTO staff VALUES ('hanoi',9,'Lan - 1234567890');
 INSERT INTO cash_book_accounts VALUES (7,'Holder','123','Main','{}'),(8,'Holder','123','','{}');`);
  const rows = [
    ['hanoi', 8, 7, '2026-09-25T00:00:00Z', 50, 0],
    ['saigon', 7, null, '2026-09-20T00:00:00Z', 100, 0],
    ['hanoi', 1, 7, '2026-10-01T00:00:00Z', 10, 0],
    ['hanoi', 2, 7, '2026-10-02T00:00:00Z', 20, 0],
    ['hanoi', 3, 7, '2026-10-03T00:00:00Z', -30, 0],
    ['saigon', 3, 8, '2026-10-03T00:00:00Z', 5, 0],
    ['hanoi', 4, 7, '2026-10-04T00:00:00Z', 999, 1],
    ['hanoi', 5, null, '2026-10-03T00:00:00Z', 8, 0],
    ['saigon', 6, -1, '2026-10-03T00:00:00Z', 9, 0],
  ];
  for (const [branch, id, account, date, amount, status] of rows)
    await db.query(
      'INSERT INTO cash_flows(branch,id,code,is_receipt,amount,account_id,status,trans_date,user_id,description,raw) VALUES($1,$2,$3,$4,$5,$6,$7,$8,9,$9,$10)',
      [
        branch,
        id,
        `P${id}`,
        amount > 0,
        amount,
        account,
        status,
        date,
        'note',
        {
          cashGroup: "Tên ' nhóm",
          createdBy: 9,
          userId: 9,
          partnerName: 'Alice',
          partnerId: 99,
          contactNumber: '123%',
          usedForFinancialReporting: 0,
        },
      ],
    );
  await db.query("UPDATE cash_flows SET method=CASE WHEN account_id IS NULL THEN 'Cash' ELSE 'Transfer' END");
  // Cùng migration 0070 chạy thật: repository đọc qua view v_cash_book_transactions.
  await db.exec(fs.readFileSync(path.join(__dirname, '../db/migrations/0070_cash_book_transactions_view.sql'), 'utf8'));
  repo = createRepository({ query: (s, p) => { queries.push(s); return db.query(s, p); } });
});
test.after(async () => {
  await db.close();
});
test('sync revision changes for either branch even when the other branch has a newer checkpoint', async () => {
  await db.exec("INSERT INTO sync_checkpoints VALUES('hanoi','invoices','2099-01-01T00:00:00Z')");
  const before = await repo.syncStatus();
  await db.exec("UPDATE sync_checkpoints SET last_synced_at='2026-10-06T03:01:00Z' WHERE branch='hanoi' AND entity='cash_flows'");
  const after = await repo.syncStatus();
  assert.notEqual(after.revision, before.revision);
  assert.equal(after.branches.length, 2);
  assert.ok(!after.revision.includes('invoices'));
  assert.deepEqual(after.branches.map(b => [b.branch, +new Date(b.syncedAt)]), [
    ['hanoi', Date.parse('2026-10-06T03:01:00Z')], ['saigon', Date.parse('2026-10-06T04:00:00Z')]
  ]);
  await db.exec("UPDATE sync_checkpoints SET last_synced_at='2026-10-06T03:00:00Z' WHERE branch='hanoi' AND entity='cash_flows'");
});
test('tồn quỹ = tổng phiếu chưa hủy, gộp HN+SG theo số TK, tách cột từng cơ sở', async () => {
  const s = await repo.summary(f({}));
  assert.deepEqual(
    s.balances.map((r) => [r.fund, r.balanceHanoi, r.balanceSaigon, r.balance]),
    [
      ['cash', 8, 100, 108],
      ['7,8', 50, 5, 55],
      ['-1', 0, 9, 9],
    ],
  );
  const bank = s.balances[1];
  assert.equal(bank.accountNo, '123');
  assert.equal(bank.name, 'Holder');
  assert.equal(bank.description, 'Main');
  assert.deepEqual(bank.accountIds, ['7', '8']);
  assert.equal(s.totalBalance, 172);
  assert.deepEqual(s.kpis, {
    totalReceipts: 52,
    totalPayments: 30,
    closingBalance: 172,
  });
  assert.equal(new Date(s.syncedAt).toISOString(), '2026-10-06T04:00:00.000Z');
});

test('nhóm theo số tài khoản trong ảnh, mọi tài khoản ngoài danh sách thuộc Khác', () => {
  const examples = [
    ['80002809285', 'Anh Quân'], ['10003099363', 'Anh Quân'], ['48206877', 'Anh Quân'], ['044345', 'Khác'],
    ['181833666', 'Chị Nguyệt'], ['3090345688', 'Chị Nguyệt'], ['52256368', 'Chị Nguyệt'], ['0034100123456688', 'Chị Nguyệt'],
    ['8040890', 'Anh Duy'], ['80002808041', 'Anh Duy'], ['087564570', 'Anh Duy'], ['1026044272', 'Anh Duy'],
    ['72104081990', 'Anh Duy'], ['00001066788', 'Anh Duy'],
    ['1069579742', 'Công ty'], ['6062.666.88888', 'Công ty'], ['898896886', 'Công ty'], ['525345345', 'Công ty'],
    ['658999', 'Công ty'], ['686345345', 'Công ty'], ['464848', 'Công ty'],
    ['0123468686789', 'Khác'], ['2053148602383', 'Khác'], ['3333333', 'Khác'],
  ];
  for (const [account_no, expected] of examples) {
    const [fund] = groupFunds([{ fund_key: '1', account_id: '1', account_no, bank_name: 'Tên chủ TK thay đổi' }]);
    assert.equal(fund.accountGroup, expected, account_no);
  }
  const special = groupFunds([{fund_key: 'cash'}, {fund_key: 'unassigned'}]);
  assert.ok(special.every(row => row.accountGroup === 'Khác'));
});

test('tổng số dư 5 nhóm bằng tổng tồn quỹ, cộng HN + SG và không phụ thuộc tài khoản đang lọc', async () => {
  await db.query("UPDATE cash_book_accounts SET account_no='48206877' WHERE id IN (7,8)");
  try {
    for (const fund of ['all', 'cash', '7']) {
      const s = await repo.summary(f({fund}));
      assert.deepEqual(s.groupBalances, [
        {name: 'Anh Quân', balance: 55}, {name: 'Chị Nguyệt', balance: 0},
        {name: 'Anh Duy', balance: 0}, {name: 'Công ty', balance: 0}, {name: 'Khác', balance: 117},
      ]);
      assert.equal(s.groupBalances.reduce((sum, row) => sum + row.balance, 0), s.totalBalance);
    }
  } finally {
    await db.query("UPDATE cash_book_accounts SET account_no='123' WHERE id IN (7,8)");
  }
});
test('bảng số dư luôn đủ quỹ; KPI Tồn quỹ theo nhóm ID đang chọn, link cũ 1 ID chỉ cộng ID đó', async () => {
  for (const [fund, closing] of [
    ['7,8', 55],
    ['7', 50],
    ['bank', 64],
    ['cash', 108],
    ['', 0],
  ]) {
    const s = await repo.summary(f({ fund }));
    assert.deepEqual(
      s.balances.map((r) => [r.fund, r.balance]),
      [
        ['cash', 108],
        ['7,8', 55],
        ['-1', 9],
      ],
      fund,
    );
    assert.equal(s.totalBalance, 172, fund);
    assert.equal(s.kpis.closingBalance, closing, fund);
  }
});
test('tồn quỹ cuối kỳ không phụ thuộc bộ lọc hiển thị thu/chi', async () => {
  const s = await repo.summary(f({ fund: '7,8', docTypes: 'receipt' }));
  assert.equal(s.kpis.totalReceipts, 35);
  assert.equal(s.kpis.totalPayments, 0);
  assert.equal(s.kpis.closingBalance, 55);
  const none = await repo.summary(f({ fund: '7,8', partnerQ: 'không khớp' }));
  assert.equal(none.kpis.totalReceipts, 0);
  assert.equal(none.kpis.closingBalance, 55);
  const past = await repo.summary(
    parseFilters({ fund: '7,8', from: '2026-10-01', to: '2026-10-02' }, now),
  );
  assert.equal(past.balances.find((r) => r.fund === '7,8').balance, 80);
  assert.equal(past.kpis.closingBalance, 80);
});
test('số dư lũy kế chạy trên toàn dòng thời gian của nhóm quỹ, kể cả khi lọc', async () => {
  const page = await repo.entries(f({ fund: '7,8', page: '1', pageSize: '2' }));
  assert.equal(page.total, 5);
  assert.deepEqual(
    page.entries.map((e) => [e.code, e.branch, e.runningBalance]),
    [
      ['P4', 'hanoi', 55],
      ['P3', 'saigon', 55],
    ],
  );
  const next = await repo.entries(f({ fund: '7,8', page: '2', pageSize: '2' }));
  assert.deepEqual(
    next.entries.map((e) => e.runningBalance),
    [50, 80],
  );
  const payments = await repo.entries(f({ fund: '7,8', docTypes: 'payment' }));
  assert.deepEqual(
    payments.entries.map((e) => [e.code, e.runningBalance]),
    [['P3', 50]],
  );
  const byCode = await repo.entries(f({ fund: '7,8', code: 'p2' }));
  assert.deepEqual(
    byCode.entries.map((e) => [e.code, e.runningBalance]),
    [['P2', 80]],
  );
  const all = await repo.entries(f({ pageSize: '1' }));
  assert.equal(all.entries[0].runningBalance, 172);
  assert.equal(page.entries[0].fundName, '123 · Holder');
});
test('tìm mã phiếu/ghi chú và các bộ lọc tham số hóa khớp SQL thật', async () => {
  assert.equal((await repo.entries(f({ note: 'NOT' }))).total > 0, true);
  assert.equal((await repo.entries(f({ note: 'khong-co' }))).total, 0);
  const opts = await repo.filterOptions();
  assert.equal(opts.groups[0].label, "Tên ' nhóm");
  assert.equal(opts.staff[0].label, 'Lan');
  assert.equal(opts.creators[0].label, 'Lan');
  assert.deepEqual(
    opts.funds.map((x) => x.fund),
    ['cash', '7,8', '-1'],
  );
  assert.equal(
    opts.funds.find((e) => e.fund === '-1').name,
    'Tài khoản #-1 (không có trong danh sách KiotViet)',
  );
  assert.equal(
    (await repo.entries(f({ groups: opts.groups[0].key, partnerPhone: '123%' })))
      .total,
    7,
  );
  for (const q of [
    { groups: '' },
    { creators: '' },
    { staff: '' },
    { docTypes: '' },
    { statuses: '' },
    { fund: '' },
  ])
    assert.equal((await repo.entries(f(q))).total, 0, JSON.stringify(q));
  assert.equal((await repo.entries(f({ partnerQ: '99' }))).total, 7);
  assert.equal((await repo.entries(f({ fund: 'bank' }))).total, 6);
  assert.equal((await repo.entries(f({ fund: 'cash' }))).total, 1);
  assert.equal((await repo.entries(f({ accounting: 'yes' }))).total, 0);
  assert.equal((await repo.entries(f({ creators: '999' }))).total, 0);
});
test('ngày VN bao gồm cả ngày cuối; lũy kế giữ phiếu trước kỳ', async () => {
  await db.query(
    `INSERT INTO cash_flows(branch,id,code,is_receipt,amount,account_id,status,trans_date,user_id,description,raw) VALUES('hanoi',100,'Boundary',TRUE,2,7,0,'2026-10-04T17:00:00Z',9,'','{}'),('hanoi',101,'Outside',TRUE,3,7,0,'2026-10-05T17:00:00Z',9,'','{}')`,
  );
  try {
    const q = { fund: '7,8', from: '2026-10-05', to: '2026-10-05' };
    const r = await repo.entries(parseFilters(q, now));
    assert.deepEqual(
      r.entries.map((row) => [row.code, row.runningBalance]),
      [['Boundary', 57]],
    );
    const s = await repo.summary(parseFilters(q, now));
    assert.equal(s.kpis.totalReceipts, 2);
    assert.equal(s.kpis.closingBalance, 57);
  } finally {
    await db.query("DELETE FROM cash_flows WHERE id IN (100,101)");
  }
});
test('groupFunds bỏ tên trùng số TK, gộp tên/mô tả khác nhau và giữ quỹ không có số TK riêng', () => {
  const funds = groupFunds([
    { account_id: null },
    { account_id: '20', bank_name: '2222', account_no: '2222' },
    { account_id: '10', bank_name: 'NH CŨ', account_no: ' 2222 ', description: 'a' },
    { account_id: '30', bank_name: 'Khác', account_no: '', description: 'b' },
    { account_id: '31', bank_name: 'Khác', account_no: null },
  ]);
  assert.deepEqual(
    funds.map((x) => [x.fund, x.accountNo, x.name, x.description]),
    [
      ['cash', '', 'Tiền mặt', ''],
      ['30', '', 'Khác', 'b'],
      ['31', '', 'Khác', ''],
      ['10,20', '2222', 'NH CŨ', 'a'],
    ],
  );
});

// KiotViet can keep a historical AccountId on a Cash payment.
test('classify funds by payment method even when Cash retains an account ID', async () => {
  await db.query(
    "INSERT INTO cash_flows(branch,id,code,is_receipt,amount,method,account_id,status,trans_date,raw) VALUES ('hanoi',200,'CashWithAccount',FALSE,-40,'Cash',7,0,'2026-10-03T00:00:00Z','{}'),('saigon',201,'CashMinusOne',TRUE,4,'Cash',-1,0,'2026-10-03T00:00:00Z','{}'),('hanoi',202,'UnknownTransfer',TRUE,6,'Transfer',NULL,0,'2026-10-03T00:00:00Z','{}')"
  );
  try {
    const s = await repo.summary(f({fund:'cash'}));
    const row=s.balances.find(r=>r.fund==='cash');
    assert.deepEqual([row.balanceHanoi,row.balanceSaigon,row.balance],[-32,104,72]);
    assert.equal(s.balances.find(r=>r.fund==='7,8').balance,55);
    assert.equal(s.balances.find(r=>r.fund==='unassigned').balance,6);
    assert.equal(s.kpis.closingBalance,72);
    const cash=await repo.entries(f({fund:'cash'}));
    assert.deepEqual(cash.entries.map(r=>r.code).sort(),['CashMinusOne','CashWithAccount','P5']);
    assert.ok(cash.entries.every(r=>r.fund==='cash' && r.fundName==='Tiền mặt'));
    assert.equal(cash.entries[0].runningBalance,72);
    const bank=await repo.entries(f({fund:'7,8'}));
    assert.ok(!bank.entries.some(r=>r.code==='CashWithAccount'));
    const unknown=await repo.entries(f({fund:'unassigned'}));
    assert.deepEqual(unknown.entries.map(r=>[r.code,r.fund,r.runningBalance]),[['UnknownTransfer','unassigned',6]]);
  } finally {await db.query('DELETE FROM cash_flows WHERE id BETWEEN 200 AND 202');}
});

test('missing source vouchers are retained in storage but excluded from KPIs, balances and entries',async()=>{
  await db.query("INSERT INTO cash_flows(branch,id,code,is_receipt,amount,method,account_id,status,trans_date,raw,source_missing_at) VALUES('hanoi',300,'Retired',TRUE,999999,'Cash',NULL,0,'2026-10-03T00:00:00Z','{}',now())");
  try {
    const summary=await repo.summary(f({fund:'cash'}));
    assert.equal(summary.kpis.closingBalance,108);
    assert.equal(summary.kpis.totalReceipts,8);
    assert.equal((await repo.entries(f({code:'Retired'}))).total,0);
  } finally {await db.query('DELETE FROM cash_flows WHERE id=300');}
});

test('truy vấn Sổ quỹ đọc qua view và trang dữ liệu không kéo cột raw', async () => {
  queries.length = 0;
  await repo.entries(f({ fund: '7,8', staff: '9', creators: '9', accounting: 'no', partnerQ: 'ali' }));
  await repo.summary(f({}));
  await repo.filterOptions();
  assert.ok(queries.length > 0);
  for (const sql of queries.filter((x) => x.includes('cash_flows') || x.includes('v_cash_book_transactions'))) {
    if (sql.includes('FROM sync_checkpoints') && !sql.includes('v_cash_book')) continue;
    assert.ok(sql.includes('v_cash_book_transactions'), sql);
    assert.ok(!/raw/.test(sql), sql);
    assert.ok(!/cash_flows/.test(sql), sql);
  }
});

test('ghi chú / người nộp-nhận tìm gần đúng: bỏ dấu, 2 từ phải đủ, nhiều từ khớp xếp trước, tổng theo kết quả lọc', async () => {
  await db.query("UPDATE cash_flows SET description='Thu tiền hàng Hà Nội' WHERE branch='hanoi' AND id=1");
  await db.query("UPDATE cash_flows SET description='Chi tiền xe' WHERE branch='hanoi' AND id=2");
  await db.query("UPDATE cash_flows SET description='Hàng Hà Nội tiền' WHERE branch='hanoi' AND id=3");
  await db.query("UPDATE cash_flows SET raw=jsonb_set(raw,'{partnerName}','\"Nguyễn Văn Đạt\"') WHERE branch='hanoi' AND id=1");
  const codes = async (q) => (await repo.entries(f({ fund: '7,8', ...q }))).entries.map((e) => e.code);
  // Bỏ dấu + hoa thường
  assert.deepEqual((await codes({ note: 'HA NOI' })).sort(), ['P1', 'P3']);
  // 2 từ phải khớp cả 2 (P2 chỉ có "tien")
  assert.deepEqual((await codes({ note: 'tien xe' })), ['P2']);
  // Khớp nguyên cụm xếp trước dù P3 mới hơn P1
  assert.deepEqual((await codes({ note: 'tien hang ha noi' }))[0], 'P1');
  // Người nộp/nhận không dấu
  assert.deepEqual(await codes({ partnerQ: 'nguyen van dat' }), ['P1']);
  // Tổng thu/chi theo kết quả lọc
  const s = await repo.summary(f({ fund: '7,8', partnerQ: 'nguyen van dat' }));
  assert.equal(s.kpis.totalReceipts, 10);
  assert.equal(s.kpis.totalPayments, 0);
});


test('entries sort all mapped rows by multiple columns before pagination and export', async () => {
  const sorts = [{key:'branch',dir:'asc'},{key:'amount',dir:'desc'}];
  const filters = f({sorts:JSON.stringify(sorts),pageSize:'1',page:'2'});
  const page = await repo.entries(filters);
  const exported = await repo.entries(filters,{exportLimit:20000});
  assert.ok(exported.entries.length > 1);
  assert.equal(page.entries[0].id, exported.entries[1].id);
  assert.equal(page.entries[0].branch, exported.entries[1].branch);
  for(let i=1;i<exported.entries.length;i++) {
    const a=exported.entries[i-1], b=exported.entries[i];
    assert.ok(a.branch < b.branch || (a.branch === b.branch && Number(a.amount) >= Number(b.amount)));
  }
});
