# Sắp xếp nhiều cấp bảng "Khách hàng theo sản phẩm" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cho phép sắp xếp bảng "Khách hàng theo sản phẩm" (mục 4 tab Hàng hóa) theo nhiều cột cùng lúc, bấm tiêu đề cột nào cũng cộng dồn thêm một cấp, tối đa 4 cấp.

**Architecture:** API nhận tham số mới `sorts=khóa:chiều,khóa:chiều` (whitelist chung với `sort`/`dir` cũ, ưu tiên hơn `sort`/`dir`). `ORDER BY` trong SQL ghép các cấp theo thứ tự rồi mới tới khóa phụ cố định. Frontend giữ danh sách cấp `state.sorts`, hiện số cấp trên tiêu đề và nút "Xóa sắp xếp". Xuất file nhận cùng chuỗi `sorts` qua `context.sorts`.

**Tech Stack:** Node.js CommonJS (Express), PostgreSQL (test bằng PGlite), Vanilla JS/CSS, `node:test` + `jsdom`.

Spec: `docs/superpowers/specs/2026-11-10-product-customer-growth-multi-sort-design.md`

## Global Constraints

- Tối đa **4 cấp** sắp xếp; trùng khóa, khóa ngoài whitelist, chiều ngoài `asc`/`desc`, quá 4 cấp, chuỗi `sorts` dài quá **200** ký tự → HTTP **400** (`statusCode: 400`).
- Không nối chuỗi người dùng vào SQL: mọi khóa phải đi qua `SORT_SQL` (whitelist có sẵn).
- Cặp `sort` + `dir` cũ vẫn chạy (tương thích ngược); có `sorts` thì `sorts` thắng. Response vẫn trả `sort` / `dir` (= cấp đầu) và thêm `sorts`.
- NULL luôn cuối ở mọi cấp (`NULLS LAST`); khóa phụ cuối cố định `product_code ASC, customer_name ASC, customer_key ASC`.
- Không dùng TailwindCSS / framework client-side; màu dùng biến CSS (`var(--…)`), không mã hex; hỗ trợ Sáng/Tối và mobile.
- Chuỗi giao diện bằng tiếng Việt có dấu; giờ giấc theo `Asia/Ho_Chi_Minh` (không đụng trong thay đổi này).
- Không migration, không đổi schema.
- Node v24: chạy test bằng đường dẫn file cụ thể (`node --test <file>`) từ thư mục `server/`.
- Commit message kết thúc bằng dòng `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## File Structure

| File | Trách nhiệm |
| --- | --- |
| `server/dashboard/productCustomerGrowthRepository.js` | Sửa: `parseSorts`, `parseFilters` hỗ trợ `sorts`, response thêm `sorts` |
| `server/dashboard/productCustomerGrowthRepository.test.js` | Sửa: thêm test sort nhiều cấp + validate |
| `server/routes.js` | Sửa: route `GET /api/product-report/customer-growth` chuyển tiếp `sorts` |
| `server/dashboard/productCustomerGrowthRoutes.test.js` | Sửa: test chuyển tiếp `sorts` |
| `server/dashboard/exportService.js` | Sửa: `growthFiltersFromContext` nhận `context.sorts` |
| `server/dashboard/exportProductCustomerGrowth.test.js` | Sửa: test xuất theo `sorts` |
| `server/public/product-customer-growth.js` | Sửa: `nextSorts`, `formatSorts`, `buildQuery`, `exportContext`, `state.sorts`, tiêu đề, nút xóa |
| `server/public/index.html` | Sửa: thêm nút `#pcgClearSort`, tăng `?v=` của JS/CSS, cập nhật chú thích |
| `server/public/product-customer-growth.css` | Sửa: kiểu số cấp và nút xóa sắp xếp |
| `server/test/frontend/product-customer-growth.test.js` | Sửa: cập nhật test cũ + thêm test đa cấp |
| `README.md`, `server/README.md`, `CURRENT.md`, `docs/04-planning/implementation_plan.md` | Sửa: tài liệu (skill `update-file`) |

## Chuẩn bị môi trường (một lần)

Worktree chưa có `server/node_modules`. Tạo junction trỏ tới bản của repo chính (thư mục này bị `.gitignore`, không commit):

```powershell
New-Item -ItemType Junction -Path server\node_modules -Target D:\tks_web\server\node_modules
```

Kiểm tra: `cd server; node --test dashboard/productCustomerGrowthRepository.test.js` phải chạy xanh trước khi sửa gì.

---

### Task 1: Repository — sắp xếp nhiều cấp trong SQL

**Files:**
- Modify: `server/dashboard/productCustomerGrowthRepository.js:16-62` (hằng số, `parseFilters`), `:122-125`, `:151-161`, `:166-198` (truyền `sorts`, response)
- Test: `server/dashboard/productCustomerGrowthRepository.test.js`

**Interfaces:**
- Consumes: `SORT_SQL`, `SORT_KEYS`, `TEXT_SORTS`, `invalid()` có sẵn trong file.
- Produces:
  - `parseSorts(value: string): Array<{ sort: string, dir: 'asc'|'desc' }>` (nội bộ, ném lỗi `statusCode 400`).
  - `parseFilters({…, sorts})` nhận thêm `sorts`; trả thêm `sorts` (mảng cấp đã chuẩn hóa); `sortKey` / `direction` (chuỗi `'ASC'|'DESC'`) = cấp đầu như cũ.
  - `getProductCustomerGrowth({…, sorts})` và `getProductCustomerGrowthForExport({…, sorts})`: response thêm `sorts`.
  - `validateFilters({…, sorts})` kiểm tra `sorts`.
  - Export thêm hằng `MAX_SORT_LEVELS = 4`.

- [ ] **Step 1: Viết test thất bại**

Chèn vào `server/dashboard/productCustomerGrowthRepository.test.js`, ngay trước test `'phan trang: kep ve trang cuoi, tong khong doi'`:

```js
test('sap xep nhieu cap: khach hang roi % cua SP; thu tu cap quyet dinh; NULL van cuoi', async () => {
  const db = await setup();
  try {
    await products(db);
    // Khach A co 3 san pham, khach B co 2. share: SP1 A .25 / B .75; SP2 A .75 / B .25; SP3 A 1.
    await pair(db, 'sp1', 'Khách A', 100, 10, 10, 10);
    await pair(db, 'sp1', 'Khách B', 300, 10, 10, 10);
    await pair(db, 'sp2', 'Khách A', 300, 10, 10, 10);
    await pair(db, 'sp2', 'Khách B', 100, 10, 10, 10);
    await pair(db, 'sp3', 'Khách A', 200, 10, 10, 10);
    const pairs = data => data.rows.map(r => r.productCode + '/' + r.customerName);
    const asc = await repo.getProductCustomerGrowth({ sorts: 'customer_name:asc,share:asc', pool: db });
    assert.deepEqual(pairs(asc), ['SP1/Khách A', 'SP2/Khách A', 'SP3/Khách A', 'SP2/Khách B', 'SP1/Khách B']);
    assert.deepEqual(asc.sorts, [{ sort: 'customer_name', dir: 'asc' }, { sort: 'share', dir: 'asc' }]);
    assert.equal(asc.sort, 'customer_name', 'sort/dir cu = cap dau');
    assert.equal(asc.dir, 'asc');
    const desc = await repo.getProductCustomerGrowth({ sorts: 'customer_name:asc,share:desc', pool: db });
    assert.deepEqual(pairs(desc), ['SP3/Khách A', 'SP2/Khách A', 'SP1/Khách A', 'SP1/Khách B', 'SP2/Khách B']);
    const swapped = await repo.getProductCustomerGrowth({ sorts: 'share:desc,customer_name:asc', pool: db });
    assert.deepEqual(pairs(swapped), ['SP3/Khách A', 'SP2/Khách A', 'SP1/Khách B', 'SP1/Khách A', 'SP2/Khách B'],
      'doi thu tu cap (share truoc, khach sau) -> ket qua khac');
  } finally { await db.close(); }
  const db2 = await setup();
  try {
    await seed(db2);
    const byProduct = await repo.getProductCustomerGrowth({ sorts: 'product_code:asc,revenue:asc', pool: db2 });
    assert.deepEqual(names(byProduct),
      ['Khách E', 'Khách thiếu kỳ', 'Khách mới D', 'Khách F', 'Khách A', 'Khách B', 'Khách C', 'Khách H', 'Khách trả hàng']);
    const nullLast = await repo.getProductCustomerGrowth({ sorts: 'product_code:desc,growth:asc', pool: db2 });
    assert.equal(nullLast.rows[0].productCode, 'SP2');
    assert.equal(nullLast.rows[0].customerName, 'Khách H', 'SP2: H 0% truoc, "Khach tra hang" (growth NULL) cuoi nhom SP2');
    assert.equal(nullLast.rows[1].customerName, 'Khách trả hàng');
  } finally { await db2.close(); }
});

test('sorts uu tien hon sort/dir; khong co sorts thi sort/dir cu chay nhu truoc; mac dinh tra sorts = DS giam dan', async () => {
  const db = await setup();
  try {
    await seed(db);
    const both = await repo.getProductCustomerGrowth({ sort: 'growth', dir: 'asc', sorts: 'revenue:asc', pool: db });
    assert.equal(both.rows[0].customerName, 'Khách E', 'sorts thang: DS tang dan, Khach E co DS 0');
    assert.deepEqual(both.sorts, [{ sort: 'revenue', dir: 'asc' }]);
    const legacy = await repo.getProductCustomerGrowth({ sort: 'growth', dir: 'asc', pool: db });
    assert.equal(legacy.rows[0].customerName, 'Khách F');
    assert.deepEqual(legacy.sorts, [{ sort: 'growth', dir: 'asc' }]);
    const def = await repo.getProductCustomerGrowth({ pool: db });
    assert.deepEqual(def.sorts, [{ sort: 'revenue', dir: 'desc' }]);
    const text = await repo.getProductCustomerGrowth({ sort: 'product_code', pool: db });
    assert.deepEqual(text.sorts, [{ sort: 'product_code', dir: 'asc' }], 'cot chu mac dinh tang dan');
    const empty = await repo.getProductCustomerGrowth({ sorts: '', pool: db });
    assert.deepEqual(empty.sorts, [{ sort: 'revenue', dir: 'desc' }], 'sorts rong = khong co sorts');
  } finally { await db.close(); }
});

test('sorts khong hop le -> 400, khong cham DB; xuat file cung luat va cung thu tu', async () => {
  const noDb = { query: () => { throw new Error('khong duoc cham DB'); } };
  const bad = [
    'revenue', 'revenue:up', 'nope:asc', 'revenue:asc,revenue:desc', 'revenue:asc:x', 'revenue:asc,', ',revenue:asc',
    'product_name:asc,customer_name:asc,revenue:asc,share:asc,growth:asc', 'constructor:asc', 'x'.repeat(201),
    ['revenue:asc'], 5, { revenue: 'asc' }
  ];
  for (const sorts of bad) {
    await assert.rejects(repo.getProductCustomerGrowth({ sorts, pool: noDb }), error => error.statusCode === 400, JSON.stringify(sorts));
    await assert.rejects(repo.getProductCustomerGrowthForExport({ sorts, pool: noDb }), error => error.statusCode === 400, JSON.stringify(sorts));
    assert.throws(() => repo.validateFilters({ sorts }), { statusCode: 400 }, JSON.stringify(sorts));
  }
  assert.doesNotThrow(() => repo.validateFilters({ sorts: 'customer_name:asc,share:desc' }));
  assert.doesNotThrow(() => repo.validateFilters({ sorts: 'product_name:asc,customer_name:asc,revenue:asc,share:asc' }), 'dung 4 cap la hop le');
  assert.equal(repo.MAX_SORT_LEVELS, 4);
  const db = await setup();
  try {
    await seed(db);
    const data = await repo.getProductCustomerGrowthForExport({ sorts: 'product_code:desc,revenue:desc', pool: db });
    assert.deepEqual(names(data), ['Khách trả hàng', 'Khách H', 'Khách C', 'Khách B', 'Khách A', 'Khách F', 'Khách mới D', 'Khách thiếu kỳ', 'Khách E']);
    assert.deepEqual(data.sorts, [{ sort: 'product_code', dir: 'desc' }, { sort: 'revenue', dir: 'desc' }]);
  } finally { await db.close(); }
});
```

Sửa thêm test mặc định có sẵn: trong `test('mac dinh: …')`, ngay sau `assert.equal(data.dir, 'desc');` thêm:

```js
    assert.deepEqual(data.sorts, [{ sort: 'revenue', dir: 'desc' }]);
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

Run (từ `server/`): `node --test dashboard/productCustomerGrowthRepository.test.js`
Expected: FAIL — `sorts` chưa được hỗ trợ (kết quả sai thứ tự / `data.sorts` là `undefined` / `MAX_SORT_LEVELS` undefined).

- [ ] **Step 3: Cài đặt `parseSorts` và nối vào `parseFilters`**

Trong `server/dashboard/productCustomerGrowthRepository.js`, thêm hằng ngay dưới `const MAX_QUERY_LENGTH = 200;`:

```js
const MAX_SORT_LEVELS = 4;
```

Thêm hàm ngay trên `// Kiem tra bo loc + dung WHERE / ORDER BY.`:

```js
// "customer_name:asc,share:desc" -> [{ sort, dir }]. Moi khoa phai nam trong whitelist, chieu chi asc/desc, khong trung khoa,
// toi da MAX_SORT_LEVELS cap. Sai bat ky diem nao -> 400. Chuoi rong khong goi ham nay (coi nhu khong co sorts).
function parseSorts(value) {
  if (typeof value !== 'string' || value.length > MAX_QUERY_LENGTH) throw invalid();
  const seen = new Set();
  const levels = value.split(',').map(part => {
    const pieces = part.split(':');
    if (pieces.length !== 2) throw invalid();
    const [sort, dir] = pieces;
    if (!SORT_KEYS.includes(sort) || (dir !== 'asc' && dir !== 'desc') || seen.has(sort)) throw invalid();
    seen.add(sort);
    return { sort, dir };
  });
  if (levels.length > MAX_SORT_LEVELS) throw invalid();
  return levels;
}
```

Sửa chữ ký và thân `parseFilters`: thay

```js
function parseFilters({ product = '', customer = '', growth = 'all', sort, dir } = {}, add) {
```

bằng

```js
function parseFilters({ product = '', customer = '', growth = 'all', sort, dir, sorts } = {}, add) {
```

Thay hai dòng tính `sortKey` / `direction` và khối `orderBy` + `return` (từ `const sortKey = sort === undefined ? …` tới hết hàm) bằng:

```js
  let levels;
  if (sorts !== undefined && sorts !== '') {
    levels = parseSorts(sorts); // sorts thang sort/dir
  } else {
    const sortKey = sort === undefined ? 'revenue' : sort;
    const direction = dir === 'asc' ? 'asc' : dir === 'desc' ? 'desc' : (TEXT_SORTS.has(sortKey) ? 'asc' : 'desc');
    levels = [{ sort: sortKey, dir: direction }];
  }
  // NULL luon cuoi o moi cap, moi chieu; sau cac cap la hoa bang -> ma hang -> ten khach -> khoa khach de thu tu on dinh giua cac trang.
  const orderBy = alias => [
    ...levels.map(level => `${alias}.${SORT_SQL[level.sort]} ${level.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`),
    `${alias}.product_code ASC`, `${alias}.customer_name ASC`, `${alias}.customer_key ASC`
  ].join(', ');
  return {
    where: where.length ? 'WHERE ' + where.join(' AND ') : '', orderBy,
    sortKey: levels[0].sort, direction: levels[0].dir.toUpperCase(), sorts: levels
  };
```

- [ ] **Step 4: Truyền `sorts` qua hai hàm công khai và đưa vào response**

Trong `getProductCustomerGrowth`: đổi chữ ký thành `({ product, customer, growth, sort, dir, sorts, page, pageSize, pool } = {})`, đổi dòng `parseFilters(...)` thành `parseFilters({ product, customer, growth, sort, dir, sorts }, add)`, và trong object trả về thêm `sorts: filters.sorts,` ngay trên dòng `sort: filters.sortKey,`.

Trong `getProductCustomerGrowthForExport`: đổi chữ ký thành `({ product, customer, growth, sort, dir, sorts, pool, maxRows = EXPORT_MAX_ROWS } = {})`, đổi dòng `parseFilters(...)` tương tự, và thêm `sorts: filters.sorts,` ngay trên dòng `sort: filters.sortKey,` của object trả về.

Trong `module.exports` thêm `MAX_SORT_LEVELS`:

```js
module.exports = {
  getProductCustomerGrowth, getProductCustomerGrowthForExport, validateFilters,
  GROWTH_GROUPS, SORT_KEYS, EXPORT_MAX_ROWS, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE, MAX_SORT_LEVELS
};
```

Cập nhật chú thích đầu file: sau dòng `// TOAN BO ket qua.` thêm một dòng `// Sap xep nhieu cap: tham so sorts = "khoa:chieu,khoa:chieu" (toi da 4 cap), uu tien hon sort/dir cu.`

- [ ] **Step 5: Chạy test, xác nhận đạt**

Run: `node --test dashboard/productCustomerGrowthRepository.test.js`
Expected: PASS toàn bộ (kể cả các test cũ: `sort`/`dir` cũ và mặc định không đổi).

- [ ] **Step 6: Commit**

```bash
git add server/dashboard/productCustomerGrowthRepository.js server/dashboard/productCustomerGrowthRepository.test.js
git commit -m "feat(hang-hoa): repository ho tro sap xep nhieu cap (sorts)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Route — chuyển tiếp `sorts`

**Files:**
- Modify: `server/routes.js:466-467`
- Test: `server/dashboard/productCustomerGrowthRoutes.test.js:83-90`

**Interfaces:**
- Consumes: `getProductCustomerGrowth({…, sorts})` từ Task 1.
- Produces: `GET /api/product-report/customer-growth?sorts=customer_name:asc,share:desc` chuyển `sorts` nguyên chuỗi vào repository; lỗi 400 từ repository vẫn trả `{ error }` 400.

- [ ] **Step 1: Viết test thất bại**

Trong `server/dashboard/productCustomerGrowthRoutes.test.js`, thay toàn bộ test `'200: chuyen dung tham so query sang repository'` bằng:

```js
test('200: chuyen dung tham so query sang repository (ke ca sorts)', async () => {
  calls.length = 0;
  nextError = null;
  const res = await call({ product: 'binh', customer: 'hanh', growth: 'check', sort: 'growth', dir: 'asc', sorts: 'customer_name:asc,share:desc', page: '2', pageSize: '25' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.available, true);
  assert.deepEqual(calls.at(-1), {
    product: 'binh', customer: 'hanh', growth: 'check', sort: 'growth', dir: 'asc', sorts: 'customer_name:asc,share:desc', page: '2', pageSize: '25'
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

Run: `node --test dashboard/productCustomerGrowthRoutes.test.js`
Expected: FAIL — `calls.at(-1)` thiếu khóa `sorts`.

- [ ] **Step 3: Cài đặt**

Trong `server/routes.js`, thay hai dòng của route:

```js
    const { product, customer, growth, sort, dir, page, pageSize } = req.query;
    res.status(200).json(await getProductCustomerGrowth({ product, customer, growth, sort, dir, page, pageSize }));
```

bằng:

```js
    const { product, customer, growth, sort, dir, sorts, page, pageSize } = req.query;
    res.status(200).json(await getProductCustomerGrowth({ product, customer, growth, sort, dir, sorts, page, pageSize }));
```

Sửa chú thích phía trên route: thay `sap xep, phan trang o SQL.` thành `sap xep (1 cot qua sort/dir hoac nhieu cap qua sorts=khoa:chieu,...), phan trang o SQL.`

- [ ] **Step 4: Chạy test, xác nhận đạt**

Run: `node --test dashboard/productCustomerGrowthRoutes.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes.js server/dashboard/productCustomerGrowthRoutes.test.js
git commit -m "feat(hang-hoa): route customer-growth nhan tham so sorts

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Xuất file — `context.sorts`

**Files:**
- Modify: `server/dashboard/exportService.js:497-512` (`growthFiltersFromContext`), chú thích `:1199-1200`
- Test: `server/dashboard/exportProductCustomerGrowth.test.js`

**Interfaces:**
- Consumes: `repository.getProductCustomerGrowthForExport({…, sorts})`, `repository.validateFilters` từ Task 1.
- Produces: `context.sorts` (chuỗi `khóa:chiều,…`) được kiểm bằng `validateFilters` trước khi xin slot (sai → 400 `EXPORT_INVALID_REQUEST`) và dùng để sắp xếp file. `context.sortKey` / `sortDir` cũ vẫn được nhận; có `sorts` thì `sorts` thắng.

- [ ] **Step 1: Viết test thất bại**

Trong `server/dashboard/exportProductCustomerGrowth.test.js`:

(a) Trong test `'bo loc o ngu canh bi kiem tra truoc khi xin slot: sai -> 400'`, thay mảng `for (const context of [...])` bằng:

```js
  for (const context of [
    { growthGroup: 'xxx' }, { productQuery: 'x'.repeat(201) }, { customerQuery: 5 }, { sortKey: 'constructor' }, { sortDir: 'up', sortKey: 'revenue' },
    { sorts: 'revenue:up' }, { sorts: 'nope:asc' }, { sorts: 'revenue:asc,revenue:desc' }, { sorts: 5 },
    { sorts: 'product_name:asc,customer_name:asc,revenue:asc,share:asc,growth:asc' }
  ]) {
```

và thêm ngay sau lệnh `await exportService.getExportFields(payload({ context: { growthGroup: 'lost' } }), 'Hà Nội', ALLOWED);`:

```js
  await exportService.getExportFields(payload({ context: { sorts: 'customer_name:asc,share:desc' } }), 'Hà Nội', ALLOWED);
```

(b) Trong test `'dataset: ap dung dung bo loc + sap xep cua man hinh; …'`, thêm ngay sau dòng `assert.deepEqual((await names({ context: { sortKey: 'growth', sortDir: 'asc' } })).slice(0, 3), …);`:

```js
    // Sap xep nhieu cap: ten hang giam dan (Cốc sứ truoc Bình giữ nhiệt) roi DS giam dan trong tung hang.
    assert.deepEqual(await names({ context: { sorts: 'product_name:desc,revenue:desc' } }),
      ['Khách Mất', 'Khách H', 'Khách B|<b>', 'Khách A', 'Khách mới D']);
    assert.deepEqual(await names({ context: { sorts: 'product_name:desc,revenue:desc', sortKey: 'growth', sortDir: 'asc' } }),
      ['Khách Mất', 'Khách H', 'Khách B|<b>', 'Khách A', 'Khách mới D'], 'sorts thang sortKey/sortDir');
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

Run: `node --test dashboard/exportProductCustomerGrowth.test.js`
Expected: FAIL — `context.sorts` đang bị bỏ qua (không ném 400, thứ tự sai).

- [ ] **Step 3: Cài đặt**

Trong `growthFiltersFromContext` (`server/dashboard/exportService.js`), thêm ngay trên dòng `if (typeof filters.product === 'string') filters.product = filters.product.trim();`:

```js
  if (source.sorts !== undefined && source.sorts !== '') filters.sorts = source.sorts; // nhieu cap: thang sortKey/sortDir
```

Sửa chú thích ở `buildProductCustomerGrowthDataset` (`// sap xep cua man hinh (context.sortKey / sortDir).`) thành `// sap xep cua man hinh (context.sorts nhieu cap, hoac sortKey / sortDir cu).`

- [ ] **Step 4: Chạy test, xác nhận đạt**

Run: `node --test dashboard/exportProductCustomerGrowth.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/dashboard/exportService.js server/dashboard/exportProductCustomerGrowth.test.js
git commit -m "feat(hang-hoa): xuat file bang khach theo san pham theo sap xep nhieu cap

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Frontend — hàm thuần `nextSorts`, `formatSorts`, `buildQuery`, `exportContext`

**Files:**
- Modify: `server/public/product-customer-growth.js:10-26` (hằng số), `:139-183` (`buildQuery`, `nextSort`, `exportContext`), `:185-189` (`helpers`)
- Test: `server/test/frontend/product-customer-growth.test.js:101-127`

**Interfaces:**
- Consumes: `COLUMNS` (mỗi cột có `sort`), `GROWTH_VALUES` có sẵn trong file.
- Produces (xuất qua `helpers`):
  - `MAX_SORT_LEVELS` = 4.
  - `nextSorts(current: Array<{sort, dir}>, key: string): Array<{sort, dir}>` — mảng mới, không sửa mảng cũ.
  - `formatSorts(sorts): string` — `"customer_name:asc,share:desc"`, `''` khi rỗng; bỏ phần tử sai khóa/chiều.
  - `buildQuery({…, sorts})` — thêm `sorts=<formatSorts>` khi khác rỗng, **bỏ** `sort`/`dir`.
  - `exportContext({…, sorts})` — thêm `context.sorts` (chuỗi) khi có cấp; **bỏ** `sortKey`/`sortDir`.
  - `nextSort` cũ bị **xóa**; `sortAction` giữ nguyên.

- [ ] **Step 1: Cập nhật / viết test thất bại**

Trong `server/test/frontend/product-customer-growth.test.js`:

(a) Thay toàn bộ test `'buildQuery: …'` bằng:

```js
test('buildQuery: bo tham so rong; growth=all khong gui; sorts gui dang khoa:chieu; tran pageSize 200', () => {
  assert.equal(H.buildQuery({}), '');
  assert.equal(H.buildQuery({ product: ' binh ', customer: 'Hạnh', growth: 'check', sorts: [{ sort: 'growth', dir: 'asc' }], page: 2, pageSize: 100 }),
    'product=binh&customer=H%E1%BA%A1nh&growth=check&sorts=growth%3Aasc&page=2&pageSize=100');
  assert.equal(H.buildQuery({ growth: 'all', sorts: [{ sort: 'customer_name', dir: 'asc' }, { sort: 'share', dir: 'desc' }], page: 1, pageSize: 500 }),
    'sorts=customer_name%3Aasc%2Cshare%3Adesc&page=1&pageSize=200');
  assert.equal(H.buildQuery({ growth: 'bad', sorts: [] }), '');
  assert.equal(H.buildQuery({ growth: 'lost' }), 'growth=lost');
  assert.equal(H.buildQuery({ sorts: [{ sort: 'khong-co', dir: 'asc' }, { sort: 'revenue', dir: 'up' }] }), '', 'cap sai bi bo');
});
```

(b) Thay toàn bộ test `'nextSort: …'` bằng:

```js
test('nextSorts: them cap -> tang -> giam -> go; toi da 4 cap thi thay cap cuoi; khong sua mang cu; formatSorts; sortAction', () => {
  const customer = { sort: 'customer_name', dir: 'asc' };
  assert.deepEqual(H.nextSorts([], 'growth'), [{ sort: 'growth', dir: 'asc' }]);
  assert.deepEqual(H.nextSorts(undefined, 'growth'), [{ sort: 'growth', dir: 'asc' }]);
  assert.deepEqual(H.nextSorts([customer], 'share'), [customer, { sort: 'share', dir: 'asc' }], 'cot moi cong don vao cuoi');
  const two = [customer, { sort: 'share', dir: 'asc' }];
  assert.deepEqual(H.nextSorts(two, 'share'), [customer, { sort: 'share', dir: 'desc' }]);
  assert.deepEqual(H.nextSorts(two, 'customer_name'), [{ sort: 'customer_name', dir: 'desc' }, { sort: 'share', dir: 'asc' }], 'doi chieu cap dau, giu thu tu');
  assert.deepEqual(H.nextSorts([customer, { sort: 'share', dir: 'desc' }], 'share'), [customer], 'giam dan -> go cap');
  assert.deepEqual(H.nextSorts([customer, { sort: 'share', dir: 'asc' }], 'customer_name').length, 2);
  assert.deepEqual(H.nextSorts([{ sort: 'customer_name', dir: 'desc' }, { sort: 'share', dir: 'asc' }], 'customer_name'), [{ sort: 'share', dir: 'asc' }], 'go cap dau -> cap sau don len');
  assert.equal(H.MAX_SORT_LEVELS, 4);
  const four = [{ sort: 'product_name', dir: 'asc' }, customer, { sort: 'revenue', dir: 'asc' }, { sort: 'share', dir: 'asc' }];
  assert.deepEqual(H.nextSorts(four, 'growth'), [four[0], four[1], four[2], { sort: 'growth', dir: 'asc' }], 'day 4 cap: thay cap cuoi');
  const snapshot = JSON.stringify(two);
  H.nextSorts(two, 'share');
  assert.equal(JSON.stringify(two), snapshot, 'khong sua mang dau vao');
  assert.equal(H.formatSorts([customer, { sort: 'share', dir: 'desc' }]), 'customer_name:asc,share:desc');
  assert.equal(H.formatSorts([]), '');
  assert.equal(H.formatSorts(null), '');
  assert.equal(H.formatSorts([{ sort: 'nope', dir: 'asc' }, { sort: 'growth', dir: 'asc' }]), 'growth:asc');
  assert.equal(H.sortAction('none'), 'Sắp xếp tăng dần');
  assert.equal(H.sortAction('ascending'), 'Sắp xếp giảm dần');
  assert.equal(H.sortAction('descending'), 'Bỏ sắp xếp');
});
```

(c) Thay toàn bộ test `'exportContext: …'` bằng:

```js
test('exportContext: dung bo loc dang ap dung, gui sorts nhieu cap, mac dinh khong gui sap xep', () => {
  assert.deepEqual(H.exportContext({ product: ' binh ', customer: '', growth: 'check', sorts: [{ sort: 'growth', dir: 'asc' }] }),
    { context: { productQuery: 'binh', customerQuery: '', growthGroup: 'check', sorts: 'growth:asc' } });
  assert.deepEqual(H.exportContext({ sorts: [{ sort: 'customer_name', dir: 'asc' }, { sort: 'share', dir: 'desc' }] }),
    { context: { productQuery: '', customerQuery: '', growthGroup: 'all', sorts: 'customer_name:asc,share:desc' } });
  assert.deepEqual(H.exportContext({}), { context: { productQuery: '', customerQuery: '', growthGroup: 'all' } });
  assert.deepEqual(H.exportContext({ growth: 'bad', sorts: [] }), { context: { productQuery: '', customerQuery: '', growthGroup: 'all' } });
  assert.equal(H.exportContext({ growth: 'lost' }).context.growthGroup, 'lost');
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

Run (từ `server/`): `node --test test/frontend/product-customer-growth.test.js`
Expected: FAIL — `H.nextSorts is not a function`, `buildQuery` còn trả `sort=…`.

- [ ] **Step 3: Cài đặt hàm thuần**

Trong `server/public/product-customer-growth.js`:

(a) Dưới dòng `const GROWTH_VALUES = …;` thêm:

```js
  const MAX_SORT_LEVELS = 4;
  const SORT_KEYS = COLUMNS.map(function (column) { return column.sort; });
```

(b) Thay hàm `buildQuery` phần sắp xếp: xóa khối

```js
    if (p.sort) {
      out.set('sort', p.sort);
      if (p.dir === 'asc' || p.dir === 'desc') out.set('dir', p.dir);
    }
```

và thay bằng

```js
    const sorts = formatSorts(p.sorts);
    if (sorts) out.set('sorts', sorts);
```

Sửa chú thích trên `buildQuery`: `dir chỉ đi kèm sort` → `sorts = "khóa:chiều,khóa:chiều" (nhiều cấp)`.

(c) Thêm ngay trên `// Chuỗi truy vấn:` (trên `buildQuery`):

```js
  // Giữ cấp hợp lệ (khóa thuộc cột của bảng, chiều asc/desc), tối đa MAX_SORT_LEVELS; luôn trả mảng mới.
  function cleanSorts(list) {
    return (Array.isArray(list) ? list : []).filter(function (level) {
      return level && SORT_KEYS.indexOf(level.sort) >= 0 && (level.dir === 'asc' || level.dir === 'desc');
    }).slice(0, MAX_SORT_LEVELS).map(function (level) { return { sort: level.sort, dir: level.dir }; });
  }

  // [{sort:'customer_name',dir:'asc'},…] → "customer_name:asc,…" (tham số sorts của API và context.sorts của xuất file); rỗng → "".
  function formatSorts(list) {
    return cleanSorts(list).map(function (level) { return level.sort + ':' + level.dir; }).join(',');
  }
```

(d) Thay toàn bộ hàm `nextSort` (và chú thích của nó) bằng:

```js
  // Bấm tiêu đề cột (cộng dồn kiểu Excel): cột chưa có → thêm vào cuối, tăng dần (đã đủ MAX_SORT_LEVELS cấp thì thay cấp cuối);
  // cột đã có → tăng dần → giảm dần → gỡ khỏi danh sách (các cấp còn lại giữ thứ tự). Không bao giờ sửa mảng đầu vào.
  function nextSorts(current, key) {
    const list = cleanSorts(current);
    const index = list.findIndex(function (level) { return level.sort === key; });
    if (index < 0) return list.slice(0, MAX_SORT_LEVELS - 1).concat({ sort: key, dir: 'asc' });
    if (list[index].dir === 'asc') {
      return list.map(function (level, i) { return i === index ? { sort: level.sort, dir: 'desc' } : level; });
    }
    return list.filter(function (level, i) { return i !== index; });
  }
```

(e) Trong `exportContext`, thay khối

```js
    if (s.sort) {
      context.sortKey = s.sort;
      context.sortDir = s.dir === 'asc' ? 'asc' : 'desc';
    }
```

bằng

```js
    const sorts = formatSorts(s.sorts);
    if (sorts) context.sorts = sorts;
```

Sửa chú thích của `exportContext` nếu có nhắc `sortKey`.

(f) Trong object `helpers`, thay `nextSort: nextSort` bằng `nextSorts: nextSorts, formatSorts: formatSorts, MAX_SORT_LEVELS: MAX_SORT_LEVELS`.

> Lưu ý: sau bước này phần giao diện (cùng file) còn dùng `state.sort` / `state.dir` / `nextSort` nên **trình duyệt chưa chạy đúng** cho tới Task 5. Chỉ chạy test hàm thuần ở bước 4; các test hành vi DOM cũ sẽ đỏ tạm thời và được sửa trong Task 5.

- [ ] **Step 4: Chạy test hàm thuần, xác nhận đạt**

Run: `node --test --test-name-pattern="buildQuery|nextSorts|exportContext" test/frontend/product-customer-growth.test.js`
Expected: PASS cho 3 test trên (các test DOM khác có thể đỏ, sẽ sửa ở Task 5).

- [ ] **Step 5: Commit**

```bash
git add server/public/product-customer-growth.js server/test/frontend/product-customer-growth.test.js
git commit -m "feat(hang-hoa): ham thuan sap xep nhieu cap (nextSorts, formatSorts, buildQuery, exportContext)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Frontend — giao diện nhiều cấp (state, tiêu đề, nút "Xóa sắp xếp")

**Files:**
- Modify: `server/public/product-customer-growth.js` (`freshState`, `renderHeader`, `renderMeta`, `exportState`, `fetchPage`, `onSortClick`, `init`)
- Modify: `server/public/index.html:55`, `:4535-4545`, `:5518`, chú thích `:4510-4512`
- Modify: `server/public/product-customer-growth.css`
- Test: `server/test/frontend/product-customer-growth.test.js`

**Interfaces:**
- Consumes: `nextSorts`, `formatSorts`, `buildQuery({sorts})`, `exportContext({sorts})` từ Task 4.
- Produces: `state.sorts: Array<{sort, dir}>`; nút `#pcgClearSort` (ẩn khi `sorts` rỗng, chữ `Xóa sắp xếp (N)`); `<span class="sort-level">N</span>` trong `.sort-button` khi có từ 2 cấp; `window.TKSProductCustomerGrowth.exportState()` trả `context.sorts`.

- [ ] **Step 1: Cập nhật / viết test thất bại**

Trong `server/test/frontend/product-customer-growth.test.js`:

(a) Trong test cấu trúc `'tieu de bang: 8 cot khop COLUMNS, …'`, sau dòng `['pcgProductSearch', 'pcgCustomerSearch', 'pcgGrowth', 'pcgExportButton', 'pcgPageSize'].forEach(…)` thêm:

```js
  const clear = pageDoc.getElementById('pcgClearSort');
  assert.ok(clear, 'co nut Xoa sap xep');
  assert.equal(clear.hidden, true, 'an khi chua sap xep');
  assert.equal(clear.type, 'button');
  assert.ok(clear.closest('.pcg-filters'));
```

(b) Thay toàn bộ test `'sap xep o may chu: …'` bằng:

```js
test('sap xep o may chu: ▲▼ -> ▼ tang -> ▲ giam -> bo; nut bao hanh dong ke tiep; ve trang 1', async () => {
  const p = createWidget();
  try {
    p.w.TKSProductCustomerGrowth.load(true);
    p.answer(0, report([sampleRow('Khách A')]));
    await settle();
    const th = p.w.document.querySelector('th[data-column-key="growth"]');
    th.querySelector('.sort-button').click();
    assert.equal(p.params(1).get('sorts'), 'growth:asc');
    assert.equal(p.params(1).get('sort'), null, 'khong con gui sort/dir cu');
    assert.equal(p.params(1).get('page'), '1');
    p.answer(1, report([sampleRow('Khách A')], { sort: 'growth', dir: 'asc' }));
    await settle();
    assert.equal(th.getAttribute('aria-sort'), 'ascending');
    assert.equal(th.querySelector('.sort-indicator').textContent, '▼');
    assert.match(th.querySelector('.sort-button').title, /^Sắp xếp giảm dần theo Tăng trưởng/);
    assert.equal(th.querySelector('.sort-level'), null, 'mot cap thi khong hien so cap');
    th.querySelector('.sort-button').click();
    assert.equal(p.params(2).get('sorts'), 'growth:desc');
    p.answer(2, report([sampleRow('Khách A')], { sort: 'growth', dir: 'desc' }));
    await settle();
    assert.equal(th.getAttribute('aria-sort'), 'descending');
    th.querySelector('.sort-button').click();
    assert.equal(p.params(3).get('sorts'), null, 'bo sap xep -> thu tu mac dinh cua may chu');
    p.answer(3, report([sampleRow('Khách A')]));
    await settle();
    assert.equal(th.getAttribute('aria-sort'), 'none');
  } finally { p.dom.window.close(); }
});

test('sap xep nhieu cap: bam cot thu hai cong don, so cap tren tieu de, doi chieu, go cap, nut Xoa sap xep', async () => {
  const p = createWidget();
  try {
    p.w.TKSProductCustomerGrowth.load(true);
    p.answer(0, report([sampleRow('Khách A')]));
    await settle();
    const th = key => p.w.document.querySelector('th[data-column-key="' + key + '"]');
    const level = key => { const el = th(key).querySelector('.sort-level'); return el ? el.textContent : null; };
    // Bam, tra loi, doi cap nhat giao dien; tra ve chi so lan goi API vua gui.
    const click = async key => {
      th(key).querySelector('.sort-button').click();
      const index = p.calls.length - 1;
      p.answer(index, report([sampleRow('Khách A')]));
      await settle();
      return index;
    };
    assert.equal(p.$('pcgClearSort').hidden, true);

    let i = await click('customer');
    assert.equal(p.params(i).get('sorts'), 'customer_name:asc');
    assert.equal(level('customer'), null, 'mot cap thi khong hien so');
    assert.equal(p.$('pcgClearSort').hidden, false);
    assert.equal(p.$('pcgClearSort').textContent, 'Xóa sắp xếp (1)');

    i = await click('share');
    assert.equal(p.params(i).get('sorts'), 'customer_name:asc,share:asc', 'bam cot thu hai = cong don');
    assert.equal(p.params(i).get('page'), '1');
    assert.equal(level('customer'), '1');
    assert.equal(level('share'), '2');
    assert.equal(th('customer').getAttribute('aria-sort'), 'ascending');
    assert.equal(th('share').getAttribute('aria-sort'), 'ascending');
    assert.equal(th('revenue').getAttribute('aria-sort'), 'none');
    assert.equal(th('share').querySelector('.sort-button').title, 'Sắp xếp giảm dần theo % của SP (cấp 2)');
    assert.equal(th('share').querySelector('.sort-button').getAttribute('aria-label'), 'Sắp xếp giảm dần theo cột % của SP (cấp 2)');
    assert.equal(p.$('pcgClearSort').textContent, 'Xóa sắp xếp (2)');

    i = await click('share');
    assert.equal(p.params(i).get('sorts'), 'customer_name:asc,share:desc', 'bam lai cot: doi chieu, giu thu tu cap');
    assert.equal(th('share').getAttribute('aria-sort'), 'descending');
    assert.equal(th('share').querySelector('.sort-indicator').textContent, '▲');

    i = await click('share');
    assert.equal(p.params(i).get('sorts'), 'customer_name:asc', 'bam lan ba: go cap khoi danh sach');
    assert.equal(level('customer'), null, 'con 1 cap -> an so cap');
    assert.equal(th('share').getAttribute('aria-sort'), 'none');

    i = await click('growth');
    assert.equal(p.params(i).get('sorts'), 'customer_name:asc,growth:asc');
    assert.deepEqual(JSON.parse(JSON.stringify(p.w.TKSProductCustomerGrowth.exportState())),
      { context: { productQuery: '', customerQuery: '', growthGroup: 'all', sorts: 'customer_name:asc,growth:asc' } });

    p.$('pcgClearSort').click();
    i = p.calls.length - 1;
    assert.equal(p.params(i).get('sorts'), null, 'Xoa sap xep -> thu tu mac dinh');
    assert.equal(p.params(i).get('page'), '1');
    p.answer(i, report([sampleRow('Khách A')]));
    await settle();
    assert.equal(p.$('pcgClearSort').hidden, true);
    ['customer', 'growth'].forEach(key => {
      assert.equal(th(key).getAttribute('aria-sort'), 'none', key);
      assert.equal(level(key), null, key);
    });
    assert.deepEqual(JSON.parse(JSON.stringify(p.w.TKSProductCustomerGrowth.exportState())),
      { context: { productQuery: '', customerQuery: '', growthGroup: 'all' } });
  } finally { p.dom.window.close(); }
});

test('reset(): xoa ca danh sach cap sap xep', async () => {
  const p = createWidget();
  try {
    p.w.TKSProductCustomerGrowth.load(true);
    p.answer(0, report([sampleRow('Khách A')]));
    await settle();
    p.w.document.querySelector('th[data-column-key="customer"] .sort-button').click();
    p.answer(1, report([sampleRow('Khách A')]));
    await settle();
    assert.equal(p.$('pcgClearSort').hidden, false);
    p.w.TKSProductCustomerGrowth.reset();
    assert.equal(p.$('pcgClearSort').hidden, true);
    assert.equal(p.w.document.querySelector('th[data-column-key="customer"]').getAttribute('aria-sort'), 'none');
  } finally { p.dom.window.close(); }
});
```

(c) Trong test `'nut Xuat file: …'`, thay khối deepEqual của `exportState()` (hai dòng `assert.deepEqual(JSON.parse(…exportState())),` + dòng context) bằng:

```js
    assert.deepEqual(JSON.parse(JSON.stringify(p.w.TKSProductCustomerGrowth.exportState())),
      { context: { productQuery: '', customerQuery: '', growthGroup: 'check', sorts: 'growth:asc' } });
```

(d) Trong test `'CSS: …'`, thêm trước dòng `assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);`:

```js
  assert.match(css, /\.pcg-table thead \.sort-level\s*\{[^}]*position:\s*absolute/);
  assert.match(css, /\.pcg-clear-sort\[hidden\]\s*\{[^}]*display:\s*none/);
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

Run: `node --test test/frontend/product-customer-growth.test.js`
Expected: FAIL — không có `#pcgClearSort`, `state.sorts` chưa tồn tại, CSS chưa có.

- [ ] **Step 3: Cài đặt giao diện trong `product-customer-growth.js`**

(a) `freshState()`: thay `product: '', customer: '', growth: 'all', sort: '', dir: '', page: 1, pageSize: 50,` bằng `product: '', customer: '', growth: 'all', sorts: [], page: 1, pageSize: 50,`.

(b) Thay toàn bộ hàm `renderHeader` bằng:

```js
  function renderHeader() {
    const d = state.data;
    const periods = d && d.available && Array.isArray(d.periods) ? d.periods : [];
    const multi = state.sorts.length > 1;
    document.querySelectorAll('#pcgTable th.sortable[data-sort]').forEach(function (th) {
      const column = COLUMNS.find(function (c) { return c.key === th.dataset.columnKey; });
      const index = state.sorts.findIndex(function (level) { return level.sort === th.dataset.sort; });
      const active = index >= 0;
      const mode = active ? (state.sorts[index].dir === 'desc' ? 'descending' : 'ascending') : 'none';
      const level = active && multi ? String(index + 1) : '';
      if (th.getAttribute('aria-sort') !== mode) th.setAttribute('aria-sort', mode);
      th.classList.toggle('sort-active', active);
      const mark = th.querySelector('.sort-indicator');
      if (mark && mark.textContent !== SORT_GLYPH[mode]) mark.textContent = SORT_GLYPH[mode];
      const button = th.querySelector('.sort-button');
      if (!button) return;
      // Số cấp (1, 2, …) chỉ hiện khi có từ 2 cột sắp xếp trở lên.
      let badge = button.querySelector('.sort-level');
      if (level && !badge) {
        badge = document.createElement('span');
        badge.className = 'sort-level';
        badge.setAttribute('aria-hidden', 'true');
        button.insertBefore(badge, mark || null);
      }
      if (badge && !level) badge.remove();
      else if (badge && badge.textContent !== level) badge.textContent = level;
      button.classList.toggle('has-level', !!level);
      if (column) {
        const period = column.period ? periods.find(function (p) { return p && p.key === column.period; }) : null;
        const range = period ? formatPeriodRange(period.from, period.to) : '';
        const suffix = level ? ' (cấp ' + level + ')' : '';
        const title = sortAction(mode) + ' theo ' + column.label + (range ? ' (' + range + ')' : '') + suffix;
        const aria = sortAction(mode) + ' theo cột ' + column.label + suffix;
        if (button.title !== title) button.title = title;
        if (button.getAttribute('aria-label') !== aria) button.setAttribute('aria-label', aria);
      }
    });
  }
```

(c) Trong `renderMeta`, thêm ngay trước khối `// Nút Xuất file:`:

```js
    const clearSort = $('pcgClearSort');
    if (clearSort) {
      clearSort.hidden = state.sorts.length === 0;
      const label = 'Xóa sắp xếp (' + state.sorts.length + ')';
      if (clearSort.textContent !== label) clearSort.textContent = label;
    }
```

(d) `exportState()`: thay `exportContext({ product: …, sort: state.sort, dir: state.dir })` thành:

```js
    return exportContext({ product: state.product, customer: state.customer, growth: state.growth, sorts: state.sorts });
```

(e) `fetchPage()`: trong `buildQuery({ … })` thay `sort: state.sort, dir: state.dir,` bằng `sorts: state.sorts,`.

(f) `onSortClick`: thay

```js
    const next = nextSort({ sort: state.sort, dir: state.dir }, th.dataset.sort);
    state.sort = next.sort;
    state.dir = next.dir;
    state.page = 1;
```

bằng

```js
    state.sorts = nextSorts(state.sorts, th.dataset.sort);
    state.page = 1;
```

(g) `init()`: thêm ngay sau `$('pcgTable').tHead.addEventListener('click', onSortClick);`:

```js
    $('pcgClearSort').addEventListener('click', function () {
      state.sorts = [];
      state.page = 1;
      fetchPage();
    });
```

(h) Cập nhật chú thích đầu file: thay `sắp xếp và phân trang đều ở máy chủ trên TOÀN BỘ kết quả.` bằng `sắp xếp (bấm tiêu đề cột nào cũng cộng dồn thêm một cấp, tối đa 4 cấp; bấm lại: tăng → giảm → gỡ; nút "Xóa sắp xếp") và phân trang đều ở máy chủ trên TOÀN BỘ kết quả.` và ở khối `COLUMNS` giữ nguyên.

- [ ] **Step 4: Sửa `index.html`**

(a) Trong `.pcg-filters`, ngay sau thẻ đóng `</label>` của `pcg-growth-filter` (trước `</div>` đóng `.pcg-filters`), thêm:

```html
                  <button type="button" class="btn-secondary pcg-clear-sort" id="pcgClearSort" hidden>Xóa sắp xếp</button>
```

(b) Đổi hai chuỗi phiên bản: `/product-customer-growth.css?v=20261107-3` → `/product-customer-growth.css?v=20261110-1` (dòng 55) và `/product-customer-growth.js?v=20261107-3` → `/product-customer-growth.js?v=20261110-1` (dòng 5518).

(c) Chú thích ngay trên `<section … id="product90dSection">`: thay `lọc/sắp xếp/phân trang ở máy chủ.` bằng `lọc/sắp xếp nhiều cấp (cộng dồn)/phân trang ở máy chủ.`

- [ ] **Step 5: Sửa CSS**

Trong `server/public/product-customer-growth.css`, thêm ngay dưới dòng `.pcg-table thead .sort-indicator { … }`:

```css
/* Số cấp sắp xếp (1, 2, …) chỉ hiện khi có từ 2 cột sắp xếp; chừa chỗ hai bên để nhãn vẫn nằm giữa. */
.pcg-table thead .sort-button.has-level { padding: 0 22px; }
.pcg-table thead .sort-level {
  position: absolute; right: 12px; top: 50%; transform: translateY(-50%);
  min-width: 8px; text-align: center; font-size: 10px; font-weight: 700; line-height: 1; color: var(--blue, var(--text));
}
```

và thêm ngay dưới dòng `.pcg-status:empty { display: none; }`:

```css
.pcg-clear-sort { height: 34px; padding: 0 12px; font-size: 12.5px; }
.pcg-clear-sort[hidden] { display: none; }
```

- [ ] **Step 6: Chạy test, xác nhận đạt**

Run: `node --test test/frontend/product-customer-growth.test.js test/frontend/export-ui.test.js`
Expected: PASS toàn bộ (bao gồm các test trang thật, bộ lọc IME, trạng thái lỗi).

- [ ] **Step 7: Kiểm tra bằng mắt trên trình duyệt**

Chạy server local an toàn theo cấu hình `readonly` trong `.claude/launch.json` (xem memory "Chạy server local an toàn với DB thật"), mở tab Hàng hóa → mục 4, và kiểm:
1. Bấm "Khách hàng" rồi "% của SP": các khách xếp A→Z, trong mỗi khách các sản phẩm xếp theo % tăng dần; tiêu đề hiện số `1` / `2`.
2. Bấm "% của SP" lần nữa → đảo chiều; lần ba → gỡ cấp 2, số cấp biến mất.
3. Nút "Xóa sắp xếp (N)" hiện/ẩn đúng và đưa về thứ tự mặc định.
4. Chế độ Tối và màn hình hẹp (≤ 600px) không vỡ tiêu đề; xuất file với 2 cấp ra đúng thứ tự.

- [ ] **Step 8: Commit**

```bash
git add server/public/product-customer-growth.js server/public/product-customer-growth.css server/public/index.html server/test/frontend/product-customer-growth.test.js
git commit -m "feat(hang-hoa): sap xep nhieu cap tren bang Khach hang theo san pham

Bam tieu de cot nao cung cong don them mot cap (toi da 4), hien so cap tren tieu de,
them nut Xoa sap xep.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Tài liệu, kiểm thử tổng và đồ thị mã nguồn

**Files:**
- Modify: `README.md` (khối mô tả `product-customer-growth.js` ở cây thư mục ~dòng 184 và mục cập nhật gần nhất ~dòng 477-479), `server/README.md` (bảng mô tả API `customer-growth`), `CURRENT.md` (thêm mục mới phía trên `## Bảng VT không còn "biến mất" …`, ~dòng 458), `docs/04-planning/implementation_plan.md` (~dòng 651), ngày cập nhật cuối các tài liệu
- Regenerate: `graphify-out/`

**Interfaces:**
- Consumes: toàn bộ thay đổi Task 1–5.
- Produces: tài liệu đồng bộ + đồ thị cập nhật.

- [ ] **Step 1: Cập nhật tài liệu theo skill `update-file`**

Đọc `.agents/skills/update-file/SKILL.md` rồi thực hiện:

- `README.md`: ở dòng mô tả `product-customer-growth.js / .css` (cây thư mục) thêm cụm `, sắp xếp nhiều cấp (bấm tiêu đề cột nào cũng cộng dồn, tối đa 4 cấp, nút "Xóa sắp xếp")`; ở khối cập nhật gần nhất, thêm một đoạn ngắn đứng đầu danh sách (theo đúng định dạng các đoạn kề bên):
  `**Sắp xếp nhiều cấp bảng Khách hàng theo sản phẩm (10/11/2026).** Bảng mục 4 tab Hàng hóa sắp xếp được nhiều cột cùng lúc như Excel: bấm tiêu đề cột nào cũng thêm một cấp (tối đa 4), bấm lại để đổi chiều rồi gỡ, nút "Xóa sắp xếp" về mặc định; tiêu đề hiện số cấp. API nhận thêm \`sorts=khóa:chiều,…\` (\`sort\`/\`dir\` cũ vẫn chạy), xuất file theo đúng thứ tự nhiều cấp. Không migration, không biến môi trường mới. Kiểm thử: \`dashboard/productCustomerGrowthRepository.test.js\`, \`productCustomerGrowthRoutes.test.js\`, \`exportProductCustomerGrowth.test.js\`, \`test/frontend/product-customer-growth.test.js\`.`
- `server/README.md`: ở dòng mô tả `GET /api/product-report/customer-growth` thêm tham số `sorts` (`khóa:chiều` cách nhau dấu phẩy, tối đa 4 cấp, ưu tiên hơn `sort`/`dir`, sai → 400) và việc response có thêm `sorts`.
- `docs/04-planning/implementation_plan.md`: dưới mục `GET /api/product-report/customer-growth` thêm `- [x] Sắp xếp nhiều cấp: tham số \`sorts\` (tối đa 4 cấp), xuất file theo \`context.sorts\`.`
- `CURRENT.md`: thêm mục `## Sắp xếp nhiều cấp bảng Khách hàng theo sản phẩm (10/11/2026)` (3–5 dòng: đã làm gì, tệp chính, kiểm thử, chưa deploy nếu chưa merge) phía trên mục `## Bảng VT không còn "biến mất" …`.
- Cập nhật ngày cập nhật mới nhất (`10/11/2026`) ở cuối các tài liệu vừa sửa, nếu chúng có dòng ngày cuối.
- Không cần sửa `server/db/SCHEMA.md` và `docs/01-brd`, `docs/02-srs` (không đổi schema; nếu SRS có mô tả bảng này thì thêm một câu về sắp xếp nhiều cấp).

- [ ] **Step 2: Chạy toàn bộ test liên quan**

Run (từ `server/`):

```bash
node --test dashboard/productCustomerGrowthRepository.test.js dashboard/productCustomerGrowthRoutes.test.js dashboard/exportProductCustomerGrowth.test.js dashboard/exportService.test.js test/frontend/product-customer-growth.test.js test/frontend/export-ui.test.js
```

Expected: 100% PASS, không lỗi mới. Nếu `exportService.test.js` hay test khác đỏ vì lý do không liên quan (đã đỏ trước khi sửa), ghi rõ trong báo cáo; không được có test nào đỏ do thay đổi này.

- [ ] **Step 3: Cập nhật đồ thị mã nguồn**

Run (từ thư mục gốc worktree): `graphify update .`
Expected: `graphify-out/` được cập nhật, không lỗi.

- [ ] **Step 4: Commit**

```bash
git add README.md server/README.md CURRENT.md docs/04-planning/implementation_plan.md graphify-out
git commit -m "docs(hang-hoa): ghi nhan sap xep nhieu cap bang Khach hang theo san pham

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review (đã chạy)

**Spec coverage**
- Giao diện: cộng dồn, tối đa 4 cấp (thay cấp cuối khi đủ), tăng → giảm → gỡ, số cấp, nút xóa, `aria-sort`/tooltip "(cấp N)", `reset()` → Task 4 (hàm thuần) + Task 5 (DOM, CSS, HTML).
- API/SQL: `sorts`, whitelist, trùng/quá 4/quá dài → 400, `sorts` thắng `sort`/`dir`, `NULLS LAST` + khóa phụ, response thêm `sorts` giữ `sort`/`dir` → Task 1 + Task 2.
- Xuất file: `context.sorts`, kiểm trước khi xin slot, `sortKey`/`sortDir` cũ còn chạy → Task 3 (+ frontend gửi `sorts` ở Task 4/5).
- Kiểm thử và tài liệu: có ở từng task + Task 6.
- Ngoài phạm vi (kéo thả, lưu sort, bảng khác): không có task, đúng spec.

**Placeholder scan:** không còn TBD/TODO; mọi bước code có nội dung đầy đủ. Kỳ vọng của các test sort nhiều cấp đã được tính tay lại theo dữ liệu seed (kể cả trường hợp hòa điểm giữa các cấp).

**Type consistency:** `sorts` là chuỗi `khóa:chiều,…` ở API và `context.sorts`; là mảng `{sort, dir}` trong `state.sorts` và response `sorts`. `formatSorts`/`cleanSorts`/`nextSorts`/`MAX_SORT_LEVELS` dùng nhất quán ở Task 4–5. `parseFilters` trả `sorts` (mảng), `sortKey`, `direction` (chuỗi hoa) như cũ.
