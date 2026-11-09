# Mục 4 tab Hàng hóa: bảng Sản phẩm × Khách hàng + Tăng trưởng — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thay giao diện mục 4 "Hàng hóa 90 ngày" bằng bảng "Khách hàng theo sản phẩm" (mỗi dòng một cặp sản phẩm × khách) có cột Tăng trưởng, lọc theo tên sản phẩm / tên khách / nhóm tăng trưởng, tô đỏ "Cần check" khi giảm quá 50%, và Xuất file.

**Architecture:** Một API đọc mới `GET /api/product-report/customer-growth` đọc thẳng `product_report_customers` JOIN `product_report` (đã có 3 kỳ cuộn 30 ngày), tính tăng trưởng/tỷ trọng bằng NUMERIC trong một câu SQL, lọc + sắp xếp + phân trang ở máy chủ. Giao diện là module vanilla `product-customer-growth.js` (hàm thuần ở đầu file + phần DOM) thay cho `product-90d-report.js` trong `index.html`. Xuất file thêm khóa `products.productCustomerGrowth` song song với `products.product90d`. Phần máy chủ cũ của mục 4 (job 02:00, `/api/product-report/90d`, xuất `products.product90d`) giữ nguyên.

**Tech Stack:** Node 22 CommonJS, Express, `pg` (test bằng PGlite), vanilla JS/CSS, `node:test` + JSDOM, ExcelJS.

## Global Constraints

- Node.js v22/v24, CommonJS (`require`/`module.exports`); **không** dùng Tailwind/React/Vue/Vite.
- Cột tiền/số lượng dùng `NUMERIC`; tính tăng trưởng và ngưỡng đỏ ở SQL bằng NUMERIC, **không** dùng float JS để quyết định màu đỏ hay nhóm lọc.
- Giờ giấc hiển thị theo `Asia/Ho_Chi_Minh` (UTC+7).
- Ngưỡng đỏ: tăng trưởng **< −50%** (đúng −50% không đỏ). Tăng trưởng = T.này ÷ trung bình(T.trước, T.trước nữa) − 1; kỳ là **30 ngày cuốn chiếu**, không phải tháng dương lịch.
- Nhóm lọc (loại trừ nhau): `all` · `check` (< −50%) · `drop` (−50% ≤ g < 0) · `up` (g ≥ 0) · `new` (trung bình hai kỳ trước ≤ 0 và T.này > 0). Hai kỳ trước tổng ≤ 0 và T.này ≤ 0, hoặc có kỳ NULL → không thuộc nhóm nào (chỉ ở "Tất cả"), hiển thị "—".
- Tên cột sắp xếp chỉ lấy từ whitelist; từ khóa chỉ đi qua tham số SQL, không nối chuỗi.
- Quyền: `reports.products` + `reports.products.sales` (API), thêm `reports.export` khi xuất file; thiếu → 403 và UI ẩn mục.
- Giao diện hỗ trợ Sáng/Tối (dùng token màu của trang, không hard-code hex), responsive (≤ 600px dùng độ rộng cột hẹp), bảng dùng `table-controls.js` (`data-table-sort="off"`, ẩn/hiện cột, kéo độ rộng).
- Pool DB production chỉ 5 kết nối: mỗi lần lọc là **một** truy vấn nhẹ, debounce 150 ms, hủy request cũ bằng `AbortController`.
- Không xóa/sửa phần máy chủ cũ của mục 4; không thêm migration; không thêm biến môi trường.
- Hai test đã đỏ sẵn trên `main` (CLAUDE.md §4.1: `hr-leave-deadlines` và `lifecycle-pick-performance`) không tính vào kết luận; mọi lỗi khác tên hoặc số lỗi khác 2 là lỗi mới. Không `.skip`/sửa assert của hai test đó.
- Commit message kết thúc bằng dòng `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Lệnh test chạy từ thư mục `server/` (Node v24: truyền đường dẫn file hoặc glob, không truyền thư mục trần).

## File Structure

| File | Việc |
|---|---|
| Create `server/dashboard/productCustomerGrowthRepository.js` | SQL + kiểm tra tham số + `getProductCustomerGrowth` (màn hình) + `getProductCustomerGrowthForExport` + `validateFilters` |
| Create `server/dashboard/productCustomerGrowthRepository.test.js` | Test PGlite cho repository |
| Create `server/dashboard/productCustomerGrowthRoutes.test.js` | Test quyền + 400/200 của route |
| Create `server/dashboard/exportProductCustomerGrowth.test.js` | Test xuất Excel/HTML |
| Modify `server/dashboard/productReportRepository.js` | Export thêm `customerPeriods` (hàm sẵn có) |
| Modify `server/routes.js` | Thêm route GET `/api/product-report/customer-growth` |
| Modify `server/dashboard/exportService.js` | Khóa `products.productCustomerGrowth`: tiêu đề, cột, spec, quyền, dataset |
| Create `server/public/product-customer-growth.js` | Module giao diện (hàm thuần + DOM) |
| Create `server/public/product-customer-growth.css` | Kiểu bảng/bộ lọc/nhãn đỏ |
| Modify `server/public/index.html` | Thay section `#product90dSection`, link/script, payload xuất file, lệnh `load` |
| Create `server/test/frontend/product-customer-growth.test.js` | Test hàm thuần + markup + hành vi + trang thật |
| Modify `server/test/frontend/product-90d-report.test.js` | Cắt phần phụ thuộc section cũ, giữ test hàm thuần của file cũ |
| Modify `server/test/frontend/dashboard-section-layout.test.js`, `export-ui.test.js`, `server/dashboard/exportService.test.js` | Cập nhật id/khóa mới |
| Delete `server/public/product-90d-report.css` | Không còn dùng |
| Modify docs | README.md, server/README.md, server/db/SCHEMA.md, docs/04-planning/implementation_plan.md, docs/02-srs/SRS_Dashboard_GoogleSheets.md, docs/01-brd/BRD_Dashboard_GoogleSheets.md, CURRENT.md, spec |

`server/public/product-90d-report.js` **giữ nguyên** (xuất file cũ `exportService.js` còn `require` nó).

---

### Task 1: Repository đọc sản phẩm × khách + tăng trưởng

**Files:**
- Create: `server/dashboard/productCustomerGrowthRepository.js`
- Create: `server/dashboard/productCustomerGrowthRepository.test.js`
- Modify: `server/dashboard/productReportRepository.js` (dòng `module.exports`, cuối file)

**Interfaces:**
- Consumes: `customerPeriods(end)` của `productReportRepository` (trả `[{key,label,from,to}]` cho `1_30d`, `31_60d`, `61_90d`, hoặc `[]`); `fuzzySqlParts(expr, query, add)` của `../shared/fuzzySql`; `timedQuery(pool, name, sql, params)` của `../lib/requestTiming`; `getPool()` của `../db/pool`.
- Produces (module exports):
  - `getProductCustomerGrowth({ product, customer, growth, sort, dir, page, pageSize, pool })` → `Promise<{ available:false, rows:[], summary:{totalRows:0,checkRows:0} } | { available:true, state:{customerWindowEnd,computedAt,version}, periods, summary:{totalRows,checkRows}, rows, page, pageSize, sort, dir }>`; mỗi row: `{ productCode, productName, customerName, revenue, revenue1_30d, revenue31_60d, revenue61_90d, share, growth, growthState }` (số hoặc `null`; `growthState` ∈ `'check'|'drop'|'up'|'new'|null`).
  - `getProductCustomerGrowthForExport({ product, customer, growth, sort, dir, pool, maxRows })` → cùng dạng nhưng không phân trang, thêm `summary`, ném lỗi 413 `EXPORT_TOO_MANY_ROWS` khi vượt trần.
  - `validateFilters({ product, customer, growth, sort, dir })` → ném lỗi `statusCode 400` nếu sai, không chạm DB.
  - Hằng: `GROWTH_GROUPS`, `SORT_KEYS`, `EXPORT_MAX_ROWS`, `MAX_PAGE_SIZE`, `DEFAULT_PAGE_SIZE`.

- [ ] **Step 1: Export `customerPeriods`**

Sửa dòng `module.exports` ở cuối `server/dashboard/productReportRepository.js` (hiện là `getProductReport, getProductReportCustomers, getProductReportVersion, createProductReportReader,`):

```js
module.exports = {
  getProductReport, getProductReportCustomers, getProductReportVersion, createProductReportReader, customerPeriods,
  PRODUCT_REPORT_PRICE_KEYS, PRODUCT_REPORT_SALES_KEYS,
  __test__: { mapRow, daysToOrder, daysOfCover }
};
```

- [ ] **Step 2: Viết test thất bại**

Tạo `server/dashboard/productCustomerGrowthRepository.test.js`:

```js
'use strict';

// Bang "Khach hang theo san pham" (muc 4 tab Hang hoa): du lieu that tu PGlite (product_report + product_report_customers
// + product_report_state) qua dung SQL cua repository. Kiem tra cong thuc tang truong, ranh gioi -50%, nhom loc,
// % cua SP khong doi theo bo loc, sap xep NULL cuoi, phan trang, validate, xuat file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const repo = require('./productCustomerGrowthRepository');

const migration = name => fs.readFileSync(path.join(__dirname, '../db/migrations', name), 'utf8');

async function setup({ state = 'ready' } = {}) {
  const db = new PGlite();
  await db.exec(migration('0018_product_report.sql'));
  await db.exec(migration('0023_product_report_customers.sql'));
  // 0055 can bang invoices/returns/customers; test chi can cac cot ma 0108 them vao nen dung DDL toi thieu.
  await db.exec(`CREATE TABLE product_report_state (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1), computed_at TIMESTAMPTZ NOT NULL, version BIGINT NOT NULL DEFAULT 1, last_full_at TIMESTAMPTZ)`);
  await db.exec(migration('0108_product_customer_periods.sql'));
  if (state === 'ready') {
    await db.exec(`INSERT INTO product_report_state (id, computed_at, version, customer_window_end)
      VALUES (1, '2026-11-05T19:00:05.123Z', 7, '2026-11-05')`);
  } else if (state === 'no-window') {
    await db.exec(`INSERT INTO product_report_state (id, computed_at, version) VALUES (1, '2026-11-05T19:00:05.123Z', 7)`);
  }
  return db;
}

async function products(db) {
  await db.exec(`INSERT INTO product_report (product_code, product_name) VALUES
    ('SP1', 'Bình giữ nhiệt Lock'), ('SP2', 'Cốc sứ'), ('SP3', 'Ấm đun nước')`);
}

// (product_key, customer_key, ten, revenue 90 ngay, r1 = T.nay, r2 = T.truoc, r3 = T.truoc nua)
async function pair(db, key, customer, revenue, r1, r2, r3) {
  await db.query(
    `INSERT INTO product_report_customers (product_key, customer_key, customer_name, revenue, revenue_1_30d, revenue_31_60d, revenue_61_90d)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [key, 'name:' + customer.toLowerCase(), customer, revenue, r1, r2, r3]);
}

async function seed(db) {
  await products(db);
  await pair(db, 'sp1', 'Khách A', 200, 40, 60, 100);           // prior 160, 4*40 = 160 -> dung -50% -> drop
  await pair(db, 'sp1', 'Khách B', 210, 10, 100, 100);          // -90% -> check
  await pair(db, 'sp1', 'Khách C', 400, 300, 50, 50);           // +500% -> up
  await pair(db, 'sp1', 'Khách mới D', 70, 70, 0, 0);           // prior 0, T.nay > 0 -> new
  await pair(db, 'sp1', 'Khách E', 0, 0, 0, 0);                 // prior 0, T.nay 0 -> khong nhom
  await pair(db, 'sp1', 'Khách F', 100, 0, 50, 50);             // -100% -> check
  await pair(db, 'sp1', 'Khách thiếu kỳ', 30, null, null, null); // ky chua tinh -> khong nhom
  await pair(db, 'sp2', 'Khách H', 15, 5, 5, 5);                // 0% -> up
  await pair(db, 'sp2', 'Khách trả hàng', 20, 10, -50, 20);     // prior -30 <= 0, T.nay > 0 -> new
  await pair(db, 'zz', 'Khách mồ côi', 999, 1, 1, 1);           // khong co trong product_report -> bi loai
}

const names = data => data.rows.map(r => r.customerName);
const byName = (data, name) => data.rows.find(r => r.customerName === name);

test('mac dinh: state + 3 ky + summary, 9 dong (bo cap mo coi) xep DS 90 ngay giam dan', async () => {
  const db = await setup();
  try {
    await seed(db);
    const data = await repo.getProductCustomerGrowth({ pool: db });
    assert.equal(data.available, true);
    assert.deepEqual(data.state, { customerWindowEnd: '2026-11-05', computedAt: '2026-11-05T19:00:05.123Z', version: 7 });
    assert.deepEqual(data.periods.map(p => p.key), ['1_30d', '31_60d', '61_90d']);
    assert.equal(data.periods[0].from, '2026-10-07');
    assert.equal(data.periods[0].to, '2026-11-05');
    assert.deepEqual(data.summary, { totalRows: 9, checkRows: 2 });
    assert.equal(data.page, 1);
    assert.equal(data.pageSize, 50);
    assert.equal(data.sort, 'revenue');
    assert.equal(data.dir, 'desc');
    assert.deepEqual(names(data), ['Khách C', 'Khách B', 'Khách A', 'Khách F', 'Khách mới D', 'Khách thiếu kỳ', 'Khách trả hàng', 'Khách H', 'Khách E']);
    const c = data.rows[0];
    assert.equal(c.productCode, 'SP1');
    assert.equal(c.productName, 'Bình giữ nhiệt Lock');
    assert.equal(c.revenue, 400);
    assert.equal(c.revenue1_30d, 300);
    assert.equal(c.revenue31_60d, 50);
    assert.equal(c.revenue61_90d, 50);
  } finally { await db.close(); }
});

test('cong thuc tang truong va ranh gioi: dung -50% khong do; -90% / -100% do; base <= 0 la Moi hoac trong', async () => {
  const db = await setup();
  try {
    await seed(db);
    const data = await repo.getProductCustomerGrowth({ pool: db });
    const state = name => byName(data, name).growthState;
    const growth = name => byName(data, name).growth;
    assert.equal(growth('Khách A'), -0.5);
    assert.equal(state('Khách A'), 'drop', 'dung -50% khong phai check');
    assert.equal(growth('Khách B'), -0.9);
    assert.equal(state('Khách B'), 'check');
    assert.equal(growth('Khách F'), -1);
    assert.equal(state('Khách F'), 'check');
    assert.equal(growth('Khách C'), 5);
    assert.equal(state('Khách C'), 'up');
    assert.equal(growth('Khách H'), 0, '0% thuoc Dang tang');
    assert.equal(state('Khách H'), 'up');
    assert.equal(growth('Khách mới D'), null);
    assert.equal(state('Khách mới D'), 'new');
    assert.equal(state('Khách trả hàng'), 'new', 'tong hai ky truoc am van la Moi neu T.nay > 0');
    assert.equal(growth('Khách E'), null);
    assert.equal(state('Khách E'), null);
    const missing = byName(data, 'Khách thiếu kỳ');
    assert.equal(missing.revenue1_30d, null, 'NULL khong thanh 0');
    assert.equal(missing.growth, null);
    assert.equal(missing.growthState, null);
  } finally { await db.close(); }
});

test('nhom loc loai tru nhau; summary va checkRows theo bo loc', async () => {
  const db = await setup();
  try {
    await seed(db);
    const run = growth => repo.getProductCustomerGrowth({ growth, pool: db });
    const check = await run('check');
    assert.deepEqual(names(check), ['Khách B', 'Khách F']);
    assert.deepEqual(check.summary, { totalRows: 2, checkRows: 2 });
    const drop = await run('drop');
    assert.deepEqual(names(drop), ['Khách A']);
    assert.deepEqual(drop.summary, { totalRows: 1, checkRows: 0 });
    assert.deepEqual(names(await run('up')), ['Khách C', 'Khách H']);
    assert.deepEqual(names(await run('new')), ['Khách mới D', 'Khách trả hàng']);
    assert.equal((await run('all')).summary.totalRows, 9);
  } finally { await db.close(); }
});

test('loc san pham / khach (khong dau); % cua SP tinh tren tat ca khach cua san pham, khong doi theo bo loc', async () => {
  const db = await setup();
  try {
    await seed(db);
    const filtered = await repo.getProductCustomerGrowth({ product: 'binh giu', growth: 'check', pool: db });
    assert.deepEqual(names(filtered), ['Khách B', 'Khách F']);
    // Tong DS cua SP1 = 200 + 210 + 400 + 70 + 0 + 100 + 30 = 1010, bo loc khong lam doi mau so.
    assert.ok(Math.abs(byName(filtered, 'Khách B').share - 210 / 1010) < 1e-12);
    const byCustomer = await repo.getProductCustomerGrowth({ customer: 'tra hang', pool: db });
    assert.deepEqual(names(byCustomer), ['Khách trả hàng']);
    assert.ok(Math.abs(byCustomer.rows[0].share - 20 / 35) < 1e-12, 'SP2 tong 15 + 20 = 35');
    const none = await repo.getProductCustomerGrowth({ product: 'khongtontai', pool: db });
    assert.equal(none.available, true);
    assert.deepEqual(none.rows, []);
    assert.deepEqual(none.summary, { totalRows: 0, checkRows: 0 });
    const sp2Only = await repo.getProductCustomerGrowth({ product: 'coc su', pool: db });
    assert.deepEqual(new Set(names(sp2Only)), new Set(['Khách H', 'Khách trả hàng']));
  } finally { await db.close(); }
});

test('sap xep theo tang truong: NULL luon cuoi o ca hai chieu; sap theo cot chu', async () => {
  const db = await setup();
  try {
    await seed(db);
    const asc = await repo.getProductCustomerGrowth({ sort: 'growth', dir: 'asc', pool: db });
    assert.deepEqual(names(asc).slice(0, 5), ['Khách F', 'Khách B', 'Khách A', 'Khách H', 'Khách C']);
    assert.deepEqual(new Set(names(asc).slice(5)), new Set(['Khách mới D', 'Khách E', 'Khách thiếu kỳ', 'Khách trả hàng']));
    const desc = await repo.getProductCustomerGrowth({ sort: 'growth', dir: 'desc', pool: db });
    assert.deepEqual(names(desc).slice(0, 5), ['Khách C', 'Khách H', 'Khách A', 'Khách B', 'Khách F']);
    assert.equal(desc.sort, 'growth');
    const text = await repo.getProductCustomerGrowth({ sort: 'product_code', pool: db });
    assert.equal(text.dir, 'asc', 'cot chu mac dinh tang dan');
    assert.equal(text.rows[0].productCode, 'SP1');
    assert.equal(text.rows.at(-1).productCode, 'SP2');
  } finally { await db.close(); }
});

test('phan trang: kep ve trang cuoi, tong khong doi', async () => {
  const db = await setup();
  try {
    await seed(db);
    const page = await repo.getProductCustomerGrowth({ page: 3, pageSize: 4, pool: db });
    assert.equal(page.page, 3);
    assert.equal(page.rows.length, 1);
    assert.equal(page.summary.totalRows, 9);
    const clamped = await repo.getProductCustomerGrowth({ page: 99, pageSize: 4, pool: db });
    assert.equal(clamped.page, 3);
    assert.deepEqual(names(clamped), names(page));
  } finally { await db.close(); }
});

test('validate: tham so sai -> 400, khong cham DB', async () => {
  const bad = [
    { growth: 'xxx' }, { growth: 5 }, { sort: 'revenue; DROP TABLE x' }, { sort: 'constructor' }, { dir: 'up' },
    { product: 'x'.repeat(201) }, { customer: ['a', 'b'] }, { pageSize: '201' }, { pageSize: '0' }, { page: '0' }, { page: '1.5' }
  ];
  for (const args of bad) {
    await assert.rejects(repo.getProductCustomerGrowth({ ...args, pool: { query: () => { throw new Error('khong duoc cham DB'); } } }),
      error => error.statusCode === 400, JSON.stringify(args));
  }
  assert.throws(() => repo.validateFilters({ growth: 'xxx' }), { statusCode: 400 });
  assert.doesNotThrow(() => repo.validateFilters({ product: 'a', customer: '', growth: 'check', sort: 'growth', dir: 'asc' }));
  assert.doesNotThrow(() => repo.validateFilters({}));
});

test('chua co state / chua tinh cua so khach -> available:false', async () => {
  for (const state of ['none', 'no-window']) {
    const db = await setup({ state });
    try {
      await seed(db);
      const data = await repo.getProductCustomerGrowth({ pool: db });
      assert.deepEqual(data, { available: false, rows: [], summary: { totalRows: 0, checkRows: 0 } }, state);
    } finally { await db.close(); }
  }
});

test('xuat file: toan bo dong theo bo loc + sap xep, tran dong -> 413 EXPORT_TOO_MANY_ROWS', async () => {
  const db = await setup();
  try {
    await seed(db);
    const all = await repo.getProductCustomerGrowthForExport({ pool: db });
    assert.equal(all.available, true);
    assert.equal(all.rows.length, 9);
    assert.deepEqual(all.summary, { totalRows: 9, checkRows: 2 });
    assert.equal(all.periods.length, 3);
    const check = await repo.getProductCustomerGrowthForExport({ growth: 'check', sort: 'growth', dir: 'asc', pool: db });
    assert.deepEqual(names(check), ['Khách F', 'Khách B']);
    await assert.rejects(repo.getProductCustomerGrowthForExport({ maxRows: 3, pool: db }),
      error => error.statusCode === 413 && error.code === 'EXPORT_TOO_MANY_ROWS' && /thu hẹp/.test(error.message));
    const empty = await repo.getProductCustomerGrowthForExport({ product: 'khongtontai', pool: db });
    assert.equal(empty.available, true);
    assert.deepEqual(empty.rows, []);
  } finally { await db.close(); }
  const none = await setup({ state: 'none' });
  try {
    assert.equal((await repo.getProductCustomerGrowthForExport({ pool: none })).available, false);
  } finally { await none.close(); }
});
```

- [ ] **Step 3: Chạy test để thấy thất bại**

Run: `cd server && node --test dashboard/productCustomerGrowthRepository.test.js`
Expected: FAIL — `Cannot find module './productCustomerGrowthRepository'`.

- [ ] **Step 4: Viết repository**

Tạo `server/dashboard/productCustomerGrowthRepository.js`:

```js
'use strict';

// Bang "Khach hang theo san pham" (muc 4 tab Hang hoa): MOI DONG = 1 CAP (san pham, khach) cua 90 ngay gan nhat, kem 3 ky cuon
// 30 ngay (T.nay / T.truoc / T.truoc nua), % cua SP va TANG TRUONG. Doc thang product_report_customers (lam moi tang dan sau moi luot
// sync) JOIN product_report lay ma/ten. Loc ten san pham, ten khach, nhom tang truong + sap xep + phan trang deu o SQL tren
// TOAN BO ket qua.
//   prior  = T.truoc + T.truoc nua  (= 2 x trung binh hai ky truoc)
//   growth = T.nay x 2 / prior - 1  khi prior > 0, so sanh nguong bang NUMERIC nhan cheo (khong dung so thuc):
//     check: 4 x T.nay < prior (growth < -50%) | drop: 2 x T.nay < prior | up: con lai khi prior > 0 | new: prior <= 0 va T.nay > 0.
const { getPool } = require('../db/pool');
const { fuzzySqlParts } = require('../shared/fuzzySql');
const { timedQuery } = require('../lib/requestTiming');
const { customerPeriods } = require('./productReportRepository');

const GROWTH_GROUPS = Object.freeze(['all', 'check', 'drop', 'up', 'new']);
// Khoa sap xep (whitelist) -> ten cot trong CTE g. KHONG BAO GIO noi chuoi tu nguoi dung vao SQL.
const SORT_SQL = Object.freeze({
  product_code: 'product_code', product_name: 'product_name', customer_name: 'customer_name',
  revenue: 'revenue', revenue_1_30d: 'r1', revenue_31_60d: 'r2', revenue_61_90d: 'r3', share: 'share', growth: 'growth'
});
const SORT_KEYS = Object.freeze(Object.keys(SORT_SQL));
const TEXT_SORTS = new Set(['product_code', 'product_name', 'customer_name']);
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;
const MAX_QUERY_LENGTH = 200;
const EXPORT_MAX_ROWS = 50000;

function invalid() {
  return Object.assign(new Error('Tham số báo cáo khách hàng theo sản phẩm không hợp lệ.'), { statusCode: 400 });
}
function integer(value, fallback, max) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' && typeof value !== 'number') throw invalid();
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) throw invalid();
  return Number(value);
}
// NUMERIC lay ra dang chuoi (::text) roi doi sang so; NULL giu nguyen NULL (khong bien thanh 0).
const toNumber = value => (value === null || value === undefined ? null : Number(value));

// Kiem tra bo loc + dung WHERE / ORDER BY. `add` them tham so va tra ve placeholder ($n). KHONG cham DB.
function parseFilters({ product = '', customer = '', growth = 'all', sort, dir } = {}, add) {
  if (typeof product !== 'string' || product.length > MAX_QUERY_LENGTH) throw invalid();
  if (typeof customer !== 'string' || customer.length > MAX_QUERY_LENGTH) throw invalid();
  if (typeof growth !== 'string' || !GROWTH_GROUPS.includes(growth)) throw invalid();
  if (sort !== undefined && (typeof sort !== 'string' || !SORT_KEYS.includes(sort))) throw invalid();
  if (dir !== undefined && dir !== 'asc' && dir !== 'desc') throw invalid();
  const where = [];
  const productFuzzy = fuzzySqlParts("COALESCE(g.product_code,'') || ' ' || COALESCE(g.product_name,'')", product, add);
  if (productFuzzy) where.push(productFuzzy.where);
  const customerFuzzy = fuzzySqlParts('g.customer_name', customer, add);
  if (customerFuzzy) where.push(customerFuzzy.where);
  if (growth !== 'all') where.push(`g.growth_state = '${growth}'`); // growth da nam trong whitelist o tren
  const sortKey = sort === undefined ? 'revenue' : sort;
  const direction = dir === 'asc' ? 'ASC' : dir === 'desc' ? 'DESC' : (TEXT_SORTS.has(sortKey) ? 'ASC' : 'DESC');
  // NULL luon cuoi o ca 2 chieu; hoa bang -> ma hang -> ten khach -> khoa khach de thu tu on dinh giua cac trang.
  const orderBy = alias => [
    `${alias}.${SORT_SQL[sortKey]} ${direction} NULLS LAST`,
    `${alias}.product_code ASC`, `${alias}.customer_name ASC`, `${alias}.customer_key ASC`
  ].join(', ');
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', orderBy, sortKey, direction };
}

function validateFilters(filters) {
  parseFilters(filters, () => '$0');
}

// s = dong state (khong co cua so khach -> khong tra dong nao, available:false); tot = tong DS cua tung san pham tren
// TAT CA khach (mau so % cua SP, khong doi theo bo loc); b = cap + prior; g = them growth / growth_state.
const BASE_CTES = `WITH s AS (
    SELECT customer_window_end::text AS window_end, version::text AS version,
      to_char(computed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS computed_at
    FROM product_report_state WHERE id = 1 AND customer_window_end IS NOT NULL
  ), tot AS (
    SELECT product_key, SUM(revenue) AS total FROM product_report_customers GROUP BY product_key
  ), b AS (
    SELECT pr.product_code, pr.product_name, pc.customer_key, pc.customer_name, pc.revenue,
      pc.revenue_1_30d AS r1, pc.revenue_31_60d AS r2, pc.revenue_61_90d AS r3,
      CASE WHEN tot.total > 0 THEN pc.revenue / tot.total END AS share,
      CASE WHEN pc.revenue_1_30d IS NULL OR pc.revenue_31_60d IS NULL OR pc.revenue_61_90d IS NULL
        THEN NULL ELSE pc.revenue_31_60d + pc.revenue_61_90d END AS prior
    FROM s
    CROSS JOIN product_report_customers pc
    JOIN tot ON tot.product_key = pc.product_key
    JOIN product_report pr ON lower(btrim(pr.product_code)) = pc.product_key
  ), g AS (
    SELECT b.*,
      CASE WHEN prior > 0 THEN r1 * 2 / prior - 1 END AS growth,
      CASE WHEN prior IS NULL THEN NULL
           WHEN prior > 0 AND r1 * 4 < prior THEN 'check'
           WHEN prior > 0 AND r1 * 2 < prior THEN 'drop'
           WHEN prior > 0 THEN 'up'
           WHEN r1 > 0 THEN 'new' END AS growth_state
    FROM b
  )`;

const ROW_SELECT = `pg.product_code, pg.product_name, pg.customer_name, pg.revenue::text AS revenue,
  pg.r1::text AS r1, pg.r2::text AS r2, pg.r3::text AS r3, pg.share::text AS share, pg.growth::text AS growth, pg.growth_state`;

function mapRecords(records) {
  return records.filter(r => r.product_code !== null && r.product_code !== undefined).map(r => ({
    productCode: r.product_code,
    productName: r.product_name,
    customerName: r.customer_name || '',
    revenue: toNumber(r.revenue),
    revenue1_30d: toNumber(r.r1),
    revenue31_60d: toNumber(r.r2),
    revenue61_90d: toNumber(r.r3),
    share: toNumber(r.share),
    growth: toNumber(r.growth),
    growthState: r.growth_state || null
  }));
}

function stateOf(head) {
  return { customerWindowEnd: head.window_end, computedAt: head.computed_at, version: Number(head.version) };
}

const UNAVAILABLE = () => ({ available: false, rows: [], summary: { totalRows: 0, checkRows: 0 } });

async function getProductCustomerGrowth({ product, customer, growth, sort, dir, page, pageSize, pool } = {}) {
  const values = [];
  const add = value => { values.push(value); return '$' + values.length; };
  const filters = parseFilters({ product, customer, growth, sort, dir }, add);
  page = integer(page, 1, 1000000);
  pageSize = integer(pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const pageParam = add(page), sizeParam = add(pageSize);

  // Mot cau lenh duy nhat: trang thai + tong + so dong "can check" + trang da kep ve trang cuoi cung doc cung mot anh chup.
  const sql = `${BASE_CTES}, f AS (
    SELECT g.* FROM g ${filters.where}
  ), meta AS (
    SELECT count(*)::int AS total_rows,
      (count(*) FILTER (WHERE growth_state = 'check'))::int AS check_rows,
      LEAST(${pageParam}::int, GREATEST(1, CEIL(count(*)::numeric / ${sizeParam}::int)::int)) AS page
    FROM f
  )
  SELECT s.*, meta.total_rows, meta.check_rows, meta.page, ${ROW_SELECT}
  FROM s CROSS JOIN meta
  LEFT JOIN LATERAL (
    SELECT * FROM f ORDER BY ${filters.orderBy('f')}
    LIMIT ${sizeParam}::int OFFSET (meta.page - 1) * ${sizeParam}::int
  ) pg ON true
  ORDER BY ${filters.orderBy('pg')}`;
  const { rows: records } = await timedQuery(pool || getPool(), 'customer-growth', sql, values);

  if (!records.length) return UNAVAILABLE();
  const head = records[0];
  return {
    available: true,
    state: stateOf(head),
    periods: customerPeriods(head.window_end),
    summary: { totalRows: head.total_rows, checkRows: head.check_rows },
    rows: mapRecords(records),
    page: head.page,
    pageSize,
    sort: filters.sortKey,
    dir: filters.direction.toLowerCase()
  };
}

// Xuat file: TOAN BO dong khop bo loc, cung luat loc + sap xep voi man hinh, khong phan trang. Tran an toan EXPORT_MAX_ROWS:
// vuot -> loi 413 ro rang, khong cat ngam.
async function getProductCustomerGrowthForExport({ product, customer, growth, sort, dir, pool, maxRows = EXPORT_MAX_ROWS } = {}) {
  const values = [];
  const add = value => { values.push(value); return '$' + values.length; };
  const filters = parseFilters({ product, customer, growth, sort, dir }, add);
  const limit = integer(maxRows, EXPORT_MAX_ROWS, EXPORT_MAX_ROWS);
  const limitParam = add(limit + 1);
  const sql = `${BASE_CTES}, f AS (
    SELECT g.* FROM g ${filters.where}
  )
  SELECT s.*, (SELECT count(*)::int FROM f) AS total_rows,
    (SELECT (count(*) FILTER (WHERE growth_state = 'check'))::int FROM f) AS check_rows, ${ROW_SELECT}
  FROM s
  LEFT JOIN LATERAL (SELECT * FROM f ORDER BY ${filters.orderBy('f')} LIMIT ${limitParam}::int) pg ON true
  ORDER BY ${filters.orderBy('pg')}`;
  const { rows: records } = await timedQuery(pool || getPool(), 'customer-growth-export', sql, values);

  if (!records.length) return UNAVAILABLE();
  const head = records[0];
  const rows = mapRecords(records);
  if (rows.length > limit) {
    throw Object.assign(new Error(`Bảng khách hàng theo sản phẩm có ${Number(head.total_rows).toLocaleString('en-US')} dòng, vượt giới hạn ${limit.toLocaleString('en-US')} dòng của một lần xuất. Vui lòng gõ từ khóa hoặc chọn nhóm tăng trưởng để thu hẹp.`),
      { statusCode: 413, code: 'EXPORT_TOO_MANY_ROWS' });
  }
  return {
    available: true,
    state: stateOf(head),
    periods: customerPeriods(head.window_end),
    summary: { totalRows: head.total_rows, checkRows: head.check_rows },
    rows,
    sort: filters.sortKey,
    dir: filters.direction.toLowerCase()
  };
}

module.exports = {
  getProductCustomerGrowth, getProductCustomerGrowthForExport, validateFilters,
  GROWTH_GROUPS, SORT_KEYS, EXPORT_MAX_ROWS, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE
};
```

- [ ] **Step 5: Chạy test để thấy pass**

Run: `cd server && node --test dashboard/productCustomerGrowthRepository.test.js`
Expected: PASS, 9 test. Nếu một test đỏ vì `data.state.computedAt` hay kiểu `version`, đối chiếu với `getProduct90dReport` (cùng `to_char`); nếu đỏ ở `share`/`growth` kiểm tra kiểu NUMERIC trả về chuỗi rồi `Number(...)`.

- [ ] **Step 6: Chạy test liên quan để chắc `customerPeriods` không phá gì**

Run: `cd server && node --test dashboard/productReportRepository.test.js`
Expected: PASS (không đổi hành vi, chỉ thêm export).

- [ ] **Step 7: Đo thật truy vấn trên DB dùng chung (chỉ đọc) — hỏi người dùng trước khi chạy**

Mục đích: xác nhận số dòng `product_report_customers` và thời gian truy vấn (pool production chỉ 5 kết nối). **Hỏi người dùng đồng ý trước vì lệnh đọc DB Supabase thật** (xem memory `local-dev-server-readonly`). Tạo script tạm trong scratchpad (không commit), chạy từ `server/` với `SUPABASE_DB_URL` lấy từ `D:\tks_web\server\.env` (worktree không có `.env`), `PG_POOL_MAX=1`:

```js
// <scratchpad>/measure-growth.js — chay: cd server && node <scratchpad>/measure-growth.js
require('dotenv').config({ path: 'D:/tks_web/server/.env' });
process.env.PG_POOL_MAX = '1';
const { getPool } = require('./db/pool');
const repo = require('./dashboard/productCustomerGrowthRepository');
(async () => {
  const pool = getPool();
  console.log((await pool.query('SELECT count(*)::int AS n FROM product_report_customers')).rows[0]);
  for (const args of [{}, { growth: 'check' }, { product: 'binh' }, { customer: 'hanh', sort: 'growth', dir: 'asc' }]) {
    const t = Date.now();
    const d = await repo.getProductCustomerGrowth({ ...args, pool });
    console.log(JSON.stringify(args), d.summary, (Date.now() - t) + 'ms');
  }
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
```
Expected: mỗi truy vấn < 1.500 ms (một vòng Oregon–Singapore ~175 ms + tính toán). Nếu > 1.500 ms hoặc `n` > 200.000: thay `tot` (GROUP BY toàn bảng) bằng cột `share` tính sau khi lọc ở trang (hoặc `SUM(...) OVER (PARTITION BY product_key)`), đo lại, ghi kết quả vào `CURRENT.md` ở Task 6. Nếu người dùng từ chối đo thật: bỏ bước này, ghi "chưa đo trên DB thật" vào `CURRENT.md`.

- [ ] **Step 8: Commit**

```bash
git add server/dashboard/productCustomerGrowthRepository.js server/dashboard/productCustomerGrowthRepository.test.js server/dashboard/productReportRepository.js
git commit -m "feat(hang-hoa): repository bang San pham x Khach hang kem tang truong

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Route `GET /api/product-report/customer-growth`

**Files:**
- Modify: `server/routes.js` (khối require gần dòng 17; route đặt ngay sau route `/api/product-report/90d`, hiện ở dòng ~437-447)
- Create: `server/dashboard/productCustomerGrowthRoutes.test.js`

**Interfaces:**
- Consumes: `getProductCustomerGrowth(args)` từ Task 1.
- Produces: HTTP `GET /api/product-report/customer-growth?product&customer&growth&sort&dir&page&pageSize` → 200 JSON của repository; 400 `{error}` khi tham số sai (`statusCode===400`); 500 `{error:'Không lấy được báo cáo khách hàng theo sản phẩm.'}` còn lại. Guard: feature `reports.products` (kế thừa) + `reports.products.sales`.

- [ ] **Step 1: Viết test thất bại**

Tạo `server/dashboard/productCustomerGrowthRoutes.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Thay repository bang ban gia TRUOC khi nap routes.js (routes.js destructure ham luc nap) - test khong cham DB.
const repositoryPath = require.resolve('./productCustomerGrowthRepository');
const realRepository = require(repositoryPath);
const calls = [];
let nextError = null;
require.cache[repositoryPath].exports = {
  ...realRepository,
  getProductCustomerGrowth: async args => {
    calls.push(args);
    if (nextError) throw nextError;
    return { available: true, rows: [{ productCode: 'SP1' }], summary: { totalRows: 1, checkRows: 0 }, page: 1, pageSize: 50 };
  }
};
const router = require('../routes');
require.cache[repositoryPath].exports = realRepository;

const PATH = '/api/product-report/customer-growth';
function routeLayer() {
  const layer = router.stack.find(item => item.route && item.route.path === PATH && item.route.methods.get);
  if (!layer) throw new Error('Khong tim thay route GET ' + PATH);
  return layer;
}
function fakeRes() {
  return {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}
// Chay lan luot featureGuard cua router.use('/api/product-report') roi guard rieng cua route (khong dung JWT that).
async function runGuards(user) {
  const res = fakeRes();
  const chain = [
    ...router.stack.filter(layer => !layer.route && layer.regexp && layer.regexp.test(PATH) && layer.handle.name === 'featureGuard')
      .map(layer => layer.handle),
    ...routeLayer().route.stack.slice(0, -1).map(layer => layer.handle)
  ];
  for (const handle of chain) {
    let passed = false;
    await handle({ user }, res, () => { passed = true; });
    if (!passed) return { blocked: true, res };
  }
  return { blocked: false, res };
}

test('route nam duoi guard /api/product-report va con yeu cau them reports.products.sales', () => {
  const layer = routeLayer();
  assert.equal(layer.route.stack.length, 2, 'requireFeature + handler');
  assert.ok(router.stack.some(x => !x.route && x.regexp && x.regexp.test(PATH) && x.handle.name === 'featureGuard'),
    'phai co featureGuard (reports.products) ke thua tu router.use');
});

test('phan quyen: chua dang nhap 401, thieu reports.products hoac reports.products.sales 403, du quyen qua', async () => {
  const cases = [
    [undefined, 401],
    [{ vaiTro: 'Nhân viên marketing' }, 403],
    [{ vaiTro: 'Quản lý', featurePermissions: { 'reports.products': false } }, 403],
    [{ vaiTro: 'Quản lý', featurePermissions: { 'reports.products.sales': false } }, 403],
    [{ vaiTro: 'Khách' }, 403]
  ];
  for (const [user, status] of cases) {
    const result = await runGuards(user);
    assert.equal(result.blocked, true, JSON.stringify(user));
    assert.equal(result.res.statusCode, status, JSON.stringify(user));
  }
  const allowed = await runGuards({ vaiTro: 'Quản lý' });
  assert.equal(allowed.blocked, false);
});

async function call(query) {
  const res = fakeRes();
  await routeLayer().route.stack.at(-1).handle({ query }, res);
  return res;
}

test('200: chuyen dung tham so query sang repository', async () => {
  calls.length = 0;
  nextError = null;
  const res = await call({ product: 'binh', customer: 'hanh', growth: 'check', sort: 'growth', dir: 'asc', page: '2', pageSize: '25' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.available, true);
  assert.deepEqual(calls.at(-1), { product: 'binh', customer: 'hanh', growth: 'check', sort: 'growth', dir: 'asc', page: '2', pageSize: '25' });
});

test('loi: 400 giu thong diep, loi khac -> 500 thong diep chung (khong lo chi tiet)', async () => {
  const errors = console.error;
  console.error = () => {};
  try {
    nextError = Object.assign(new Error('Tham số báo cáo khách hàng theo sản phẩm không hợp lệ.'), { statusCode: 400 });
    let res = await call({ growth: 'xxx' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'Tham số báo cáo khách hàng theo sản phẩm không hợp lệ.');
    nextError = new Error('password=secret connection refused');
    res = await call({});
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'Không lấy được báo cáo khách hàng theo sản phẩm.');
    assert.doesNotMatch(JSON.stringify(res.body), /secret/);
  } finally {
    console.error = errors;
    nextError = null;
  }
});
```

- [ ] **Step 2: Chạy test để thấy thất bại**

Run: `cd server && node --test dashboard/productCustomerGrowthRoutes.test.js`
Expected: FAIL — `Khong tim thay route GET /api/product-report/customer-growth`.

- [ ] **Step 3: Thêm route**

Trong `server/routes.js`, sau dòng `const { getProduct90dReport } = require('./dashboard/product90dReportRepository');` (dòng 17) thêm:

```js
const { getProductCustomerGrowth } = require('./dashboard/productCustomerGrowthRepository');
```

Ngay sau khối `router.get('/api/product-report/90d', ...)` (kết thúc bằng `});` ở dòng ~447) thêm:

```js
// Muc 4 "Hang hoa 90 ngay" (tab Hang hoa): bang San pham x Khach hang + Tang truong. CHI DOC product_report_customers
// JOIN product_report (3 ky cuon 30 ngay lam moi tang dan sau moi luot sync); loc ten san pham / ten khach / nhom tang truong,
// sap xep, phan trang o SQL. Duoi /api/product-report (guard reports.products) va them reports.products.sales vi doanh so khach
// theo san pham la du lieu ban hang.
router.get('/api/product-report/customer-growth', requireFeature('reports.products.sales'), async (req, res) => {
  try {
    const { product, customer, growth, sort, dir, page, pageSize } = req.query;
    res.status(200).json(await getProductCustomerGrowth({ product, customer, growth, sort, dir, page, pageSize }));
  } catch (err) {
    if (!err.statusCode || err.statusCode >= 500) console.error('product-report/customer-growth:', err.message);
    res.status(err.statusCode === 400 ? 400 : 500).json({
      error: err.statusCode === 400 ? err.message : 'Không lấy được báo cáo khách hàng theo sản phẩm.'
    });
  }
});
```

- [ ] **Step 4: Chạy test để thấy pass + route cũ vẫn xanh**

Run: `cd server && node --test dashboard/productCustomerGrowthRoutes.test.js dashboard/product90dReportRoutes.test.js`
Expected: PASS cả hai file.

- [ ] **Step 5: Commit**

```bash
git add server/routes.js server/dashboard/productCustomerGrowthRoutes.test.js
git commit -m "feat(hang-hoa): API GET /api/product-report/customer-growth

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Xuất file `products.productCustomerGrowth`

**Files:**
- Modify: `server/dashboard/exportService.js` (require ~dòng 26; `TABLE_TITLES` dòng 55-67; cột sau khối `PRODUCT_90D_*` ~dòng 458; `TABLE_SPECS` sau `'products.product90d'` ~dòng 873-890; hàm dataset sau `buildProduct90dDataset` ~dòng 1143; `describeExport` ~dòng 1290; `buildExportDataset` ~dòng 1363)
- Modify: `server/dashboard/exportService.test.js` (dòng 438 và 639)
- Create: `server/dashboard/exportProductCustomerGrowth.test.js`

**Interfaces:**
- Consumes: `getProductCustomerGrowthForExport`, `validateFilters` (Task 1); helper nội bộ của `exportService.js`: `aggregateColumn(key,label,type,description,options)`, `reportWorksheet(key,name,columns)`, `exportError(message,status,code)`, `normalizeText`, `plainObject`, `throwIfAborted`, `formatDayKey`, `formatVnStamp`, `BRANCH_BOTH`, `TABLE_TITLES`.
- Produces: tableKey `products.productCustomerGrowth`; payload `{ tableKey, context: { productQuery, customerQuery, growthGroup, sortKey?, sortDir? }, columns? , format? }`; worksheet key `product_customer_growth` với các cột (key → nhãn): `productCode` Mã hàng · `productName` Tên hàng · `customerName` Khách hàng · `revenue` DS 90 ngày · `revenue1_30d` T.này · `revenue31_60d` T.trước · `revenue61_90d` T.trước nữa · `share` % của SP (percent) · `growth` Tăng trưởng (percent) · `status` Trạng thái. Nhãn kỳ trong dataset có thêm khoảng ngày thật, vd `T.này (07/10–05/11)`.

- [ ] **Step 1: Viết test thất bại**

Tạo `server/dashboard/exportProductCustomerGrowth.test.js`:

```js
'use strict';

// Xuat Excel + HTML cho bang "Khach hang theo san pham" (tableKey products.productCustomerGrowth): du lieu that tu PGlite qua
// dung duong exportService -> productCustomerGrowthRepository.getProductCustomerGrowthForExport.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { PGlite } = require('@electric-sql/pglite');
const repository = require('./productCustomerGrowthRepository');
const exportService = require('./exportService');

const migration = name => fs.readFileSync(path.join(__dirname, '../db/migrations', name), 'utf8');
const ALLOWED = { canViewProducts: true, canViewSales: true };
const original = repository.getProductCustomerGrowthForExport;
const KEYS = ['productCode', 'productName', 'customerName', 'revenue', 'revenue1_30d', 'revenue31_60d', 'revenue61_90d', 'share', 'growth', 'status'];

async function setup({ withState = true } = {}) {
  const db = new PGlite();
  await db.exec(migration('0018_product_report.sql'));
  await db.exec(migration('0023_product_report_customers.sql'));
  await db.exec(`CREATE TABLE product_report_state (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1), computed_at TIMESTAMPTZ NOT NULL, version BIGINT NOT NULL DEFAULT 1, last_full_at TIMESTAMPTZ)`);
  await db.exec(migration('0108_product_customer_periods.sql'));
  if (withState) {
    await db.exec(`INSERT INTO product_report_state (id, computed_at, version, customer_window_end)
      VALUES (1, '2026-11-05T19:00:05.123Z', 7, '2026-11-05')`);
  }
  await db.exec(`INSERT INTO product_report (product_code, product_name) VALUES ('SP1', 'Bình giữ nhiệt'), ('SP2', 'Cốc sứ')`);
  const pair = (key, customer, revenue, r1, r2, r3) => db.query(
    `INSERT INTO product_report_customers (product_key, customer_key, customer_name, revenue, revenue_1_30d, revenue_31_60d, revenue_61_90d)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`, [key, 'name:' + customer.toLowerCase(), customer, revenue, r1, r2, r3]);
  await pair('sp1', 'Khách A', 200, 40, 60, 100);   // dung -50% -> Giam duoi 50%
  await pair('sp1', 'Khách B|<b>', 210, 10, 100, 100); // -90% -> Can check (ky tu dac biet phai an toan)
  await pair('sp1', 'Khách mới D', 70, 70, 0, 0);   // Moi
  await pair('sp2', 'Khách H', 15, 5, 5, 5);        // 0% -> Dang tang
  repository.getProductCustomerGrowthForExport = args => original({ ...args, pool: db });
  return db;
}
async function teardown(db) {
  repository.getProductCustomerGrowthForExport = original;
  await db.close();
}

const payload = (extra = {}) => ({ tableKey: 'products.productCustomerGrowth', columns: { product_customer_growth: KEYS }, ...extra });
const dataset = extra => exportService.getExportDataset(payload(extra), 'Hà Nội', ALLOWED);

test('quyen: can CA reports.products va reports.products.sales; khoa khong lo ra danh sach truong', async () => {
  for (const options of [undefined, {}, { canViewSales: true }, { canViewProducts: true }, { canViewProducts: true, canViewSales: false }]) {
    await assert.rejects(exportService.getExportFields(payload(), 'Hà Nội', options),
      error => error.statusCode === 403 && error.code === 'EXPORT_TABLE_NOT_ALLOWED', JSON.stringify(options));
    await assert.rejects(exportService.createExport(payload({ format: 'html' }), 'Hà Nội', options),
      error => error.statusCode === 403 && error.code === 'EXPORT_TABLE_NOT_ALLOWED', JSON.stringify(options));
  }
  const fields = await exportService.getExportFields(payload(), 'Hà Nội', ALLOWED);
  assert.equal(fields.title, 'Khách hàng theo sản phẩm 90 ngày');
  assert.deepEqual(fields.worksheets[0].fields.map(f => f.key), KEYS);
  assert.deepEqual(fields.worksheets[0].fields.map(f => f.label),
    ['Mã hàng', 'Tên hàng', 'Khách hàng', 'DS 90 ngày', 'T.này', 'T.trước', 'T.trước nữa', '% của SP', 'Tăng trưởng', 'Trạng thái']);
  assert.equal(fields.worksheets[0].fields[7].type, 'percent');
  assert.equal(fields.worksheets[0].fields[8].type, 'percent');
});

test('bo loc o ngu canh bi kiem tra truoc khi xin slot: sai -> 400', async () => {
  for (const context of [{ growthGroup: 'xxx' }, { productQuery: 'x'.repeat(201) }, { customerQuery: 5 }, { sortKey: 'constructor' }, { sortDir: 'up', sortKey: 'revenue' }]) {
    await assert.rejects(exportService.getExportFields(payload({ context }), 'Hà Nội', ALLOWED), { statusCode: 400 }, JSON.stringify(context));
  }
});

test('dataset: toan bo dong, nhan ky co ngay that, tang truong/ti trong la phan so, trang thai bang chu, ghi chu snapshot', async () => {
  const db = await setup();
  try {
    const data = await dataset();
    const sheet = data.worksheets[0];
    assert.equal(sheet.rows.length, 4);
    assert.deepEqual(sheet.columns.map(c => c.key), KEYS);
    assert.deepEqual(sheet.columns.slice(3, 7).map(c => c.label),
      ['DS 90 ngày', 'T.này (07/10–05/11)', 'T.trước (07/09–06/10)', 'T.trước nữa (08/08–06/09)']);
    const byCustomer = name => sheet.rows.find(r => r.customerName === name);
    assert.equal(byCustomer('Khách A').growth, -0.5);
    assert.equal(byCustomer('Khách A').status, 'Giảm dưới 50%');
    assert.equal(byCustomer('Khách B|<b>').status, 'Cần check');
    assert.equal(byCustomer('Khách mới D').growth, null);
    assert.equal(byCustomer('Khách mới D').status, 'Mới');
    assert.equal(byCustomer('Khách H').status, 'Đang tăng');
    assert.equal(byCustomer('Khách H').revenue1_30d, 5);
    assert.equal(data.meta.title, 'Khách hàng theo sản phẩm 90 ngày');
    assert.equal(data.meta.branch, 'Cả hai');
    assert.match(data.meta.fileBase, /^TKS_Khach_hang_theo_san_pham_90_ngay_/);
    const notes = Object.fromEntries(data.meta.reportNotes);
    assert.equal(notes['Dữ liệu cập nhật lúc'], '02:00 06/11/2026');
    assert.equal(notes['Kỳ T.này'], '07/10/2026 – 05/11/2026');
    assert.equal(notes['Số dòng trong file'], '4');
    assert.equal(notes['Cần check'], '1');
  } finally { await teardown(db); }
});

test('dataset: ap dung dung bo loc + sap xep cua man hinh; khong khop / chua co du lieu -> EXPORT_NO_DATA', async () => {
  const db = await setup();
  try {
    const names = async extra => (await dataset(extra)).worksheets[0].rows.map(r => r.customerName);
    assert.deepEqual(await names({ context: { growthGroup: 'check' } }), ['Khách B|<b>']);
    assert.deepEqual(await names({ context: { productQuery: 'coc su' } }), ['Khách H']);
    assert.deepEqual(await names({ context: { customerQuery: 'moi' } }), ['Khách mới D']);
    assert.deepEqual((await names({ context: { sortKey: 'growth', sortDir: 'asc' } })).slice(0, 3), ['Khách B|<b>', 'Khách A', 'Khách H']);
    const filtered = await dataset({ context: { growthGroup: 'drop', productQuery: 'binh' } });
    const notes = Object.fromEntries(filtered.meta.reportNotes);
    assert.equal(notes['Lọc tên sản phẩm'], 'binh');
    assert.equal(notes['Nhóm tăng trưởng'], 'Giảm dưới 50%');
    await assert.rejects(dataset({ context: { productQuery: 'khongtontai' } }),
      e => e.statusCode === 404 && e.code === 'EXPORT_NO_DATA' && /khongtontai/.test(e.message));
  } finally { await teardown(db); }
  const empty = await setup({ withState: false });
  try {
    await assert.rejects(dataset(), e => e.statusCode === 404 && e.code === 'EXPORT_NO_DATA' && /Chưa có dữ liệu/.test(e.message));
    await assert.rejects(exportService.createExport(payload(), 'Hà Nội', ALLOWED), e => e.code === 'EXPORT_NO_DATA');
  } finally { await teardown(empty); }
});

test('xlsx doc lai: o so la so that, tang truong dinh dang %, ten khach chua ky tu dac biet khong vo file', async () => {
  const db = await setup();
  try {
    const file = await exportService.createExport(payload({ context: { sortKey: 'revenue', sortDir: 'desc' } }), 'Hà Nội', ALLOWED);
    assert.match(file.fileName, /^TKS_Khach_hang_theo_san_pham_90_ngay_\d{8}_\d{4}\.xlsx$/);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer);
    assert.deepEqual(workbook.worksheets.map(w => w.name), ['Khách theo sản phẩm', 'Thông tin báo cáo']);
    const sheet = workbook.worksheets[0];
    const header = sheet.getRow(1).values.slice(1);
    assert.equal(header.length, 10);
    assert.equal(header[4], 'T.này (07/10–05/11)');
    const row = sheet.getRow(2); // Khach B|<b> co DS 210 lon nhat
    assert.equal(row.getCell(3).value, 'Khách B|<b>');
    assert.equal(typeof row.getCell(4).value, 'number');
    assert.equal(row.getCell(9).value, -0.9);
    assert.equal(row.getCell(9).numFmt, '0.00%');
    assert.equal(row.getCell(10).value, 'Cần check');
    // Khach moi: tang truong trong, trang thai "Mới".
    const fresh = [2, 3, 4, 5].map(i => sheet.getRow(i)).find(r => r.getCell(3).value === 'Khách mới D');
    assert.ok(fresh.getCell(9).value === null || fresh.getCell(9).value === '' || fresh.getCell(9).value === undefined);
    assert.equal(fresh.getCell(10).value, 'Mới');
  } finally { await teardown(db); }
});

test('html: tao duoc bao cao, chua du lieu va thoat ky tu dac biet', async () => {
  const db = await setup();
  try {
    const file = await exportService.createExport(payload({ format: 'html' }), 'Hà Nội', ALLOWED);
    assert.match(file.fileName, /\.html$/);
    const text = file.buffer.toString('utf8');
    assert.match(text, /Khách hàng theo sản phẩm 90 ngày/);
    assert.match(text, /Khách A/);
    assert.doesNotMatch(text, /Khách B\|<b>/, 'ten khach co the HTML khong duoc xuat dang tho');
  } finally { await teardown(db); }
});
```

- [ ] **Step 2: Chạy test để thấy thất bại**

Run: `cd server && node --test dashboard/exportProductCustomerGrowth.test.js`
Expected: FAIL — `EXPORT_TABLE_NOT_ALLOWED` / `Bảng yêu cầu xuất không hợp lệ` (khóa chưa có).

- [ ] **Step 3: Thêm vào `exportService.js`**

3a. Dưới dòng `const product90dReportRepository = require('./product90dReportRepository');` (dòng 26) thêm:

```js
const productCustomerGrowthRepository = require('./productCustomerGrowthRepository');
```

3b. Trong `TABLE_TITLES`, sau dòng `'products.product90d': 'Hàng hóa 90 ngày',` thêm:

```js
  'products.productCustomerGrowth': 'Khách hàng theo sản phẩm 90 ngày',
```

3c. Ngay sau hàm `product90dColumnsWithDates` (kết thúc trước comment `// ---------- Ghep dong tho theo ma ----------`) thêm khối cột + tiện ích:

```js
// Khach hang theo san pham (muc 4 tab Hang hoa, bang moi): doc product_report_customers qua
// productCustomerGrowthRepository, CUNG thu tu cot voi man hinh (public/product-customer-growth.js COLUMNS) nhung tach Ma/Ten hang.
// Ti trong va tang truong la PHAN SO (0,25 = 25%) kieu 'percent'; nhan ky them khoang ngay that o dataset (growthColumnsWithDates).
const GROWTH_STATUS_LABELS = Object.freeze({ check: 'Cần check', drop: 'Giảm dưới 50%', up: 'Đang tăng', new: 'Mới' });
const PRODUCT_CUSTOMER_GROWTH_COLUMNS = [
  aggregateColumn('productCode', 'Mã hàng', 'text', 'Mã hàng (gộp Hà Nội + Sài Gòn theo mã).'),
  aggregateColumn('productName', 'Tên hàng', 'text', 'Tên hàng.'),
  aggregateColumn('customerName', 'Khách hàng', 'text', 'Tên khách hàng (gộp theo tên chuẩn hóa).'),
  { ...aggregateColumn('revenue', 'DS 90 ngày', 'number', 'Doanh số của khách với mã hàng trong 90 ngày gần nhất (VNĐ).'), fractionDigits: 0 },
  { ...aggregateColumn('revenue1_30d', 'T.này', 'number', 'Doanh số kỳ 30 ngày gần nhất (VNĐ); trống khi chưa tính kỳ.'), fractionDigits: 0, period: '1_30d' },
  { ...aggregateColumn('revenue31_60d', 'T.trước', 'number', 'Doanh số kỳ 30 ngày liền trước (VNĐ); trống khi chưa tính kỳ.'), fractionDigits: 0, period: '31_60d' },
  { ...aggregateColumn('revenue61_90d', 'T.trước nữa', 'number', 'Doanh số kỳ 30 ngày trước nữa (VNĐ); trống khi chưa tính kỳ.'), fractionDigits: 0, period: '61_90d' },
  aggregateColumn('share', '% của SP', 'percent', 'Doanh số của khách chia tổng doanh số của mã hàng trên tất cả khách.'),
  aggregateColumn('growth', 'Tăng trưởng', 'percent',
    'T.này ÷ trung bình(T.trước, T.trước nữa) − 1. Trống khi hai kỳ trước không có doanh số dương hoặc chưa tính kỳ.'),
  aggregateColumn('status', 'Trạng thái', 'text', 'Cần check (giảm quá 50%), Giảm dưới 50%, Đang tăng hoặc Mới (chưa có doanh số hai kỳ trước).')
];

// Bo loc + sap xep cua man hinh gui trong context; kiem tra lai bang CUNG whitelist cua repository (khong I/O).
function growthFiltersFromContext(context) {
  const source = plainObject(context);
  const filters = {
    product: source.productQuery === undefined ? '' : source.productQuery,
    customer: source.customerQuery === undefined ? '' : source.customerQuery,
    growth: source.growthGroup === undefined || source.growthGroup === '' ? 'all' : source.growthGroup
  };
  if (source.sortKey !== undefined && source.sortKey !== '') {
    filters.sort = source.sortKey;
    if (source.sortDir !== undefined) filters.dir = source.sortDir;
  }
  if (typeof filters.product === 'string') filters.product = filters.product.trim();
  if (typeof filters.customer === 'string') filters.customer = filters.customer.trim();
  return filters;
}

function growthColumnsWithDates(columns, periods) {
  const byKey = new Map((periods || []).map(period => [period.key, period]));
  return columns.map(column => {
    if (!column.period) return column;
    const range = product90dRange(byKey.get(column.period));
    return range ? { ...column, label: `${column.label} (${range})` } : column;
  });
}
```

3d. Trong `TABLE_SPECS`, ngay sau khối `'products.product90d': () => ({ ... }),` (kết thúc bằng `}),` trước `'overview.productReport'`? — vị trí: ngay trước `'stockout.recentScan'`), thêm:

```js
  // Khach hang theo san pham: dong doc o buildProductCustomerGrowthDataset (khong qua dashboard). HTML: chi so ma/ten/khach de tim,
  // khong bieu do xu huong (khong dat periodTrend).
  'products.productCustomerGrowth': () => ({
    worksheets: [{
      ...reportWorksheet('product_customer_growth', 'Khách theo sản phẩm', PRODUCT_CUSTOMER_GROWTH_COLUMNS),
      codeKey: 'productCode',
      summaryKeys: ['revenue'],
      hints: { labelKey: 'productName', categoryKey: false },
      searchKeys: ['productCode', 'productName', 'customerName']
    }]
  }),
```

3e. Sau hàm `buildProduct90dDataset` (kết thúc `}` trước `async function buildProductHistoryDataset`) thêm:

```js
/**
 * Khach hang theo san pham: TOAN BO dong khop bo loc (context.productQuery / customerQuery / growthGroup) theo thu tu
 * sap xep cua man hinh (context.sortKey / sortDir). Chua co cua so khach / khong co dong -> EXPORT_NO_DATA, khong bao gio tao
 * file rong.
 */
async function buildProductCustomerGrowthDataset(description, payload, signal) {
  const worksheet = description.worksheets[0];
  const filters = growthFiltersFromContext(payload.context);
  const data = await productCustomerGrowthRepository.getProductCustomerGrowthForExport(filters);
  throwIfAborted(signal);
  if (!data.available) {
    throw exportError('Chưa có dữ liệu kỳ của khách theo sản phẩm (số liệu được tính sau mỗi lượt đồng bộ KiotViet), chưa có dữ liệu để xuất.', 404, 'EXPORT_NO_DATA');
  }
  if (!data.rows.length) {
    const keyword = [filters.product, filters.customer].filter(Boolean).join(' / ');
    throw exportError(keyword ? `Không có dòng nào khớp “${keyword}” để xuất.` : 'Bảng khách hàng theo sản phẩm chưa có dòng nào để xuất.', 404, 'EXPORT_NO_DATA');
  }
  const columns = growthColumnsWithDates(worksheet.columns, data.periods);
  const rows = data.rows.map(row => ({
    productCode: row.productCode, productName: row.productName, customerName: row.customerName,
    revenue: row.revenue, revenue1_30d: row.revenue1_30d, revenue31_60d: row.revenue31_60d, revenue61_90d: row.revenue61_90d,
    share: row.share, growth: row.growth, status: GROWTH_STATUS_LABELS[row.growthState] || ''
  }));
  const periodRange = period => {
    const from = formatDayKey(period.from), to = formatDayKey(period.to);
    return from && to ? `${from} – ${to}` : '—';
  };
  const notes = [
    ['Dữ liệu cập nhật lúc', formatVnStamp(data.state.computedAt)],
    ['Ngày kết thúc cửa sổ', formatDayKey(data.state.customerWindowEnd) || '—'],
    ...data.periods.map(period => [`Kỳ ${period.label}`, periodRange(period)]),
    ['Phạm vi', 'Toàn công ty (Hà Nội + Sài Gòn, gộp theo mã hàng, khách gộp theo tên chuẩn hóa)'],
    ['Số dòng trong file', rows.length.toLocaleString('en-US')],
    ['Cần check', data.summary.checkRows.toLocaleString('en-US')]
  ];
  if (filters.product) notes.push(['Lọc tên sản phẩm', filters.product]);
  if (filters.customer) notes.push(['Lọc tên khách hàng', filters.customer]);
  if (filters.growth !== 'all') notes.push(['Nhóm tăng trưởng', GROWTH_STATUS_LABELS[filters.growth]]);
  return {
    tableKey: 'products.productCustomerGrowth', title: TABLE_TITLES['products.productCustomerGrowth'], selectionMode: 'custom',
    reportNotes: notes,
    reportNotesTitle: 'Thông tin báo cáo',
    sourceBranch: BRANCH_BOTH,
    worksheets: [{ ...worksheet, columns, rows }]
  };
}
```

3f. Trong `describeExport`, ngay sau khối `if (tableKey === 'products.product90d') { ... }` (kết thúc bằng `}` trước `if (tableKey === 'products.productHistory')`) thêm:

```js
  // Khach hang theo san pham cung lo doanh so khach: can reports.products + reports.products.sales nhu Hang hoa 90 ngay; bo loc o
  // context duoc kiem tra bang whitelist cua repository TRUOC khi xin slot (sai -> 400).
  if (tableKey === 'products.productCustomerGrowth') {
    if (options.canViewProducts !== true || options.canViewSales !== true) {
      throw exportError('Bạn không có quyền xuất bảng khách hàng theo sản phẩm.', 403, 'EXPORT_TABLE_NOT_ALLOWED');
    }
    try {
      productCustomerGrowthRepository.validateFilters(growthFiltersFromContext(context));
    } catch (error) {
      throw exportError('Bộ lọc xuất bảng khách hàng theo sản phẩm không hợp lệ.', 400, 'EXPORT_INVALID_REQUEST');
    }
  }
```

3g. Trong `buildExportDataset`, ngay sau khối `if (tableKey === 'products.product90d') { return buildProduct90dDataset(...); }` thêm:

```js
  if (tableKey === 'products.productCustomerGrowth') {
    return buildProductCustomerGrowthDataset(description, request, signal);
  }
```

- [ ] **Step 4: Cập nhật `exportService.test.js` cho khóa mới**

Sửa dòng 438:

```js
const accessFor = tableKey => (['products.product90d', 'products.productCustomerGrowth', 'products.productHistory'].includes(tableKey) ? { canViewProducts: true, canViewSales: true } : undefined);
```

Sửa dòng 639:

```js
      const payloads = ALL_STATIC_TABLES.filter(tableKey => !['products.product90d', 'products.productCustomerGrowth', 'products.productHistory'].includes(tableKey)).map(tableKey => payloadFor(tableKey));
```

Sửa comment dòng 637-638 nếu nhắc riêng product90d (thêm "và Khách hàng theo sản phẩm cũng đổi nhãn kỳ").

- [ ] **Step 5: Chạy test để thấy pass**

Run: `cd server && node --test dashboard/exportProductCustomerGrowth.test.js dashboard/exportProduct90d.test.js dashboard/exportService.test.js`
Expected: PASS cả ba. Nếu test HTML đỏ vì renderer đòi trường (ví dụ `periodTrend`, `hints`), đọc thông báo lỗi, bổ sung đúng tùy chọn tối thiểu vào worksheet ở bước 3d (đối chiếu khối `products.product90d` ngay trên) và chạy lại. Nếu `Number` Excel `numFmt` của `percent` khác `'0.00%'` đối chiếu `exportService.js` dòng ~1528 (`column.type === 'percent'`) rồi chỉnh assert cho khớp giá trị thật.

- [ ] **Step 6: Commit**

```bash
git add server/dashboard/exportService.js server/dashboard/exportService.test.js server/dashboard/exportProductCustomerGrowth.test.js
git commit -m "feat(hang-hoa): xuat file bang Khach hang theo san pham

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Module giao diện + CSS + markup mục 4 mới

**Files:**
- Create: `server/public/product-customer-growth.js`
- Create: `server/public/product-customer-growth.css`
- Modify: `server/public/index.html` (thay khối comment + `<section id="product90dSection">` ở dòng ~4510-4583; link CSS dòng 55; script dòng 5523)
- Create: `server/test/frontend/product-customer-growth.test.js` (phần hàm thuần + markup + hành vi; phần trang thật ở Task 5)

**Interfaces:**
- Consumes: API Task 2 (`/api/product-report/customer-growth`, dạng JSON của Task 1); `window.TKSTables.enhance(table, { columns })`, `window.TKSNav.can(key)`, `window.openExportDialog(tableKey)`.
- Produces: `window.TKSProductCustomerGrowth = { load(force), reset(), helpers, exportState(), openExport() }`; `module.exports = helpers` (Node) với `COLUMNS`, `GROWTH_OPTIONS`, `formatMoney`, `formatShare`, `formatGrowth`, `formatPeriodRange`, `formatStamp`, `growthCellHtml`, `rowHtml`, `buildQuery`, `nextSort`, `sortAction`, `exportContext`, `escapeHtml`. `exportState()` trả `{ context: { productQuery, customerQuery, growthGroup, sortKey?, sortDir? } }`. Id DOM (giữ ổn định cho test): `product90dSection`, `pcgUpdatedAt`, `pcgRowsTag`, `pcgExportButton`, `pcgProductSearch`, `pcgProductClear`, `pcgCustomerSearch`, `pcgCustomerClear`, `pcgGrowth`, `pcgStatus`, `pcgScroll`, `pcgTable`, `pcgRows`, `pcgPagination`, `pcgFirstPage`, `pcgPrevPage`, `pcgPageLabel`, `pcgNextPage`, `pcgLastPage`, `pcgPageSize`.

- [ ] **Step 1: Viết test thất bại**

Tạo `server/test/frontend/product-customer-growth.test.js`:

```js
'use strict';

// Muc 4 "Hang hoa 90 ngay" cua tab Hang hoa (product-customer-growth.js): ham thuan (dinh dang, nhan "Can check", chuoi truy van,
// ngu canh xuat file), cau truc index.html, hanh vi bang (loc/sap xep/phan trang o may chu, chong phan hoi cu, cac trang thai)
// va phan quyen tren trang that.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const publicDir = path.join(__dirname, '..', '..', 'public');
const modulePath = path.join(publicDir, 'product-customer-growth.js');
const moduleSource = fs.readFileSync(modulePath, 'utf8');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const H = require(modulePath);
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---------- ham thuan ----------
test('formatMoney: NULL -> "—", 0 -> "0", am giu dau, lam tron so nguyen', () => {
  assert.equal(H.formatMoney(null), '—');
  assert.equal(H.formatMoney(undefined), '—');
  assert.equal(H.formatMoney(''), '—');
  assert.equal(H.formatMoney(0), '0');
  assert.equal(H.formatMoney(-0.2), '0');
  assert.equal(H.formatMoney(26920000), '26,920,000');
  assert.equal(H.formatMoney('-1250.5'), '-1,251');
});

test('formatShare + formatGrowth: 1 chu so le, dau + cho so duong, khong bao gio "-0"', () => {
  assert.equal(H.formatShare(0.4523), '45.2%');
  assert.equal(H.formatShare(0.5), '50%');
  assert.equal(H.formatShare(null), '—');
  assert.equal(H.formatGrowth(-0.625), '-62.5%');
  assert.equal(H.formatGrowth(0.125), '+12.5%');
  assert.equal(H.formatGrowth(0), '0%');
  assert.equal(H.formatGrowth(-0.0004), '0%');
  assert.equal(H.formatGrowth(5), '+500%');
  assert.equal(H.formatGrowth(null), '—');
});

test('formatPeriodRange + formatStamp (gio Viet Nam)', () => {
  assert.equal(H.formatPeriodRange('2026-10-07', '2026-11-05'), '07/10–05/11/2026');
  assert.equal(H.formatPeriodRange('2025-12-15', '2026-01-13'), '15/12/2025–13/01/2026');
  assert.equal(H.formatPeriodRange(null, '2026-01-13'), '');
  assert.equal(H.formatStamp('2026-11-05T19:05:00.000Z'), '02:05 06/11/2026');
  assert.equal(H.formatStamp('khong-phai-ngay'), '');
  assert.equal(H.formatStamp(null), '');
});

function cell(markup) {
  const dom = new JSDOM('<table><tbody><tr></tr></tbody></table>');
  dom.window.document.querySelector('tr').innerHTML = markup;
  return dom.window.document.querySelector('td');
}

test('growthCellHtml: check -> chu do + nhan "Cần check"; new -> "Mới"; khong tinh duoc -> "—"; giam nhe / tang khong do', () => {
  const check = cell(H.growthCellHtml({ growth: -0.62, growthState: 'check' }));
  assert.ok(check.classList.contains('is-check'));
  assert.match(check.textContent, /Cần check/);
  assert.match(check.textContent, /-62%/);
  const drop = cell(H.growthCellHtml({ growth: -0.3, growthState: 'drop' }));
  assert.ok(!drop.classList.contains('is-check'));
  assert.equal(drop.textContent.trim(), '-30%');
  assert.equal(cell(H.growthCellHtml({ growth: null, growthState: 'new' })).textContent.trim(), 'Mới');
  assert.equal(cell(H.growthCellHtml({ growth: null, growthState: null })).textContent.trim(), '—');
  assert.equal(cell(H.growthCellHtml({ growth: 0.4, growthState: 'up' })).textContent.trim(), '+40%');
});

test('rowHtml: 8 o theo thu tu COLUMNS, 0 -> "0", NULL -> "—", khach rong -> "Khách lẻ", ky tu HTML duoc escape', () => {
  const dom = new JSDOM('<table><tbody id="b"></tbody></table>');
  const body = dom.window.document.getElementById('b');
  body.innerHTML = H.rowHtml({
    productCode: 'SP<1>', productName: 'Bình & Ly', customerName: '', revenue: 26920000, revenue1_30d: 16000000,
    revenue31_60d: 0, revenue61_90d: null, share: 0.5, growth: null, growthState: null
  });
  const cells = [...body.rows[0].cells].map(td => td.textContent.trim());
  assert.equal(cells.length, H.COLUMNS.length);
  assert.equal(H.COLUMNS.length, 8);
  assert.ok(cells[0].includes('SP<1>') && cells[0].includes('Bình & Ly'));
  assert.ok(body.innerHTML.includes('SP&lt;1&gt;'));
  assert.equal(cells[1], 'Khách lẻ');
  assert.equal(cells[2], '26,920,000');
  assert.equal(cells[3], '16,000,000');
  assert.equal(cells[4], '0');
  assert.equal(cells[5], '—');
  assert.ok(cells[6].includes('50%'));
  assert.equal(cells[7], '—');
});

test('buildQuery: bo tham so rong; growth=all khong gui; dir chi di kem sort; tran pageSize 200', () => {
  assert.equal(H.buildQuery({}), '');
  assert.equal(H.buildQuery({ product: ' binh ', customer: 'Hạnh', growth: 'check', sort: 'growth', dir: 'asc', page: 2, pageSize: 100 }),
    'product=binh&customer=H%E1%BA%A1nh&growth=check&sort=growth&dir=asc&page=2&pageSize=100');
  assert.equal(H.buildQuery({ growth: 'all', sort: 'revenue', page: 1, pageSize: 500 }), 'sort=revenue&page=1&pageSize=200');
  assert.equal(H.buildQuery({ growth: 'bad', dir: 'asc' }), '');
});

test('nextSort: tang dan -> giam dan -> bo sap xep; sortAction bao hanh dong ke tiep', () => {
  assert.deepEqual(H.nextSort({ sort: '', dir: '' }, 'growth'), { sort: 'growth', dir: 'asc' });
  assert.deepEqual(H.nextSort({ sort: 'growth', dir: 'asc' }, 'growth'), { sort: 'growth', dir: 'desc' });
  assert.deepEqual(H.nextSort({ sort: 'growth', dir: 'desc' }, 'growth'), { sort: '', dir: '' });
  assert.deepEqual(H.nextSort({ sort: 'growth', dir: 'asc' }, 'revenue'), { sort: 'revenue', dir: 'asc' });
  assert.equal(H.sortAction('none'), 'Sắp xếp tăng dần');
  assert.equal(H.sortAction('ascending'), 'Sắp xếp giảm dần');
  assert.equal(H.sortAction('descending'), 'Bỏ sắp xếp');
});

test('exportContext: dung bo loc dang ap dung, mac dinh khong gui sap xep', () => {
  assert.deepEqual(H.exportContext({ product: ' binh ', customer: '', growth: 'check', sort: 'growth', dir: 'asc' }),
    { context: { productQuery: 'binh', customerQuery: '', growthGroup: 'check', sortKey: 'growth', sortDir: 'asc' } });
  assert.deepEqual(H.exportContext({}), { context: { productQuery: '', customerQuery: '', growthGroup: 'all' } });
  assert.deepEqual(H.exportContext({ growth: 'bad', sort: 'revenue', dir: 'xxx' }),
    { context: { productQuery: '', customerQuery: '', growthGroup: 'all', sortKey: 'revenue', sortDir: 'desc' } });
});

// ---------- cau truc index.html ----------
const pageDoc = new JSDOM(html).window.document;

test('muc 4 nam ngay sau Tang truong ma hang, buoc "4", tieu de "Hàng hóa 90 ngày", an mac dinh, nap script/css co ?v=', () => {
  const ids = [...pageDoc.querySelectorAll('#view-products > section.section')].map(s => s.id);
  assert.deepEqual(ids, ['productReportSection', 'expectedArrivalsSection', 'productGrowthSection', 'product90dSection']);
  const section = pageDoc.getElementById('product90dSection');
  assert.equal(section.hidden, true);
  assert.equal(section.querySelector('.section-step').textContent.trim(), '4');
  assert.equal(section.querySelector('.section-head h2').firstChild.textContent.trim(), 'Hàng hóa 90 ngày');
  assert.equal(section.querySelector('.panel-head h2').firstChild.textContent.trim(), 'Khách hàng theo sản phẩm');
  assert.match(html, /<script src="\/product-customer-growth\.js\?v=\d{8}-\d+"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/product-customer-growth\.css\?v=\d{8}-\d+">/);
  assert.ok(html.indexOf('/shared/table-controls.js') < html.indexOf('/product-customer-growth.js'), 'table-controls phai nap truoc');
  assert.doesNotMatch(html, /product-90d-report\.(js|css)/, 'giao dien cu cua muc 4 da bi go khoi trang');
  assert.doesNotMatch(section.textContent, /Làm mới/);
});

test('tieu de bang: 8 cot khop COLUMNS, nut sap xep, do rong ghi trong thead; bo loc co du 3 dieu khien', () => {
  const table = pageDoc.getElementById('pcgTable');
  assert.equal(table.dataset.tableSort, 'off');
  assert.equal(table.dataset.tableKey, 'dashboard-table-product-customer-growth');
  assert.ok(table.classList.contains('fixed-table'));
  assert.equal(table.tHead.rows.length, 1);
  const ths = [...table.tHead.rows[0].cells];
  assert.deepEqual(ths.map(th => th.dataset.columnKey), H.COLUMNS.map(c => c.key));
  assert.equal(new Set(ths.map(th => th.dataset.columnKey)).size, 8);
  assert.deepEqual(ths.map(th => th.dataset.sort), H.COLUMNS.map(c => c.sort));
  assert.deepEqual(ths.map(th => th.querySelector('.sort-label').textContent), H.COLUMNS.map(c => c.label));
  ths.forEach((th, index) => {
    assert.ok(th.hasAttribute('data-no-sort'), 'trang tu sap xep qua API');
    assert.equal(th.getAttribute('aria-sort'), 'none');
    assert.equal(th.querySelector('.sort-indicator').textContent, '▲▼');
    assert.equal(th.style.width, H.COLUMNS[index].width + 'px');
  });
  assert.deepEqual([...pageDoc.querySelectorAll('#pcgGrowth option')].map(o => [o.value, o.textContent]), H.GROWTH_OPTIONS);
  ['pcgProductSearch', 'pcgCustomerSearch', 'pcgGrowth', 'pcgExportButton', 'pcgPageSize'].forEach(id => assert.ok(pageDoc.getElementById(id), id));
  assert.match(pageDoc.getElementById('pcgExportButton').getAttribute('onclick'), /openExportDialog\('products\.productCustomerGrowth'\)/);
  assert.ok(pageDoc.getElementById('pcgExportButton').closest('#product90dSection .panel-head-actions'));
});

test('CSS: nhan "Can check" dung bien mau cua trang (khong ma hex), bang co khung cuon rieng', () => {
  const css = fs.readFileSync(path.join(publicDir, 'product-customer-growth.css'), 'utf8');
  assert.match(css, /\.pcg-table td\.is-check[^{]*\{[^}]*var\(--red\)/);
  assert.match(css, /\.pcg-scroll\s*\{[^}]*overflow:\s*auto/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
});

// ---------- hanh vi bang (DOM toi thieu + table-controls that) ----------
function sectionHtml() {
  const start = html.indexOf('<section class="section" id="product90dSection"');
  return html.slice(start, html.indexOf('</section>', start) + '</section>'.length);
}
function periods() {
  return [
    { key: '1_30d', label: 'T.này', from: '2026-10-07', to: '2026-11-05' },
    { key: '31_60d', label: 'T.trước', from: '2026-09-07', to: '2026-10-06' },
    { key: '61_90d', label: 'T.trước nữa', from: '2026-08-08', to: '2026-09-06' }
  ];
}
function sampleRow(customer, extra) {
  return Object.assign({
    productCode: 'SP1', productName: 'Bình giữ nhiệt', customerName: customer, revenue: 1000, revenue1_30d: 400,
    revenue31_60d: 300, revenue61_90d: 300, share: 0.5, growth: 0.3333, growthState: 'up'
  }, extra);
}
function report(rows, extra) {
  return Object.assign({
    available: true, state: { customerWindowEnd: '2026-11-05', computedAt: '2026-11-05T19:05:00.000Z', version: 3 }, periods: periods(),
    summary: { totalRows: rows.length, checkRows: rows.filter(r => r.growthState === 'check').length }, rows,
    page: 1, pageSize: 50, sort: 'revenue', dir: 'desc'
  }, extra);
}

function createWidget({ can = () => true } = {}) {
  const dom = new JSDOM('<!doctype html><body><div class="view active" id="view-products">' + sectionHtml() + '</div></body>',
    { runScripts: 'outside-only', url: 'https://tokosi.example/reports/#products', pretendToBeVisual: true });
  const w = dom.window;
  w.TKSNav = { can };
  const calls = [];
  w.fetch = (url, options) => new Promise((resolve, reject) => {
    if (!String(url).startsWith('/api/product-report/customer-growth')) return; // vd /api/me/table-prefs cua table-controls
    const call = { url: String(url), options, resolve, reject };
    calls.push(call);
    if (options && options.signal) options.signal.addEventListener('abort', () => { call.aborted = true; });
  });
  w.eval(fs.readFileSync(path.join(publicDir, 'shared', 'table-controls.js'), 'utf8'));
  w.eval(moduleSource);
  const $ = id => w.document.getElementById(id);
  const answer = (index, body, status = 200) => calls[index].resolve({ ok: status < 400, status, json: async () => body });
  const params = index => new URL(calls[index].url, 'https://x').searchParams;
  const texts = () => [...$('pcgRows').rows].map(tr => [...tr.cells].map(td => td.textContent.trim()));
  const type = (id, value) => { $(id).value = value; $(id).dispatchEvent(new w.Event('input')); };
  const choose = (id, value) => { $(id).value = value; $(id).dispatchEvent(new w.Event('change')); };
  return { dom, w, $, calls, answer, params, texts, type, choose };
}

test('tai lan dau: goi API mac dinh, ve dong, tieu de ky co khoang ngay, nhan do dung o, "Dữ liệu cập nhật lúc" gio VN', async () => {
  const p = createWidget();
  try {
    p.w.TKSProductCustomerGrowth.load(false);
    assert.equal(p.$('product90dSection').hidden, false);
    assert.equal(p.calls.length, 1);
    assert.equal(p.calls[0].url, '/api/product-report/customer-growth?page=1&pageSize=50');
    assert.match(p.$('pcgRows').textContent, /Đang tải/);
    p.answer(0, report([sampleRow('Khách A', { growth: -0.62, growthState: 'check' }), sampleRow('Khách B')]));
    await settle();
    const rows = p.texts();
    assert.equal(rows.length, 2);
    assert.equal(rows[0][1], 'Khách A');
    assert.match(rows[0][7], /Cần check/);
    assert.equal(p.w.document.querySelectorAll('#pcgRows td.is-check').length, 1);
    assert.equal(p.$('pcgStatus').textContent, '2 dòng khớp · 1 cần check');
    assert.equal(p.$('pcgRowsTag').textContent, '2 dòng');
    assert.equal(p.$('pcgUpdatedAt').textContent, 'Dữ liệu cập nhật lúc 02:05 06/11/2026');
    const title = key => p.w.document.querySelector('th[data-column-key="' + key + '"] .sort-button').title;
    assert.equal(title('revenue_1_30d'), 'Sắp xếp tăng dần theo T.này (07/10–05/11/2026)');
    assert.equal(title('revenue_61_90d'), 'Sắp xếp tăng dần theo T.trước nữa (08/08–06/09/2026)');
    // Du lieu con moi: mo lai tab khong goi lai API.
    await p.w.TKSProductCustomerGrowth.load(false);
    assert.equal(p.calls.length, 1);
  } finally { p.dom.window.close(); }
});

test('loc: debounce 150ms, bo qua khi dang go IME, doi nhom ve trang 1, giu cac bo loc con lai', async () => {
  const p = createWidget();
  try {
    p.w.TKSProductCustomerGrowth.load(true);
    p.answer(0, report([sampleRow('Khách A')], { summary: { totalRows: 120, checkRows: 0 } }));
    await settle();
    p.$('pcgNextPage').click();
    assert.equal(p.params(1).get('page'), '2');
    p.answer(1, report([sampleRow('Khách B')], { summary: { totalRows: 120, checkRows: 0 }, page: 2 }));
    await settle();
    p.type('pcgProductSearch', 'binh');
    assert.equal(p.calls.length, 2, 'debounce: chua goi ngay');
    await wait(220);
    assert.equal(p.calls.length, 3);
    assert.equal(p.params(2).get('product'), 'binh');
    assert.equal(p.params(2).get('page'), '1', 'doi bo loc ve trang 1');
    p.answer(2, report([sampleRow('Khách A')]));
    await settle();
    p.type('pcgCustomerSearch', 'hanh');
    await wait(220);
    assert.equal(p.params(3).get('product'), 'binh');
    assert.equal(p.params(3).get('customer'), 'hanh');
    p.answer(3, report([sampleRow('Khách A')]));
    await settle();
    p.choose('pcgGrowth', 'check');
    assert.equal(p.calls.length, 5);
    assert.equal(p.params(4).get('growth'), 'check');
    assert.equal(p.params(4).get('product'), 'binh');
    assert.equal(p.params(4).get('customer'), 'hanh');
    // Dang go bo go (IME): cho compositionend moi goi.
    p.answer(4, report([sampleRow('Khách A')]));
    await settle();
    const before = p.calls.length;
    p.$('pcgProductSearch').dispatchEvent(new p.w.Event('compositionstart'));
    p.type('pcgProductSearch', 'binh gi');
    await wait(220);
    assert.equal(p.calls.length, before, 'IME dang go khong goi API');
    p.$('pcgProductSearch').dispatchEvent(new p.w.Event('compositionend'));
    await wait(220);
    assert.equal(p.calls.length, before + 1);
    // Nut x xoa o tim va goi lai khong co tham so product.
    p.answer(before, report([sampleRow('Khách A')]));
    await settle();
    p.$('pcgProductClear').click();
    assert.equal(p.params(p.calls.length - 1).get('product'), null);
  } finally { p.dom.window.close(); }
});

test('sap xep o may chu: ▲▼ -> ▼ tang -> ▲ giam -> bo; nut bao hanh dong ke tiep; ve trang 1', async () => {
  const p = createWidget();
  try {
    p.w.TKSProductCustomerGrowth.load(true);
    p.answer(0, report([sampleRow('Khách A')]));
    await settle();
    const th = p.w.document.querySelector('th[data-column-key="growth"]');
    th.querySelector('.sort-button').click();
    assert.equal(p.params(1).get('sort'), 'growth');
    assert.equal(p.params(1).get('dir'), 'asc');
    assert.equal(p.params(1).get('page'), '1');
    p.answer(1, report([sampleRow('Khách A')], { sort: 'growth', dir: 'asc' }));
    await settle();
    assert.equal(th.getAttribute('aria-sort'), 'ascending');
    assert.equal(th.querySelector('.sort-indicator').textContent, '▼');
    assert.match(th.querySelector('.sort-button').title, /^Sắp xếp giảm dần theo Tăng trưởng/);
    th.querySelector('.sort-button').click();
    assert.equal(p.params(2).get('dir'), 'desc');
    p.answer(2, report([sampleRow('Khách A')], { sort: 'growth', dir: 'desc' }));
    await settle();
    assert.equal(th.getAttribute('aria-sort'), 'descending');
    th.querySelector('.sort-button').click();
    assert.equal(p.params(3).get('sort'), null, 'bo sap xep -> thu tu mac dinh cua may chu');
    assert.equal(p.params(3).get('dir'), null);
    p.answer(3, report([sampleRow('Khách A')]));
    await settle();
    assert.equal(th.getAttribute('aria-sort'), 'none');
  } finally { p.dom.window.close(); }
});

test('nut Xuat file: khoa/mo theo du lieu, an khi thieu reports.export, exportState mang dung bo loc + sap xep', async () => {
  const p = createWidget();
  try {
    p.w.TKSProductCustomerGrowth.load(true);
    assert.equal(p.$('pcgExportButton').disabled, true, 'khoa khi dang tai');
    p.answer(0, report([sampleRow('Khách A')]));
    await settle();
    assert.equal(p.$('pcgExportButton').disabled, false);
    p.choose('pcgGrowth', 'check');
    p.answer(1, report([sampleRow('Khách A', { growth: -0.9, growthState: 'check' })]));
    await settle();
    p.w.document.querySelector('th[data-column-key="growth"] .sort-button').click();
    assert.deepEqual(p.w.TKSProductCustomerGrowth.exportState(),
      { context: { productQuery: '', customerQuery: '', growthGroup: 'check', sortKey: 'growth', sortDir: 'asc' } });
    p.answer(2, report([]));
    await settle();
    assert.equal(p.$('pcgExportButton').disabled, true, 'khong co dong -> khong xuat');
  } finally { p.dom.window.close(); }
  const noExport = createWidget({ can: key => key !== 'reports.export' });
  try {
    noExport.w.TKSProductCustomerGrowth.load(true);
    noExport.answer(0, report([sampleRow('Khách A')]));
    await settle();
    assert.equal(noExport.$('pcgExportButton').hidden, true);
  } finally { noExport.dom.window.close(); }
});

test('trang thai: loi -> thong bao + Thu lai (khong ve so 0); chua co du lieu; khong khop bo loc; phan hoi cu khong ghi de', async () => {
  const p = createWidget();
  try {
    p.w.TKSProductCustomerGrowth.load(true);
    p.answer(0, { error: 'Không lấy được' }, 500);
    await settle();
    assert.match(p.$('pcgRows').textContent, /Không tải được báo cáo khách hàng theo sản phẩm/);
    assert.ok(p.$('pcgRows').querySelector('[data-action="retry"]'));
    assert.equal(p.$('pcgRows').textContent.includes('0'), false, 'loi khong duoc thanh bang so 0');
    p.$('pcgRows').querySelector('[data-action="retry"]').click();
    assert.equal(p.calls.length, 2);
    p.answer(1, { available: false, rows: [], summary: { totalRows: 0, checkRows: 0 } });
    await settle();
    assert.match(p.$('pcgRows').textContent, /Chưa có dữ liệu kỳ/);
    // Khong khop bo loc.
    p.type('pcgProductSearch', 'zzz');
    await wait(220);
    p.answer(2, report([], { summary: { totalRows: 0, checkRows: 0 } }));
    await settle();
    assert.match(p.$('pcgRows').textContent, /Không có dòng nào khớp bộ lọc/);
    // Phan hoi cu ve muon KHONG ghi de truy van moi hon.
    p.type('pcgProductSearch', 'abc');
    await wait(220);
    p.type('pcgProductSearch', 'abcd');
    await wait(220);
    const older = p.calls.length - 2, newer = p.calls.length - 1;
    assert.equal(p.calls[older].aborted, true, 'yeu cau cu bi huy');
    p.answer(newer, report([sampleRow('Khách MỚI')]));
    await settle();
    p.answer(older, report([sampleRow('Khách CŨ')]));
    await settle();
    assert.equal(p.texts()[0][1], 'Khách MỚI');
  } finally { p.dom.window.close(); }
});

test('thieu reports.products.sales: an muc, khong goi API', async () => {
  const p = createWidget({ can: key => key !== 'reports.products.sales' });
  try {
    await p.w.TKSProductCustomerGrowth.load(true);
    assert.equal(p.$('product90dSection').hidden, true);
    assert.equal(p.calls.length, 0);
  } finally { p.dom.window.close(); }
});

test('table-controls: nhan hop "Cot hien thi" dung ten cot, an cot Tang truong khong lam vo bang', async () => {
  const p = createWidget();
  try {
    p.w.TKSProductCustomerGrowth.load(true);
    p.answer(0, report([sampleRow('Khách A', { growth: -0.9, growthState: 'check' })]));
    await settle();
    assert.ok(p.$('pcgTable').classList.contains('tks-controlled-table'));
    const button = p.w.document.querySelector('.tks-columns-button');
    assert.ok(button, 'co nut Cot hien thi');
    button.click();
    const labels = [...p.w.document.querySelectorAll('.tks-columns-list label')].map(l => l.textContent.trim());
    assert.deepEqual(labels, H.COLUMNS.map(c => c.label));
  } finally { p.dom.window.close(); }
});
```

- [ ] **Step 2: Chạy test để thấy thất bại**

Run: `cd server && node --test test/frontend/product-customer-growth.test.js`
Expected: FAIL — `Cannot find module '.../product-customer-growth.js'`.

- [ ] **Step 3: Viết CSS**

Tạo `server/public/product-customer-growth.css`:

```css
/* Tab Hàng hóa — mục 4 "Hàng hóa 90 ngày": bảng Khách hàng theo sản phẩm (product-customer-growth.js). Dùng lại panel,
   table-search-*, sort-button, pagination-controls, price-audit-page-size của trang; ở đây chỉ có thanh lọc, khung cuộn có viền,
   thanh tỷ trọng và nhãn "Cần check". Màu đều là biến chung nên tự đổi theo Sáng/Tối. */
.pcg-panel { min-width: 0; }
.pcg-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0 0 10px; }
.pcg-filters .table-search-input-wrap { flex: 1 1 220px; max-width: 360px; min-width: 0; }
.pcg-growth-filter { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12.5px; }
.pcg-growth-filter select {
  height: 34px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--radius-7, 8px);
  background: var(--panel); color: var(--text); font: inherit;
}
.pcg-status { margin: 0 0 8px; min-height: 0; color: var(--muted); font-size: 11.5px; }
.pcg-status:empty { display: none; }

/* Khung cuộn riêng của bảng: trang không bao giờ tràn ngang, bảng rộng cuộn trong khung. */
.pcg-scroll {
  max-width: 100%; min-width: 0; max-height: 640px; overflow: auto;
  border: 1px solid var(--border); border-radius: var(--radius-7, 8px); overscroll-behavior-x: contain;
}
.pcg-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.pcg-scroll::-webkit-scrollbar-thumb { background: var(--border); border-radius: var(--radius-4, 4px); }
.pcg-scroll.is-busy tbody { opacity: .55; transition: opacity .15s ease; }

.pcg-table { border-collapse: separate; border-spacing: 0; }
.pcg-table thead th {
  position: sticky; top: 0; z-index: 3; white-space: normal; vertical-align: middle; text-align: center !important;
  background: linear-gradient(var(--glass-head), var(--glass-head)), var(--panel);
}
.pcg-table.tks-controlled-table thead th { vertical-align: middle; }
.pcg-table thead .sort-button { position: relative; justify-content: center; padding: 0 13px; }
.pcg-table thead .sort-button > .sort-label { flex: 0 1 auto; text-align: center; }
.pcg-table thead .sort-indicator { position: absolute; right: 0; top: 50%; width: 12px; transform: translateY(-50%); }
.pcg-table tbody tr:hover td { background-color: var(--surface-hover); }
.pcg-table td.col-num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.pcg-table td.name-cell { white-space: normal; overflow-wrap: anywhere; }
.pcg-code { display: block; font-family: var(--font-data); font-size: 11.5px; color: var(--muted); }
.pcg-name { display: block; line-height: 1.35; }

/* % của SP: chữ + thanh ngang như bảng khách trong hộp chi tiết hàng hóa. */
.pcg-share { display: inline-flex; align-items: center; justify-content: flex-end; gap: 8px; width: 100%; }
.pcg-bar { flex: 0 0 56px; height: 6px; border-radius: 3px; background: var(--border); overflow: hidden; }
.pcg-bar > i { display: block; height: 100%; background: var(--blue, var(--green)); border-radius: 3px; }

/* Tăng trưởng: chỉ ô này đổi màu. Cần check (giảm quá 50%) chữ đỏ + nhãn; Mới là nhãn trung tính. */
.pcg-table td.pcg-growth { white-space: nowrap; }
.pcg-table td.is-check { color: var(--red); font-weight: 600; }
.pcg-flag {
  display: inline-block; margin-right: 8px; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 600;
  color: var(--red); background: color-mix(in srgb, var(--red) 14%, var(--panel));
}
.pcg-new { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 600; color: var(--muted); background: var(--surface-hover); }

.pcg-table td.pcg-note { text-align: left; white-space: normal; }
.pcg-note-inner { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.pcg-error { color: var(--red); margin-right: 8px; }
.pcg-retry { margin-left: 4px; }

@media (max-width: 768px) {
  .pcg-scroll { max-height: 70vh; }
  .pcg-filters .table-search-input-wrap { max-width: none; flex-basis: 100%; }
}
@media (prefers-reduced-motion: reduce) { .pcg-scroll.is-busy tbody { transition: none; } }
```

- [ ] **Step 4: Thay markup mục 4 trong `index.html`**

Dùng script Node thay đúng khối từ comment mở đầu đến `</section>` đầu tiên sau `id="product90dSection"` (khối cũ không lồng `<section>` khác — test cũ cũng dựa vào giả định này). Tạo file tạm ngoài repo (scratchpad) `replace-section.js` rồi chạy từ thư mục gốc worktree:

```js
const fs = require('node:fs');
const file = 'server/public/index.html';
let html = fs.readFileSync(file, 'utf8');
const marker = '<!-- Hàng hóa 90 ngày: bảng tính sẵn lúc 02:00';
const start = html.indexOf(marker);
if (start < 0) throw new Error('khong thay comment dau muc 4');
const open = html.indexOf('<section class="section" id="product90dSection"', start);
const end = html.indexOf('</section>', open) + '</section>'.length;
const lineStart = html.lastIndexOf('\n', start) + 1;
const indent = html.slice(lineStart, start);
const replacement = fs.readFileSync(process.argv[2], 'utf8').replace(/\n$/, '').split('\n').map((l, i) => (i === 0 ? l : indent + l)).join('\n');
html = html.slice(0, start) + replacement + html.slice(end);
fs.writeFileSync(file, html);
```

Nội dung `section.html` (tạo cùng chỗ, truyền làm tham số):

```html
<!-- Hàng hóa 90 ngày: bảng Khách hàng theo sản phẩm (product-customer-growth.js), API chỉ đọc /api/product-report/customer-growth
     (reports.products.sales). Mỗi dòng một cặp sản phẩm × khách + 3 kỳ 30 ngày + Tăng trưởng; lọc/sắp xếp/phân trang ở máy chủ.
     thead 1 tầng khớp COLUMNS của module (test/frontend/product-customer-growth.test.js khóa khớp). -->
<section class="section" id="product90dSection" hidden>
  <div class="section-head"><span class="section-step">4</span>
    <h2>Hàng hóa 90 ngày <span class="section-note" id="pcgUpdatedAt">—</span></h2>
  </div>
  <div class="grid">
    <div class="panel col-12 pcg-panel">
      <div class="panel-head">
        <h2>Khách hàng theo sản phẩm <span class="tag" id="pcgRowsTag">—</span></h2>
        <div class="panel-head-actions">
          <button class="export-button" type="button" id="pcgExportButton" disabled
            onclick="openExportDialog('products.productCustomerGrowth')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>Xuất file</button>
        </div>
      </div>
      <div class="pcg-filters">
        <div class="table-search-input-wrap">
          <input type="search" class="table-search-input" id="pcgProductSearch" autocomplete="off" maxlength="200" placeholder="Tìm tên hoặc mã sản phẩm…" aria-label="Tìm theo tên hoặc mã sản phẩm trong bảng Khách hàng theo sản phẩm">
          <button type="button" class="table-search-clear" id="pcgProductClear" aria-label="Xóa tìm sản phẩm" hidden>×</button>
        </div>
        <div class="table-search-input-wrap">
          <input type="search" class="table-search-input" id="pcgCustomerSearch" autocomplete="off" maxlength="200" placeholder="Tìm tên khách hàng…" aria-label="Tìm theo tên khách hàng trong bảng Khách hàng theo sản phẩm">
          <button type="button" class="table-search-clear" id="pcgCustomerClear" aria-label="Xóa tìm khách hàng" hidden>×</button>
        </div>
        <label class="pcg-growth-filter"><span>Tăng trưởng</span>
          <select id="pcgGrowth" aria-label="Lọc theo nhóm tăng trưởng">
            <option value="all">Tất cả</option>
            <option value="check">Cần check (giảm quá 50%)</option>
            <option value="drop">Giảm dưới 50%</option>
            <option value="up">Đang tăng</option>
            <option value="new">Khách mới</option>
          </select>
        </label>
      </div>
      <p class="pcg-status" id="pcgStatus" role="status" aria-live="polite"></p>
      <div class="pcg-scroll" id="pcgScroll">
        <table class="fixed-table pcg-table" id="pcgTable" data-table-key="dashboard-table-product-customer-growth" data-table-sort="off">
          <thead>
            <tr>
              <th data-no-sort class="sortable" data-sort="product_name" aria-sort="none" style="width:280px" data-column-key="product"><button type="button" class="sort-button" title="Sắp xếp theo Sản phẩm"><span class="sort-label">Sản phẩm</span><span class="sort-indicator" aria-hidden="true">▲▼</span></button></th>
              <th data-no-sort class="sortable" data-sort="customer_name" aria-sort="none" style="width:240px" data-column-key="customer"><button type="button" class="sort-button" title="Sắp xếp theo Khách hàng"><span class="sort-label">Khách hàng</span><span class="sort-indicator" aria-hidden="true">▲▼</span></button></th>
              <th data-no-sort class="sortable col-num" data-sort="revenue" aria-sort="none" style="width:130px" data-column-key="revenue"><button type="button" class="sort-button" title="Sắp xếp theo DS 90 ngày"><span class="sort-label">DS 90 ngày</span><span class="sort-indicator" aria-hidden="true">▲▼</span></button></th>
              <th data-no-sort class="sortable col-num" data-sort="revenue_1_30d" aria-sort="none" style="width:120px" data-column-key="revenue_1_30d"><button type="button" class="sort-button" title="Sắp xếp theo T.này"><span class="sort-label">T.này</span><span class="sort-indicator" aria-hidden="true">▲▼</span></button></th>
              <th data-no-sort class="sortable col-num" data-sort="revenue_31_60d" aria-sort="none" style="width:120px" data-column-key="revenue_31_60d"><button type="button" class="sort-button" title="Sắp xếp theo T.trước"><span class="sort-label">T.trước</span><span class="sort-indicator" aria-hidden="true">▲▼</span></button></th>
              <th data-no-sort class="sortable col-num" data-sort="revenue_61_90d" aria-sort="none" style="width:130px" data-column-key="revenue_61_90d"><button type="button" class="sort-button" title="Sắp xếp theo T.trước nữa"><span class="sort-label">T.trước nữa</span><span class="sort-indicator" aria-hidden="true">▲▼</span></button></th>
              <th data-no-sort class="sortable col-num" data-sort="share" aria-sort="none" style="width:150px" data-column-key="share"><button type="button" class="sort-button" title="Sắp xếp theo % của SP"><span class="sort-label">% của SP</span><span class="sort-indicator" aria-hidden="true">▲▼</span></button></th>
              <th data-no-sort class="sortable col-num" data-sort="growth" aria-sort="none" style="width:170px" data-column-key="growth"><button type="button" class="sort-button" title="Sắp xếp theo Tăng trưởng"><span class="sort-label">Tăng trưởng</span><span class="sort-indicator" aria-hidden="true">▲▼</span></button></th>
            </tr>
          </thead>
          <tbody id="pcgRows">
            <tr>
              <td colspan="8" class="table-note">Đang tải...</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="pagination-controls" id="pcgPagination" hidden>
        <button type="button" id="pcgFirstPage" aria-label="Trang đầu" title="Trang đầu">&lt;&lt;</button>
        <button type="button" id="pcgPrevPage" aria-label="Trang trước" title="Trang trước">&lt;</button>
        <span id="pcgPageLabel">Trang 1/1</span>
        <button type="button" id="pcgNextPage" aria-label="Trang sau" title="Trang sau">&gt;</button>
        <button type="button" id="pcgLastPage" aria-label="Trang cuối" title="Trang cuối">&gt;&gt;</button>
        <select id="pcgPageSize" class="price-audit-page-size" aria-label="Số dòng mỗi trang">
          <option value="25">25 dòng</option>
          <option value="50" selected>50 dòng</option>
          <option value="100">100 dòng</option>
          <option value="200">200 dòng</option>
        </select>
      </div>
    </div>
  </div>
</section>
```

Chạy: `node <scratchpad>/replace-section.js <scratchpad>/section.html` (từ gốc worktree). Kiểm tra: `git diff --stat server/public/index.html` chỉ thấy khối mục 4 bị thay.

Rồi sửa hai thẻ nạp tài nguyên (Edit):
- `<link rel="stylesheet" href="/product-90d-report.css?v=20261104-9">` → `<link rel="stylesheet" href="/product-customer-growth.css?v=20261106-1">`
- `<script src="/product-90d-report.js?v=20261104-8"></script>` → `<script src="/product-customer-growth.js?v=20261106-1"></script>`

- [ ] **Step 5: Viết module giao diện**

Tạo `server/public/product-customer-growth.js`:

```js
/* Tab Hàng hóa — mục 4 "Hàng hóa 90 ngày": bảng Khách hàng theo sản phẩm (mỗi dòng một cặp sản phẩm × khách) kèm Tăng trưởng
   (API chỉ đọc /api/product-report/customer-growth, quyền reports.products + reports.products.sales). Tăng trưởng = T.này ÷
   trung bình(T.trước, T.trước nữa) − 1, do máy chủ tính; dưới −50% là "Cần check" (chữ đỏ + nhãn). Lọc tên sản phẩm / tên khách /
   nhóm tăng trưởng, sắp xếp và phân trang đều ở máy chủ trên TOÀN BỘ kết quả. thead tĩnh trong index.html (1 tầng, khớp COLUMNS
   bên dưới — test/frontend/product-customer-growth.test.js khóa khớp). Ẩn/hiện cột + kéo độ rộng: shared/table-controls.js
   (data-table-sort="off": trang tự sắp xếp qua API). Phần đầu file là hàm thuần (không đụng DOM) — Node require() được để test. */
(function () {
  'use strict';

  // ---------- hàm thuần ----------
  // sort = khóa sắp xếp gửi API (whitelist của máy chủ); field = tên trường trong dòng API; width = máy tính, mobile = màn hẹp (≤ 600px).
  const COLUMNS = [
    { key: 'product', label: 'Sản phẩm', sort: 'product_name', width: 280, mobile: 190, type: 'product' },
    { key: 'customer', label: 'Khách hàng', sort: 'customer_name', width: 240, mobile: 170, type: 'customer' },
    { key: 'revenue', label: 'DS 90 ngày', sort: 'revenue', field: 'revenue', width: 130, mobile: 110, type: 'money' },
    { key: 'revenue_1_30d', label: 'T.này', sort: 'revenue_1_30d', field: 'revenue1_30d', width: 120, mobile: 100, type: 'money', period: '1_30d' },
    { key: 'revenue_31_60d', label: 'T.trước', sort: 'revenue_31_60d', field: 'revenue31_60d', width: 120, mobile: 100, type: 'money', period: '31_60d' },
    { key: 'revenue_61_90d', label: 'T.trước nữa', sort: 'revenue_61_90d', field: 'revenue61_90d', width: 130, mobile: 110, type: 'money', period: '61_90d' },
    { key: 'share', label: '% của SP', sort: 'share', width: 150, mobile: 120, type: 'share' },
    { key: 'growth', label: 'Tăng trưởng', sort: 'growth', width: 170, mobile: 140, type: 'growth' }
  ];
  const GROWTH_OPTIONS = [
    ['all', 'Tất cả'], ['check', 'Cần check (giảm quá 50%)'], ['drop', 'Giảm dưới 50%'], ['up', 'Đang tăng'], ['new', 'Khách mới']
  ];
  const GROWTH_VALUES = GROWTH_OPTIONS.map(function (option) { return option[0]; });

  const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const PERCENT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
  const DASH = '—';

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toNumber(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
  }

  // Làm tròn nửa ra xa số 0, KHÔNG BAO GIỜ trả -0 (chỉ để HIỂN THỊ; màu đỏ/nhóm lọc do máy chủ quyết định trên giá trị gốc).
  function roundTo(n, digits) {
    const k = Math.pow(10, digits);
    const r = n < 0 ? -Math.round(-n * k) / k : Math.round(n * k) / k;
    return r === 0 ? 0 : r;
  }

  // NULL/không phải số → "—"; 0 → "0"; số tiền hiển thị KHÔNG có phần thập phân (en-US: 26920000 → "26,920,000").
  function formatMoney(value) {
    const n = toNumber(value);
    return n === null ? DASH : NUMBER.format(roundTo(n, 0));
  }

  // share là tỷ lệ 0–1 → "45.2%".
  function formatShare(value) {
    const n = toNumber(value);
    return n === null ? DASH : PERCENT.format(roundTo(n * 100, 1)) + '%';
  }

  // growth là tỷ lệ (−0.625 = −62.5%) → "-62.5%", số dương có dấu "+" ("+12.5%"), 0 → "0%".
  function formatGrowth(value) {
    const n = toNumber(value);
    if (n === null) return DASH;
    const pct = roundTo(n * 100, 1);
    return (pct > 0 ? '+' : '') + PERCENT.format(pct) + '%';
  }

  function parseDay(value) {
    const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? { y: m[1], m: m[2], d: m[3] } : null;
  }

  // Khoảng ngày thực tế của kỳ: cùng năm "07/10–05/11/2026", khác năm "15/12/2025–13/01/2026"; thiếu ngày → "".
  function formatPeriodRange(from, to) {
    const a = parseDay(from), b = parseDay(to);
    if (!a || !b) return '';
    return a.y === b.y
      ? a.d + '/' + a.m + '–' + b.d + '/' + b.m + '/' + b.y
      : a.d + '/' + a.m + '/' + a.y + '–' + b.d + '/' + b.m + '/' + b.y;
  }

  // Thời điểm (ISO UTC) → "HH:mm dd/MM/yyyy" theo giờ Việt Nam; sai định dạng → "".
  const STAMP = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  function formatStamp(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const parts = {};
    STAMP.formatToParts(date).forEach(function (p) { parts[p.type] = p.value; });
    return parts.hour + ':' + parts.minute + ' ' + parts.day + '/' + parts.month + '/' + parts.year;
  }

  function muted() { return '<span class="muted">' + DASH + '</span>'; }

  // check → chữ đỏ + nhãn "Cần check"; new → nhãn "Mới"; không tính được → "—"; còn lại chỉ hiện %.
  function growthCellHtml(row) {
    const state = row ? row.growthState : null;
    const n = toNumber(row ? row.growth : null);
    if (state === 'new') return '<td class="col-num pcg-growth"><span class="pcg-new" title="Chưa có doanh số 2 kỳ trước">Mới</span></td>';
    if (n === null || !state) return '<td class="col-num pcg-growth">' + muted() + '</td>';
    const text = escapeHtml(formatGrowth(n));
    if (state === 'check') {
      return '<td class="col-num pcg-growth is-check"><span class="pcg-flag">Cần check</span><span class="pcg-pct">' + text + '</span></td>';
    }
    return '<td class="col-num pcg-growth"><span class="pcg-pct">' + text + '</span></td>';
  }

  function shareCellHtml(value) {
    const n = toNumber(value);
    if (n === null) return '<td class="col-num">' + muted() + '</td>';
    const width = Math.max(0, Math.min(100, roundTo(n * 100, 1)));
    return '<td class="col-num"><span class="pcg-share"><span>' + escapeHtml(formatShare(n)) + '</span>' +
      '<span class="pcg-bar"><i style="width:' + width + '%"></i></span></span></td>';
  }

  function cellHtml(row, column) {
    const r = row || {};
    if (column.type === 'product') {
      return '<td class="name-cell"><span class="pcg-code">' + escapeHtml(r.productCode) + '</span><span class="pcg-name">' + escapeHtml(r.productName) + '</span></td>';
    }
    if (column.type === 'customer') return '<td class="name-cell">' + (String(r.customerName || '').trim() ? escapeHtml(r.customerName) : 'Khách lẻ') + '</td>';
    if (column.type === 'share') return shareCellHtml(r.share);
    if (column.type === 'growth') return growthCellHtml(r);
    const text = formatMoney(r[column.field]);
    return '<td class="col-num">' + (text === DASH ? muted() : escapeHtml(text)) + '</td>';
  }

  function rowHtml(row) {
    return '<tr>' + COLUMNS.map(function (column) { return cellHtml(row, column); }).join('') + '</tr>';
  }

  function trimmed(value) { return typeof value === 'string' ? value.trim().slice(0, 200) : ''; }

  // Chuỗi truy vấn: BỎ tham số rỗng (máy chủ chỉ nhận chuỗi hợp lệ); growth=all không gửi; dir chỉ đi kèm sort.
  function buildQuery(params) {
    const p = params || {};
    const out = new URLSearchParams();
    const product = trimmed(p.product), customer = trimmed(p.customer);
    if (product) out.set('product', product);
    if (customer) out.set('customer', customer);
    if (GROWTH_VALUES.indexOf(p.growth) > 0) out.set('growth', p.growth);
    if (p.sort) {
      out.set('sort', p.sort);
      if (p.dir === 'asc' || p.dir === 'desc') out.set('dir', p.dir);
    }
    const page = Number(p.page);
    if (Number.isInteger(page) && page >= 1) out.set('page', String(page));
    const size = Number(p.pageSize);
    if (Number.isInteger(size) && size >= 1) out.set('pageSize', String(Math.min(200, size)));
    return out.toString();
  }

  // Thứ tự bấm tiêu đề: tăng dần → giảm dần → bỏ sắp xếp (thứ tự mặc định của máy chủ: DS 90 ngày giảm dần).
  function nextSort(current, key) {
    if (!current || current.sort !== key) return { sort: key, dir: 'asc' };
    if (current.dir === 'asc') return { sort: key, dir: 'desc' };
    return { sort: '', dir: '' };
  }

  // Chữ của nút sắp xếp báo hành động KẾ TIẾP khi bấm: chưa sắp → tăng dần → giảm dần → bỏ sắp xếp.
  function sortAction(mode) {
    return mode === 'ascending' ? 'Sắp xếp giảm dần' : mode === 'descending' ? 'Bỏ sắp xếp' : 'Sắp xếp tăng dần';
  }

  // Ngữ cảnh gửi hộp thoại "Xuất file" (POST /api/export, tableKey products.productCustomerGrowth): đúng bộ lọc ĐANG áp dụng.
  function exportContext(current) {
    const s = current || {};
    const context = {
      productQuery: trimmed(s.product),
      customerQuery: trimmed(s.customer),
      growthGroup: GROWTH_VALUES.indexOf(s.growth) >= 0 ? s.growth : 'all'
    };
    if (s.sort) {
      context.sortKey = s.sort;
      context.sortDir = s.dir === 'asc' ? 'asc' : 'desc';
    }
    return { context: context };
  }

  const helpers = {
    COLUMNS: COLUMNS, GROWTH_OPTIONS: GROWTH_OPTIONS, escapeHtml: escapeHtml, formatMoney: formatMoney, formatShare: formatShare,
    formatGrowth: formatGrowth, formatPeriodRange: formatPeriodRange, formatStamp: formatStamp, growthCellHtml: growthCellHtml,
    rowHtml: rowHtml, buildQuery: buildQuery, nextSort: nextSort, sortAction: sortAction, exportContext: exportContext
  };
  if (typeof module === 'object' && module && module.exports) module.exports = helpers;
  if (typeof window === 'undefined' || !window.document) return;

  // ---------- giao diện ----------
  const API = '/api/product-report/customer-growth';
  const FRESH_MS = 5 * 60 * 1000; // số liệu làm mới sau mỗi lượt đồng bộ: quay lại tab sau 5 phút mới hỏi lại máy chủ
  const SEARCH_DELAY = 150;
  const SORT_GLYPH = { none: '▲▼', ascending: '▼', descending: '▲' };
  const NOT_LOADED = 'Chưa có dữ liệu kỳ của khách theo sản phẩm. Số liệu được tính sau mỗi lượt đồng bộ KiotViet; vui lòng quay lại sau.';
  const GENERIC_ERROR = 'Không tải được báo cáo khách hàng theo sản phẩm.';

  const $ = function (id) { return document.getElementById(id); };
  const can = function (key) { return !!(window.TKSNav && typeof window.TKSNav.can === 'function' && window.TKSNav.can(key)); };

  function freshState() {
    return {
      product: '', customer: '', growth: 'all', sort: '', dir: '', page: 1, pageSize: 50,
      data: null, error: '', loading: false, seq: 0, controller: null, pending: null, loadedAt: 0,
      timers: { product: null, customer: null }, composing: { product: false, customer: false }
    };
  }
  let state = freshState();
  let initialized = false;
  let tableMode = '';

  function screenMode() { return window.innerWidth <= 600 ? 'mobile' : 'desktop'; }

  // Bật table-controls với nhãn đầy đủ cho hộp "Cột hiển thị" và độ rộng theo cỡ màn hình.
  // Gọi ngay khi nạp script (trước lần dựng tự động của table-controls) để phiên cột nhận đúng độ rộng mặc định.
  function setupTable() {
    const table = $('pcgTable');
    if (!table || !window.TKSTables || typeof window.TKSTables.enhance !== 'function') return;
    const mode = screenMode();
    if (mode === tableMode) return;
    tableMode = mode;
    window.TKSTables.enhance(table, {
      columns: COLUMNS.map(function (c) { return { key: c.key, label: c.label, width: mode === 'mobile' ? c.mobile : c.width }; })
    });
  }

  // ---------- vẽ ----------
  function noteRow(html) {
    return '<tr><td colspan="' + COLUMNS.length + '" class="table-note pcg-note"><div class="pcg-note-inner">' + html + '</div></td></tr>';
  }

  function totalRows() {
    const d = state.data;
    return d && d.available && d.summary ? Number(d.summary.totalRows) || 0 : 0;
  }
  function totalPages() {
    return Math.max(1, Math.ceil(totalRows() / state.pageSize));
  }

  function renderHeader() {
    const d = state.data;
    const periods = d && d.available && Array.isArray(d.periods) ? d.periods : [];
    document.querySelectorAll('#pcgTable th.sortable[data-sort]').forEach(function (th) {
      const column = COLUMNS.find(function (c) { return c.key === th.dataset.columnKey; });
      const active = state.sort === th.dataset.sort;
      const mode = active ? (state.dir === 'desc' ? 'descending' : 'ascending') : 'none';
      if (th.getAttribute('aria-sort') !== mode) th.setAttribute('aria-sort', mode);
      th.classList.toggle('sort-active', active);
      const mark = th.querySelector('.sort-indicator');
      if (mark && mark.textContent !== SORT_GLYPH[mode]) mark.textContent = SORT_GLYPH[mode];
      const button = th.querySelector('.sort-button');
      if (button && column) {
        const period = column.period ? periods.find(function (p) { return p && p.key === column.period; }) : null;
        const range = period ? formatPeriodRange(period.from, period.to) : '';
        const title = sortAction(mode) + ' theo ' + column.label + (range ? ' (' + range + ')' : '');
        const aria = sortAction(mode) + ' theo cột ' + column.label;
        if (button.title !== title) button.title = title;
        if (button.getAttribute('aria-label') !== aria) button.setAttribute('aria-label', aria);
      }
    });
  }

  function hasFilter() { return !!(state.product || state.customer || state.growth !== 'all'); }

  function renderBody() {
    const body = $('pcgRows');
    const d = state.data;
    if (state.error) {
      body.innerHTML = noteRow('<span class="pcg-error" role="alert">' + escapeHtml(state.error) + '</span> ' +
        '<button type="button" class="btn-secondary pcg-retry" data-action="retry">Thử lại</button>');
      return;
    }
    if (!d) { body.innerHTML = noteRow('Đang tải...'); return; }
    if (!d.available) { body.innerHTML = noteRow(escapeHtml(NOT_LOADED)); return; }
    const rows = Array.isArray(d.rows) ? d.rows : [];
    if (!rows.length) {
      body.innerHTML = noteRow(hasFilter() ? 'Không có dòng nào khớp bộ lọc.' : 'Chưa có dữ liệu khách theo sản phẩm.');
      return;
    }
    body.innerHTML = rows.map(rowHtml).join('');
  }

  function renderMeta() {
    const d = state.data;
    const ok = !state.error && d && d.available;
    const stamp = ok && d.state ? formatStamp(d.state.computedAt) : '';
    $('pcgUpdatedAt').textContent = stamp ? 'Dữ liệu cập nhật lúc ' + stamp : '—';
    const total = ok ? totalRows() : 0;
    const check = ok && d.summary ? Number(d.summary.checkRows) || 0 : 0;
    $('pcgRowsTag').textContent = ok ? NUMBER.format(total) + ' dòng' : '—';
    const busy = state.loading && !!d && !state.error;
    const frame = $('pcgScroll');
    frame.classList.toggle('is-busy', busy);
    if (busy || (state.loading && !d)) frame.setAttribute('aria-busy', 'true'); else frame.removeAttribute('aria-busy');
    $('pcgStatus').textContent = state.loading ? (d ? 'Đang cập nhật…' : 'Đang tải…')
      : ok ? NUMBER.format(total) + ' dòng khớp · ' + NUMBER.format(check) + ' cần check' : '';
    const pages = totalPages();
    $('pcgPagination').hidden = !ok || total === 0;
    $('pcgPageLabel').textContent = 'Trang ' + state.page + '/' + pages;
    $('pcgFirstPage').disabled = $('pcgPrevPage').disabled = state.page <= 1;
    $('pcgNextPage').disabled = $('pcgLastPage').disabled = state.page >= pages;
    ['Product', 'Customer'].forEach(function (name) {
      const clear = $('pcg' + name + 'Clear');
      if (clear) clear.hidden = !$('pcg' + name + 'Search').value;
    });
    // Nút Xuất file: ẩn khi tài khoản không có quyền xuất; khóa khi chưa có dữ liệu / lỗi / đang tải / lọc không ra dòng nào.
    const exportButton = $('pcgExportButton');
    if (exportButton) {
      exportButton.hidden = !can('reports.export');
      const ready = ok && total > 0 && !state.loading;
      exportButton.disabled = !ready;
      exportButton.title = ready ? 'Xuất Excel hoặc HTML đúng bộ lọc và cột đang sắp xếp' : 'Chưa có dữ liệu để xuất';
    }
  }

  // Mở hộp thoại "Xuất file" dùng chung (index.html openExportDialog → buildExportPayload đọc exportState()).
  function openExport() {
    if (typeof window.openExportDialog === 'function') window.openExportDialog('products.productCustomerGrowth');
  }
  function exportState() {
    return exportContext({ product: state.product, customer: state.customer, growth: state.growth, sort: state.sort, dir: state.dir });
  }

  function render() {
    if (!$('pcgRows')) return;
    renderHeader();
    renderBody();
    renderMeta();
  }

  // ---------- tải ----------
  function readJson(res) {
    if (res.status === 401) {
      window.location.href = '/login/?next=' + encodeURIComponent(location.pathname + location.search + location.hash);
      return Promise.reject(Object.assign(new Error('Phiên đăng nhập đã hết hạn.'), { status: 401 }));
    }
    return res.json().catch(function () { return {}; }).then(function (body) {
      if (!res.ok) throw Object.assign(new Error((body && body.error) || 'HTTP ' + res.status), { status: res.status });
      return body;
    });
  }

  // Mỗi lần gọi: hủy yêu cầu cũ (AbortController) + số thứ tự — phản hồi cũ về muộn KHÔNG ghi đè bộ lọc/sắp xếp/trang mới hơn.
  function fetchPage() {
    const seq = ++state.seq;
    if (state.controller) { try { state.controller.abort(); } catch (_) { /* đã xong */ } }
    const controller = typeof window.AbortController === 'function' ? new window.AbortController() : null;
    state.controller = controller;
    state.loading = true;
    state.error = '';
    render();
    const url = API + '?' + buildQuery({
      product: state.product, customer: state.customer, growth: state.growth, sort: state.sort, dir: state.dir,
      page: state.page, pageSize: state.pageSize
    });
    const options = { credentials: 'same-origin' };
    if (controller) options.signal = controller.signal;
    let request;
    try { request = Promise.resolve(window.fetch(url, options)); } catch (err) { request = Promise.reject(err); }
    const pending = request.then(readJson).then(function (data) {
      if (seq !== state.seq) return;
      state.data = data && typeof data === 'object' ? data : { available: false, rows: [], summary: { totalRows: 0, checkRows: 0 } };
      if (state.data.available && Number.isInteger(Number(state.data.page)) && Number(state.data.page) >= 1) state.page = Number(state.data.page);
      state.loadedAt = Date.now();
    }, function (err) {
      if (seq !== state.seq || (err && err.name === 'AbortError')) return;
      if (err && err.status === 401) return;
      console.error('Không tải được báo cáo khách hàng theo sản phẩm:', err);
      // Lỗi KHÔNG được thành bảng số 0: bỏ dữ liệu, chỉ hiện thông báo + Thử lại.
      state.data = null;
      state.error = err && err.status && err.status < 500 && err.message && !/^HTTP /.test(err.message)
        ? err.message : GENERIC_ERROR;
    }).then(function () {
      if (seq !== state.seq) return;
      state.loading = false;
      state.controller = null;
      state.pending = null;
      render();
    });
    state.pending = pending;
    return pending;
  }

  // Ô tìm kiếm có debounce; bỏ qua khi đang gõ bộ gõ (IME) và chờ compositionend; Esc / nút × xóa ô.
  function bindSearch(field, inputId, clearId) {
    const input = $(inputId), clear = $(clearId);
    const run = function () {
      state.timers[field] = null;
      const value = input.value.trim();
      if (value === state[field]) return;
      state[field] = value;
      state.page = 1;
      fetchPage();
    };
    const schedule = function () {
      clearTimeout(state.timers[field]);
      if (clear) clear.hidden = !input.value;
      if (!input.value.trim()) run(); else state.timers[field] = setTimeout(run, SEARCH_DELAY);
    };
    input.addEventListener('compositionstart', function () { state.composing[field] = true; });
    input.addEventListener('compositionend', function () { state.composing[field] = false; schedule(); });
    input.addEventListener('input', function (event) {
      if (state.composing[field] || event.isComposing) return;
      schedule();
    });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && input.value) { event.preventDefault(); input.value = ''; schedule(); }
    });
    if (clear) clear.addEventListener('click', function () { input.value = ''; schedule(); input.focus(); });
  }

  function onSortClick(event) {
    // Bấm nút hoặc phần đệm của ô tiêu đề (ngoài nút) đều sắp xếp — quy ước chung (table-controls.js); tay kéo độ rộng thì không.
    const button = event.target.closest('.sort-button');
    const th = button ? button.closest('th.sortable[data-sort]')
      : (event.target.matches && event.target.matches('th.sortable[data-sort]') ? event.target : null);
    if (!th) return;
    event.preventDefault();
    const next = nextSort({ sort: state.sort, dir: state.dir }, th.dataset.sort);
    state.sort = next.sort;
    state.dir = next.dir;
    state.page = 1;
    fetchPage();
  }

  function goTo(target) {
    const page = Math.min(Math.max(1, target), totalPages());
    if (page === state.page) return;
    state.page = page;
    fetchPage();
  }

  function init() {
    if (initialized) return;
    initialized = true;
    setupTable();
    $('pcgTable').tHead.addEventListener('click', onSortClick);
    bindSearch('product', 'pcgProductSearch', 'pcgProductClear');
    bindSearch('customer', 'pcgCustomerSearch', 'pcgCustomerClear');
    $('pcgGrowth').addEventListener('change', function (event) {
      state.growth = GROWTH_VALUES.indexOf(event.target.value) >= 0 ? event.target.value : 'all';
      state.page = 1;
      fetchPage();
    });
    $('pcgPageSize').addEventListener('change', function (event) {
      state.pageSize = Number(event.target.value) || 50;
      state.page = 1;
      fetchPage();
    });
    $('pcgFirstPage').addEventListener('click', function () { goTo(1); });
    $('pcgPrevPage').addEventListener('click', function () { goTo(state.page - 1); });
    $('pcgNextPage').addEventListener('click', function () { goTo(state.page + 1); });
    $('pcgLastPage').addEventListener('click', function () { goTo(totalPages()); });
    // Thử lại: chỉ gọi lại API với đúng bộ lọc hiện tại.
    $('pcgRows').addEventListener('click', function (event) {
      if (event.target.closest('[data-action="retry"]')) fetchPage();
    });
    window.addEventListener('resize', setupTable);
  }

  function allowed() { return can('reports.products') && can('reports.products.sales'); }

  /** Mở tab Hàng hóa: ẩn mục khi thiếu quyền (không gọi API); có quyền thì tải nếu chưa có dữ liệu hoặc đã cũ (force = luôn tải). */
  function load(force) {
    const section = $('product90dSection');
    if (!section) return Promise.resolve();
    const ok = allowed();
    section.hidden = !ok;
    if (!ok) return Promise.resolve();
    init();
    if (state.pending) return state.pending;
    if (!force && state.data && !state.error && Date.now() - state.loadedAt < FRESH_MS) return Promise.resolve();
    return fetchPage();
  }

  /** Về trạng thái ban đầu (hủy yêu cầu đang chạy, xóa bộ lọc/sắp xếp/trang). */
  function reset() {
    if (state.controller) { try { state.controller.abort(); } catch (_) { /* đã xong */ } }
    clearTimeout(state.timers.product);
    clearTimeout(state.timers.customer);
    const seq = state.seq + 1;
    state = freshState();
    state.seq = seq;
    ['pcgProductSearch', 'pcgCustomerSearch'].forEach(function (id) { if ($(id)) $(id).value = ''; });
    if ($('pcgGrowth')) $('pcgGrowth').value = 'all';
    if ($('pcgPageSize')) $('pcgPageSize').value = '50';
    render();
  }

  window.TKSProductCustomerGrowth = { load: load, reset: reset, helpers: helpers, exportState: exportState, openExport: openExport };
  if ($('pcgTable')) setupTable();
})();
```

- [ ] **Step 6: Chạy test để thấy pass**

Run: `cd server && node --test test/frontend/product-customer-growth.test.js`
Expected: PASS toàn bộ (các test "trang thật" nằm ở Task 5 nên chưa có). Nếu test `table-controls` đỏ vì lớp/selector khác (`.tks-columns-button`, `.tks-columns-list label`), mở `server/public/shared/table-controls.js` (dòng ~429-525) để lấy đúng selector rồi sửa test cho khớp (không đổi code module). Nếu test "phản hồi cũ" đỏ do `aborted` không được set, kiểm tra `options.signal.addEventListener('abort', ...)` trong `createWidget` (đã có) và rằng `fetchPage` truyền `options.signal`.

- [ ] **Step 7: Commit**

```bash
git add server/public/product-customer-growth.js server/public/product-customer-growth.css server/public/index.html server/test/frontend/product-customer-growth.test.js
git commit -m "feat(hang-hoa): giao dien muc 4 bang Khach hang theo san pham + Tang truong

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Nối vào trang (xuất file, tải khi mở tab) + dọn test/CSS cũ

**Files:**
- Modify: `server/public/index.html` (payload xuất file ~dòng 7087-7093; lệnh `load` ~dòng 7594-7595)
- Modify: `server/test/frontend/product-customer-growth.test.js` (thêm test trang thật)
- Modify: `server/test/frontend/export-ui.test.js` (dòng 15-45)
- Modify: `server/test/frontend/dashboard-section-layout.test.js` (dòng 66)
- Modify: `server/test/frontend/product-90d-report.test.js` (cắt phần phụ thuộc section cũ)
- Delete: `server/public/product-90d-report.css`

**Interfaces:**
- Consumes: `window.TKSProductCustomerGrowth.exportState()` / `.load(false)` (Task 4); `payload.context` của `buildExportPayload` trong `index.html`.
- Produces: nút Xuất file gửi `tableKey: 'products.productCustomerGrowth'` kèm `context.productQuery/customerQuery/growthGroup[/sortKey/sortDir]`; mở tab Hàng hóa gọi `TKSProductCustomerGrowth.load(false)`.

- [ ] **Step 1: Viết test thất bại cho trang thật + payload xuất file**

Cuối `server/test/frontend/product-customer-growth.test.js` thêm:

```js
// ---------- trang that: phan quyen + tai khi mo tab ----------
function createPage(permissions) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://tokosi.example/reports/#products' });
  const w = dom.window;
  w.HTMLCanvasElement.prototype.getContext = () => ({});
  w.Chart = class { static defaults = { font: {}, animation: {}, plugins: { tooltip: {} } }; constructor(c, config) { this.config = config; } destroy() {} };
  w.setInterval = () => 1;
  w.requestAnimationFrame = cb => cb();
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.EventSource = class { addEventListener() {} close() {} };
  w.TKSNav = {
    getPermissions: () => permissions.slice(),
    can: (...keys) => keys.some(k => permissions.includes(k)),
    authGuard: () => Promise.resolve({ vaiTro: 'Kế toán', permissions }),
    handleBranchError: () => false, renderTopSidebar() {}
  };
  const urls = [];
  w.fetch = url => { urls.push(String(url)); return new Promise(() => {}); };
  ['pagination.js', 'table-explorer.js'].forEach(file => w.eval(fs.readFileSync(path.join(publicDir, 'js', file), 'utf8')));
  w.eval(moduleSource);
  [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(s => s.trim()).forEach(s => w.eval(s));
  return { dom, urls, $: id => w.document.getElementById(id) };
}

test('trang that: chi co Du kien hang ve -> muc 4 an, khong goi /api/product-report/customer-growth', async () => {
  const page = createPage(['reports.products.expected']);
  try {
    await settle();
    assert.equal(page.$('product90dSection').hidden, true);
    assert.equal(page.urls.some(u => u.startsWith('/api/product-report/customer-growth')), false);
    assert.deepEqual(page.urls, ['/api/expected-arrivals']);
  } finally { /* khong close(): MutationObserver cua trang chay sau khi dong cua so se nem loi vo hai */ }
});

test('trang that: reports.products + reports.products.sales -> muc 4 hien va goi API; thieu .sales -> an', async () => {
  const allowed = createPage(['reports.products', 'reports.products.sales']);
  const denied = createPage(['reports.products']);
  try {
    await settle();
    assert.equal(allowed.$('product90dSection').hidden, false);
    assert.ok(allowed.urls.includes('/api/product-report/customer-growth?page=1&pageSize=50'));
    await settle();
    assert.equal(denied.$('product90dSection').hidden, true);
    assert.equal(denied.urls.some(u => u.startsWith('/api/product-report/customer-growth')), false);
    assert.equal(denied.urls.some(u => u.startsWith('/api/product-report/90d')), false, 'API cu cua muc 4 khong con duoc goi tu giao dien');
  } finally { /* xem ghi chu o test tren */ }
});
```

Trong `server/test/frontend/export-ui.test.js`, sửa test đếm nút (dòng 15-25) và thay test dòng 27-45:

```js
test('giao dien gan dung 7 nut xuat Excel cho 7 bang co dinh (khong con Dat hang / Tra hang / Khach hang cu / cac muc cu cua Hang hoa)', () => {
  const html = readDashboardHtml();
  const matches = [...html.matchAll(/openExportDialog\('([^']+)'\)/g)].map(match => match[1]);
  assert.equal(matches.length, 7);
  assert.equal(new Set(matches).size, 7);
  assert.deepEqual(matches.sort(), [
    'customers.productDetail', 'debt.aging', 'debt.management', 'debt.penalty',
    'overview.productReport', 'overview.transactions', 'products.productCustomerGrowth'
  ].sort());
});

test('Khach hang theo san pham: nut Xuat file gui dung bo loc + sap xep dang ap dung (lay tu TKSProductCustomerGrowth.exportState)', async () => {
  const h = createExportDashboard();
  // Chua nap product-customer-growth.js (jsdom chi chay script inline): payload van hop le, khong co bo loc.
  h.win.openExportDialog('products.productCustomerGrowth');
  let call = h.fieldsCalls().pop();
  assert.equal(call.body.tableKey, 'products.productCustomerGrowth');
  assert.equal(call.body.context.productQuery, undefined);
  assert.equal(call.body.tableSort, undefined);
  h.win.TKSProductCustomerGrowth = { exportState: () => ({ context: { productQuery: 'binh', customerQuery: 'hanh', growthGroup: 'check', sortKey: 'growth', sortDir: 'asc' } }) };
  h.win.openExportDialog('products.productCustomerGrowth');
  call = h.fieldsCalls().pop();
  assert.equal(call.body.context.productQuery, 'binh');
  assert.equal(call.body.context.customerQuery, 'hanh');
  assert.equal(call.body.context.growthGroup, 'check');
  assert.equal(call.body.context.sortKey, 'growth');
  assert.equal(call.body.context.sortDir, 'asc');
  const button = h.document.getElementById('pcgExportButton');
  assert.ok(button.closest('#product90dSection .panel-head-actions'));
  assert.ok(button.classList.contains('export-button'));
  assert.equal(button.disabled, true, 'khoa cho toi khi co du lieu');
});
```

Trong `server/test/frontend/dashboard-section-layout.test.js` dòng 66 đổi `'product90dRows'` thành `'pcgRows'`:

```js
  ['productReportRows', 'expectedArrivalsRows', 'businessProductsRows', 'pcgRows'].forEach(id => assert.ok(view('products').querySelector('#' + id), id));
```

- [ ] **Step 2: Chạy để thấy thất bại**

Run: `cd server && node --test test/frontend/product-customer-growth.test.js test/frontend/export-ui.test.js test/frontend/dashboard-section-layout.test.js`
Expected: FAIL — trang thật không gọi API (chưa nối `load`), `export-ui` đỏ vì payload chưa có `context` mới.

- [ ] **Step 3: Nối vào `index.html`**

Thay khối payload xuất file (Edit, `old_string` đúng như hiện tại):

```js
      // Hàng hóa 90 ngày: tìm/sắp xếp ở máy chủ — gửi đúng từ khóa đang áp dụng + nhãn cột sắp xếp do product-90d-report.js giữ.
      if (tableKey === 'products.product90d') {
        const context = window.TKSProduct90d && typeof window.TKSProduct90d.exportState === 'function' ? window.TKSProduct90d.exportState() : null;
        payload.tableSearch = context ? context.tableSearch : { mode: 'normal', query: '' };
        if (context && context.tableSort) payload.tableSort = context.tableSort;
        return payload;
      }
```

bằng:

```js
      // Hàng hóa 90 ngày (bảng Khách hàng theo sản phẩm): lọc/sắp xếp ở máy chủ — gửi đúng bộ lọc đang áp dụng do
      // product-customer-growth.js giữ (context.productQuery/customerQuery/growthGroup/sortKey/sortDir).
      if (tableKey === 'products.productCustomerGrowth') {
        const growth = window.TKSProductCustomerGrowth && typeof window.TKSProductCustomerGrowth.exportState === 'function'
          ? window.TKSProductCustomerGrowth.exportState() : null;
        if (growth) Object.assign(payload.context, growth.context);
        return payload;
      }
```

Thay lệnh tải khi mở tab (Edit):

```js
        // Muc 4 "Hang hoa 90 ngay": API rieng /api/product-report/90d, tu kiem quyen (reports.products + .sales) truoc khi goi.
        if (window.TKSProduct90d) window.TKSProduct90d.load(false);
```

bằng:

```js
        // Muc 4 "Hang hoa 90 ngay" (bang Khach hang theo san pham): API rieng /api/product-report/customer-growth, tu kiem quyen
        // (reports.products + .sales) truoc khi goi.
        if (window.TKSProductCustomerGrowth) window.TKSProductCustomerGrowth.load(false);
```

- [ ] **Step 4: Dọn test và CSS cũ**

4a. `server/test/frontend/product-90d-report.test.js`: giữ test hàm thuần (dòng 1–150), cắt phần phụ thuộc section/markup cũ. Chạy từ gốc worktree:

```bash
head -n 150 server/test/frontend/product-90d-report.test.js > "$TMP/p90.tmp" && mv "$TMP/p90.tmp" server/test/frontend/product-90d-report.test.js
```

(`$TMP` = thư mục scratchpad; hoặc dùng Edit xóa từ dòng `// ---------- cau truc index.html ----------` đến hết file.) Rồi sửa đầu file (Edit): đổi comment dòng 3-5 thành

```js
// Ham thuan cua product-90d-report.js (dinh dang NULL/0/am/le, Top 3, khoang ngay, chuoi truy van, ngu canh xuat file): file nay con
// duoc exportService.js require cho xuat file Hang hoa 90 ngay cu. Giao dien muc 4 da chuyen sang product-customer-growth.js
// (xem product-customer-growth.test.js); test bang/markup cu da go cung giao dien cu.
```

và xóa các khai báo không còn dùng: `const modulePath`, `const moduleSource`, `const html`, `const settle`, `const wait` (giữ `const H = require(path.join(publicDir, 'product-90d-report.js'));` — sửa dòng đó cho khỏi dùng `modulePath`):

```js
const publicDir = path.join(__dirname, '..', '..', 'public');
const H = require(path.join(publicDir, 'product-90d-report.js'));
```

Nếu `fs` hết dùng thì bỏ `const fs = require('node:fs');`.

4b. Xóa CSS cũ:

```bash
git rm server/public/product-90d-report.css
```

- [ ] **Step 5: Chạy để thấy pass**

Run: `cd server && node --test test/frontend/product-customer-growth.test.js test/frontend/export-ui.test.js test/frontend/dashboard-section-layout.test.js test/frontend/product-90d-report.test.js test/frontend/expected-arrivals.test.js`
Expected: PASS toàn bộ. Nếu `dashboard-section-layout` còn đỏ ở chỗ đếm `.section-kpis` cho `product90dSection`, id vẫn là `product90dSection` nên phải qua; nếu có test nào khác tham chiếu `product90dRows|product90dTable|product90dSearch`, chạy `grep -rn "product90d[A-Z]" server/test server/public` và đổi sang id `pcg*` tương ứng.

- [ ] **Step 6: Chạy bộ test frontend + xuất file liên quan để chắc không vỡ chỗ khác**

Run: `cd server && node --test "test/frontend/**/*.test.js" "dashboard/**/*.test.js" 2>&1 | tail -40`
Expected: chỉ còn **đúng 2 lỗi nền** theo tên (`timing remains independent after approval and legacy violation is readable without a new violation decision` ở `hr-leave-deadlines.test.js` và `printing and saving stay blocked until fresh shared form succeeds, including programmatic clicks` ở `lifecycle-pick-performance.test.js`) cùng các lỗi nền đã ghi trong `CURRENT.md` (`business-report` ×3, ... — đối chiếu bằng cách chạy lại cùng file trên `git stash`-free bản `main`: `git worktree`/checkout sạch nếu nghi ngờ). Lỗi khác tên hoặc số lỗi khác 2 (ngoài danh sách nền đã ghi) = lỗi mới, phải xử lý trước khi commit. Không `.skip`.

- [ ] **Step 7: Commit**

```bash
git add server/public/index.html server/test/frontend server/public/product-90d-report.css
git commit -m "feat(hang-hoa): noi bang Khach hang theo san pham vao trang, don giao dien cu cua muc 4

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Tài liệu, kiểm tra trên trình duyệt, graphify, kết luận kiểm thử

**Files:**
- Modify: `docs/superpowers/specs/2026-11-06-product-customer-growth-section-design.md` (§6 nói `tableSort theo nhãn cột` → đổi thành `context.sortKey/sortDir` đã triển khai)
- Modify: `README.md` (dòng cây thư mục ~159 `product90dReportRepository.js`, ~176 `product-90d-report.js / .css`; mục "cập nhật gần nhất")
- Modify: `server/README.md` (bảng API: thêm `/api/product-report/customer-growth`)
- Modify: `server/db/SCHEMA.md` (ghi "không đổi schema")
- Modify: `docs/04-planning/implementation_plan.md`, `docs/02-srs/SRS_Dashboard_GoogleSheets.md`, `docs/01-brd/BRD_Dashboard_GoogleSheets.md`
- Modify: `CURRENT.md`

**Interfaces:** không có (chỉ tài liệu + kiểm thử).

- [ ] **Step 1: Sửa spec cho khớp triển khai**

Trong spec §6, thay câu "Dùng đúng bộ lọc đang áp dụng: `context: { productQuery, customerQuery, growthGroup }` + `tableSort` theo nhãn cột (như `exportContext` cũ). Máy chủ kiểm tra lại giá trị (cùng whitelist) rồi gọi `getProductCustomerGrowthForExport`." bằng: "Dùng đúng bộ lọc đang áp dụng: `context: { productQuery, customerQuery, growthGroup, sortKey?, sortDir? }` (khóa sắp xếp gửi thẳng, không qua nhãn cột). Máy chủ kiểm tra lại bằng cùng whitelist của repository (`validateFilters`) trước khi xin slot xuất, rồi gọi `getProductCustomerGrowthForExport`." Cập nhật dòng đầu "Trạng thái" thành "đã duyệt, đã triển khai".

- [ ] **Step 2: Cập nhật các tài liệu bắt buộc (CLAUDE.md §3)**

Tìm vị trí bằng `grep -n "product-90d-report\|product90dReportRepository\|Hàng hóa 90 ngày" <file>` rồi sửa/ghi thêm đúng nội dung sau (ngày 06/11/2026):

- `README.md` cây thư mục: dòng `product-90d-report.js / .css` đổi thành: `product-customer-growth.js / .css # Mục 4 "Hàng hóa 90 ngày" của tab Hàng hóa (06/11/2026): bảng Khách hàng theo sản phẩm (mỗi dòng một cặp sản phẩm × khách) + 3 kỳ + Tăng trưởng, lọc tên sản phẩm/khách/nhóm tăng trưởng, "Cần check" khi giảm quá 50%; đọc API /api/product-report/customer-growth` và thêm một dòng `product-90d-report.js` ghi "(còn dùng cho xuất file cũ products.product90d, không còn nạp trong index.html)". Dòng `dashboard/`: thêm `productCustomerGrowthRepository.js (06/11/2026)`. Mục cập nhật gần nhất: thêm 3-4 câu mô tả thay đổi + nêu "không migration, không biến môi trường, phần máy chủ cũ của mục 4 giữ nguyên".
- `server/README.md` bảng API: thêm hàng `GET /api/product-report/customer-growth` | quyền `reports.products` + `reports.products.sales` | tham số `product, customer, growth(all|check|drop|up|new), sort, dir, page, pageSize` | trả `available, state, periods, summary{totalRows,checkRows}, rows, page, pageSize`.
- `server/db/SCHEMA.md`: thêm đoạn "06/11/2026 — Không đổi schema. API `GET /api/product-report/customer-growth` đọc `product_report_customers` (0023 + 0108) JOIN `product_report` theo `lower(btrim(product_code)) = product_key`, và `product_report_state.customer_window_end`. `NULL` ở các cột kỳ nghĩa là kỳ chưa tính (không coi là 0)."
- `docs/04-planning/implementation_plan.md`: ghi kiến trúc đã triển khai (repository → route → module giao diện → xuất file `products.productCustomerGrowth`), công thức tăng trưởng và ngưỡng, cách tính bằng NUMERIC nhân chéo.
- `docs/02-srs/SRS_Dashboard_GoogleSheets.md` + `docs/01-brd/BRD_Dashboard_GoogleSheets.md`: thêm yêu cầu nghiệp vụ: bảng khách theo sản phẩm có Tăng trưởng, định nghĩa kỳ, ngưỡng "Cần check" dưới −50%, các nhóm lọc, quyền xem/xuất.
- `CURRENT.md`: thêm một dòng đầu danh sách theo mẫu các dòng `> dd/mm/yyyy — **...**` hiện có: nêu thay đổi, danh sách file, số test/kết quả thật vừa chạy (Step 4), kết quả đo hiệu năng ở Task 1 Step 7 (hoặc "chưa đo trên DB thật"), việc tiếp (gỡ job/API/xuất cũ của mục 4 ở một đợt riêng sau khi người dùng yên tâm; deploy web).
- Cuối mỗi tài liệu: cập nhật ngày cập nhật mới nhất thành 06/11/2026 theo thói quen từng file.

- [ ] **Step 3: Kiểm tra trên trình duyệt thật (xin phép người dùng trước vì đọc DB thật)**

Dùng `preview_start` với cấu hình `tks-dashboard-local-readonly` (xem memory `local-dev-server-readonly`; hỏi người dùng trước, sau đó tắt server). Người dùng tự đăng nhập tài khoản thật. Kiểm tra:
1. Tab Hàng hóa → mục 4: bảng hiện, có dòng "Cần check" màu đỏ, trạng thái "N dòng khớp · M cần check".
2. Gõ ô tên sản phẩm / ô tên khách (có dấu và không dấu), đổi danh sách tăng trưởng từng nhóm: số dòng đổi đúng; "Cần check" chỉ gồm dòng đỏ.
3. Bấm tiêu đề Tăng trưởng: giảm mạnh nhất lên đầu, dòng "Mới"/"—" luôn cuối.
4. "Cột hiển thị": ẩn/hiện, kéo độ rộng; chế độ Sáng/Tối (nhãn đỏ đọc rõ); `resize_window` 375px không tràn ngang.
5. Xuất file Excel và HTML với bộ lọc đang chọn; mở file kiểm tra tên cột, nhãn kỳ có ngày, trạng thái.
6. Chụp ảnh bằng `computer {action:"screenshot"}`; `read_console_messages` không có lỗi.
Nếu người dùng từ chối chạy bước này: ghi rõ trong `CURRENT.md` và báo cáo cuối "chưa kiểm tra trên trình duyệt thật".

- [ ] **Step 4: Chạy toàn bộ test liên quan và ghi kết quả thật**

Run (từ `server/`):

```bash
node --test dashboard/productCustomerGrowthRepository.test.js dashboard/productCustomerGrowthRoutes.test.js dashboard/exportProductCustomerGrowth.test.js dashboard/exportProduct90d.test.js dashboard/exportService.test.js dashboard/productReportRepository.test.js dashboard/product90dReportRoutes.test.js dashboard/product90dReportRepository.test.js "test/frontend/**/*.test.js" 2>&1 | tail -60
```

Expected: mọi test mới xanh; phần còn đỏ chỉ là các lỗi nền đã biết theo đúng tên (CLAUDE.md §4.1). Đối chiếu theo **tên lỗi**, không theo số lượng; báo cáo trung thực mọi lỗi khác. Ghi đúng số đạt/đỏ vào `CURRENT.md`.

- [ ] **Step 5: Cập nhật đồ thị mã nguồn**

Run (từ gốc worktree, PowerShell): `graphify update .`
Expected: hoàn tất, `graphify-out/` đồng bộ. Nếu lệnh lỗi, ghi nguyên văn lỗi vào báo cáo, không bỏ qua im lặng.

- [ ] **Step 6: Commit tài liệu**

```bash
git add README.md server/README.md server/db/SCHEMA.md docs CURRENT.md graphify-out
git commit -m "docs(hang-hoa): cap nhat tai lieu bang Khach hang theo san pham + Tang truong

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review (đã chạy)

**Spec coverage:** §1 mục tiêu → Task 1-5; §2 nguồn dữ liệu (JOIN, `customer_window_end`, NULL kỳ, không migration) → Task 1; §3 công thức/ranh giới/nhóm lọc/NUMERIC/`% của SP` → Task 1 (SQL + test) + Task 4 (hiển thị); §4 giao diện (cột, bộ lọc, trạng thái, sắp xếp NULL cuối, phân trang, tô đỏ chỉ ô tăng trưởng, Sáng/Tối, mobile, table-controls, file mới thay file cũ, `product-90d-report.js` giữ) → Task 4-5; §5 API (tham số, whitelist, phản hồi, một câu SQL, hiệu năng/pool, đo) → Task 1-2; §6 xuất file (cột, bộ lọc ngữ cảnh, quyền, trần 50.000, EXPORT_NO_DATA, ghi chú, HTML không `periodTrend`) → Task 3; §7 kiểm thử → từng task + Task 6; §8 tài liệu → Task 6; §9 rủi ro (key bảng mới `dashboard-table-product-customer-growth`, đo thật) → Task 1 Step 7 + Task 4 markup.

**Lệch nhỏ so với spec, đã xử lý:** spec §6 ghi `tableSort theo nhãn` → triển khai gửi `context.sortKey/sortDir` (đơn giản, an toàn hơn), spec được sửa ở Task 6 Step 1.

**Placeholder scan:** không có TBD/TODO; mọi bước code có nội dung đầy đủ. Hai chỗ có phần "nếu lỗi thì đối chiếu" (renderer HTML đòi trường, selector `table-controls`) đều chỉ rõ file/dòng cần mở và cách sửa.

**Type consistency:** `getProductCustomerGrowth` / `getProductCustomerGrowthForExport` / `validateFilters` (Task 1) khớp tên ở Task 2-3; trường dòng `productCode, productName, customerName, revenue, revenue1_30d, revenue31_60d, revenue61_90d, share, growth, growthState` thống nhất giữa repository, export (Task 3), module giao diện và fixture test (Task 4); `summary.totalRows/checkRows` thống nhất; `context.productQuery/customerQuery/growthGroup/sortKey/sortDir` thống nhất giữa `exportContext` (Task 4), payload `index.html` (Task 5), `growthFiltersFromContext` (Task 3); id DOM `pcg*` thống nhất giữa markup, module, test.
