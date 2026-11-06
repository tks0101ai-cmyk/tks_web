# Ba mức màu cho cột Tăng trưởng + lọc "Giảm hết 100%" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cột Tăng trưởng của bảng "Khách hàng theo sản phẩm" chỉ hiện %, tô ba mức màu (đỏ ≤ −100%, cam −100%..−50%, vàng −50%..0), bỏ nhãn "Cần check", và dropdown tăng trưởng có thêm mục "Giảm hết 100%".

**Architecture:** Thêm trạng thái `lost` vào CASE SQL của repository (đỏ), đổi nghĩa `check` thành cam; `summary` có thêm `lostRows`. Xuất file đổi nhãn trạng thái/ghi chú và nhận `growthGroup: 'lost'`. Giao diện đổi `growthCellHtml`, dropdown, dòng trạng thái, CSS ba lớp màu; hai token màu mới `--orange`/`--yellow` vào `shared/shared.css`.

**Tech Stack:** Node CommonJS, Postgres SQL (test PGlite), vanilla JS/CSS, node:test + JSDOM, ExcelJS.

Spec: `docs/superpowers/specs/2026-11-06-growth-color-tiers-design.md` (bổ sung cho `2026-11-06-product-customer-growth-section-design.md`, spec này thắng khi mâu thuẫn).

## Global Constraints

- Phân nhóm bằng NUMERIC nhân chéo trong SQL, không dùng số thực: `prior = T.trước + T.trước nữa`; `lost`: `prior > 0 AND r1 <= 0`; `check` (cam): `prior > 0 AND r1 > 0 AND 4·r1 < prior`; `drop` (vàng): `prior > 0 AND 4·r1 >= prior AND 2·r1 < prior`; `up`: `prior > 0 AND 2·r1 >= prior`; `new`: `prior <= 0 AND r1 > 0`; còn lại và mọi dòng có kỳ NULL → NULL. Các nhóm loại trừ nhau. Đúng −50% là vàng; đúng −100% (T.này = 0) và T.này âm là đỏ.
- Nhóm lọc API: `all|lost|check|drop|up|new`. `summary = { totalRows, lostRows, checkRows }` (`checkRows` nay chỉ đếm `check`/cam; trạng thái không có dữ liệu trả cả ba bằng 0).
- Dropdown (thứ tự, nhãn): Tất cả · Giảm hết 100% · Giảm hơn 50% · Giảm dưới 50% · Đang tăng · Khách mới (giá trị `all|lost|check|drop|up|new`).
- Nhãn trạng thái xuất file: `lost` Giảm hết 100% · `check` Giảm hơn 50% · `drop` Giảm dưới 50% · `up` Đang tăng · `new` Mới.
- Ô Tăng trưởng chỉ hiện %, không còn nhãn "Cần check"; giữ nhãn "Mới". Màu không dựa riêng vào sắc: ô có `title` ("Giảm hết 100%" / "Giảm hơn 50%" / "Giảm dưới 50%").
- Không hard-code hex trong `product-customer-growth.css`; token màu mới `--orange` (Tối `#FB923C`, Sáng `#C2410C`) và `--yellow` (Tối `#FACC15`, Sáng `#A16207`) định nghĩa trong `server/public/shared/shared.css` ở cả khối Tối (cạnh `--amber:#F59E0B`) và khối Sáng (cạnh `--amber:#D97706`).
- Mô tả (description) cột xuất file không được chứa viết tắt "T." / "DS" / "SP" (test chuẩn nhãn của `exportService.test.js` chặn mô tả viết tắt).
- Không đổi: sắp xếp phụ, độ trễ gõ 150 ms, công thức tăng trưởng, cách tính kỳ, quyền, route logic, migration, biến môi trường. Phần máy chủ cũ của mục 4 giữ nguyên.
- Hai test đỏ sẵn trên `main` (CLAUDE.md §4.1: `hr-leave-deadlines` "timing remains independent after approval and legacy violation is readable without a new violation decision"; `lifecycle-pick-performance` "printing and saving stay blocked until fresh shared form succeeds, including programmatic clicks") không tính vào kết luận; không `.skip`/sửa assert của chúng; lỗi khác tên hoặc số lỗi khác 2 là lỗi mới.
- Commit message kết thúc bằng dòng `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Môi trường test: worktree không có `node_modules`/`.env`; chạy từ `server/` với `NODE_PATH=D:/tks_web/server/node_modules GOOGLE_SERVICE_ACCOUNT_JSON='{}' JWT_SECRET=test-secret node --test <file...>`. Không đụng `.env` hay DB thật.

## File Structure

| File | Việc |
|---|---|
| Modify `server/dashboard/productCustomerGrowthRepository.js` | CASE `lost`, `GROWTH_GROUPS`, `lost_rows`, `summary.lostRows` |
| Modify `server/dashboard/productCustomerGrowthRepository.test.js` | Cập nhật kỳ vọng, thêm test ba mức màu |
| Modify `server/dashboard/exportService.js` | `GROWTH_STATUS_LABELS`, mô tả cột trạng thái, ghi chú đầu file |
| Modify `server/dashboard/exportProductCustomerGrowth.test.js`, `productCustomerGrowthRoutes.test.js` | Cập nhật kỳ vọng nhãn/summary |
| Modify `server/public/shared/shared.css` | Token `--orange`, `--yellow` (Tối + Sáng) |
| Modify `server/public/product-customer-growth.js` | `GROWTH_OPTIONS`, `growthCellHtml`, dòng trạng thái, fallback summary |
| Modify `server/public/product-customer-growth.css` | Ba lớp màu, bỏ `.pcg-flag` |
| Modify `server/public/index.html` | 6 `<option>` của `#pcgGrowth` |
| Modify `server/test/frontend/product-customer-growth.test.js` | Cập nhật + thêm test |
| Modify docs | `CURRENT.md`, `README.md`, `server/README.md`, `server/db/SCHEMA.md`, `docs/04-planning/implementation_plan.md`, SRS, BRD, spec gốc (mục 3–5 trỏ sang spec mới) |

---

### Task 1: Backend — nhóm `lost`, summary, xuất file

**Files:**
- Modify: `server/dashboard/productCustomerGrowthRepository.js`
- Modify: `server/dashboard/productCustomerGrowthRepository.test.js`
- Modify: `server/dashboard/exportService.js`
- Modify: `server/dashboard/exportProductCustomerGrowth.test.js`
- Modify: `server/dashboard/productCustomerGrowthRoutes.test.js` (chỉ nếu có fixture `summary` cần thêm `lostRows`)

**Interfaces:**
- Consumes: không (chỉ sửa hàm sẵn có).
- Produces: `getProductCustomerGrowth` / `getProductCustomerGrowthForExport` trả `summary: { totalRows, lostRows, checkRows }` và `growthState ∈ 'lost'|'check'|'drop'|'up'|'new'|null`; `GROWTH_GROUPS = ['all','lost','check','drop','up','new']`; `validateFilters` chấp nhận `growth: 'lost'`; xuất file chấp nhận `context.growthGroup: 'lost'`, cột `status` dùng nhãn mới, ghi chú đầu file có `['Giảm hết 100%', n]` và `['Giảm hơn 50%', n]` thay `['Cần check', n]`.

- [ ] **Step 1: Viết/sửa test thất bại (repository)**

Trong `server/dashboard/productCustomerGrowthRepository.test.js`:

1. Thêm test mới ba mức màu (đặt sau test "cong thuc tang truong va ranh gioi"). Dữ liệu riêng cho SP3 để không làm đổi các test cũ:

```js
test('ba muc mau: T.nay <= 0 la lost, -100%..-50% la check, dung -50% la drop; T.nay am (tra hang) cung la lost', async () => {
  const db = await setup();
  try {
    await products(db);
    await pair(db, 'sp3', 'Khách Zero', 100, 0, 100, 100);   // prior 200, T.nay 0 -> -100% -> lost
    await pair(db, 'sp3', 'Khách Âm', 90, -5, 50, 50);        // prior 100, T.nay am -> lost
    await pair(db, 'sp3', 'Khách 51', 200, 49, 100, 100);     // 4*49 = 196 < 200 -> -51% -> check (cam)
    await pair(db, 'sp3', 'Khách 50', 200, 50, 100, 100);     // 4*50 = 200 khong < 200 -> dung -50% -> drop (vang)
    await pair(db, 'sp3', 'Khách 10', 200, 90, 100, 100);     // -10% -> drop
    const data = await repo.getProductCustomerGrowth({ product: 'am dun', pool: db });
    const state = name => byName(data, name).growthState;
    assert.equal(state('Khách Zero'), 'lost');
    assert.equal(byName(data, 'Khách Zero').growth, -1);
    assert.equal(state('Khách Âm'), 'lost');
    assert.ok(byName(data, 'Khách Âm').growth < -1, 'T.nay am -> tang truong < -100%');
    assert.equal(state('Khách 51'), 'check');
    assert.equal(state('Khách 50'), 'drop');
    assert.equal(byName(data, 'Khách 50').growth, -0.5);
    assert.equal(state('Khách 10'), 'drop');
    assert.deepEqual(data.summary, { totalRows: 5, lostRows: 2, checkRows: 1 });
    assert.deepEqual(names(await repo.getProductCustomerGrowth({ product: 'am dun', growth: 'lost', sort: 'growth', dir: 'asc', pool: db })),
      ['Khách Âm', 'Khách Zero']);
    assert.deepEqual(names(await repo.getProductCustomerGrowth({ product: 'am dun', growth: 'check', pool: db })), ['Khách 51']);
    assert.deepEqual(new Set(names(await repo.getProductCustomerGrowth({ product: 'am dun', growth: 'drop', pool: db }))), new Set(['Khách 50', 'Khách 10']));
  } finally { await db.close(); }
});
```

2. Sửa các test sẵn có theo ý nghĩa mới (dữ liệu `seed()` giữ nguyên; chỉ đổi kỳ vọng). Khách F (T.này 0, hai kỳ trước 50+50) giờ là `lost`; Khách B (10 / 100 / 100) vẫn là `check`:
   - test "mac dinh": `assert.deepEqual(data.summary, { totalRows: 9, lostRows: 1, checkRows: 1 })`.
   - test "cong thuc tang truong va ranh gioi": `state('Khách F')` kỳ vọng `'lost'` (giữ `growth('Khách F') === -1`); `Khách B` giữ `'check'`.
   - test "nhom loc loai tru nhau": `check` → `['Khách B']` với summary `{ totalRows: 1, lostRows: 0, checkRows: 1 }`; thêm `lost` → `['Khách F']` với summary `{ totalRows: 1, lostRows: 1, checkRows: 0 }`; `drop` summary `{ totalRows: 1, lostRows: 0, checkRows: 0 }`; `all` vẫn 9 dòng.
   - test "loc san pham / khach": lọc `product: 'binh giu', growth: 'check'` giờ chỉ ra `['Khách B']` (share vẫn `210 / 1010`).
   - test "chua co state": `deepEqual(data, { available: false, rows: [], summary: { totalRows: 0, lostRows: 0, checkRows: 0 } }, state)`.
   - test "xuat file": `all.summary` là `{ totalRows: 9, lostRows: 1, checkRows: 1 }`; `growth: 'check', sort: 'growth', dir: 'asc'` giờ chỉ ra `['Khách B']`.
   - test "validate": thêm vào `assert.doesNotThrow` một lời gọi `repo.validateFilters({ growth: 'lost' })`.

- [ ] **Step 2: Chạy để thấy thất bại**

Run: `cd server && NODE_PATH=D:/tks_web/server/node_modules GOOGLE_SERVICE_ACCOUNT_JSON='{}' JWT_SECRET=test-secret node --test dashboard/productCustomerGrowthRepository.test.js`
Expected: FAIL (ba mức màu: `growthState` chưa có `lost`, `summary` thiếu `lostRows`, `validateFilters({growth:'lost'})` ném 400).

- [ ] **Step 3: Sửa repository**

Trong `server/dashboard/productCustomerGrowthRepository.js`:

a) Comment đầu file: thay đoạn mô tả `check/drop/up/new` bằng:

```
//   growth = T.nay x 2 / prior - 1  khi prior > 0, so sanh nguong bang NUMERIC nhan cheo (khong dung so thuc):
//     lost: prior > 0 va T.nay <= 0 (<= -100%) | check: T.nay > 0 va 4 x T.nay < prior (-100%..-50%) |
//     drop: 2 x T.nay < prior (-50%..0) | up: con lai khi prior > 0 | new: prior <= 0 va T.nay > 0.
```

b) Dòng `GROWTH_GROUPS`:

```js
const GROWTH_GROUPS = Object.freeze(['all', 'lost', 'check', 'drop', 'up', 'new']);
```

c) CASE `growth_state` trong CTE `g`:

```sql
      CASE WHEN prior IS NULL THEN NULL
           WHEN prior > 0 AND r1 <= 0 THEN 'lost'
           WHEN prior > 0 AND r1 * 4 < prior THEN 'check'
           WHEN prior > 0 AND r1 * 2 < prior THEN 'drop'
           WHEN prior > 0 THEN 'up'
           WHEN r1 > 0 THEN 'new' END AS growth_state
```

d) `UNAVAILABLE`:

```js
const UNAVAILABLE = () => ({ available: false, rows: [], summary: { totalRows: 0, lostRows: 0, checkRows: 0 } });
```

e) Trong `getProductCustomerGrowth`: CTE `meta` thêm cột đếm `lost`, câu SELECT chính lấy thêm `meta.lost_rows`, và `summary`:

```sql
    SELECT count(*)::int AS total_rows,
      (count(*) FILTER (WHERE growth_state = 'lost'))::int AS lost_rows,
      (count(*) FILTER (WHERE growth_state = 'check'))::int AS check_rows,
      LEAST(...) AS page
```

```sql
  SELECT s.*, meta.total_rows, meta.lost_rows, meta.check_rows, meta.page, ${ROW_SELECT}
```

```js
    summary: { totalRows: head.total_rows, lostRows: head.lost_rows, checkRows: head.check_rows },
```

f) Trong `getProductCustomerGrowthForExport`: thêm dòng đếm và `summary`:

```sql
  SELECT s.*, (SELECT count(*)::int FROM f) AS total_rows,
    (SELECT (count(*) FILTER (WHERE growth_state = 'lost'))::int FROM f) AS lost_rows,
    (SELECT (count(*) FILTER (WHERE growth_state = 'check'))::int FROM f) AS check_rows, ${ROW_SELECT}
```

```js
    summary: { totalRows: head.total_rows, lostRows: head.lost_rows, checkRows: head.check_rows },
```

- [ ] **Step 4: Chạy repository test để thấy pass**

Run lại lệnh ở Step 2. Expected: PASS toàn bộ (10 test).

- [ ] **Step 5: Viết/sửa test thất bại (xuất file + route)**

Trong `server/dashboard/exportProductCustomerGrowth.test.js`:
- Test "quyen": `fields.worksheets[0].fields` không đổi; không cần sửa.
- Test "bo loc o ngu canh bi kiem tra": thêm một `context` hợp lệ `{ growthGroup: 'lost' }` kiểm bằng `await exportService.getExportFields(payload({ context: { growthGroup: 'lost' } }), 'Hà Nội', ALLOWED)` (không ném lỗi).
- Test "dataset: toan bo dong, ...": đổi kỳ vọng `byCustomer('Khách B|<b>').status` từ `'Cần check'` sang `'Giảm hơn 50%'`; ghi chú: thay `assert.equal(notes['Cần check'], '1')` bằng `assert.equal(notes['Giảm hết 100%'], '0'); assert.equal(notes['Giảm hơn 50%'], '1'); assert.equal(notes['Cần check'], undefined);`.
- Thêm một ca `lost` vào dữ liệu mẫu của `setup()` trong file này: `await pair('sp2', 'Khách Mất', 40, 0, 20, 20);` (SP2, hai kỳ trước 40, T.này 0 → `lost`). Hệ quả: tổng số dòng 5 thay vì 4, `notes['Số dòng trong file']` là `'5'`, `notes['Giảm hết 100%']` là `'1'`; test "dataset: ap dung dung bo loc + sap xep" thêm `assert.deepEqual(await names({ context: { growthGroup: 'lost' } }), ['Khách Mất'])` và đổi kỳ vọng `productQuery: 'coc su'` thành tập `['Khách H', 'Khách Mất']` (dùng `new Set`/sort để không phụ thuộc thứ tự); `sortKey: 'growth', sortDir: 'asc'` ba tên đầu thành `['Khách Mất', 'Khách B|<b>', 'Khách A']`; ca test `xlsx doc lai`: `sheet.getRow(...)` theo chỉ số — kiểm lại hàng của 'Khách mới D' nếu dùng `[2,3,4,5]` thì mở rộng thành `[2,3,4,5,6]`; thêm `assert.equal(<hàng Khách Mất>.getCell(10).value, 'Giảm hết 100%')`. Điều chỉnh các kỳ vọng số dòng khác trong file nếu test đỏ vì tổng thay đổi.

Trong `server/dashboard/productCustomerGrowthRoutes.test.js`: nếu fixture trả về `summary: { totalRows: 1, checkRows: 0 }`, thêm `lostRows: 0` cho khớp contract (stub, không đổi logic).

- [ ] **Step 6: Chạy để thấy thất bại**

Run: `cd server && NODE_PATH=D:/tks_web/server/node_modules GOOGLE_SERVICE_ACCOUNT_JSON='{}' JWT_SECRET=test-secret node --test dashboard/exportProductCustomerGrowth.test.js`
Expected: FAIL (nhãn `Cần check`, ghi chú, `growthGroup: 'lost'`).

- [ ] **Step 7: Sửa `exportService.js`**

a) Nhãn:

```js
const GROWTH_STATUS_LABELS = Object.freeze({ lost: 'Giảm hết 100%', check: 'Giảm hơn 50%', drop: 'Giảm dưới 50%', up: 'Đang tăng', new: 'Mới' });
```

b) Mô tả cột trạng thái (không viết tắt "T." / "DS" / "SP"):

```js
  aggregateColumn('status', 'Trạng thái', 'text',
    'Giảm hết 100% (kỳ gần nhất không còn doanh số hoặc âm), Giảm hơn 50%, Giảm dưới 50%, Đang tăng hoặc Mới (chưa có doanh số hai kỳ trước).')
```

c) Trong `buildProductCustomerGrowthDataset`, thay dòng ghi chú `['Cần check', data.summary.checkRows.toLocaleString('en-US')]` bằng hai dòng:

```js
    ['Giảm hết 100%', data.summary.lostRows.toLocaleString('en-US')],
    ['Giảm hơn 50%', data.summary.checkRows.toLocaleString('en-US')]
```

(`growthFiltersFromContext`/`validateFilters` không cần sửa: nhóm `lost` đi qua `GROWTH_GROUPS` của repository; ghi chú `Nhóm tăng trưởng` dùng `GROWTH_STATUS_LABELS[filters.growth]` nên tự có nhãn `lost`.)

- [ ] **Step 8: Chạy các test liên quan để thấy pass**

Run: `cd server && NODE_PATH=D:/tks_web/server/node_modules GOOGLE_SERVICE_ACCOUNT_JSON='{}' JWT_SECRET=test-secret node --test dashboard/productCustomerGrowthRepository.test.js dashboard/productCustomerGrowthRoutes.test.js dashboard/exportProductCustomerGrowth.test.js dashboard/exportProduct90d.test.js dashboard/exportService.test.js`
Expected: PASS toàn bộ. Nếu `exportService.test.js` (test chuẩn nhãn) đỏ vì mô tả/nhãn mới, chỉnh **mô tả** cho khớp luật (không thêm ngoại lệ mới), rồi chạy lại.

- [ ] **Step 9: Commit**

```bash
git add server/dashboard
git commit -m "feat(hang-hoa): nhom lost (giam het 100%) + summary.lostRows, doi nhan xuat file

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Giao diện — ba màu, dropdown, token màu

**Files:**
- Modify: `server/public/shared/shared.css`
- Modify: `server/public/product-customer-growth.js`
- Modify: `server/public/product-customer-growth.css`
- Modify: `server/public/index.html` (các `<option>` của `#pcgGrowth`, hiện ở dòng ~4536-4541)
- Modify: `server/test/frontend/product-customer-growth.test.js`

**Interfaces:**
- Consumes: API Task 1 (`growthState` có `lost`; `summary.lostRows`/`checkRows`; tham số `growth=lost`).
- Produces: `helpers.GROWTH_OPTIONS` (6 cặp `[value,label]`), `helpers.growthCellHtml(row)` (trả `<td>` với lớp `is-lost` / `is-check` / `is-drop`, `title` mô tả mức, không còn `.pcg-flag`/chữ "Cần check"); `exportContext`/`buildQuery` chấp nhận `lost` (do `GROWTH_VALUES` suy từ `GROWTH_OPTIONS`).

- [ ] **Step 1: Viết/sửa test thất bại**

Trong `server/test/frontend/product-customer-growth.test.js`:

1. Thay test `growthCellHtml` hiện có bằng:

```js
test('growthCellHtml: chi hien %, ba muc mau theo lop (lost do, check cam, drop vang) kem title; new -> "Mới"; khong tinh duoc -> "—"; tang khong mau', () => {
  const lost = cell(H.growthCellHtml({ growth: -1, growthState: 'lost' }));
  assert.ok(lost.classList.contains('is-lost'));
  assert.equal(lost.textContent.trim(), '-100%');
  assert.equal(lost.getAttribute('title'), 'Giảm hết 100%');
  const check = cell(H.growthCellHtml({ growth: -0.62, growthState: 'check' }));
  assert.ok(check.classList.contains('is-check'));
  assert.equal(check.textContent.trim(), '-62%');
  assert.equal(check.getAttribute('title'), 'Giảm hơn 50%');
  assert.ok(!check.textContent.includes('Cần check'));
  const drop = cell(H.growthCellHtml({ growth: -0.3, growthState: 'drop' }));
  assert.ok(drop.classList.contains('is-drop'));
  assert.equal(drop.textContent.trim(), '-30%');
  assert.equal(drop.getAttribute('title'), 'Giảm dưới 50%');
  const up = cell(H.growthCellHtml({ growth: 0.4, growthState: 'up' }));
  assert.equal(up.textContent.trim(), '+40%');
  assert.ok(!/is-(lost|check|drop)/.test(up.className));
  assert.equal(up.getAttribute('title'), null);
  assert.equal(cell(H.growthCellHtml({ growth: null, growthState: 'new' })).textContent.trim(), 'Mới');
  assert.equal(cell(H.growthCellHtml({ growth: null, growthState: null })).textContent.trim(), '—');
});
```

2. Test `buildQuery`/`exportContext`: thêm `assert.equal(H.buildQuery({ growth: 'lost' }), 'growth=lost');` và `assert.equal(H.exportContext({ growth: 'lost' }).context.growthGroup, 'lost');`.
3. Test markup (`tieu de bang ...`) đã so `#pcgGrowth option` với `H.GROWTH_OPTIONS`: thêm `assert.deepEqual(H.GROWTH_OPTIONS.map(o => o[0]), ['all', 'lost', 'check', 'drop', 'up', 'new']);`.
4. Hàm `report(rows, extra)`: đổi phần `summary` thành `{ totalRows: rows.length, lostRows: rows.filter(r => r.growthState === 'lost').length, checkRows: rows.filter(r => r.growthState === 'check').length }`.
5. Test "tai lan dau": hàng đầu đổi `sampleRow('Khách A', { growth: -1, growthState: 'lost' })` (thay vì check) thêm một hàng `sampleRow('Khách C', { growth: -0.62, growthState: 'check' })`; `rows[0][7]` kỳ vọng `/^-100%$/`; `td.is-lost` đếm 1 và `td.is-check` đếm 1; `pcgStatus` kỳ vọng `'3 dòng khớp · 1 giảm hết 100% · 1 giảm hơn 50%'` (3 hàng gồm cả `Khách B` mặc định `up`); `pcgRowsTag` `'3 dòng'`.
6. Mọi chỗ khác dùng chuỗi `'cần check'`, `'check'` làm nhóm đỏ cũ (test "loc: debounce...", "nut Xuat file...", "trang thai...") cập nhật cho khớp: giá trị dropdown `'check'` vẫn hợp lệ (nay là cam); nếu một test kiểm `exportState().context.growthGroup === 'check'` thì giữ nguyên.
7. Test CSS: thay assert `.pcg-table td.is-check ... var(--red)` bằng:

```js
  assert.match(css, /\.pcg-table td\.is-lost[^{]*\{[^}]*var\(--red\)/);
  assert.match(css, /\.pcg-table td\.is-check[^{]*\{[^}]*var\(--orange\)/);
  assert.match(css, /\.pcg-table td\.is-drop[^{]*\{[^}]*var\(--yellow\)/);
  assert.doesNotMatch(css, /pcg-flag/);
```

8. Thêm test token màu:

```js
test('shared.css: --orange va --yellow co o ca khoi Toi lan khoi Sang (moi token xuat hien it nhat 2 lan)', () => {
  const css = fs.readFileSync(path.join(publicDir, 'shared', 'shared.css'), 'utf8');
  ['--orange', '--yellow'].forEach(token => {
    assert.ok((css.match(new RegExp('\\s' + token + ':\\s*#[0-9A-Fa-f]{6}', 'g')) || []).length >= 2, token);
  });
  assert.match(css, /--orange:#FB923C/);
  assert.match(css, /--orange:#C2410C/);
  assert.match(css, /--yellow:#FACC15/);
  assert.match(css, /--yellow:#A16207/);
});
```

- [ ] **Step 2: Chạy để thấy thất bại**

Run: `cd server && NODE_PATH=D:/tks_web/server/node_modules GOOGLE_SERVICE_ACCOUNT_JSON='{}' JWT_SECRET=test-secret node --test test/frontend/product-customer-growth.test.js`
Expected: FAIL (ô chưa có lớp `is-lost`, dropdown 5 mục, CSS chưa có `--orange`/`--yellow`, token chưa có).

- [ ] **Step 3: Thêm token màu vào `shared.css`**

Trong `server/public/shared/shared.css`, ngay sau dòng `--amber:#F59E0B;` (khối Tối) thêm:

```css
  --orange:#FB923C;
  --yellow:#FACC15;
```

và ngay sau dòng `--amber:#D97706;` (khối Sáng) thêm:

```css
  --orange:#C2410C;
  --yellow:#A16207;
```

(Giữ đúng thụt lề 2 dấu cách của các dòng kế bên.)

- [ ] **Step 4: Sửa module giao diện**

Trong `server/public/product-customer-growth.js`:

a) Comment đầu file: thay cụm `dưới −50% là "Cần check" (chữ đỏ + nhãn)` bằng `ba mức màu theo %: đỏ ≤ −100% (không còn doanh số), cam −100%..−50%, vàng −50%..0 (chỉ hiện %)`.

b) `GROWTH_OPTIONS`:

```js
  const GROWTH_OPTIONS = [
    ['all', 'Tất cả'], ['lost', 'Giảm hết 100%'], ['check', 'Giảm hơn 50%'], ['drop', 'Giảm dưới 50%'],
    ['up', 'Đang tăng'], ['new', 'Khách mới']
  ];
```

c) Thay hàm `growthCellHtml` (và comment ngay trên nó) bằng:

```js
  // lost/check/drop → chỉ hiện %, tô đỏ / cam / vàng (lớp is-lost / is-check / is-drop) kèm title mô tả mức; new → nhãn "Mới";
  // không tính được → "—"; tăng (up) chỉ hiện % không màu.
  const TIER_TITLES = { lost: 'Giảm hết 100%', check: 'Giảm hơn 50%', drop: 'Giảm dưới 50%' };
  function growthCellHtml(row) {
    const state = row ? row.growthState : null;
    const n = toNumber(row ? row.growth : null);
    if (state === 'new') return '<td class="col-num pcg-growth"><span class="pcg-new" title="Chưa có doanh số 2 kỳ trước">Mới</span></td>';
    if (n === null || !state) return '<td class="col-num pcg-growth">' + muted() + '</td>';
    const tier = TIER_TITLES[state];
    return '<td class="col-num pcg-growth' + (tier ? ' is-' + state : '') + '"' + (tier ? ' title="' + tier + '"' : '') + '>' +
      '<span class="pcg-pct">' + escapeHtml(formatGrowth(n)) + '</span></td>';
  }
```

d) Trong `renderMeta`: thay `const check = ...` và biểu thức dòng trạng thái:

```js
    const lost = ok && d.summary ? Number(d.summary.lostRows) || 0 : 0;
    const check = ok && d.summary ? Number(d.summary.checkRows) || 0 : 0;
```

```js
      : ok ? NUMBER.format(total) + ' dòng khớp · ' + NUMBER.format(lost) + ' giảm hết 100% · ' + NUMBER.format(check) + ' giảm hơn 50%' : '';
```

e) Fallback trong `fetchPage`: `summary: { totalRows: 0, lostRows: 0, checkRows: 0 }`.

- [ ] **Step 5: Sửa CSS**

Trong `server/public/product-customer-growth.css`: xóa rule `.pcg-flag { ... }` (cả khối nhiều dòng) và thay dòng `.pcg-table td.is-check { color: var(--red); font-weight: 600; }` cùng comment phía trên bằng:

```css
/* Tăng trưởng: chỉ ô này đổi màu theo mức giảm, luôn kèm số %. Đỏ = giảm hết 100%, cam = giảm hơn 50%, vàng = giảm dưới 50%. */
.pcg-table td.is-lost { color: var(--red); font-weight: 600; }
.pcg-table td.is-check { color: var(--orange); font-weight: 600; }
.pcg-table td.is-drop { color: var(--yellow); }
```

Giữ `.pcg-new`. Cập nhật comment đầu file nếu nhắc "nhãn Cần check".

- [ ] **Step 6: Sửa dropdown trong `index.html`**

Thay 5 `<option>` của `<select id="pcgGrowth">` bằng:

```html
            <option value="all">Tất cả</option>
            <option value="lost">Giảm hết 100%</option>
            <option value="check">Giảm hơn 50%</option>
            <option value="drop">Giảm dưới 50%</option>
            <option value="up">Đang tăng</option>
            <option value="new">Khách mới</option>
```

(giữ nguyên thụt lề hiện tại; file dùng CRLF — chỉnh bằng công cụ Edit, không viết lại cả file.)

- [ ] **Step 7: Chạy test để thấy pass**

Run: `cd server && NODE_PATH=D:/tks_web/server/node_modules GOOGLE_SERVICE_ACCOUNT_JSON='{}' JWT_SECRET=test-secret node --test test/frontend/product-customer-growth.test.js test/frontend/export-ui.test.js test/frontend/dashboard-section-layout.test.js test/frontend/expected-arrivals.test.js`
Expected: PASS toàn bộ.

- [ ] **Step 8: Chạy bộ test rộng, so tên lỗi**

Run: `cd server && NODE_PATH=D:/tks_web/server/node_modules GOOGLE_SERVICE_ACCOUNT_JSON='{}' JWT_SECRET=test-secret node --test "test/frontend/**/*.test.js" "dashboard/**/*.test.js" 2>&1 | tail -40`
Expected: chỉ đúng 2 lỗi nền theo tên (xem Global Constraints). Báo mọi lỗi khác theo tên.

- [ ] **Step 9: Commit**

```bash
git add server/public server/test/frontend
git commit -m "feat(hang-hoa): ba muc mau do/cam/vang cho cot Tang truong, loc Giam het 100%

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Tài liệu và đồng bộ spec gốc

**Files:**
- Modify: `docs/superpowers/specs/2026-11-06-product-customer-growth-section-design.md`
- Modify: `CURRENT.md`, `README.md`, `server/README.md`, `server/db/SCHEMA.md`, `docs/04-planning/implementation_plan.md`, `docs/02-srs/SRS_Dashboard_GoogleSheets.md`, `docs/01-brd/BRD_Dashboard_GoogleSheets.md`

**Interfaces:** không có.

- [ ] **Step 1: Spec gốc trỏ sang spec mới**

Ngay dưới dòng "Ngày: ... Trạng thái: ..." của spec gốc thêm một đoạn: "**Cập nhật 06/11/2026:** các mục 3 (công thức/nhóm), 4 (dropdown, tô đỏ, dòng trạng thái) và 5 (`summary`, tham số `growth`) đã được thay bằng `2026-11-06-growth-color-tiers-design.md` (ba mức màu đỏ/cam/vàng, nhóm `lost`, bỏ nhãn Cần check)." Không sửa phần còn lại của spec gốc.

- [ ] **Step 2: Cập nhật tài liệu đồng bộ (CLAUDE.md §3)**

Dùng `grep -n "Cần check\|checkRows\|customer-growth" <file>` để tìm chỗ cần sửa, đọc `.agents/skills/update-file/SKILL.md` và làm theo. Nội dung:
- `CURRENT.md`: thêm một dòng đầu danh sách (mẫu `> 06/11/2026 — **...**`) nêu: ba mức màu (đỏ ≤ −100%, cam −100%..−50%, vàng −50%..0), bỏ nhãn "Cần check", nhóm lọc mới `lost` "Giảm hết 100%" và "Giảm hơn 50%" nay chỉ là phần cam, `summary.lostRows`, token `--orange`/`--yellow` trong `shared.css`, nhãn/ghi chú xuất file mới; lý do: kỳ là 30 ngày cuốn chiếu nên T.này = 0 là tín hiệu mạnh nhất, trước đó 53% dòng bị đỏ. Ghi kết quả test thật (số đạt/đỏ theo tên). Việc tiếp: deploy; người dùng còn chưa chọn đổi sắp xếp phụ khi tăng trưởng hòa nhau và độ trễ gõ 150→300 ms. Sửa các câu cũ trong CURRENT.md nhắc "Cần check" của bảng này nếu chúng còn là mô tả hiện hành (giữ nguyên nhật ký lịch sử, chỉ thêm "(đã thay bằng ba mức màu, xem dòng 06/11/2026 mới nhất)").
- `README.md` và `server/README.md`: cập nhật mô tả bảng và bảng API (`growth` nhận `all|lost|check|drop|up|new`; `summary = {totalRows, lostRows, checkRows}`).
- `server/db/SCHEMA.md`: một dòng "Không đổi schema" cho thay đổi này.
- `docs/04-planning/implementation_plan.md`, SRS, BRD: cập nhật quy tắc màu/nhóm lọc cho khớp spec mới.
- Cuối mỗi tài liệu: ngày cập nhật 06/11/2026.

- [ ] **Step 3: Chạy test kết quả cuối + graphify**

Run: `cd server && NODE_PATH=D:/tks_web/server/node_modules GOOGLE_SERVICE_ACCOUNT_JSON='{}' JWT_SECRET=test-secret node --test "test/frontend/**/*.test.js" "dashboard/**/*.test.js" 2>&1 | tail -30`
Expected: đúng 2 lỗi nền theo tên. Ghi số thật vào `CURRENT.md`. Rồi chạy `graphify update .` từ gốc worktree; nếu lỗi ghi nguyên văn vào `CURRENT.md` thay vì báo thành công.

- [ ] **Step 4: Commit**

```bash
git add CURRENT.md README.md server/README.md server/db/SCHEMA.md docs graphify-out
git commit -m "docs(hang-hoa): cap nhat tai lieu ba muc mau cot Tang truong

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

(Nếu `graphify-out` không có thay đổi hoặc bị bỏ qua, chỉ `git add` các file có thay đổi.)

---

## Self-Review

**Spec coverage:** mục 2 phân nhóm → Task 1 Step 3 + test; mục 3 dropdown → Task 2 Step 4b/Step 6; mục 4 hiển thị (chỉ %, tier lớp, title, token, dòng trạng thái) → Task 2; mục 5 API/xuất file (`lost`, `summary`, nhãn, ghi chú) → Task 1; mục 6 kiểm thử → các test trong từng task; mục 7 tài liệu → Task 3; mục 8 ngoài phạm vi → Global Constraints "Không đổi".

**Placeholder scan:** không có TBD/TODO; mọi sửa mã có code đầy đủ; các chỉnh test hiện có nêu rõ kỳ vọng mới từng test.

**Type consistency:** `growth_state` giá trị `lost|check|drop|up|new` thống nhất giữa SQL, `GROWTH_GROUPS`, `GROWTH_OPTIONS`, `TIER_TITLES`, `GROWTH_STATUS_LABELS`; `summary.lostRows`/`checkRows` (camelCase) thống nhất giữa repository, `renderMeta`, fallback, export notes; lớp CSS `is-lost`/`is-check`/`is-drop` thống nhất giữa `growthCellHtml` và CSS + test.
