# In phiếu nhặt nhanh hơn — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Giảm thời gian chờ khi kế toán mở đơn → Thay đổi chỉ định → Hủy nhặt → in phiếu trên trang Vòng đời đơn hàng, bằng cách bớt lượt gọi mạng/DB nối tiếp.

**Architecture:** Server Render (Oregon) ↔ Supabase (Singapore) tốn ~170 ms mỗi lượt truy vấn, nên mọi tối ưu là gộp/song song hóa lượt gọi: client tải song song + tải trước hộp chỉ định + Hủy nhặt không tải lại; server gộp truy vấn chỉ định, cho `/candidates` đọc Google Sheet/SĐT sale bản cũ (làm mới nền) và bỏ phần chi tiết Kiot không dùng.

**Tech Stack:** Node.js 24, Express, CommonJS, `pg` (Supabase Postgres), PGlite trong test, `node:test`, JSDOM (test giao diện), Vanilla JS/HTML.

**Spec:** `docs/superpowers/specs/2026-11-03-fast-pick-print-design.md`

## Global Constraints

- Làm trên nhánh `perf/fast-pick-print` (tạo từ `origin/main`). Không push lên `main`; kết thúc bằng PR.
- CommonJS (`require` / `module.exports`), Vanilla JS phía client, không thêm thư viện.
- Không migration, không đổi schema. Không đổi cách khóa / kiểm `version` trong transaction chỉ định / xác nhận / hủy.
- Hình dạng JSON của `/api/shipment/pick*` và `/api/shipment/lifecycle/order-detail` giữ nguyên.
- Chỉ `/candidates` được đọc Sheet / SĐT sale bản cũ (`allowStale: true`). `assign`, `positionScope`, danh sách, xuất Excel, ghi đè trạng thái giữ hành vi cũ.
- Tải trước `/candidates` dùng lại tối đa **30 000 ms**, chỉ một mục (đơn đang xem gần nhất), dùng một lần.
- Cache Google Sheet TTL giữ **15 s**; cache SĐT sale giữ **300 000 ms** (lỗi: thử lại sau 30 000 ms).
- Comment trong code viết tiếng Việt không dấu ở file server (theo code xung quanh), có dấu ở `pick-assign.js` (theo code xung quanh).
- Chạy test một file: `cd server && node --test <file>`; cả bộ: `cd server && npm test` (Node v24: thư mục phải truyền glob, ví dụ `node --test "test/frontend/**/*.test.js"`).
- Commit message kết thúc bằng dòng `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

| File | Trách nhiệm | Task |
|---|---|---|
| `server/sheets/sheetValuesCache.js` (mới) | Cache giá trị tab Sheet theo tên tab, TTL, `allowStale` + làm mới nền, `invalidate` | 1 |
| `server/sheets/sheetValuesCache.test.js` (mới) | Test cache trên | 1 |
| `server/sheets/orderLifecycleSheetsClient.js` | Dùng `sheetValuesCache`, `getValues(name, opts)` | 1 |
| `server/sheets/orderLifecycleHistoryClient.js` | Dùng `sheetValuesCache`, `getValues(name, opts)`, `invalidateCache` | 1 |
| `server/shipment/orderLifecycleRepository.js` | `readAll(opts)` / `readOverrideHistory(opts)` chuyển `allowStale` | 2 |
| `server/shipment/orderLifecycleService.js` | `loadMergedRows(kiot, opts)` / `findMergedOrder(…, { allowStale })` | 2 |
| `server/shipment/kiotOrdersRepository.js` | `readOrderDetail({ lite })` | 3 |
| `server/pickAssignments/pickKiotData.js` | SĐT sale: trả bản cũ + làm mới nền | 4 |
| `server/pickAssignments/pickAssignmentsService.js` | `readLatest` 1 truy vấn + đọc song song; `candidates` song song + SQL gộp; `createOrderLoader` | 5, 6 |
| `server/public/shipment/lifecycle/pick/pick-assign.js` | `attachButton`, `prefetch`, `forgetPrefetch`, Hủy nhặt tại chỗ | 7 |
| `server/public/shipment/lifecycle/index.html` | Tải song song, nút sớm, gọi prefetch, quên prefetch khi đổi trạng thái | 8 |
| `server/routes.js` | `startTiming` cho `/api/shipment/lifecycle`, `/api/shipment/pick` | 9 |
| `server/README.md`, `CURRENT.md` | Tài liệu | 9 |

---

### Task 1: Cache Google Sheet có `allowStale`

**Files:**
- Create: `server/sheets/sheetValuesCache.js`
- Create: `server/sheets/sheetValuesCache.test.js`
- Modify: `server/sheets/orderLifecycleSheetsClient.js:53-84` (`sheetCache`, `getValues`)
- Modify: `server/sheets/orderLifecycleHistoryClient.js:53-76` (`cache`, `invalidateCache`, `getValues`)

**Interfaces:**
- Produces: `createSheetValuesCache({ ttlMs, load, now?, onBackgroundError? }) → { get(sheetName, { allowStale }?) → Promise<any[][]>, invalidate() }`.
- Produces: `orderLifecycleSheetsClient.getValues(sheetName, { allowStale }?)`, `orderLifecycleHistoryClient.getValues(sheetName, { allowStale }?)` (Task 2 dùng).

- [ ] **Step 1: Viết test (đỏ)** — `server/sheets/sheetValuesCache.test.js`

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSheetValuesCache } = require('./sheetValuesCache');

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup() {
  let time = 0;
  const loads = [];
  const cache = createSheetValuesCache({
    ttlMs: 15000,
    now: () => time,
    load: name => { const d = deferred(); loads.push({ name, ...d }); return d.promise; }
  });
  return { cache, loads, advance: ms => { time += ms; } };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('con han: tra cache, khong doc lai; het han khong allowStale: cho ban moi', async () => {
  const { cache, loads, advance } = setup();
  const first = cache.get('A');
  loads[0].resolve([['v1']]);
  assert.deepEqual(await first, [['v1']]);
  assert.deepEqual(await cache.get('A'), [['v1']]);
  assert.equal(loads.length, 1);
  advance(15001);
  const second = cache.get('A');
  assert.equal(loads.length, 2, 'het han thi doc lai');
  loads[1].resolve([['v2']]);
  assert.deepEqual(await second, [['v2']]);
});

test('allowStale: het han tra ngay ban cu, lam moi nen dung 1 luot; xong thi dung ban moi', async () => {
  const { cache, loads, advance } = setup();
  const first = cache.get('A');
  loads[0].resolve([['v1']]);
  await first;
  advance(15001);
  assert.deepEqual(await cache.get('A', { allowStale: true }), [['v1']], 'khong cho mang');
  assert.deepEqual(await cache.get('A', { allowStale: true }), [['v1']]);
  assert.equal(loads.length, 2, 'chi 1 luot lam moi nen');
  loads[1].resolve([['v2']]);
  await flush();
  assert.deepEqual(await cache.get('A', { allowStale: true }), [['v2']]);
});

test('allowStale nhung chua co du lieu: cho doc nhu thuong', async () => {
  const { cache, loads } = setup();
  const pending = cache.get('A', { allowStale: true });
  assert.equal(loads.length, 1);
  loads[0].resolve([['v1']]);
  assert.deepEqual(await pending, [['v1']]);
});

test('lam moi nen loi: giu ban cu, bao onBackgroundError, lan sau thu lai', async () => {
  let time = 0;
  const errors = [];
  const results = [[['v1']], new Error('quota'), [['v3']]];
  let calls = 0;
  const cache = createSheetValuesCache({
    ttlMs: 15000, now: () => time, onBackgroundError: e => errors.push(e.message),
    load: async () => { const r = results[calls++]; if (r instanceof Error) throw r; return r; }
  });
  await cache.get('A');
  time = 15001;
  assert.deepEqual(await cache.get('A', { allowStale: true }), [['v1']]);
  await flush();
  assert.deepEqual(errors, ['quota']);
  assert.deepEqual(await cache.get('A', { allowStale: true }), [['v1']], 'van ban cu');
  await flush();
  assert.equal(calls, 3, 'thu lai');
  assert.deepEqual(await cache.get('A', { allowStale: true }), [['v3']]);
});

test('khong allowStale + doc loi: nem loi; invalidate bo ca luot doc dang chay', async () => {
  const { cache, loads } = setup();
  const failing = cache.get('A');
  loads[0].reject(new Error('down'));
  await assert.rejects(failing, /down/);
  const before = cache.get('B');
  cache.invalidate();
  loads[1].resolve([['truoc khi ghi']]);
  await before;
  const after = cache.get('B');
  assert.equal(loads.length, 3, 'sau invalidate phai doc lai, khong dung ket qua cua luot truoc');
  loads[2].resolve([['sau khi ghi']]);
  assert.deepEqual(await after, [['sau khi ghi']]);
});
```

- [ ] **Step 2: Chạy test, xác nhận đỏ**

Run: `cd server && node --test sheets/sheetValuesCache.test.js`
Expected: FAIL — `Cannot find module './sheetValuesCache'`.

- [ ] **Step 3: Viết `server/sheets/sheetValuesCache.js`**

```js
'use strict';

// Cache gia tri tung tab Google Sheet (mang 2 chieu) theo ten tab, TTL ngan.
// - Con han: tra cache. Het han: doc lai (moi tab chi 1 luot doc dang chay, cac request khac cho chung).
// - allowStale: het han nhung con ban cu -> tra NGAY ban cu va lam moi o nen (request khong phai cho Google).
//   Loi khi lam moi nen chi bao onBackgroundError, giu ban cu, lan sau thu lai.
// - invalidate(): bo het (ke ca ket qua cua luot doc dang chay) — dung ngay sau khi chinh server ghi sheet.
function createSheetValuesCache({ ttlMs, load, now = () => Date.now(), onBackgroundError = () => {} }) {
  let entries = new Map(); // sheetName -> { data, expiresAt, loading }

  function refresh(sheetName) {
    const owner = entries;
    const previous = owner.get(sheetName);
    const loading = Promise.resolve().then(() => load(sheetName)).then(values => {
      if (owner.get(sheetName)?.loading === loading) owner.set(sheetName, { data: values, expiresAt: now() + ttlMs, loading: null });
      return values;
    }, error => {
      const current = owner.get(sheetName);
      if (current?.loading === loading) {
        if (current.data) owner.set(sheetName, { data: current.data, expiresAt: 0, loading: null });
        else owner.delete(sheetName);
      }
      throw error;
    });
    owner.set(sheetName, { data: previous ? previous.data : null, expiresAt: 0, loading });
    return loading;
  }

  async function get(sheetName, { allowStale = false } = {}) {
    const cached = entries.get(sheetName);
    if (cached && cached.data && now() < cached.expiresAt) return cached.data;
    if (allowStale && cached && cached.data) {
      if (!cached.loading) refresh(sheetName).catch(onBackgroundError);
      return cached.data;
    }
    if (cached && cached.loading) return cached.loading;
    return refresh(sheetName);
  }

  function invalidate() { entries = new Map(); }

  return { get, invalidate };
}

module.exports = { createSheetValuesCache };
```

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `cd server && node --test sheets/sheetValuesCache.test.js`
Expected: PASS (5 test).

- [ ] **Step 5: Dùng cache trong `orderLifecycleSheetsClient.js`** — thay khối từ `const sheetCache = new Map();` tới hết hàm `getValues` (dòng 53-83) bằng:

```js
const { createSheetValuesCache } = require('./sheetValuesCache');

const valuesCache = createSheetValuesCache({
  ttlMs: CACHE_TTL_MS,
  load: sheetName => {
    const spreadsheetId = requireSpreadsheetId();
    return getSheetsApi().then(sheets => sheets.spreadsheets.values.get({
      spreadsheetId,
      range: quoteSheetName(sheetName),
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING'
    }, { timeout: API_TIMEOUT_MS })).then(res => res.data.values || []);
  },
  onBackgroundError: err => console.warn('[orderLifecycleSheetsClient] lam moi nen loi:', err.message)
});

/**
 * Doc toan bo du lieu cua 1 tab, tra ve mang 2 chieu (giong sheetsClient.js).
 * options.allowStale: cache het han van tra ban cu ngay va lam moi o nen (hop Chi dinh vi tri dung).
 */
function getValues(sheetName, options) {
  return valuesCache.get(sheetName, options);
}
```

Giữ nguyên `module.exports = { getValues };`. Đặt `require('./sheetValuesCache')` cạnh các `require` đầu file thay vì giữa file.

- [ ] **Step 6: Dùng cache trong `orderLifecycleHistoryClient.js`** — thay `let cache = null; …`, `invalidateCache` và `getValues` (dòng 53-76) bằng:

```js
const valuesCache = createSheetValuesCache({
  ttlMs: CACHE_TTL_MS,
  load: async sheetName => {
    const spreadsheetId = requireSpreadsheetId();
    const sheets = await getSheetsApi();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: quoteSheetName(sheetName),
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING'
    }, { timeout: API_TIMEOUT_MS });
    return res.data.values || [];
  },
  onBackgroundError: err => console.warn('[orderLifecycleHistoryClient] lam moi nen loi:', err.message)
});

function invalidateCache() {
  valuesCache.invalidate();
}

/**
 * Doc toan bo du lieu tab "Lich su cap nhat" (mang 2 chieu, dong 1 la header).
 * options.allowStale: xem orderLifecycleSheetsClient.getValues. Sau moi lan ghi cache bi xoa nen luon doc ban moi.
 */
function getValues(sheetName, options) {
  return valuesCache.get(sheetName, options);
}
```

Thêm `const { createSheetValuesCache } = require('./sheetValuesCache');` cạnh `require('../config')`. Các chỗ đang gọi `invalidateCache()` giữ nguyên.

- [ ] **Step 7: Chạy test liên quan**

Run: `cd server && node --test sheets/sheetValuesCache.test.js shipment/orderLifecycleRepository.test.js shipment/orderLifecycleService.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/sheets/sheetValuesCache.js server/sheets/sheetValuesCache.test.js server/sheets/orderLifecycleSheetsClient.js server/sheets/orderLifecycleHistoryClient.js
git commit -m "perf(sheets): cache tab Vong doi co allowStale (tra ban cu, lam moi nen)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Chuyển `allowStale` qua repository / service Vòng đời

**Files:**
- Modify: `server/shipment/orderLifecycleRepository.js:175-257` (`readAccountingTab`, `readTab`, `readOptionalTab`, `readAll`, `readOverrideHistory`)
- Modify: `server/shipment/orderLifecycleService.js:488-504, 567-571` (`loadMergedRows`, `findMergedOrder`)
- Test: `server/shipment/orderLifecycleService.test.js`

**Interfaces:**
- Consumes: `client.getValues(name, { allowStale })`, `historyClient.getValues(name, { allowStale })` (Task 1).
- Produces: `findMergedOrder(branch, orderCode, { kiot, allowStale })` (Task 6 dùng).

- [ ] **Step 1: Viết test (đỏ)** — thêm vào cuối `server/shipment/orderLifecycleService.test.js`:

```js
test('findMergedOrder: allowStale chuyen xuong readAll + readOverrideHistory; mac dinh false', async () => {
  const ctx = freshService([]);
  const repoExports = require.cache[require.resolve('./orderLifecycleRepository')].exports;
  const seen = [];
  repoExports.readAll = async opts => { seen.push(['all', opts]); return []; };
  repoExports.readOverrideHistory = async opts => { seen.push(['history', opts]); return []; };
  try {
    const kiot = fakeKiot({ ok: true, orders: [kiotOrder({ code: 'DH000001', branch: 'HN' })] });
    await ctx.service.findMergedOrder('HN', 'DH000001', { kiot, allowStale: true });
    await ctx.service.findMergedOrder('HN', 'DH000001', { kiot });
    assert.deepEqual(seen, [
      ['all', { allowStale: true }], ['history', { allowStale: true }],
      ['all', { allowStale: false }], ['history', { allowStale: false }]
    ]);
  } finally {
    ctx.restore();
  }
});
```

- [ ] **Step 2: Chạy, xác nhận đỏ**

Run: `cd server && node --test shipment/orderLifecycleService.test.js`
Expected: FAIL ở test mới (`seen` chứa `undefined` thay vì `{ allowStale: … }`).

- [ ] **Step 3: Sửa `orderLifecycleService.js`**

```js
async function loadMergedRows(kiot, { allowStale = false } = {}) {
  const [records, historyRows, kiotResult] = await Promise.all([
    repo.readAll({ allowStale }),
    repo.readOverrideHistory({ allowStale }),
    kiot ? kiot.readOrders() : Promise.resolve(null)
  ]);
  // ... phan con lai giu nguyen
}
```

```js
// allowStale: Sheet het han cache van tra ban cu (lam moi nen) — chi hop Chi dinh vi tri (doc) dung.
async function findMergedOrder(branch, orderCode, { kiot, allowStale = false } = {}) {
  const { rows } = await loadMergedRows(kiot, { allowStale });
  const target = normalizeCode(orderCode);
  return rows.find(row => row.branch === branch && normalizeCode(row.orderCode) === target) || null;
}
```

Các chỗ gọi `loadMergedRows(kiot)` khác (`queryOrders`, `exportOrders`) giữ nguyên (mặc định `allowStale: false`).

- [ ] **Step 4: Sửa `orderLifecycleRepository.js`** — thêm tham số `readOptions` và chuyển xuống `getValues`:

```js
async function readAccountingTab(readOptions) {
  try {
    return readAccountingRows(await client.getValues(CONFIG.ORDER_LIFECYCLE_SHEET_ACCOUNTING, readOptions));
  } catch (err) {
    // ... giu nguyen
  }
}

async function readTab(sheetName, branch, { fieldKeys = DELIVERY_FIELD_KEYS, flow = FLOW_DELIVERY } = {}, readOptions) {
  const values = await client.getValues(sheetName, readOptions);
  // ... giu nguyen
}

async function readOptionalTab(sheetName, branch, options, label, readOptions) {
  try {
    return await readTab(sheetName, branch, options, readOptions);
  } catch (err) {
    // ... giu nguyen
  }
}

/** ... (giu comment cu) readOptions.allowStale: xem orderLifecycleSheetsClient.getValues. */
async function readAll(readOptions) {
  const northSouth = { fieldKeys: NORTH_SOUTH_FIELD_KEYS, flow: FLOW_NORTH_SOUTH };
  const pickup = { fieldKeys: PICKUP_FIELD_KEYS, flow: FLOW_PICKUP };
  const [hnRows, northSouthRows, pickupHnRows, sgRows, pickupSgRows, accountingRows] = await Promise.all([
    readTab(CONFIG.ORDER_LIFECYCLE_SHEET_HN, LIFECYCLE_BRANCH.HN, undefined, readOptions),
    readOptionalTab(CONFIG.ORDER_LIFECYCLE_SHEET_NORTH_SOUTH, LIFECYCLE_BRANCH.HN, northSouth, 'don Bac-Nam', readOptions),
    readOptionalTab(CONFIG.ORDER_LIFECYCLE_SHEET_PICKUP_HN, LIFECYCLE_BRANCH.HN, pickup, 'khach/ship lay HN', readOptions),
    readTab(CONFIG.ORDER_LIFECYCLE_SHEET_SG, LIFECYCLE_BRANCH.SG, undefined, readOptions),
    readOptionalTab(CONFIG.ORDER_LIFECYCLE_SHEET_PICKUP_SG, LIFECYCLE_BRANCH.SG, pickup, 'khach/ship lay SG', readOptions),
    readAccountingTab(readOptions)
  ]);
  return [...hnRows, ...northSouthRows, ...pickupHnRows, ...sgRows, ...pickupSgRows, ...accountingRows];
}

async function readOverrideHistory(readOptions) {
  let values;
  try {
    values = await historyClient.getValues(CONFIG.ORDER_LIFECYCLE_SHEET_HISTORY, readOptions);
  } catch (err) {
    // ... giu nguyen
  }
  // ... giu nguyen
}
```

- [ ] **Step 5: Chạy test, xác nhận xanh**

Run: `cd server && node --test shipment/orderLifecycleService.test.js shipment/orderLifecycleRepository.test.js`
Expected: PASS. Nếu test repository có fake `getValues` so sánh số tham số, cập nhật fake để nhận thêm tham số thứ hai (không đổi kỳ vọng).

- [ ] **Step 6: Commit**

```bash
git add server/shipment/orderLifecycleRepository.js server/shipment/orderLifecycleService.js server/shipment/orderLifecycleService.test.js
git commit -m "perf(lifecycle): findMergedOrder nhan allowStale de doc Sheet ban cu

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `readOrderDetail({ lite: true })` bỏ tồn / cước

**Files:**
- Modify: `server/shipment/kiotOrdersRepository.js:347-415` (`readOrderDetail`)
- Test: `server/shipment/kiotOrdersRepository.test.js` (khối `readOrderDetail`, quanh dòng 500-560)

**Interfaces:**
- Produces: `kiotOrders.readOrderDetail({ branch, code, lite })` — `lite: true` trả `phieuTam`, `lines` (không `onHand/inTransit/sellable*/measure`), không `freight`, `sellableValue: null` (Task 6 dùng).

- [ ] **Step 1: Viết test (đỏ)** — thêm sau test `readOrderDetail: don KHONG con Phieu tam …`:

```js
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
```

(`createFakePool` đã trả `calls` với `calls.onHand` ghi mỗi lượt đọc tồn.)

- [ ] **Step 2: Chạy, xác nhận đỏ**

Run: `cd server && node --test shipment/kiotOrdersRepository.test.js`
Expected: FAIL ở test mới (đọc tồn / cân đo vẫn chạy).

- [ ] **Step 3: Sửa `readOrderDetail`** — đổi chữ ký và thêm nhánh `lite` ngay sau khi có `detail`:

```js
  /**
   * … (giu comment cu)
   * lite: true — chi dau don + dong hang (hop Chi dinh vi tri / phieu nhat khong dung ton, co ban, can do, cuoc): bot 1-2 luot DB.
   */
  async function readOrderDetail({ branch, code, lite = false }) {
    const dbBranch = LIFECYCLE_TO_DB_BRANCH[branch];
    if (!dbBranch) throw makeError('Cơ sở không hợp lệ (HN hoặc SG).', 400, 'INVALID_BRANCH');
    const db = getDb();
    let detail;
    try {
      detail = await fetchOrderDetail({ code, branchCode: dbBranch, pool: db });
    } catch (error) {
      // ... giu nguyen
    }
    const isPending = detail.status === PHIEU_TAM;
    if (lite) return { ...detail, branch, phieuTam: isPending, sellableValue: null };
    // ... phan con lai giu nguyen
  }
```

- [ ] **Step 4: Chạy, xác nhận xanh**

Run: `cd server && node --test shipment/kiotOrdersRepository.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/shipment/kiotOrdersRepository.js server/shipment/kiotOrdersRepository.test.js
git commit -m "perf(kiot): readOrderDetail lite bo doc ton va can do

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: SĐT sale trả bản cũ, làm mới nền

**Files:**
- Modify: `server/pickAssignments/pickKiotData.js:19-52` (`createSellerPhoneLookup`)
- Test: `server/pickAssignments/pickStatusFlow.test.js` (cạnh 2 test `Kiot seller phone …`, dòng ~303-322)

**Interfaces:**
- Produces: `createSellerPhoneLookup(...)` trả `async (branch, sellerId) → string` — cùng chữ ký; hành vi mới: đã từng đọc thành công thì không bao giờ chờ API KiotViet.

- [ ] **Step 1: Viết test (đỏ)** — thêm sau test `Kiot seller phones match ID …`:

```js
test('Kiot seller phones: het han tra ban cu ngay va lam moi nen; lam moi loi giu ban cu',async()=>{
 let time=0,calls=0,gate=null,fail=false;
 const lookup=kiotData.createSellerPhoneLookup({now:()=>time,getBranches:()=>[{branch:'hanoi'}],createClient:()=>({fetchAllPages:async(e,q,cb)=>{
  calls++;if(gate)await gate;if(fail)throw new Error('API unavailable');await cb([{id:7,mobilePhone:calls===1?'0901111111':'0909999999'}]);
 }})});
 assert.equal(await lookup('hanoi',7),'0901111111');
 time=301000;let open;gate=new Promise(r=>{open=r;});
 assert.equal(await lookup('hanoi',7),'0901111111','khong cho API');
 assert.equal(calls,2);
 assert.equal(await lookup('hanoi',7),'0901111111','dang lam moi: khong goi them');assert.equal(calls,2);
 open();gate=null;await new Promise(r=>setImmediate(r));
 assert.equal(await lookup('hanoi',7),'0909999999','dung ban moi sau khi lam moi xong');
 time=700000;fail=true;
 assert.equal(await lookup('hanoi',7),'0909999999');await new Promise(r=>setImmediate(r));
 assert.equal(await lookup('hanoi',7),'0909999999','loi giu ban cu');
});
```

- [ ] **Step 2: Chạy, xác nhận đỏ**

Run: `cd server && node --test pickAssignments/pickStatusFlow.test.js`
Expected: FAIL ở test mới (lần gọi sau hết hạn bị treo chờ `gate` / trả bản mới).

- [ ] **Step 3: Sửa `createSellerPhoneLookup`** — thay phần thân `return async (branch, sellerId) => { … }`:

```js
  const cache = new Map(); // key -> { phones (lan doc thanh cong gan nhat) | null, expires, pending }
  function refresh(config, entry) {
    entry.expires = Infinity;
    entry.pending = (async () => {
      try {
        const phones = new Map();
        const client = createClient({...config, requestOptions:{maxRetries:1,timeoutMs:5000}});
        await client.fetchAllPages('users', {}, async users => {
          for (const user of users) phones.set(String(user.id), toLocalPhone(user.mobilePhone));
        }, {requireComplete:true});
        entry.phones = phones;
        entry.expires = now() + 300000;
      } catch (error) {
        entry.expires = now() + 30000;
      }
      return entry.phones || new Map();
    })();
    return entry.pending;
  }
  // Da tung doc duoc: het han thi tra ban cu ngay va lam moi o nen (in phieu khong cho API KiotViet). Chua tung doc duoc: cho.
  return async (branch, sellerId) => {
    if (!sellerId) return '';
    const config = getBranches().find(item => item.branch === branch);
    if (!config) return '';
    const key = branch + ':' + (config.retailer || '');
    let entry = cache.get(key);
    if (!entry) { entry = { phones: null, expires: 0, pending: null }; cache.set(key, entry); }
    if (entry.expires <= now()) {
      const pending = refresh(config, entry);
      if (!entry.phones) return (await pending).get(String(sellerId)) || '';
    } else if (!entry.phones) {
      return (await entry.pending).get(String(sellerId)) || '';
    }
    return entry.phones.get(String(sellerId)) || '';
  };
```

Ghi chú hành vi để kiểm: lượt đang làm mới đặt `expires = Infinity` nên không gọi trùng; test cũ `Kiot seller phones match ID …` (hai lời gọi đồng thời chỉ 1 lần API; lỗi lần đầu trả `''` và thử lại sau 30 s) phải vẫn xanh.

- [ ] **Step 4: Chạy, xác nhận xanh**

Run: `cd server && node --test pickAssignments/pickStatusFlow.test.js`
Expected: PASS (cả 3 test SĐT).

- [ ] **Step 5: Commit**

```bash
git add server/pickAssignments/pickKiotData.js server/pickAssignments/pickStatusFlow.test.js
git commit -m "perf(pick): SDT sale tra ban cu va lam moi nen, khong cho API KiotViet

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `readLatest` một truy vấn, dòng / lịch sử / SĐT song song

**Files:**
- Modify: `server/pickAssignments/pickAssignmentsService.js:170-220` (`readAssignment`, `readLatestId`, `readLatest`)
- Test: `server/pickAssignments/pickAssignmentsService.test.js`

**Interfaces:**
- Produces: `readLatest(db, branch, orderCode)` / `readAssignment(db, id)` — cùng kết quả JSON như cũ (Task 6 dùng `readLatest`).

- [ ] **Step 1: Viết test (đỏ)** — thêm sau test `old print snapshots …` (đầu file):

```js
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
```

- [ ] **Step 2: Chạy, xác nhận đỏ**

Run: `cd server && node --test pickAssignments/pickAssignmentsService.test.js`
Expected: FAIL ở test mới (`seen` có 2 truy vấn `order_pick_assignments` và `gates.length` = 0 vì đang chờ SĐT tuần tự).

- [ ] **Step 3: Sửa service** — thay `readAssignment`, `readLatestId`, `readLatest` bằng:

```js
  // Hang order_pick_assignments -> JSON cho client. Dong, lich su va SDT sale (snapshot cu thieu) doc SONG SONG (1 luot DB thay vi 3).
  async function shapeAssignment(db, head) {
    // Older snapshots have no seller contact: supplement the print response without rewriting history.
    const snapshot = {...(head.order_snapshot || {})};
    const [sellerPhone, lines, history] = await Promise.all([
      !snapshot.sellerPhone && loadSellerPhone ? loadSellerPhone(db, head.branch, head.order_code) : null,
      db.query('SELECT * FROM order_pick_lines WHERE assignment_id = $1 ORDER BY id', [head.id]).then(result => result.rows),
      db.query('SELECT created_at, action, actor_name, summary FROM order_pick_history WHERE assignment_id = $1 ORDER BY id', [head.id]).then(result => result.rows)
    ]);
    if (sellerPhone !== null) snapshot.sellerPhone = sellerPhone;
    const at = value => (value ? isoOf(value) : null);
    return {
      // ... GIU NGUYEN toan bo object tra ve cua readAssignment cu (id, branch, ..., snapshot, lines.map(...), history.map(...))
    };
  }

  async function readAssignment(db, id) {
    const head = (await db.query('SELECT * FROM order_pick_assignments WHERE id = $1', [id])).rows[0];
    return head ? shapeAssignment(db, head) : null;
  }

  // Chi dinh moi nhat cua don: lay luon ca hang (1 luot) thay vi id roi doc lai theo id.
  async function readLatest(db, branch, orderCode) {
    const head = (await db.query(
      'SELECT * FROM order_pick_assignments WHERE branch = $1 AND lower(btrim(order_code)) = $2 ORDER BY id DESC LIMIT 1',
      [branch, codeKey(orderCode)])).rows[0];
    return head ? shapeAssignment(db, head) : null;
  }
```

Chép nguyên khối `return { id: Number(head.id), … history: history.map(…) }` của `readAssignment` cũ vào chỗ đánh dấu (không sửa trường nào). Xóa `readLatestId` (chỉ `readLatest` dùng — xác nhận bằng `grep -n readLatestId server/pickAssignments/pickAssignmentsService.js` trả rỗng sau khi sửa).

- [ ] **Step 4: Chạy, xác nhận xanh**

Run: `cd server && node --test pickAssignments/pickAssignmentsService.test.js pickAssignments/pickStatusFlow.test.js pickAssignments/pickAssignmentsRoutes.test.js`
Expected: PASS (gồm test `old print snapshots …` — fake của nó khớp `SELECT * FROM order_pick_assignments`).

- [ ] **Step 5: Commit**

```bash
git add server/pickAssignments/pickAssignmentsService.js server/pickAssignments/pickAssignmentsService.test.js
git commit -m "perf(pick): readLatest 1 truy van, dong/lich su/SDT doc song song

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `/candidates` song song, SQL gộp, tải đơn song song + bản gọn

**Files:**
- Modify: `server/pickAssignments/pickAssignmentsService.js:140-165` (`defaultLoadOrder` → `createOrderLoader`), `:269-273` (`requireOrder`), `:284-299` (`candidates`), `:770` (exports)
- Test: `server/pickAssignments/pickAssignmentsService.test.js`

**Interfaces:**
- Consumes: `lifecycle.findMergedOrder(branch, code, { kiot, allowStale })` (Task 2), `kiot.readOrderDetail({ branch, code, lite: true })` (Task 3), `readLatest` (Task 5), `kiotData.readSellerPhone` (Task 4).
- Produces: `createOrderLoader({ lifecycle, kiot, readSellerPhone }) → async ({ branch, orderCode, allowStale }) → order | null`; `loadOrder` nhận `{ branch, orderCode, allowStale }` (`allowStale: true` chỉ từ `candidates`).

- [ ] **Step 1: Cho `fixture` nhận `loadOrder` tùy chọn** — trong `pickAssignmentsService.test.js`, đổi chữ ký `async function fixture({ orders = { DH001: order() }, positions } = {})` thành `async function fixture({ orders = { DH001: order() }, positions, loadOrder } = {})` và trong `createPickAssignmentsService({ … })` dùng `loadOrder: loadOrder || (async ({ branch, orderCode }) => { … như cũ … })`.

- [ ] **Step 2: Viết test (đỏ)** — thêm cuối file:

```js
test('candidates: tai don va chi dinh moi nhat song song, allowStale=true; ton tru giu cho don khac, khong tru chinh don', async () => {
  const calls = [];
  let gate = null; // chi chan loadOrder trong luot candidates (assign ben duoi khong bi chan)
  let release;
  const { db, service } = await fixture({
    loadOrder: async args => {
      calls.push(args);
      if (gate && args.orderCode === 'DH001') await gate;
      return args.orderCode === 'DH001' ? order() : order({ orderCode: 'DH002' });
    }
  });
  try {
    await service.assign(ctx(), { branch: 'HN', orderCode: 'DH002', allocations: [{ productCode: 'AAA1', positionId: 1, qty: 100 }], allowMismatch: true });
    await service.assign(ctx(), { branch: 'HN', orderCode: 'DH001', allocations: [{ productCode: 'AAA1', positionId: 2, qty: 50 }], allowMismatch: true });
    calls.length = 0;
    gate = new Promise(resolve => { release = resolve; });
    const seen = [];
    const originalQuery = db.query.bind(db);
    db.query = (sql, params) => { seen.push(sql); return originalQuery(sql, params); };
    const pending = service.candidates(ctx(), { branch: 'HN', orderCode: 'DH001' });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(seen.some(sql => sql.includes('FROM order_pick_assignments WHERE branch')), 'doc chi dinh truoc khi don tai xong');
    release();
    const view = await pending;
    db.query = originalQuery;
    assert.deepEqual(calls.map(c => c.allowStale), [true]);
    const byId = Object.fromEntries(view.candidates.aaa1.map(c => [c.positionId, c]));
    assert.equal(byId[1].held, 100, 'giu cho cua DH002');
    assert.equal(byId[1].available, 200);
    assert.equal(byId[2].held, 0, 'giu cho cua chinh DH001 khong tru');
    assert.equal(byId[2].available, 200);
    assert.equal(view.assignment.orderCode, 'DH001');
    assert.equal(view.assignment.status, 'picking');
  } finally { await db.close(); }
});

test('assign doc don voi allowStale=false', async () => {
  const calls = [];
  const { db, service } = await fixture({ loadOrder: async args => { calls.push(args); return order(); } });
  try {
    await service.assign(ctx(), assignBody([{ productCode: 'AAA1', positionId: 1, qty: 250 }], { allowMismatch: true }));
    assert.deepEqual(calls.map(c => c.allowStale), [false]);
  } finally { await db.close(); }
});

test('createOrderLoader: bang gop va chi tiet Kiot (lite) doc song song; ma chuan khac thi doc lai; khong co don -> null', async () => {
  const { createOrderLoader } = require('./pickAssignmentsService');
  const events = [];
  let releaseRow;
  const rowGate = new Promise(resolve => { releaseRow = resolve; });
  const row = { orderCode: 'DH001', customerName: 'KH', saleName: 'Sale', saleTelegramId: '1', orderDate: 'd', summary: { code: 'SENT_TO_ACCOUNTANT', label: 'x' }, note: '' };
  const loader = createOrderLoader({
    lifecycle: { findMergedOrder: async (branch, code, opts) => { events.push(['row', code, opts.allowStale]); await rowGate; return code === 'none' ? null : row; } },
    kiot: { readOrderDetail: async args => { events.push(['detail', args.code, args.lite]); return { lines: [{ productCode: 'A', quantity: 1 }], sellerId: 9, sellerPhone: '' }; } },
    readSellerPhone: async () => '0901'
  });
  const pending = loader({ branch: 'HN', orderCode: 'dh001', allowStale: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, [['detail', 'dh001', true], ['row', 'dh001', true]], 'chi tiet bat dau truoc khi bang gop xong');
  releaseRow();
  const loaded = await pending;
  assert.deepEqual(events.slice(2), [['detail', 'DH001', true]], 'ma chuan khac ma gui -> doc lai theo ma chuan');
  assert.equal(loaded.orderCode, 'DH001');
  assert.equal(loaded.sellerPhone, '0901');
  assert.equal(loaded.status.code, 'SENT_TO_ACCOUNTANT');
  assert.equal(await loader({ branch: 'HN', orderCode: 'none' }), null);
});
```

- [ ] **Step 3: Chạy, xác nhận đỏ**

Run: `cd server && node --test pickAssignments/pickAssignmentsService.test.js`
Expected: FAIL — `allowStale` là `undefined`, `createOrderLoader is not a function`, chưa đọc chỉ định trước khi đơn tải xong.

- [ ] **Step 4: Thay `defaultLoadOrder` bằng `createOrderLoader`**

```js
// Nguon don mac dinh: trang thai tu bang gop Vong doi don hang + dong hang tu don Kiot (khong tin du lieu tu trinh duyet).
// Bang gop va chi tiet Kiot (ban gon: hop chi dinh khong dung ton/cuoc) doc SONG SONG theo ma nguoi dung gui; ma chuan
// cua bang gop khac (chu hoa/thuong, khoang trang) thi doc lai chi tiet theo ma chuan. allowStale: Sheet tra ban cu (chi /candidates).
function createOrderLoader({ lifecycle, kiot, readSellerPhone }) {
  const readDetail = (branch, code) => kiot.readOrderDetail({ branch, code, lite: true }).then(detail => ({ detail }), error => ({ error }));
  return async function loadOrder({ branch, orderCode, allowStale = false }) {
    const early = readDetail(branch, orderCode);
    const row = await lifecycle.findMergedOrder(branch, orderCode, { kiot, allowStale });
    if (!row) return null;
    const { detail, error } = row.orderCode === orderCode ? await early : await readDetail(branch, row.orderCode);
    if (error) throw error;
    return {
      branch,
      orderCode: row.orderCode,
      customerName: row.customerName || detail.customerName || '',
      saleName: row.saleName || detail.seller || '',
      saleTelegramId: row.saleTelegramId || '',
      orderDate: row.orderDate || detail.date || '',
      status: { code: row.summary.code, label: row.summary.label },
      invoiceDiscount: Number(detail.discount) || 0,
      customerPhone: detail.customerPhone || '',
      customerAddress: detail.customerAddress || '',
      sellerPhone: detail.sellerPhone || await readSellerPhone(tx.DB_BRANCH[branch], detail.sellerId),
      note: detail.note || row.note || '',
      lines: detail.lines
    };
  };
}

// require luc goi (nhu truoc) de tranh vong require giua pickAssignments va shipment.
function defaultLoadOrder(args) {
  return createOrderLoader({
    lifecycle: require('../shipment/orderLifecycleService'),
    kiot: require('../shipment/kiotOrdersRepository').kiotOrders,
    readSellerPhone: kiotData.readSellerPhone
  })(args);
}
```

Lỗi của `early` khi `row` là `null` bị bỏ qua có chủ đích (giữ thứ tự cũ: không có đơn → `null`). `early` đã có `.then(…, error => ({ error }))` nên không sinh unhandled rejection.

- [ ] **Step 5: Sửa `requireOrder`, `candidates`, exports**

Thêm hằng số ngay sau `const codeKey = …` (dòng ~35):

```js
// Vi tri ung vien cua cac ma trong don + giu cho cua cac don KHAC dang nhat, 1 luot DB (truoc la 2 luot noi tiep).
const CANDIDATES_SQL = `SELECT p.*, COALESCE(h.held, 0)::float8 AS held
  FROM (SELECT ${ROW_COLUMNS} FROM stock_positions WHERE branch = $1 AND lower(btrim(code)) = ANY($2::text[])) p
  LEFT JOIN (SELECT l.position_id, SUM(l.reserved_qty) AS held
               FROM order_pick_lines l JOIN order_pick_assignments a ON a.id = l.assignment_id
              WHERE a.status = 'picking' AND a.branch = $1 AND lower(btrim(a.order_code)) <> $3
              GROUP BY l.position_id) h ON h.position_id = p.id
 ORDER BY p.id`;
```

```js
  async function requireOrder(branch, orderCode, { allowStale = false } = {}) {
    const order = await loadOrder({ branch, orderCode, allowStale });
    if (!order) throw fail(404, 'NOT_FOUND', 'Không tìm thấy đơn hàng này.');
    return { order, lines: mergeOrderLines(order.lines) };
  }
```

```js
  // Dong don (da gop theo ma) + cac vi tri ung vien kem ton kha dung, va chi dinh moi nhat cua don (neu co).
  // Don va chi dinh doc song song; ma chuan cua don khac ma gui (hiem) thi doc lai chi dinh theo ma chuan.
  async function candidates(ctx, { branch, orderCode } = {}) {
    assertBranch(branch);
    assertScope(ctx, branch);
    const code = cleanOrderCode(orderCode);
    const db = getDb();
    const [{ order, lines }, latestByCode] = await Promise.all([
      requireOrder(branch, code, { allowStale: true }),
      readLatest(db, branch, code)
    ]);
    const assignment = codeKey(order.orderCode) === codeKey(code) ? latestByCode : await readLatest(db, branch, order.orderCode);
    const keys = [...new Set(lines.map(line => codeKey(line.productCode)))];
    const rows = keys.length ? (await db.query(CANDIDATES_SQL, [branch, keys, codeKey(order.orderCode)])).rows : [];
    const byCode = {};
    for (const key of keys) byCode[key] = [];
    for (const row of rows) byCode[codeKey(row.code)].push(shapeCandidate(row, Number(row.held) || 0));
    return { order: orderView(order, lines), candidates: byCode, assignment };
  }
```

`positionScope` và `assign` gọi `requireOrder(branch, code)` như cũ (mặc định `allowStale: false`). `heldByPosition` giữ nguyên cho `assign`.

Exports (dòng cuối):

```js
module.exports = { createPickAssignmentsService, createOrderLoader, mergeOrderLines, applyRemovals, applyNeeds, STATUS, CANCEL_REASON, PRUNE_REASON, ...createPickAssignmentsService() };
```

- [ ] **Step 6: Chạy, xác nhận xanh**

Run: `cd server && node --test pickAssignments/pickAssignmentsService.test.js pickAssignments/pickStatusFlow.test.js pickAssignments/pickAssignmentsRoutes.test.js pickAssignments/pickKiotReconcileJob.test.js`
Expected: PASS. Nếu PGlite báo lỗi kiểu dữ liệu ở `$1` (dùng chung giữa `stock_positions.branch` và `order_pick_assignments.branch`), ép kiểu rõ `$1::text` ở cả hai chỗ.

- [ ] **Step 7: Commit**

```bash
git add server/pickAssignments/pickAssignmentsService.js server/pickAssignments/pickAssignmentsService.test.js
git commit -m "perf(pick): candidates doc don + chi dinh song song, gop SQL vi tri va giu cho, chi tiet Kiot ban gon

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `pick-assign.js` — nút sớm, tải trước, Hủy nhặt tại chỗ

**Files:**
- Modify: `server/public/shipment/lifecycle/pick/pick-assign.js` (`load` dòng ~485-509, `changeStatus` ~598-605, `attach` ~863-883, `window.TKSPick` ~892)
- Test: `server/test/frontend/lifecycle-pick.test.js`

**Interfaces:**
- Produces (cho Task 8): `TKSPick.attachButton({ order, buttonHost, canPick, status })`, `TKSPick.prefetch(order)`, `TKSPick.forgetPrefetch()`. `attach`, `open`, `loadAssignment` giữ nguyên chữ ký.

- [ ] **Step 1: Viết test (đỏ)** — thêm cuối `server/test/frontend/lifecycle-pick.test.js` (test gọi thẳng `TKSPick.prefetch` nên đỏ được trước Task 8):

```js
test('tải trước candidates: mở hộp trong 30 giây dùng lại kết quả (1 request); quá 30 giây, đã quên hoặc mở lại thì tải mới', async () => {
  const page = await renderPage();
  try {
    let now = 1_000_000;
    page.window.Date.now = () => now;
    await openDetail(page);
    const base = page.store.candidateCalls; // 0 trước Task 8, 1 sau Task 8 (mở chi tiết tự tải trước)
    page.window.TKSPick.prefetch({ branch: 'HN', orderCode: 'DH1' });
    await settle();
    assert.equal(page.store.candidateCalls, base + 1, 'prefetch gọi 1 lần');
    await click(page, 'openPickingBtn');
    assert.equal(page.store.candidateCalls, base + 1, 'mở hộp dùng lại kết quả tải trước');
    assert.equal(page.document.querySelectorAll('#pickingRows tr').length, 1);
    await click(page, 'pickingClose');
    await click(page, 'openPickingBtn');
    assert.equal(page.store.candidateCalls, base + 2, 'mở lại: tải mới');
    await click(page, 'pickingClose');

    page.window.TKSPick.prefetch({ branch: 'HN', orderCode: 'DH1' });
    await settle();
    now += 30_001;
    await click(page, 'openPickingBtn');
    assert.equal(page.store.candidateCalls, base + 4, 'quá 30 giây: tải mới');
    await click(page, 'pickingClose');

    page.window.TKSPick.prefetch({ branch: 'HN', orderCode: 'DH1' });
    await settle();
    page.window.TKSPick.forgetPrefetch();
    await click(page, 'openPickingBtn');
    assert.equal(page.store.candidateCalls, base + 6, 'đã quên: tải mới');
  } finally { page.dom.window.close(); }
});

test('tải trước lỗi thì mở hộp tải lại bình thường', async () => {
  let fail = true;
  const page = await renderPage({ fetchImpl: href => (fail && href.startsWith('/api/shipment/pick/candidates') ? { ok: false, status: 500, json: async () => ({ error: 'x' }) } : null) });
  try {
    await openDetail(page);
    page.window.TKSPick.prefetch({ branch: 'HN', orderCode: 'DH1' });
    await settle();
    fail = false;
    await click(page, 'openPickingBtn');
    assert.equal(page.document.querySelectorAll('#pickingRows tr').length, 1, 'đã tải lại và vẽ bảng');
  } finally { page.dom.window.close(); }
});

test('Hủy nhặt: không tải lại candidates, về Hủy nhặt với gợi ý mới và sửa được ngay', async () => {
  const store = newStore({ assignment: makeAssignment('picking') });
  const page = await renderPage({ orders: [orderRow('DH1', { pickStatus: 'picking' })], store });
  try {
    await openPopup(page);
    const before = store.candidateCalls;
    await click(page, 'pickingCancelPick');
    assert.equal(store.candidateCalls, before, 'không gọi lại /candidates');
    assert.equal(text(page, 'pickingOrderStatus'), 'Hủy nhặt');
    assert.equal(text(page, 'pickingConfirm'), 'Xác nhận & In phiếu nhặt');
    assert.equal(page.document.getElementById('pickingConfirm').disabled, false);
    assert.equal(page.document.querySelector('[data-qty][data-qloc="11"]').disabled, false, 'sửa được ngay');
    assert.equal(page.document.querySelectorAll('.picking-loc.selected').length, 1, 'có gợi ý mới (A07 x 100)');
  } finally { page.dom.window.close(); }
});
```

- [ ] **Step 2: Chạy, xác nhận đỏ**

Run: `cd server && node --test test/frontend/lifecycle-pick.test.js`
Expected: FAIL — `TKSPick.prefetch is not a function`; test Hủy nhặt đỏ vì `candidateCalls` tăng 1.

- [ ] **Step 3: Thêm tải trước + dùng trong `load()`** — đặt ngay trên `// ---------- Tải dữ liệu ----------`:

```js
  // ---------- Tải trước candidates ----------
  /* Hộp chi tiết đơn gọi prefetch khi mở: bấm "Thay đổi chỉ định" trong 30 giây dùng lại kết quả (đang tải dở thì chờ đúng request đó).
     Chỉ giữ 1 mục (đơn đang xem gần nhất) và chỉ dùng 1 lần; tồn có thể cũ vài giây nhưng khi lưu máy chủ vẫn kiểm lại (REFETCH_CODES). */
  const PREFETCH_MS=30000;
  let prefetched=null; // {key, at, promise}
  const prefetchKey=o=>o.branch+'|'+key(o.orderCode);
  const candidatesUrl=o=>API+'/candidates?branch='+encodeURIComponent(o.branch)+'&order='+encodeURIComponent(o.orderCode);
  function prefetch(o){
    if(!o||!o.branch||!o.orderCode)return;
    const promise=api('GET',candidatesUrl(o));
    promise.catch(()=>{});
    prefetched={key:prefetchKey(o),at:Date.now(),promise};
  }
  function forgetPrefetch(){prefetched=null;}
  function takePrefetched(o){
    const hit=prefetched&&prefetched.key===prefetchKey(o)&&Date.now()-prefetched.at<=PREFETCH_MS?prefetched.promise:null;
    prefetched=null;
    return hit;
  }
```

Trong `load()`, thay dòng `const r=await api('GET',API+'/candidates?branch='+…);` bằng:

```js
    const early=takePrefetched(o);
    let r=early?await early.catch(()=>null):null;
    if(!r||!r.ok)r=await api('GET',candidatesUrl(o));
```

- [ ] **Step 4: Hủy nhặt tại chỗ** — thêm ngay trên `async function changeStatus(action){`:

```js
  // Hủy nhặt: tồn khả dụng không đổi (candidates không trừ giữ chỗ của chính đơn đang xem) → làm đúng nhánh "chưa có chỉ định"
  // của load() ngay tại chỗ, không tải lại /candidates.
  function applyCancelled(){
    state.assignment=null;state.reassignOf=null;state.posEdit=null;state.removed=new Set();state.needs=editedNeeds({});
    if(state.order&&state.order.eligible!==false)suggest();else state.allocations={};
    render();
  }
```

Trong `changeStatus`, thay

```js
    // Hủy nhặt: tải lại để có gợi ý mới theo tồn vừa được trả giữ chỗ, sẵn sàng chỉ định lại ngay.
    if(action==='cancel')await reloadCurrent(epoch);
```

bằng

```js
    if(action==='cancel'&&current(epoch))applyCancelled();
```

- [ ] **Step 5: Nút dùng chung + `attachButton`** — thêm ngay trên `function attach(opts){`:

```js
  function openButton(o,status){
    const button=document.createElement('button');button.type='button';button.id='openPickingBtn';button.className='picking-open-btn';button.textContent=status==='picking'?'Thay đổi chỉ định':'Chỉ định vị trí';
    if(status==='picking')button.title='Đổi vị trí hoặc số lượng rồi lưu bằng Cập nhật chỉ định & In phiếu.';
    button.addEventListener('click',()=>open(o));
    return button;
  }
  // Gắn sớm nút mở hộp vào đầu hộp chi tiết khi bảng hàng chưa về: opts {order, buttonHost, canPick, status (pickStatus của dòng)}.
  function attachButton(opts){
    const host=opts&&opts.buttonHost;if(!host)return;
    host.replaceChildren();
    if(opts.canPick)host.appendChild(openButton(opts.order||{},opts.status||null));
  }
```

Trong `attach`, thay ba dòng tạo `button` trong `if(canOpen){ … }` bằng:

```js
    if(canOpen)(buttonHost||controls).appendChild(openButton(o,status));
```

Cập nhật export:

```js
  window.TKSPick={attach,attachButton,open,prefetch,forgetPrefetch,loadAssignment,STATUS_LABEL,_state:state,_moveLine:(from,to,after)=>{const moved=moveLine(key(from),key(to),after);if(moved)render();return moved;}};
```

- [ ] **Step 6: Chạy, xác nhận xanh**

Run: `cd server && node --test test/frontend/lifecycle-pick.test.js test/frontend/lifecycle-pick-status.test.js test/frontend/lifecycle-pick-positions.test.js test/frontend/lifecycle-pick-invoice.test.js`
Expected: PASS. Nếu test cũ nào khẳng định "Hủy nhặt thì tải lại candidates", sửa khẳng định thành "không tải lại" (hành vi mới theo spec §3) và ghi trong commit.

- [ ] **Step 7: Commit**

```bash
git add server/public/shipment/lifecycle/pick/pick-assign.js server/test/frontend/lifecycle-pick.test.js
git commit -m "perf(pick-ui): tai truoc candidates, Huy nhat khong tai lai, nut mo hop dung chung

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Trang Vòng đời — tải song song, nút ngay, gọi tải trước

**Files:**
- Modify: `server/public/shipment/lifecycle/index.html:1217-1247` (`loadKiotLines`), `:1281-1294` (`applyPickStatus`)
- Test: `server/test/frontend/lifecycle-pick.test.js`

**Interfaces:**
- Consumes: `TKSPick.attachButton`, `TKSPick.prefetch`, `TKSPick.forgetPrefetch`, `TKSPick.loadAssignment` (Task 7).

- [ ] **Step 1: Viết test (đỏ)** — thêm cuối `lifecycle-pick.test.js`:

```js
test('mở chi tiết đơn: nút hiện ngay, tải trước candidates và tải chỉ định song song với chi tiết Kiot', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const store = newStore({ assignment: makeAssignment('picking') });
  const page = await renderPage({
    orders: [orderRow('DH1', { pickStatus: 'picking' })], store,
    fetchImpl: href => (href.startsWith('/api/shipment/lifecycle/order-detail') ? gate.then(() => json({ detail: kiotDetail('DH1') })) : null)
  });
  try {
    await openDetail(page);
    assert.equal(text(page, 'openPickingBtn'), 'Thay đổi chỉ định', 'nút có trước khi bảng hàng về');
    assert.ok(page.calls.some(c => c.url === '/api/shipment/pick?branch=HN&order=DH1'), 'tải chỉ định song song');
    assert.equal(store.candidateCalls, 1, 'đã tải trước candidates');
    release();
    await settle();
    assert.ok(page.document.querySelector('#lcDetailKiot table.lc-lines'), 'bảng hàng vẽ sau khi về');
    assert.equal(text(page, 'openPickingBtn'), 'Thay đổi chỉ định');
    await click(page, 'openPickingBtn');
    assert.equal(store.candidateCalls, 1, 'mở hộp không gọi thêm');
  } finally { page.dom.window.close(); }
});

test('mở chi tiết: không có quyền thì không nút, không tải trước; đơn không có trên Kiot (404) thì bỏ nút', async () => {
  const noPick = await renderPage({ permissions: ['shipment.lifecycle'] });
  const missing = await renderPage({ fetchImpl: href => (href.startsWith('/api/shipment/lifecycle/order-detail') ? json({ error: 'x' }, 404) : null) });
  try {
    await openDetail(noPick);
    assert.equal(noPick.document.getElementById('openPickingBtn'), null);
    assert.equal(noPick.store.candidateCalls, 0);
    await openDetail(missing);
    assert.equal(missing.document.getElementById('openPickingBtn'), null, '404: như trước, không có nút');
  } finally { [noPick, missing].forEach(page => page.dom.window.close()); }
});
```

- [ ] **Step 2: Chạy, xác nhận đỏ**

Run: `cd server && node --test test/frontend/lifecycle-pick.test.js`
Expected: FAIL — chưa có nút khi bảng hàng chưa về, chưa có request `/api/shipment/pick?…`, `candidateCalls` = 0.

- [ ] **Step 3: Sửa `loadKiotLines`**

```js
    function loadKiotLines(order){
      const requestId = detailRequestId;
      deliverToChanh = false; // moi don chon lai
      const holder = document.getElementById('lcDetailKiot');
      const pickActions = document.getElementById('lcDetailPickActions');
      holder.innerHTML = '<p class="lc-lines-status">Đang tải chi tiết hàng hóa từ Kiot…</p>';
      // Nguoi co quyen: nut Chi dinh vi tri hien NGAY (theo pickStatus cua dong) + tai truoc hop chi dinh (bam la mo ngay).
      if(window.TKSPick && canPick){
        window.TKSPick.attachButton({ order: order, buttonHost: pickActions, canPick: canPick, status: order.pickStatus || null });
        window.TKSPick.prefetch(order);
      }
      // Chi tiet Kiot va chi dinh (de ve cot ST) tai SONG SONG; loadAssignment khong bao gio loi (tra null).
      const pickLoad = window.TKSPick && canPick && order.pickStatus ? window.TKSPick.loadAssignment(order) : Promise.resolve(undefined);
      Promise.all([
        readDetailJSON('/api/shipment/lifecycle/order-detail?code=' + encodeURIComponent(order.orderCode) +
          '&branch=' + encodeURIComponent(order.branch)),
        pickLoad
      ])
        .then(function(results){
          const result = results[0];
          if(requestId !== detailRequestId) return; // hop da dong / doi don
          if(!result.ok){
            pickActions.replaceChildren(); // nhu truoc: khong co bang hang thi khong co nut
            // 404: don chua/khong con tren Kiot (vd dong chi co trong Sheet) -> khong hien muc nay.
            holder.innerHTML = result.status === 404
              ? ''
              : '<p class="lc-lines-status">' + escapeHtml((result.body && result.body.error) || 'Không tải được chi tiết hàng hóa.') + '</p>';
            return;
          }
          detailKiot = result.body.detail || {};
          if(results[1] !== undefined) detailPick = results[1];
          renderKiotHolder(order);
        })
        .catch(function(){
          if(requestId !== detailRequestId) return;
          pickActions.replaceChildren();
          holder.innerHTML = '<p class="lc-lines-status">Lỗi kết nối khi tải chi tiết hàng hóa.</p>';
        });
    }
```

- [ ] **Step 4: Quên tải trước khi trạng thái bốc đổi** — đầu thân `applyPickStatus(order, status)` thêm:

```js
      if(window.TKSPick && window.TKSPick.forgetPrefetch) window.TKSPick.forgetPrefetch(); // trang thai doi: ban tai truoc da cu
```

- [ ] **Step 5: Chạy, xác nhận xanh**

Run: `cd server && node --test "test/frontend/**/*.test.js"`
Expected: PASS. Test cũ dùng `before = store.candidateCalls` sau khi mở hộp nên không bị ảnh hưởng bởi lượt tải trước; nếu test nào đếm tuyệt đối `candidateCalls` hoặc số request GET, cập nhật con số (+1 do tải trước) và ghi lý do trong commit.

- [ ] **Step 6: Commit**

```bash
git add server/public/shipment/lifecycle/index.html server/test/frontend/lifecycle-pick.test.js
git commit -m "perf(lifecycle-ui): mo don tai chi tiet + chi dinh song song, nut hien ngay, tai truoc hop chi dinh

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Đo `[timing]` trên Render, tài liệu, kiểm tra toàn bộ

**Files:**
- Modify: `server/routes.js:142-144`
- Modify: `server/README.md`, `CURRENT.md`

- [ ] **Step 1: Gắn `startTiming`** — trong `server/routes.js`:

```js
router.use('/api/shipment/lifecycle', startTiming, requireAuth, orderLifecycleRoutes);
// Chi dinh vi tri hang cho don (giu cho / in phieu nhat / xac nhan, huy nhat): quyen shipment.pick (mac dinh chi Quan ly).
// startTiming: request >= REQUEST_TIMING_SLOW_MS (500ms) ghi 1 dong [timing] tren log Render de do toc do in phieu.
router.use('/api/shipment/pick', startTiming, pickAssignmentsRoutes);
```

- [ ] **Step 2: Chạy toàn bộ test**

Run: `cd server && npm test`
Expected: 100% xanh. Có lỗi thì sửa trước khi đi tiếp (không bỏ qua test).

- [ ] **Step 3: Cập nhật tài liệu**
  - `server/README.md`: ở mục mô tả `/api/shipment/pick` và `/api/shipment/lifecycle`, thêm một dòng: "Có `Server-Timing` + log `[timing]` khi ≥ 500 ms. `/candidates` đọc Sheet / SĐT sale bản cũ (làm mới nền), chi tiết Kiot bản gọn." Cập nhật ngày cuối tài liệu thành 03/11/2026.
  - `CURRENT.md`: thêm mục "In phiếu nhặt nhanh hơn (nhánh `perf/fast-pick-print`)" — đã làm gì, kết quả test, việc tiếp: sau deploy đọc log `[timing] … /api/shipment/pick` trên Render để so trước/sau; hướng chuyển server sang Singapore chưa làm.

- [ ] **Step 4: Cập nhật đồ thị mã nguồn**

Run: `cd /d/tks_web && graphify update .`
Expected: `graphify-out/` cập nhật, không lỗi.

- [ ] **Step 5: Commit**

```bash
git add server/routes.js server/README.md CURRENT.md graphify-out
git commit -m "perf(pick): do [timing] cho /api/shipment/lifecycle va /pick, cap nhat tai lieu

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Push nhánh và mở PR** (chỉ khi người dùng đồng ý)

```bash
git push -u origin perf/fast-pick-print
```

PR vào `main`, mô tả: nguyên nhân (Oregon ↔ Singapore, lượt gọi nối tiếp), các thay đổi theo task, kết quả `npm test`, cách đo sau deploy (`[timing]` trên Render). Cuối mô tả: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
