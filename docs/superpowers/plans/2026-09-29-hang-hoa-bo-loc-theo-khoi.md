# Tab Hàng hóa: bộ lọc thời gian theo từng khối — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phần 3 "Phân tích doanh thu" của tab Hàng hóa luôn tính 90 ngày gần nhất; phần 5 "Hàng mới nhập" và phần 6 "Mã mới tạo" có bộ lọc thời gian riêng đặt trong khối; thanh lọc trên cùng ở tab Hàng hóa chỉ còn Trạng thái + tìm kiếm.

**Architecture:** Server tách một truy vấn doanh thu `daily_product_sales` thành ba khoảng độc lập: `pr` (Tổng quan), 90 ngày cố định (phần 3), `ni` (phần 5). Việc gom doanh thu được tách thành hàm thuần `aggregateProductSales()` và gọi một lần cho mỗi khoảng. Khai báo tab ở `dashboardViews.js` được sửa để tab Hàng hóa không chạy truy vấn `pr` và cache key không phụ thuộc khoảng `pr`. Client thêm hai khóa `state.filters.newlyImported` (`ni`) và `newProducts` (`np`), tái dùng component `.mini-filter` sẵn có.

**Tech Stack:** Node 22 + Express, `pg`; frontend HTML/JS thuần trong `server/public/index.html`; test `node:test` + `node:assert/strict`, frontend test bằng `jsdom`.

**Spec:** [docs/superpowers/specs/2026-09-29-hang-hoa-bo-loc-theo-khoi-design.md](../specs/2026-09-29-hang-hoa-bo-loc-theo-khoi-design.md)

## Global Constraints

- Làm trên nhánh `feature/sua-code`. Không commit/push lên `main`. Không `git push` khi người dùng chưa đồng ý.
- Không thêm dependency. Chạy test bằng `node --test` trong thư mục `server/`.
- Phần 3 cố định 90 ngày: hằng số `PRODUCT_ANALYSIS_DAYS = 90`, tính bằng `resolveFilterRange({ mode: 'days', days: 90 }, now)` (cùng ngữ nghĩa nút "90 ngày" cũ).
- Tiền tố query: `pr` = Tổng quan (khoảng thời gian), `prStatus` = trạng thái kinh doanh dùng chung Tổng quan + Hàng hóa, `ni` = Hàng mới nhập, `np` = Mã mới tạo.
- Mặc định mỗi bộ lọc mới: `{ mode: 'days', days: 30 }`.
- Trạng thái áp cho phần 1–5; phần 6 vẫn bỏ qua trạng thái (không đổi).
- Không đổi công thức tính. Tab Tổng quan giữ nguyên hành vi (payload và truy vấn như cũ).
- Comment trong JS viết không dấu như code hiện có; chữ hiển thị cho người dùng có dấu.
- Nhãn hiển thị chính xác: `doanh thu 90 ngày gần nhất`, `ngày nhập đầu tiên: <khoảng>`, `ngày tạo: <khoảng>`.
- Commit message theo kiểu repo (`feat(...)`, `refactor(...)`, `test(...)`, không dấu) và kết thúc bằng dòng `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

| File | Trách nhiệm | Task |
|---|---|---|
| `server/dashboard/dashboardData.js` | Hàm `aggregateProductSales`/`categorySalesRows`; khoảng `ni` và 90 ngày; truy vấn rollup; payload | 1, 2, 3 |
| `server/dashboard/dashboardViews.js` | Rollup/bộ lọc/payload của tab Hàng hóa; khóa ảo `productStatus` cho cache key | 2, 3 |
| `server/routes.js` | Đọc `niMode/niDays/niFrom/niTo` | 2 |
| `server/dashboard/exportService.js` | `normalizeFilters` nhận `newlyImported` | 4 |
| `server/public/index.html` | State/tiền tố/query/xuất file (Task 5); HTML thanh lọc, bộ lọc trong phần 5–6, nhãn (Task 6) | 5, 6 |
| `server/dashboard/dashboardData.test.js`, `dashboardViews.test.js`, `exportService.test.js`, `server/test/dashboard-route.test.js` | Test server | 1–4 |
| `server/test/frontend/dashboard-per-view-loading.test.js`, `dashboard-section-layout.test.js`, `export-ui.test.js` | Test giao diện | 5, 6 |
| `README.md`, `server/README.md` | Ghi chú thay đổi | 7 |

---

### Task 0: Chuẩn bị

**Files:** không sửa file.

- [ ] **Step 1: Kiểm tra nhánh và thay đổi mới trên `main`**

```bash
cd /d/tks_web
git branch --show-current
git status --short
git fetch origin
git log --oneline HEAD..origin/main -- server/
```

Expected: nhánh `feature/sua-code`, working tree sạch. Nếu lệnh cuối in ra commit (đồng nghiệp vừa sửa `server/` trên `main`), **dừng lại và báo người dùng** trước khi làm tiếp: các file của kế hoạch này (`dashboardData.js`, `index.html`) vừa được đồng nghiệp sửa lớn ở commit `4f7293e`, dễ xung đột.

- [ ] **Step 2: Chạy toàn bộ test để có mốc**

```bash
cd /d/tks_web/server
npm test 2>&1 | tail -15
```

Expected: ghi lại số `# pass` / `# fail`. Nếu đã có test fail từ trước, ghi tên lại; các task sau chỉ được phép không làm tăng số fail đó.

---

### Task 1: Tách hàm gom doanh thu (refactor, không đổi hành vi)

**Files:**
- Modify: `server/dashboard/dashboardData.js` — thêm hàm sau `limitParentCategoryBars` (~dòng 323–334); thay khối "SẢN PHẨM BÁN CHẠY" trong `computeDashboardData` (~dòng 2754–2868) và khối `newlyImportedByCategoryFull` (~dòng 2874–2881); thêm vào `__test__` (~dòng 3259)
- Test: `server/dashboard/dashboardData.test.js` (thêm cuối file)

**Interfaces:**
- Produces:
  - `aggregateProductSales(rows, lookups, includeCode?) -> { byCode, byTrimmedCode, byParent, childrenByParent }`
    - `rows`: mảng `{ code, name, qty, revenue }` (có thể `undefined`)
    - `lookups`: `{ productStatusFilter: 'all'|'Đang kinh doanh'|'Ngừng kinh doanh', productStatusByCode: Map, productParentCategoryByCode: Map, productChildCategoryByCode: Map }`
    - `includeCode(trimmedCode) -> boolean` (tùy chọn)
    - `byCode`: object khóa = mã gốc → `{ code, name, qty, revenue }`
    - `byTrimmedCode`: `Map` khóa = mã đã trim → `{ code, name, qty, revenue }`
    - `byParent`: object tên nhóm cha → `{ name, qty, revenue, productCodes: Set }`
    - `childrenByParent`: object nhóm cha → object nhóm con → `{ name, qty, revenue, productCodes: Set }`
  - `categorySalesRows(groups) -> Array<{ name, qty, revenue, productCount }>` sắp giảm dần theo doanh thu
  - Cả hai có trong `dashboardData.__test__`

- [ ] **Step 1: Viết test thất bại**

Thêm vào cuối `server/dashboard/dashboardData.test.js`:

```js
// ===== aggregateProductSales: gom doanh thu 1 tap dong daily_product_sales =====
test('aggregateProductSales gom theo ma/nhom cha/nhom con, bo ma rong, loc trang thai va includeCode', () => {
  const { dashboardData } = freshDashboardData();
  const { aggregateProductSales, categorySalesRows } = dashboardData.__test__;
  const lookups = {
    productStatusFilter: 'Đang kinh doanh',
    productStatusByCode: new Map([
      ['SP-1', 'Đang kinh doanh'], ['SP-2', 'Đang kinh doanh'], ['SP-3', 'Ngừng kinh doanh'], ['SP-4', 'Đang kinh doanh']
    ]),
    productParentCategoryByCode: new Map([['SP-1', 'NHÀ BẾP'], ['SP-2', 'NHÀ BẾP']]),
    productChildCategoryByCode: new Map([['SP-1', 'Nồi'], ['SP-2', 'Chảo']])
  };
  const rows = [
    { code: 'SP-1', name: 'Nồi một', qty: 2, revenue: 200 },
    { code: 'SP-2 ', name: 'Chảo hai', qty: 1, revenue: 50 },
    { code: 'SP-3', name: 'Đã ngừng', qty: 9, revenue: 900 },
    { code: 'SP-4', name: '', qty: 1, revenue: 10 },
    { code: '', name: 'Không mã', qty: 1, revenue: 1 }
  ];

  const all = aggregateProductSales(rows, lookups);
  assert.deepEqual(Object.keys(all.byCode), ['SP-1', 'SP-2 ', 'SP-4'], 'bo SP-3 (ngung kinh doanh) va dong khong ma');
  assert.deepEqual(all.byTrimmedCode.get('SP-2'), { code: 'SP-2 ', name: 'Chảo hai', qty: 1, revenue: 50 });
  assert.equal(all.byCode['SP-4'].name, 'SP-4', 'thieu ten thi dung ma');
  assert.deepEqual(categorySalesRows(all.byParent), [
    { name: 'NHÀ BẾP', qty: 3, revenue: 250, productCount: 2 },
    { name: 'Chưa xác định', qty: 1, revenue: 10, productCount: 1 }
  ]);
  assert.deepEqual(categorySalesRows(all.childrenByParent['NHÀ BẾP']).map(c => c.name), ['Nồi', 'Chảo']);
  assert.deepEqual(Object.keys(all.childrenByParent['Chưa xác định']), ['Chưa phân nhóm']);

  const onlySp1 = aggregateProductSales(rows, lookups, code => code === 'SP-1');
  assert.deepEqual(Object.keys(onlySp1.byCode), ['SP-1']);
  assert.deepEqual(aggregateProductSales(undefined, lookups).byCode, {});
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

```bash
cd /d/tks_web/server
node --test --test-name-pattern="aggregateProductSales" dashboard/dashboardData.test.js
```

Expected: FAIL, `TypeError: aggregateProductSales is not a function`.

- [ ] **Step 3: Thêm hai hàm**

Trong `server/dashboard/dashboardData.js`, ngay sau hàm `limitParentCategoryBars` (kết thúc bằng `});\n}` trước `const SEARCH_SOURCES = {`), thêm:

```js
// Gom doanh thu/SL ban theo ma hang, nhom cha va nhom con cho MOT tap dong
// daily_product_sales (1 khoang thoi gian). `includeCode(trimmedCode)` (tuy chon)
// chi gom cac ma thoa dieu kien, vd chi hang moi nhap.
// byCode (khoa = ma goc) giu dung khoa/thu tu nhu vong lap cu cho bang ban chay;
// byTrimmedCode (Map, khoa = ma da trim) dung de tra cuu theo ma.
function aggregateProductSales(rows, lookups, includeCode) {
  const { productStatusFilter, productStatusByCode, productParentCategoryByCode, productChildCategoryByCode } = lookups;
  const byCode = {};
  const byTrimmedCode = new Map();
  const byParent = {};
  const childrenByParent = {};
  (rows || []).forEach(row => {
    const code = row.code;
    if (!code) return;
    const trimmedCode = String(code).trim();
    if (productStatusFilter !== 'all' && productStatusByCode.get(trimmedCode) !== productStatusFilter) return;
    if (includeCode && !includeCode(trimmedCode)) return;

    const name = row.name || code;
    const qty = row.qty;
    const revenue = row.revenue;

    if (!byCode[code]) byCode[code] = { code, name, qty: 0, revenue: 0 };
    byCode[code].qty += qty;
    byCode[code].revenue += revenue;

    if (!byTrimmedCode.has(trimmedCode)) byTrimmedCode.set(trimmedCode, { code, name, qty: 0, revenue: 0 });
    const productSale = byTrimmedCode.get(trimmedCode);
    productSale.qty += qty;
    productSale.revenue += revenue;

    const parentCategoryName = productParentCategoryByCode.get(trimmedCode) || 'Chưa xác định';
    if (!byParent[parentCategoryName]) {
      byParent[parentCategoryName] = { name: parentCategoryName, qty: 0, revenue: 0, productCodes: new Set() };
    }
    byParent[parentCategoryName].qty += qty;
    byParent[parentCategoryName].revenue += revenue;
    byParent[parentCategoryName].productCodes.add(trimmedCode);

    const childCategoryName = productChildCategoryByCode.get(trimmedCode) || 'Chưa phân nhóm';
    if (!childrenByParent[parentCategoryName]) childrenByParent[parentCategoryName] = {};
    const children = childrenByParent[parentCategoryName];
    if (!children[childCategoryName]) {
      children[childCategoryName] = { name: childCategoryName, qty: 0, revenue: 0, productCodes: new Set() };
    }
    children[childCategoryName].qty += qty;
    children[childCategoryName].revenue += revenue;
    children[childCategoryName].productCodes.add(trimmedCode);
  });
  return { byCode, byTrimmedCode, byParent, childrenByParent };
}

// Nhom (co Set productCodes) -> dong payload, sap giam dan theo doanh thu.
function categorySalesRows(groups) {
  return Object.values(groups)
    .map(category => ({
      name: category.name,
      qty: category.qty,
      revenue: category.revenue,
      productCount: category.productCodes.size
    }))
    .sort((a, b) => b.revenue - a.revenue);
}
```

- [ ] **Step 4: Dùng hai hàm trong `computeDashboardData`**

Thay toàn bộ đoạn từ dòng `  // ---------- SẢN PHẨM BÁN CHẠY -> TOP SẢN PHẨM/NHÓM HÀNG (theo bộ lọc Hàng hóa) ----------` đến hết dòng `    .slice(0, NEWLY_IMPORTED_REVENUE_LIMIT);` (ngay trước comment `// ---------- HÀNG MỚI NHẬP -> DOANH THU BÁN THỰC TẾ THEO NHÓM HÀNG ----------`) bằng:

```js
  // ---------- SẢN PHẨM BÁN CHẠY -> TOP SẢN PHẨM/NHÓM HÀNG ----------
  // Nguon: daily_product_sales (rollup, da tong hop san theo ma hang, loai hoa
  // don status=2 "Đã hủy" tu luc refresh — xem
  // dashboardRollupRepository.getProductSalesBreakdown()). Nhom cha/con tra cuu qua
  // productParentCategoryByCode/productChildCategoryByCode (tab Hang hoa/Nhom hang).
  const salesLookups = { productStatusFilter, productStatusByCode, productParentCategoryByCode, productChildCategoryByCode };
  const productSales = aggregateProductSales(rollups.productSalesRows, salesLookups);
  const newlyImportedSales = aggregateProductSales(
    rollups.productSalesRows, salesLookups, code => newlyImportedCodeSet.has(code)
  );
  const allSellingProducts = Object.values(productSales.byCode)
    .sort((a, b) => b.revenue - a.revenue);
  const allSellingParentCategories = categorySalesRows(productSales.byParent);
  const topSellingProducts = allSellingProducts.slice(0, TOP_SELLING_LIMIT);
  const topSellingParentCategories = allSellingParentCategories.slice(0, TOP_SELLING_LIMIT);

  // ---------- DOANH THU/SL BÁN THEO NHÓM CON, GOM THEO TỪNG NHÓM CHA ----------
  // Dung cho phan "chon 1 nhom cha -> xem chi tiet nhom con" o tab Tong quan.
  const childCategorySalesByParent = {};
  Object.keys(productSales.childrenByParent).forEach(parentName => {
    childCategorySalesByParent[parentName] = categorySalesRows(productSales.childrenByParent[parentName]);
  });
  const availableParentCategories = Object.keys(parentCategoryMap).sort((a, b) => a.localeCompare(b, 'vi'));

  const newlyImportedRows = newlyImportedProducts.map(({ _sortTime, ...product }) => {
    const sales = newlyImportedSales.byTrimmedCode.get(String(product.code).trim());
    return {
      ...product,
      revenue: sales ? sales.revenue : 0
    };
  });
  const topNewlyImportedByRevenue = Array.from(newlyImportedSales.byTrimmedCode.values())
    .filter(product => product.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue || b.qty - a.qty || String(a.name).localeCompare(String(b.name), 'vi'))
    .slice(0, NEWLY_IMPORTED_REVENUE_LIMIT);
```

Ngay bên dưới, thay khối:

```js
  const newlyImportedByCategoryFull = Object.values(newlyImportedCategorySalesMap)
    .map(category => ({
      name: category.name,
      qty: category.qty,
      revenue: category.revenue,
      productCount: category.productCodes.size
    }))
    .sort((a, b) => b.revenue - a.revenue);
```

bằng:

```js
  const newlyImportedByCategoryFull = categorySalesRows(newlyImportedSales.byParent);
```

- [ ] **Step 5: Xuất hai hàm cho test**

Trong `module.exports.__test__` của `dashboardData.js`, thêm hai dòng ngay sau `__test__: {`:

```js
    aggregateProductSales,
    categorySalesRows,
```

- [ ] **Step 6: Chạy test**

```bash
cd /d/tks_web/server
node --test dashboard/dashboardData.test.js dashboard/dashboardViews.test.js dashboard/exportService.test.js test/dashboard-route.test.js
```

Expected: tất cả PASS. Đặc biệt test `tung tab: payload y het lat cat cua ban day du 6 tab` và các test "Ca hai … product rollup" vẫn xanh, chứng tỏ refactor không đổi output.

- [ ] **Step 7: Commit**

```bash
cd /d/tks_web
git add server/dashboard/dashboardData.js server/dashboard/dashboardData.test.js
git commit -m "$(cat <<'EOF'
refactor(dashboard): tach ham gom doanh thu san pham theo tung tap dong

aggregateProductSales() + categorySalesRows() thay vong lap gom chung, de
buoc sau goi rieng cho tung khoang thoi gian. Khong doi output.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Hàng mới nhập theo bộ lọc riêng `ni` (server)

**Files:**
- Modify: `server/routes.js` (~dòng 160, object `filters` trong `GET /api/dashboard`)
- Modify: `server/dashboard/dashboardViews.js` (`ALL_ROLLUPS`, `VIEW_SOURCES.products`, `VIEW_FILTER_KEYS.products`, danh sách thứ tự trong `resolveViewPlan`, `VIEW_PAYLOAD.products.filters`)
- Modify: `server/dashboard/dashboardData.js` (`mergeDashboardRollups`, `fetchDashboardRollups`, `shareDashboardRollupFetch`, `getDashboardData`, `computeDashboardData`)
- Test: `server/dashboard/dashboardViews.test.js`, `server/dashboard/dashboardData.test.js`, `server/test/dashboard-route.test.js`

**Interfaces:**
- Consumes: `aggregateProductSales`, `categorySalesRows` (Task 1)
- Produces:
  - `filters.newlyImported` (spec thời gian `{ mode, days?, from?, to? }`) là đầu vào của `getDashboardData`; route đọc từ `niMode/niDays/niFrom/niTo`
  - Rollup `'newlyImportedSales'` → trường `rollups.newlyImportedSalesRows`
  - Object `ranges` có thêm `newlyImportedRange`
  - Payload có `filters.newlyImported` (range, có `.label`); `products.newlyImported.label` = nhãn của khoảng `ni`

- [ ] **Step 1: Viết test thất bại — `dashboardViews.test.js`**

Trong test `moi tab chi doc dung nguon cua no; ...`, thay dòng:

```js
  assert.deepEqual([...resolveViewPlan(['products']).rollups].sort(), ['firstPurchase', 'productSales']);
```

bằng:

```js
  assert.deepEqual([...resolveViewPlan(['products']).rollups].sort(), ['firstPurchase', 'newlyImportedSales', 'productSales']);
  assert.deepEqual(resolveViewPlan(['products']).filterKeys, ['products', 'newlyImported', 'newProducts']);
```

Trong test `pickFilters: chi giu bo loc anh huong tab ...`, thêm `newlyImported: { mode: 'days', days: 14 },` vào object `filters` (sau `newPurchases`), rồi thêm cuối test:

```js
  // Bo loc Hang moi nhap chi doi khoa cua Hang hoa, khong doi khoa cua Tong quan.
  const niChanged = { ...filters, newlyImported: { mode: 'days', days: 7 } };
  assert.notDeepEqual(pickFilters(niChanged, resolveViewPlan(['products'])), pickFilters(filters, resolveViewPlan(['products'])));
  assert.deepEqual(pickFilters(niChanged, resolveViewPlan(['overview'])), pickFilters(filters, resolveViewPlan(['overview'])));
```

- [ ] **Step 2: Viết test thất bại — `dashboardData.test.js`**

(a) Trong test `getDashboardData: Hang moi nhap doc tu getFirstPurchaseDates (rollup), loc theo range + trang thai kinh doanh`, thay object `filters`:

```js
  const filters = {
    ...BASE_FILTERS,
    products: { mode: 'range', from: '2026-08-01', to: '2026-08-31', status: 'all' }
  };
```

bằng:

```js
  const filters = {
    ...BASE_FILTERS,
    // pr (bo loc Tong quan) co y dat ngoai khoang: Hang moi nhap chi theo ni.
    products: { mode: 'range', from: '2019-01-01', to: '2019-01-31', status: 'all' },
    newlyImported: { mode: 'range', from: '2026-08-01', to: '2026-08-31' }
  };
```

và đổi thông điệp `'SP-03 ngoai khoang productsRange va VAT01 la ma VAT deu bi loai'` thành `'SP-03 ngoai khoang ni va VAT01 la ma VAT deu bi loai'`.

(b) Trong test `getDashboardData: Top san pham ban chay + nhom hang doc tu getProductSalesBreakdown (rollup)`, thay ba dòng:

```js
  assert.equal(calls.length, 1);
  assert.equal(calls[0].from, '2026-08-01');
  assert.equal(calls[0].to, '2026-08-31');
```

bằng:

```js
  assert.ok(calls.some(call => call.from === '2026-08-01' && call.to === '2026-08-31'), 'co truy van theo khoang pr');
```

(c) Thêm test mới ngay sau test (a):

```js
test('getDashboardData: doanh thu Hang moi nhap lay tu truy van rieng theo khoang ni, khong theo pr', async () => {
  const { dashboardData, dashboardPgReader, dashboardRollupRepository } = freshDashboardData();
  const CONFIG = require('../config');
  mockPgSheets(dashboardPgReader, {
    [CONFIG.SHEET_PRODUCTS]: [PRODUCT_HEADERS, productRow({ code: 'SP-01', name: 'Sản phẩm một' })]
  });
  const calls = [];
  mockDashboardRollups(dashboardRollupRepository, {
    getFirstPurchaseDates: [{ code: 'SP-01', name: 'Sản phẩm một', firstPurchaseDateText: '10/07/2020 09:00:00' }],
    getProductSalesBreakdown: args => {
      calls.push(args);
      return args.from === '2020-07-01'
        ? [{ code: 'SP-01', name: 'Sản phẩm một', qty: 3, revenue: 300000 }]
        : [{ code: 'SP-01', name: 'Sản phẩm một', qty: 1, revenue: 1 }];
    }
  });
  dashboardData.__test__.resetCaches();

  const data = await dashboardData.getDashboardData({
    ...BASE_FILTERS,
    products: { mode: 'range', from: '2020-08-01', to: '2020-08-31' },
    newlyImported: { mode: 'range', from: '2020-07-01', to: '2020-07-31' }
  });

  assert.ok(calls.some(call => call.from === '2020-07-01' && call.to === '2020-07-31'), 'co truy van doanh thu rieng theo khoang ni');
  const info = data.products.newlyImported;
  assert.deepEqual(info.products.map(p => [p.code, p.revenue]), [['SP-01', 300000]]);
  assert.deepEqual(info.topByRevenue.map(p => p.revenue), [300000]);
  assert.equal(info.salesRevenue, 300000);
  assert.equal(info.salesQty, 3);
  assert.match(info.label, /01\/07\/2020/);
  assert.equal(data.filters.newlyImported.label, info.label);
});
```

- [ ] **Step 3: Viết test thất bại — `server/test/dashboard-route.test.js`**

Thêm cuối file:

```js
test('bo loc Hang moi nhap (ni*) doc rieng, khong lan voi pr/np', async () => {
  calls.length = 0;
  await dashboardHandler()(request({
    view: 'products', niMode: 'range', niFrom: '2026-07-01', niTo: '2026-07-31',
    npMode: 'days', npDays: '7', prStatus: 'Đang kinh doanh'
  }), fakeRes());

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].filters.newlyImported, { mode: 'range', days: undefined, from: '2026-07-01', to: '2026-07-31' });
  assert.equal(calls[0].filters.newProducts.days, '7');
  assert.equal(calls[0].filters.products.status, 'Đang kinh doanh');
  assert.deepEqual(calls[0].options, { views: ['products'] });
});
```

- [ ] **Step 4: Chạy test, xác nhận thất bại**

```bash
cd /d/tks_web/server
node --test dashboard/dashboardViews.test.js dashboard/dashboardData.test.js test/dashboard-route.test.js
```

Expected: FAIL ở test rollup/filterKeys của tab Hàng hóa, test `pickFilters` (notDeepEqual), hai test Hàng mới nhập (danh sách rỗng / doanh thu sai) và test route (`newlyImported` undefined).

- [ ] **Step 5: Sửa `server/routes.js`**

Trong object `filters` của `router.get('/api/dashboard', ...)`, ngay sau dòng `newPurchases: parseFilterSpec(req.query, 'pu'),` thêm:

```js
      // Tab Hang hoa phan 5 "Hang moi nhap" co bo loc thoi gian rieng.
      newlyImported: parseFilterSpec(req.query, 'ni'),
```

- [ ] **Step 6: Sửa `server/dashboard/dashboardViews.js`**

Thay `ALL_ROLLUPS`:

```js
const ALL_ROLLUPS = Object.freeze([
  'overviewRevenue', 'invoicesRevenue', 'productSales', 'newlyImportedSales', 'firstPurchase',
  'purchaseTotals', 'newPurchaseOrders', 'invoiceQuantity'
]);
```

Trong `VIEW_SOURCES`, thay khối `products`:

```js
  // newlyImportedSales: doanh thu hang moi nhap (phan 5) theo bo loc rieng ni.
  products: {
    sheets: [CONFIG.SHEET_CATEGORIES, CONFIG.SHEET_PRODUCTS],
    rollups: ['productSales', 'newlyImportedSales', 'firstPurchase'],
    needsDebt: false
  },
```

Trong `VIEW_FILTER_KEYS`, đổi dòng `products`:

```js
  products: ['products', 'newlyImported', 'newProducts'],
```

Trong `resolveViewPlan`, đổi danh sách thứ tự của `filterKeys`:

```js
  const filterKeys = unionInOrder(
    ['overview', 'products', 'invoices', 'customers', 'newPurchases', 'newlyImported', 'newProducts'],
    views.map(name => VIEW_FILTER_KEYS[name])
  );
```

Trong `VIEW_PAYLOAD.products`, đổi dòng `filters`:

```js
    filters: ['products', 'productStatus', 'newlyImported', 'newProducts']
```

- [ ] **Step 7: Sửa `server/dashboard/dashboardData.js`**

(a) `mergeDashboardRollups`: ngay sau khối `productSalesRows: mergeRollupRows(...)`, thêm:

```js
    newlyImportedSalesRows: mergeRollupRows(
      branchSources,
      'newlyImportedSalesRows',
      row => normalizeSearchValue(row.code),
      ['qty', 'revenue']
    ),
```

(b) Thay toàn bộ hàm `fetchDashboardRollups` (giữ nguyên comment phía trên, chỉ đổi câu cuối `Bo trong = du 7 truy van nhu cu.` thành `Bo trong = chay moi truy van trong ALL_ROLLUPS.`):

```js
async function fetchDashboardRollups(branch, { overviewRange, productsRange, newlyImportedRange, invoicesRange, newPurchasesRange }, plan) {
  const wanted = plan ? plan.rollups : new Set(ALL_ROLLUPS);
  const run = (name, load) => (wanted.has(name) ? load() : undefined);
  const overviewBounds = rangeToDateBounds(overviewRange);
  const invoicesBounds = rangeToDateBounds(invoicesRange);
  const productsBounds = rangeToDateBounds(productsRange);
  const newlyImportedBounds = rangeToDateBounds(newlyImportedRange);
  const newPurchasesBounds = rangeToDateBounds(newPurchasesRange);
  // Doanh thu theo ma hang (daily_product_sales) trong 1 khoang — moi khoang can thi goi 1 lan.
  const productSalesIn = bounds => dashboardRollupRepository.getProductSalesBreakdown({
    branch,
    from: bounds.from,
    to: bounds.to,
    preserveNameSource: true
  });

  const [
    overviewRevenueRows, invoicesRevenueRows, productSalesRows, newlyImportedSalesRows,
    firstPurchaseRows, purchaseTotals, newPurchaseOrdersRaw, invoiceQuantityRows
  ] = await Promise.all([
    run('overviewRevenue', () => dashboardRollupRepository.getInvoiceRevenueByDay({ branch, from: overviewBounds.from, to: overviewBounds.to })),
    run('invoicesRevenue', () => dashboardRollupRepository.getInvoiceRevenueByDay({ branch, from: invoicesBounds.from, to: invoicesBounds.to })),
    run('productSales', () => productSalesIn(productsBounds)),
    run('newlyImportedSales', () => productSalesIn(newlyImportedBounds)),
    run('firstPurchase', () => dashboardRollupRepository.getFirstPurchaseDates({ branch })),
    run('purchaseTotals', () => dashboardRollupRepository.getPurchaseTotals({ branch })),
    run('newPurchaseOrders', () => dashboardRollupRepository.listPurchaseOrders({ branch, from: newPurchasesBounds.from, to: newPurchasesBounds.to })),
    run('invoiceQuantity', () => dashboardRollupRepository.getInvoiceQuantitiesByCode({ branch, from: invoicesBounds.from, to: invoicesBounds.to }))
  ]);

  return {
    overviewRevenueRows, invoicesRevenueRows, productSalesRows, newlyImportedSalesRows,
    firstPurchaseRows, purchaseTotals, newPurchaseOrdersRaw, invoiceQuantityRows
  };
}
```

(c) `shareDashboardRollupFetch`: khóa dùng chung phải có khoảng `ni`, nếu không hai request khác `ni` sẽ dùng chung kết quả truy vấn:

```js
  const bounds = ['overviewRange', 'productsRange', 'newlyImportedRange', 'invoicesRange', 'newPurchasesRange']
    .map(name => rangeToDateBounds(ranges[name]));
```

(d) `getDashboardData`: thay hai dòng

```js
  const productsRange = resolveFilterRange(f.products, now);
```
```js
  const ranges = { overviewRange, productsRange, invoicesRange, newPurchasesRange };
```

bằng

```js
  const productsRange = resolveFilterRange(f.products, now);
  const newlyImportedRange = resolveFilterRange(f.newlyImported, now);
```
```js
  const ranges = { overviewRange, productsRange, newlyImportedRange, invoicesRange, newPurchasesRange };
```

(e) `computeDashboardData`:

- Ngay sau `const newProductsRange = resolveFilterRange(f.newProducts, now);` thêm:

```js
  const newlyImportedRange = resolveFilterRange(f.newlyImported, now);
```

- Trong khối "HÀNG MỚI NHẬP": đổi dòng tiêu đề comment `// ---------- HÀNG MỚI NHẬP (theo bộ lọc Hàng hóa) ----------` thành `// ---------- HÀNG MỚI NHẬP (theo bộ lọc riêng ni) ----------`, đổi `// ma chi xuat hien neu ngay nhap dau tien nam trong khoang cua tab Hang hoa` thành `// ma chi xuat hien neu ngay nhap dau tien nam trong khoang ni`, và đổi:

```js
    if (!importDate || !isWithinRange(importDate, productsRange)) return;
```

thành

```js
    if (!importDate || !isWithinRange(importDate, newlyImportedRange)) return;
```

- Trong đoạn gom doanh thu (Task 1), đổi nguồn dòng của `newlyImportedSales`:

```js
  const newlyImportedSales = aggregateProductSales(
    rollups.newlyImportedSalesRows, salesLookups, code => newlyImportedCodeSet.has(code)
  );
```

- Đổi comment `// Chi lay doanh thu cua nhung ma hang co ngay nhap dau tien nam trong productsRange` thành `// Chi lay doanh thu cua nhung ma hang co ngay nhap dau tien nam trong newlyImportedRange`.

- Trong object `result`: thêm vào `filters` ngay sau `products: productsRange,`:

```js
      newlyImported: newlyImportedRange,
```

và trong `products.newlyImported` đổi `label: productsRange.label,` thành `label: newlyImportedRange.label,`.

- [ ] **Step 8: Chạy test**

```bash
cd /d/tks_web/server
node --test dashboard/dashboardViews.test.js dashboard/dashboardData.test.js test/dashboard-route.test.js dashboard/exportService.test.js
```

Expected: tất cả PASS.

- [ ] **Step 9: Commit**

```bash
cd /d/tks_web
git add server/routes.js server/dashboard/dashboardViews.js server/dashboard/dashboardData.js server/dashboard/dashboardViews.test.js server/dashboard/dashboardData.test.js server/test/dashboard-route.test.js
git commit -m "$(cat <<'EOF'
feat(dashboard): Hang moi nhap theo bo loc thoi gian rieng (ni)

Route doc niMode/niDays/niFrom/niTo; danh sach hang moi nhap va doanh thu
cua chung tinh theo khoang ni bang 1 truy van daily_product_sales rieng,
khong con theo bo loc pr.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Phân tích doanh thu cố định 90 ngày; tab Hàng hóa bỏ phụ thuộc `pr` (server)

**Files:**
- Modify: `server/dashboard/dashboardData.js` (hằng số ~dòng 31, helper sau `rangeToDateBounds` ~dòng 255, `mergeDashboardRollups`, `fetchDashboardRollups`, `shareDashboardRollupFetch`, `getDashboardData`, `computeDashboardData`)
- Modify: `server/dashboard/dashboardViews.js` (`ALL_ROLLUPS`, `VIEW_SOURCES.products`, `VIEW_FILTER_KEYS.products`, `DERIVED_FILTER_KEYS` mới, `resolveViewPlan`, `pickFilters`, `VIEW_PAYLOAD.products`)
- Test: `server/dashboard/dashboardViews.test.js`, `server/dashboard/dashboardData.test.js`

**Interfaces:**
- Consumes: `aggregateProductSales`, `categorySalesRows` (Task 1); `newlyImportedRange`, `productSalesIn`, rollup `'newlyImportedSales'` (Task 2)
- Produces:
  - `PRODUCT_ANALYSIS_DAYS = 90`, `resolveProductAnalysisRange(now) -> range`
  - Rollup `'productSales90d'` → `rollups.productSales90dRows`; `ranges.productAnalysisRange`
  - Kế hoạch tab `products`: `rollups = ['productSales90d', 'newlyImportedSales', 'firstPurchase']`, `filterKeys = ['productStatus', 'newlyImported', 'newProducts']`
  - Payload tab `products`: `filters = { productStatus, newlyImported, newProducts }` (không còn `filters.products`); `products` chỉ gồm `newProducts, topSellingProducts, topSellingParentCategories, allSellingProducts, allSellingParentCategories, newlyImported`

- [ ] **Step 1: Viết test thất bại — `dashboardViews.test.js`**

(a) Trong test `moi tab chi doc dung nguon cua no; ...`, thay hai dòng của tab products (đã sửa ở Task 2) bằng:

```js
  assert.deepEqual([...resolveViewPlan(['products']).rollups].sort(), ['firstPurchase', 'newlyImportedSales', 'productSales90d']);
  assert.deepEqual(resolveViewPlan(['products']).filterKeys, ['productStatus', 'newlyImported', 'newProducts']);
```

(b) Trong test `pickFilters: ...`, đổi `products: { mode: 'days', days: 7 }` trong object `filters` thành `products: { mode: 'days', days: 7, status: 'all' }` rồi thêm cuối test:

```js
  // Hang hoa chi phu thuoc trang thai cua `products`, khong phu thuoc khoang pr (bo loc Tong quan).
  const productsPlan = resolveViewPlan(['products']);
  assert.deepEqual(pickFilters(filters, productsPlan), {
    productStatus: 'all', newlyImported: { mode: 'days', days: 14 }, newProducts: { mode: 'days', days: 30 }
  });
  const prChanged = { ...filters, products: { mode: 'days', days: 90, status: 'all' } };
  assert.deepEqual(pickFilters(prChanged, productsPlan), pickFilters(filters, productsPlan));
  const statusChanged = { ...filters, products: { ...filters.products, status: 'Đang kinh doanh' } };
  assert.notDeepEqual(pickFilters(statusChanged, productsPlan), pickFilters(filters, productsPlan));
```

(c) Trong test `pickPayload: ...`: thêm `newlyImported: 7` vào `full.filters`, rồi thay ba dòng

```js
  const products = pickPayload(full, resolveViewPlan(['products']));
  assert.equal(products.products, full.products, 'tab Hang hoa lay nguyen ca khoa products');
```
```js
  const both = pickPayload(full, resolveViewPlan(['overview', 'products']));
  assert.equal(both.products, full.products, 'khi co ca Hang hoa thi products day du thang partial cua Tong quan');
```

bằng

```js
  const products = pickPayload(full, resolveViewPlan(['products']));
  assert.deepEqual(products.products, { allSellingProducts: [1, 2, 3] },
    'tab Hang hoa chi lay truong cua no, khong keo doanh thu nhom con (theo pr) cua Tong quan');
  assert.deepEqual(products.filters, { productStatus: 'all', newlyImported: 7, newProducts: 6 });
```
```js
  const both = pickPayload(full, resolveViewPlan(['overview', 'products']));
  assert.deepEqual(Object.keys(both.products).sort(), ['allSellingProducts', 'availableParentCategories', 'childCategorySalesByParent'],
    'Tong quan + Hang hoa: gop truong cua ca hai tab');
```

(giữ nguyên các dòng `assert.deepEqual(products.lowStock, [1]);`, `assert.equal(products.invoices, undefined);`, `assert.equal(both.overview.a, 1);`).

- [ ] **Step 2: Viết test thất bại — `dashboardData.test.js`**

(a) Thay **toàn bộ** test `getDashboardData: Top san pham ban chay + nhom hang doc tu getProductSalesBreakdown (rollup)` bằng:

```js
test('getDashboardData: Phan tich doanh thu tab Hang hoa luon 90 ngay gan nhat, nhom con Tong quan van theo pr', async () => {
  const { dashboardData, dashboardPgReader, dashboardRollupRepository } = freshDashboardData();
  const CONFIG = require('../config');
  const productWithCategory = (code, name) => {
    const row = productRow({ code, name });
    row[2] = 'Đồ uống'; // Nhóm hàng (ten)
    row[11] = '1'; // Mã nhóm hàng (id) — khop id nhom cha trong CATEGORY_HEADERS
    return row;
  };
  mockPgSheets(dashboardPgReader, {
    [CONFIG.SHEET_CATEGORIES]: [CATEGORY_HEADERS, categoryRow({ id: '1', name: 'Đồ uống' })],
    [CONFIG.SHEET_PRODUCTS]: [
      PRODUCT_HEADERS,
      productWithCategory('SP-01', 'Sản phẩm một'),
      productWithCategory('SP-02', 'Sản phẩm hai')
    ]
  });
  const calls = [];
  mockDashboardRollups(dashboardRollupRepository, {
    getProductSalesBreakdown: (args) => {
      calls.push(args);
      if (args.from === '2020-08-01') return [{ code: 'SP-01', name: 'Sản phẩm một', qty: 1, revenue: 7 }]; // pr cua Tong quan
      return [
        { code: 'SP-01', name: 'Sản phẩm một', qty: 5, revenue: 500000 },
        { code: 'SP-02', name: 'Sản phẩm hai', qty: 2, revenue: 100000 }
      ];
    }
  });
  dashboardData.__test__.resetCaches();

  const filters = { ...BASE_FILTERS, products: { mode: 'range', from: '2020-08-01', to: '2020-08-31' } };
  const data = await dashboardData.getDashboardData(filters);

  const spanDays = call => (Date.parse(call.to) - Date.parse(call.from)) / 86400000 + 1;
  assert.ok(calls.some(call => call.from && spanDays(call) === 90), 'co 1 truy van dung 90 ngay cho phan Phan tich');
  assert.deepEqual(
    data.products.topSellingProducts.map(p => [p.code, p.revenue]),
    [['SP-01', 500000], ['SP-02', 100000]],
    'Phan tich doc tu truy van 90 ngay, khong phai pr'
  );
  assert.equal(data.products.allSellingProducts.length, 2);
  assert.equal(data.products.topSellingParentCategories.length, 1);
  assert.equal(data.products.topSellingParentCategories[0].revenue, 600000);
  assert.equal(data.products.childCategorySalesByParent['Đồ uống'][0].revenue, 7, 'nhom con cua Tong quan van theo pr');
});
```

(b) Thêm test sau test `tung tab: cache tach rieng — ...`:

```js
test('tung tab: Hang hoa khong phu thuoc khoang pr cua Tong quan (khong truy van pr, doi pr van trung cache)', async () => {
  const ctx = freshDashboardData();
  installRichViewFixture(ctx);
  const salesCalls = [];
  const original = ctx.dashboardRollupRepository.getProductSalesBreakdown;
  ctx.dashboardRollupRepository.getProductSalesBreakdown = async (args) => { salesCalls.push(args); return original(args); };
  ctx.dashboardData.__test__.resetCaches();
  const { dashboardData } = ctx;
  const compute = () => dashboardData.__test__.getComputeCallCount();
  const filters = { ...BASE_FILTERS, products: { mode: 'range', from: '2020-01-01', to: '2020-01-31', status: 'all' } };

  const data = await dashboardData.getDashboardData(filters, undefined, VIEW_TEST_VIEWER, { views: ['products'] });
  assert.equal(salesCalls.length, 2, 'Hang hoa = 90 ngay (Phan tich) + ni (Hang moi nhap)');
  assert.ok(salesCalls.every(call => call.from !== '2020-01-01'), 'khong truy van theo pr');
  assert.equal(data.products.childCategorySalesByParent, undefined, 'nhom con la cua Tong quan');
  assert.equal(data.filters.products, undefined);
  assert.equal(data.filters.productStatus, 'all');
  assert.equal(compute(), 1);

  await dashboardData.getDashboardData({ ...filters, products: { mode: 'days', days: 7, status: 'all' } },
    undefined, VIEW_TEST_VIEWER, { views: ['products'] });
  assert.equal(compute(), 1, 'doi khoang pr khong lam tinh lai tab Hang hoa');

  await dashboardData.getDashboardData({ ...filters, products: { mode: 'days', days: 7, status: 'Đang kinh doanh' } },
    undefined, VIEW_TEST_VIEWER, { views: ['products'] });
  assert.equal(compute(), 2, 'doi trang thai kinh doanh thi tinh lai');
});
```

- [ ] **Step 3: Chạy test, xác nhận thất bại**

```bash
cd /d/tks_web/server
node --test dashboard/dashboardViews.test.js dashboard/dashboardData.test.js
```

Expected: FAIL ở rollup/filterKeys tab Hàng hóa, `pickFilters`, `pickPayload`, test 90 ngày (không có truy vấn 90 ngày; top theo pr = 7) và test cache (`salesCalls.length` = 2 nhưng có call `from: '2020-01-01'`, `childCategorySalesByParent` còn có).

- [ ] **Step 4: Sửa `server/dashboard/dashboardViews.js`**

Thay `ALL_ROLLUPS`:

```js
const ALL_ROLLUPS = Object.freeze([
  'overviewRevenue', 'invoicesRevenue', 'productSales', 'productSales90d', 'newlyImportedSales', 'firstPurchase',
  'purchaseTotals', 'newPurchaseOrders', 'invoiceQuantity'
]);
```

Trong `VIEW_SOURCES`, thay khối `products` (gồm comment đã thêm ở Task 2):

```js
  // productSales90d: phan 3 "Phan tich doanh thu", co dinh 90 ngay. newlyImportedSales:
  // phan 5 "Hang moi nhap" theo bo loc ni. KHONG chay productSales (theo pr) — do la
  // bo loc cua Tong quan.
  products: {
    sheets: [CONFIG.SHEET_CATEGORIES, CONFIG.SHEET_PRODUCTS],
    rollups: ['productSales90d', 'newlyImportedSales', 'firstPurchase'],
    needsDebt: false
  },
```

Thay `VIEW_FILTER_KEYS.products` và thêm `DERIVED_FILTER_KEYS` ngay sau object `VIEW_FILTER_KEYS`:

```js
  // Hang hoa chi phu thuoc TRANG THAI cua `products` (khoa ao productStatus, xem
  // DERIVED_FILTER_KEYS); khoang thoi gian pr la bo loc cua Tong quan.
  products: ['productStatus', 'newlyImported', 'newProducts'],
```

```js
// Khoa "ao" trong VIEW_FILTER_KEYS: lay 1 phan cua bo loc khac lam cache key.
const DERIVED_FILTER_KEYS = Object.freeze({
  productStatus: filters => (filters.products ? filters.products.status : undefined)
});
```

Trong `resolveViewPlan`, đổi danh sách thứ tự:

```js
  const filterKeys = unionInOrder(
    ['overview', 'products', 'productStatus', 'invoices', 'customers', 'newPurchases', 'newlyImported', 'newProducts'],
    views.map(name => VIEW_FILTER_KEYS[name])
  );
```

Thay thân `pickFilters`:

```js
function pickFilters(filters, plan) {
  const source = filters || {};
  if (plan.all) return source;
  const picked = {};
  plan.filterKeys.forEach(key => {
    const value = DERIVED_FILTER_KEYS[key] ? DERIVED_FILTER_KEYS[key](source) : source[key];
    if (value !== undefined) picked[key] = value;
  });
  return picked;
}
```

Thay `VIEW_PAYLOAD.products`:

```js
  products: {
    top: ['lowStock', 'stockValueByCategory', 'allProducts', 'stockByCategory'],
    // Khong lay childCategorySalesByParent/availableParentCategories: do la doanh thu
    // theo nhom hang cua Tong quan (theo bo loc pr).
    nested: {
      products: [
        'newProducts', 'topSellingProducts', 'topSellingParentCategories',
        'allSellingProducts', 'allSellingParentCategories', 'newlyImported'
      ]
    },
    kpi: [
      'totalProducts', 'totalStock', 'inStockCodes', 'activeProducts', 'inactiveProducts',
      'lowStockCount', 'totalInventoryValue', 'inventoryValueCategoryCount'
    ],
    filters: ['productStatus', 'newlyImported', 'newProducts']
  },
```

- [ ] **Step 5: Sửa `server/dashboard/dashboardData.js`**

(a) Ngay sau `const TOP_SELLING_LIMIT = 15;` thêm:

```js
const PRODUCT_ANALYSIS_DAYS = 90; // Phan tich doanh thu (tab Hang hoa phan 3): luon 90 ngay gan nhat, khong theo bo loc
```

(b) Ngay sau hàm `rangeToDateBounds`, thêm:

```js
// Khoang cua phan "Phan tich doanh thu" tab Hang hoa — y het nut "90 ngày" cua bo loc.
function resolveProductAnalysisRange(now) {
  return resolveFilterRange({ mode: 'days', days: PRODUCT_ANALYSIS_DAYS }, now);
}
```

(c) `mergeDashboardRollups`: sau khối `newlyImportedSalesRows: mergeRollupRows(...)` (Task 2), thêm:

```js
    productSales90dRows: mergeRollupRows(
      branchSources,
      'productSales90dRows',
      row => normalizeSearchValue(row.code),
      ['qty', 'revenue']
    ),
```

(d) `fetchDashboardRollups`:
- Chữ ký: `async function fetchDashboardRollups(branch, { overviewRange, productsRange, productAnalysisRange, newlyImportedRange, invoicesRange, newPurchasesRange }, plan) {`
- Sau `const productsBounds = rangeToDateBounds(productsRange);` thêm `const productAnalysisBounds = rangeToDateBounds(productAnalysisRange);`
- Trong mảng destructure và trong object `return`, đổi `productSalesRows, newlyImportedSalesRows,` thành `productSalesRows, productSales90dRows, newlyImportedSalesRows,`
- Trong `Promise.all([...])`, ngay sau dòng `run('productSales', ...)` thêm:

```js
    run('productSales90d', () => productSalesIn(productAnalysisBounds)),
```

(e) `shareDashboardRollupFetch`:

```js
  const bounds = ['overviewRange', 'productsRange', 'productAnalysisRange', 'newlyImportedRange', 'invoicesRange', 'newPurchasesRange']
    .map(name => rangeToDateBounds(ranges[name]));
```

(f) `getDashboardData`: sau dòng `const newlyImportedRange = ...` (Task 2) thêm `const productAnalysisRange = resolveProductAnalysisRange(now);` và đổi `ranges`:

```js
  const ranges = { overviewRange, productsRange, productAnalysisRange, newlyImportedRange, invoicesRange, newPurchasesRange };
```

(g) `computeDashboardData`: thay dòng

```js
  const productSales = aggregateProductSales(rollups.productSalesRows, salesLookups);
```

bằng

```js
  // Tong quan (doanh thu theo nhom hang/nhom con): theo bo loc pr.
  const overviewSales = aggregateProductSales(rollups.productSalesRows, salesLookups);
  // Tab Hang hoa phan 3 "Phan tich doanh thu": co dinh PRODUCT_ANALYSIS_DAYS ngay.
  const analysisSales = aggregateProductSales(rollups.productSales90dRows, salesLookups);
```

rồi đổi các chỗ dùng:
- `Object.values(productSales.byCode)` → `Object.values(analysisSales.byCode)`
- `categorySalesRows(productSales.byParent)` → `categorySalesRows(analysisSales.byParent)`
- `Object.keys(productSales.childrenByParent)` → `Object.keys(overviewSales.childrenByParent)`
- `categorySalesRows(productSales.childrenByParent[parentName])` → `categorySalesRows(overviewSales.childrenByParent[parentName])`

Sau khi sửa, `grep -n "productSales\." server/dashboard/dashboardData.js` không được còn kết quả.

- [ ] **Step 6: Chạy test**

```bash
cd /d/tks_web/server
node --test dashboard/dashboardViews.test.js dashboard/dashboardData.test.js dashboard/exportService.test.js test/dashboard-route.test.js
```

Expected: tất cả PASS, gồm `tung tab: payload y het lat cat cua ban day du 6 tab (mot co so va "Ca hai")` (xác nhận `nested.products` khai báo đúng trường).

- [ ] **Step 7: Commit**

```bash
cd /d/tks_web
git add server/dashboard/dashboardViews.js server/dashboard/dashboardData.js server/dashboard/dashboardViews.test.js server/dashboard/dashboardData.test.js
git commit -m "$(cat <<'EOF'
feat(dashboard): Phan tich doanh thu tab Hang hoa co dinh 90 ngay

Phan 3 doc truy van daily_product_sales 90 ngay rieng (productSales90d).
Tab Hang hoa khong con chay truy van pr, cache key chi theo trang thai +
ni + np, payload khong keo doanh thu nhom con cua Tong quan.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Xuất file nhận bộ lọc `newlyImported`

**Files:**
- Modify: `server/dashboard/exportService.js` (`normalizeFilters`, ~dòng 107–124)
- Test: `server/dashboard/exportService.test.js` (thêm cuối file)

**Interfaces:**
- Consumes: `getDashboardData` đọc `filters.newlyImported` (Task 2)
- Produces: `normalizeFilters(raw).newlyImported` luôn là spec hợp lệ; client cũ không gửi thì lấy từ `raw.products`

- [ ] **Step 1: Viết test thất bại**

Thêm cuối `server/dashboard/exportService.test.js`:

```js
test('normalizeFilters: Hang moi nhap co bo loc rieng, client cu khong gui thi dung bo loc products', () => {
  const { normalizeFilters } = exportService.__test__;
  const own = normalizeFilters({
    products: { mode: 'days', days: 7, status: 'Đang kinh doanh' },
    newlyImported: { mode: 'range', from: '2026-07-01', to: '2026-07-31' }
  });
  assert.deepEqual(own.newlyImported, { mode: 'range', from: '2026-07-01', to: '2026-07-31' });
  assert.deepEqual(own.products, { mode: 'days', days: 7, status: 'Đang kinh doanh' });
  assert.deepEqual(normalizeFilters({ products: { mode: 'days', days: 7 } }).newlyImported, { mode: 'days', days: 7 });
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

```bash
cd /d/tks_web/server
node --test --test-name-pattern="normalizeFilters" dashboard/exportService.test.js
```

Expected: FAIL, `own.newlyImported` là `undefined`.

- [ ] **Step 3: Sửa `normalizeFilters`**

Trong object `return` của `normalizeFilters`, ngay trước dòng `newProducts: normalizeFilterSpec(raw.newProducts || overview)`, thêm:

```js
    // Hang moi nhap (tab Hang hoa phan 5) co bo loc rieng; client cu chua gui thi dung bo loc products nhu truoc.
    newlyImported: normalizeFilterSpec(raw.newlyImported || raw.products),
```

- [ ] **Step 4: Chạy test**

```bash
cd /d/tks_web/server
node --test dashboard/exportService.test.js
```

Expected: tất cả PASS.

- [ ] **Step 5: Commit**

```bash
cd /d/tks_web
git add server/dashboard/exportService.js server/dashboard/exportService.test.js
git commit -m "$(cat <<'EOF'
feat(export): xuat Hang moi nhap theo bo loc rieng newlyImported

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Client gửi bộ lọc theo khối (state, query, xuất file)

**Files:**
- Modify: `server/public/index.html` — `state.filters` (~dòng 4989), `currentExportFilters` (~dòng 6353), `TAB_FILTER_PREFIXES` + comment (~dòng 7369–7377), `buildMiniFilterQuery` (~dòng 7459–7461), `VIEW_FILTER_SOURCES` + comment (~dòng 9387–9396), các lời gọi `syncMiniFilterUI` lúc khởi động (~dòng 9742–9745)
- Test: `server/test/frontend/dashboard-per-view-loading.test.js`, `server/test/frontend/dashboard-section-layout.test.js`, `server/test/frontend/export-ui.test.js`

**Interfaces:**
- Consumes: server đọc `niMode/niDays/niFrom/niTo`, `npMode/...`, `prStatus` (Task 2–3)
- Produces:
  - `state.filters.newlyImported`, `state.filters.newProducts` (mặc định `{ mode: 'days', days: 30 }`); `state.filters.products` từ nay chỉ là bộ lọc của Tổng quan
  - `setMiniFilterDays/setMiniFilterAll/applyMiniFilterRange('newlyImported' | 'newProducts', ...)` dùng được (Task 6 gắn nút vào)
  - Query tab products: `view=products&days=30&niMode=…&niDays=…&npMode=…&npDays=…&prStatus=…` (không có `pr` khoảng thời gian)

- [ ] **Step 1: Viết test thất bại — `dashboard-per-view-loading.test.js`**

(a) Trong `payloadFor`, thay nhánh `case 'products':` bằng payload đúng như server trả sau Task 3:

```js
    case 'products':
      return {
        updatedAt: marker,
        kpi: { totalProducts: 4, totalStock: 120, inStockCodes: 3, activeProducts: 3, inactiveProducts: 1, lowStockCount: 1, totalInventoryValue: 5000, inventoryValueCategoryCount: 1 },
        filters: { productStatus: 'all', newlyImported: filters('30 ngày'), newProducts: filters('30 ngày') },
        products: {
          newProducts: { label: '30 ngày', count: 0, dateColumnAvailable: true, products: [] },
          topSellingProducts: [], topSellingParentCategories: [], allSellingProducts: [{ code: 'SP-1', name: 'Bán chạy', qty: 2, revenue: 200000 }],
          allSellingParentCategories: [],
          newlyImported: { label: '30 ngày', count: 0, products: [], topByRevenue: [], salesByCategory: [], countByCategory: [], salesRevenue: 0, salesQty: 0 }
        },
        lowStock: [], stockValueByCategory: [], stockByCategory: [],
        allProducts: [{ code: 'SP-1', name: 'Sản phẩm một', stock: 5, reserved: 0, status: 'Đang kinh doanh', cost: 1000, stockValue: 5000, pct: 100 }]
      };
```

(b) Thay **toàn bộ** test `doi bo loc Hoa don khong lam Tong quan tai lai, nhung doi bo loc Hang hoa lam Tong quan (dung chung bo loc) tai lai khi mo` bằng hai test:

```js
test('doi bo loc Hoa don khong lam Tong quan tai lai', async () => {
  const page = createPage();
  await settle();
  page.run("switchView('invoices')");
  await settle();
  page.run("setMiniFilterDays('invoices', 7)");
  await settle();
  const before = page.calls.length;

  page.run("switchView('overview')");
  await settle();
  assert.equal(page.calls.length, before, 'chu ky Tong quan khong gom bo loc Hoa don -> khong tai lai');
});

test('Hang hoa gui ni/np + trang thai (khong gui khoang pr); bo loc ni/np va pr khong lam tab kia tai lai', async () => {
  const page = createPage();
  await settle();
  page.run("switchView('products')");
  await settle();
  assert.equal(page.calls[page.calls.length - 1].url,
    '/api/dashboard?view=products&days=30&niMode=days&niDays=30&npMode=days&npDays=30&prStatus=all');

  page.run("setMiniFilterDays('newlyImported', 7)");
  await settle();
  assert.match(page.calls[page.calls.length - 1].url, /view=products&days=30&niMode=days&niDays=7&npMode=days&npDays=30&prStatus=all$/);
  page.run("setMiniFilterAll('newProducts')");
  await settle();
  assert.match(page.calls[page.calls.length - 1].url, /niDays=7&npMode=all&prStatus=all$/);
  const afterProducts = page.calls.length;

  page.run("switchView('overview')");
  await settle();
  assert.equal(page.calls.length, afterProducts, 'ni/np khong thuoc Tong quan -> Tong quan khong tai lai');

  page.run("setMiniFilterDays('products', 7)");
  await settle();
  assert.match(page.calls[page.calls.length - 1].url, /view=overview.*prDays=7/);
  const afterOverview = page.calls.length;
  page.run("switchView('products')");
  await settle();
  assert.equal(page.calls.length, afterOverview, 'khoang pr cua Tong quan khong lam tab Hang hoa tai lai');
});
```

(Giữ nguyên test `doi trang thai kinh doanh (Hang hoa) tai lai tab Hang hoa va danh dau Tong quan cu …`: trạng thái vẫn dùng chung nên test đó phải tiếp tục xanh.)

- [ ] **Step 2: Viết test thất bại — `dashboard-section-layout.test.js`**

Thay **toàn bộ** test `tham số bộ lọc gửi backend: pu theo Nhà cung cấp, np theo Hàng hóa, không còn ov/de` bằng:

```js
test('tham số bộ lọc gửi backend: pr cho Tổng quan, ni cho Hàng mới nhập, np cho Mã mới tạo', () => {
  const match = html.match(/const TAB_FILTER_PREFIXES = \{([\s\S]*?)\};/);
  assert.ok(match, 'phai co TAB_FILTER_PREFIXES');
  const map = new Function('return {' + match[1] + '}')();
  assert.deepEqual(map.products, ['pr']);
  assert.deepEqual(map.newlyImported, ['ni']);
  assert.deepEqual(map.newProducts, ['np']);
  assert.deepEqual(map.invoices, ['in']);
  assert.deepEqual(map.suppliers, ['pu']);
  assert.equal(map.overview, undefined);
});
```

- [ ] **Step 3: Viết test thất bại — `export-ui.test.js`**

Thêm cuối file:

```js
test('xuat file gui bo loc rieng cua tung khoi: Hang moi nhap (ni), Ma moi tao (np), Tong quan (pr)', async () => {
  const h = createExportDashboard();
  h.win.eval("setMiniFilterDays('newlyImported', 7)");
  h.win.eval("setMiniFilterAll('newProducts')");
  h.win.eval("setMiniFilterDays('products', 90)");

  h.win.openExportDialog('products.newly-imported');
  const body = h.fieldsCalls().pop().body;
  assert.deepEqual(body.filters.newlyImported, { mode: 'days', days: 7 });
  assert.deepEqual(body.filters.newProducts, { mode: 'all' });
  assert.deepEqual(body.filters.products, { mode: 'days', days: 90, status: 'all' });
  h.win.close();
});
```

- [ ] **Step 4: Chạy test, xác nhận thất bại**

```bash
cd /d/tks_web/server
node --test test/frontend/dashboard-per-view-loading.test.js test/frontend/dashboard-section-layout.test.js test/frontend/export-ui.test.js
```

Expected: FAIL ở test query tab Hàng hóa (còn `prMode`), test `TAB_FILTER_PREFIXES` và test xuất file (`newlyImported` undefined, `newProducts` = bộ lọc products).

- [ ] **Step 5: Sửa `server/public/index.html` — state**

Trong `state`, thay object `filters`:

```js
      filters: {
        // Bo loc thoi gian cua Tong quan (doanh thu theo nhom hang), tien to pr.
        products: { mode: 'days', days: 30 },
        // Tab Hang hoa: phan 5 Hang moi nhap (ni) va phan 6 Ma moi tao (np).
        newlyImported: { mode: 'days', days: 30 },
        newProducts: { mode: 'days', days: 30 },
        invoices: { mode: 'days', days: 30 },
        suppliers: { mode: 'days', days: 30 },
        customers: { mode: 'all' }
      },
```

(Cache sessionStorage cũ không có hai khóa mới vẫn chạy: lúc khởi động đã gộp `Object.assign({}, state.filters, dashboardCache.filters)`.)

- [ ] **Step 6: Sửa `TAB_FILTER_PREFIXES` và `buildMiniFilterQuery`**

Thay comment + hằng số (bắt đầu bằng `// Moi tab nho mot bo loc thoi gian doc lap;`):

```js
    // Moi khoa cua state.filters la 1 bo loc thoi gian doc lap, gui backend bang tien to
    // rieng: products = Tong quan (pr, doanh thu theo nhom hang), newlyImported = Hang
    // hoa phan 5 (ni), newProducts = Hang hoa phan 6 (np). Hoa don: in (gom bang chi
    // tiet giao dich). Nha cung cap: pu (phieu nhap hang). Khach hang: cu.
    // Phan 3 "Phan tich doanh thu" cua Hang hoa co dinh 90 ngay nen khong co bo loc.
    const TAB_FILTER_PREFIXES = {
      products: ['pr'],
      newlyImported: ['ni'],
      newProducts: ['np'],
      invoices: ['in'],
      suppliers: ['pu'],
      customers: ['cu']
    };
```

Trong `buildMiniFilterQuery`, thay:

```js
      if (!filterKeys || filterKeys.indexOf('products') !== -1) {
        parts.push('prStatus=' + encodeURIComponent(state.productStatus));
      }
```

bằng:

```js
      // Trang thai kinh doanh dung chung Tong quan + Hang hoa. Khoa 'productStatus' chi gui
      // prStatus (khong gui khoang pr) — tab Hang hoa dung khoa nay.
      if (!filterKeys || filterKeys.indexOf('products') !== -1 || filterKeys.indexOf('productStatus') !== -1) {
        parts.push('prStatus=' + encodeURIComponent(state.productStatus));
      }
```

- [ ] **Step 7: Sửa `VIEW_FILTER_SOURCES`**

```js
    // Bo loc (khoa cua state.filters) anh huong tung tab — khop VIEW_FILTER_KEYS phia server.
    // Hang hoa chi gui trang thai ('productStatus') + ni + np, khong gui khoang pr cua Tong quan.
    const VIEW_FILTER_SOURCES = {
      overview: ['products'],
      products: ['productStatus', 'newlyImported', 'newProducts'],
      invoices: ['invoices'],
      customers: ['customers'],
      suppliers: ['suppliers'],
      debt: []
    };
```

- [ ] **Step 8: Sửa `currentExportFilters`**

```js
    function currentExportFilters() {
      const products = cloneExportFilter(state.filters.products);
      products.status = state.productStatus;
      return {
        products: products,
        invoices: cloneExportFilter(state.filters.invoices),
        customers: cloneExportFilter(state.filters.customers, 'all'),
        newPurchases: cloneExportFilter(state.filters.suppliers),
        newlyImported: cloneExportFilter(state.filters.newlyImported),
        newProducts: cloneExportFilter(state.filters.newProducts)
      };
    }
```

- [ ] **Step 9: Đồng bộ nút lúc khởi động**

Ngay sau dòng `syncMiniFilterUI('products');` (cuối script) thêm:

```js
    syncMiniFilterUI('newlyImported');
    syncMiniFilterUI('newProducts');
```

- [ ] **Step 10: Chạy test**

```bash
cd /d/tks_web/server
node --test test/frontend/
```

Expected: tất cả PASS. Riêng test `mỗi tab có thời gian lọc riêng: Tổng quan dùng chung bộ lọc Hàng hóa cho phần nhóm hàng` vẫn xanh ở task này (HTML thanh lọc chưa đổi) và sẽ được thay ở Task 6.

- [ ] **Step 11: Commit**

```bash
cd /d/tks_web
git add server/public/index.html server/test/frontend/dashboard-per-view-loading.test.js server/test/frontend/dashboard-section-layout.test.js server/test/frontend/export-ui.test.js
git commit -m "$(cat <<'EOF'
feat(ui): tab Hang hoa gui bo loc ni/np rieng, khong gui khoang pr

state.filters them newlyImported/newProducts; tab Hang hoa chi gui trang
thai + ni + np; xuat file gui bo loc rieng cua tung khoi.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Giao diện — thanh trên, bộ lọc trong phần 5 và 6, nhãn

**Files:**
- Modify: `server/public/index.html` — nhóm lọc thời gian trong `#filterBar` (~dòng 3470), tiêu đề phần 3 (~dòng 4054), đầu phần 5 (~dòng 4179–4183), đầu phần 6 (~dòng 4231–4235), `renderView('products')` (~dòng 8780–8782, ~8824, ~8851)
- Test: `server/test/frontend/dashboard-section-layout.test.js`

**Interfaces:**
- Consumes: `state.filters.newlyImported/newProducts` và các hàm `setMiniFilterDays/All`, `applyMiniFilterRange`, `focusMiniFilterRange`, `syncMiniFilterUI` (Task 5); payload `products.newlyImported.label`, `products.newProducts.label`
- Produces: phần tử `#newProductsPeriod`; `.mini-filter[data-filter-key="newlyImported"]` trong phần 5 và `[data-filter-key="newProducts"]` trong phần 6; input `#miniFrom-newlyImported`, `#miniTo-newlyImported`, `#miniFrom-newProducts`, `#miniTo-newProducts`

- [ ] **Step 1: Viết test thất bại**

Trong `server/test/frontend/dashboard-section-layout.test.js`, thay **toàn bộ** test `mỗi tab có thời gian lọc riêng: Tổng quan dùng chung bộ lọc Hàng hóa cho phần nhóm hàng` bằng:

```js
test('bộ lọc thời gian: thanh trên chỉ ở Tổng quan; Hàng hóa có bộ lọc riêng trong phần 5 và 6, Trạng thái vẫn dùng chung', () => {
  const groupsOf = name => [...document.querySelectorAll('#filterBar .filter-group')]
    .filter(group => (group.dataset.filterView || '').split(/\s+/).includes(name));
  assert.ok(groupsOf('overview').some(group => group.querySelector('.mini-filter[data-filter-key="products"]')),
    'Tong quan giu bo loc thoi gian cho phan doanh thu theo nhom hang');
  assert.equal(groupsOf('products').some(group => group.querySelector('.mini-filter')), false,
    'thanh tren o Hang hoa khong con bo loc thoi gian');
  assert.ok(groupsOf('products').some(group => group.querySelector('#productStatusToggle')),
    'Trang thai van o thanh tren cua Hang hoa');

  const sections = [...view('products').querySelectorAll(':scope > section.section')];
  const filterIn = (section, key) => section.querySelector('.mini-filter[data-filter-key="' + key + '"]');
  assert.ok(filterIn(sections[4], 'newlyImported'), 'phan 5 co bo loc rieng');
  assert.ok(filterIn(sections[5], 'newProducts'), 'phan 6 co bo loc rieng');
  assert.equal(sections[2].querySelector('.mini-filter'), null, 'phan 3 khong co bo loc thoi gian');
  assert.equal(document.getElementById('productAnalysisPeriod').textContent, 'doanh thu 90 ngày gần nhất');

  ['products', 'newlyImported', 'newProducts', 'invoices', 'suppliers', 'customers'].forEach(key => {
    assert.ok(document.getElementById('miniFrom-' + key), 'thieu o Tu ngay cua ' + key);
    assert.ok(document.getElementById('miniTo-' + key), 'thieu o Den ngay cua ' + key);
  });
  ['invoices', 'suppliers', 'customers'].forEach(name => assert.ok(groupsOf(name).length, name + ' phai co nhom loc'));
});
```

Và thêm test render sau test `render: giao dịch hiện ở Hóa đơn, phiếu nhập ở Nhà cung cấp, mã mới tạo ở Hàng hóa`:

```js
test('render: phần 3 luôn ghi 90 ngày; phần 5/6 ghi khoảng của bộ lọc riêng, không theo bộ lọc Tổng quan', () => {
  const payload = samplePayload();
  payload.filters = { products: { label: '7 ngày' } };
  payload.products.newlyImported.label = '01/07/2026 – 31/07/2026';
  payload.products.newProducts.label = 'Tất cả';
  const dom = createRenderedDashboard(payload);
  const text = id => dom.window.document.getElementById(id).textContent;

  dom.window.eval("switchView('products')");
  assert.equal(text('productAnalysisPeriod'), 'doanh thu 90 ngày gần nhất');
  assert.equal(text('newlyImportedPeriod'), 'ngày nhập đầu tiên: 01/07/2026 – 31/07/2026');
  assert.equal(text('newProductsPeriod'), 'ngày tạo: Tất cả');
  assert.match(text('newlyImportedRows'), /01\/07\/2026 – 31\/07\/2026/, 'thong bao rong dung khoang ni');
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

```bash
cd /d/tks_web/server
node --test test/frontend/dashboard-section-layout.test.js
```

Expected: FAIL (thanh trên ở Hàng hóa còn bộ lọc thời gian; không có `.mini-filter` trong phần 5/6; không có `#newProductsPeriod`; nhãn phần 3 là `doanh thu trong 30 ngày`).

- [ ] **Step 3: Sửa thanh lọc trên cùng**

Thay:

```html
          <div class="filter-group" data-filter-view="overview products" hidden>
            <div class="mini-filter" data-filter-key="products" style="margin:0; grid-row:3;">
```

bằng:

```html
          <div class="filter-group" data-filter-view="overview" hidden>
            <div class="mini-filter" data-filter-key="products" style="margin:0; grid-row:3;">
```

(Nhóm `#productStatusToggle` giữ `data-filter-view="overview products"`.)

- [ ] **Step 4: Sửa nhãn phần 3**

Thay:

```html
              <h2>Phân tích <span class="section-note" id="productAnalysisPeriod">doanh thu trong 30 ngày</span></h2>
```

bằng:

```html
              <h2>Phân tích <span class="section-note" id="productAnalysisPeriod">doanh thu 90 ngày gần nhất</span></h2>
```

- [ ] **Step 5: Thêm bộ lọc vào đầu phần 5**

Thay:

```html
            <div class="section-head"><span class="section-step">5</span>
              <h2>Hàng mới nhập <span class="section-note" id="newlyImportedPeriod">ngày nhập đầu tiên trong 30
                  ngày</span></h2>
            </div>
```

bằng:

```html
            <div class="section-head"><span class="section-step">5</span>
              <h2>Hàng mới nhập <span class="section-note" id="newlyImportedPeriod">ngày nhập đầu tiên: 30 ngày</span></h2>
            </div>
            <div class="mini-filter" data-filter-key="newlyImported">
              <div class="period-toggle" data-mini-toggle role="group" aria-label="Khoảng thời gian: Hàng mới nhập">
                <button type="button" data-days="1" onclick="setMiniFilterDays('newlyImported',1)">1 ngày</button>
                <button type="button" data-days="7" onclick="setMiniFilterDays('newlyImported',7)">7 ngày</button>
                <button type="button" data-days="30" class="active" onclick="setMiniFilterDays('newlyImported',30)">30 ngày</button>
                <button type="button" data-days="90" onclick="setMiniFilterDays('newlyImported',90)">90 ngày</button>
                <button type="button" data-custom onclick="focusMiniFilterRange('newlyImported')">Tùy chọn</button>
                <button type="button" data-all onclick="setMiniFilterAll('newlyImported')">Tất cả</button>
              </div>
              <div class="mini-filter-range">
                <input type="date" class="mini-date" id="miniFrom-newlyImported" aria-label="Từ ngày (Hàng mới nhập)">
                <span class="mini-filter-sep">đến</span>
                <input type="date" class="mini-date" id="miniTo-newlyImported" aria-label="Đến ngày (Hàng mới nhập)">
                <button type="button" class="mini-filter-apply" onclick="applyMiniFilterRange('newlyImported')">Áp dụng</button>
              </div>
            </div>
```

- [ ] **Step 6: Thêm bộ lọc vào đầu phần 6**

Thay:

```html
            <div class="section-head"><span class="section-step">6</span>
              <h2>Mã mới tạo <span class="section-note">các mã hàng có Ngày tạo trong khoảng thời gian đã chọn ở
                  trên</span></h2>
            </div>
```

bằng:

```html
            <div class="section-head"><span class="section-step">6</span>
              <h2>Mã mới tạo <span class="section-note" id="newProductsPeriod">ngày tạo: 30 ngày</span></h2>
            </div>
            <div class="mini-filter" data-filter-key="newProducts">
              <div class="period-toggle" data-mini-toggle role="group" aria-label="Khoảng thời gian: Mã mới tạo">
                <button type="button" data-days="1" onclick="setMiniFilterDays('newProducts',1)">1 ngày</button>
                <button type="button" data-days="7" onclick="setMiniFilterDays('newProducts',7)">7 ngày</button>
                <button type="button" data-days="30" class="active" onclick="setMiniFilterDays('newProducts',30)">30 ngày</button>
                <button type="button" data-days="90" onclick="setMiniFilterDays('newProducts',90)">90 ngày</button>
                <button type="button" data-custom onclick="focusMiniFilterRange('newProducts')">Tùy chọn</button>
                <button type="button" data-all onclick="setMiniFilterAll('newProducts')">Tất cả</button>
              </div>
              <div class="mini-filter-range">
                <input type="date" class="mini-date" id="miniFrom-newProducts" aria-label="Từ ngày (Mã mới tạo)">
                <span class="mini-filter-sep">đến</span>
                <input type="date" class="mini-date" id="miniTo-newProducts" aria-label="Đến ngày (Mã mới tạo)">
                <button type="button" class="mini-filter-apply" onclick="applyMiniFilterRange('newProducts')">Áp dụng</button>
              </div>
            </div>
```

- [ ] **Step 7: Sửa `renderView('products')`**

Thay ba dòng đầu nhánh `else if (view === 'products') {`:

```js
        const productRangeLabel = d.filters && d.filters.products ? d.filters.products.label : '30 ngày';
        document.getElementById('productAnalysisPeriod').textContent = 'doanh thu: ' + productRangeLabel;
        document.getElementById('newlyImportedPeriod').textContent = 'ngày nhập đầu tiên: ' + productRangeLabel;
```

bằng:

```js
        // Phan 3 co dinh 90 ngay (nhan tinh trong HTML); phan 5/6 theo bo loc rieng cua khoi.
        const newlyImportedLabel = (d.products && d.products.newlyImported && d.products.newlyImported.label) || '30 ngày';
        document.getElementById('newlyImportedPeriod').textContent = 'ngày nhập đầu tiên: ' + newlyImportedLabel;
```

Thay:

```js
          'Không có mã hàng mới nhập · ' + escapeHtml(productRangeLabel)
```

bằng:

```js
          'Không có mã hàng mới nhập · ' + escapeHtml(newlyImportedLabel)
```

Ngay sau dòng `document.getElementById('tagTodayNewProductsDate').textContent = todayNewProducts.label || '—';` thêm:

```js
        document.getElementById('newProductsPeriod').textContent = 'ngày tạo: ' + (todayNewProducts.label || '—');
```

Sau khi sửa, `grep -n "productRangeLabel" server/public/index.html` không được còn kết quả.

- [ ] **Step 8: Chạy test giao diện**

```bash
cd /d/tks_web/server
node --test test/frontend/
```

Expected: tất cả PASS.

- [ ] **Step 9: Commit**

```bash
cd /d/tks_web
git add server/public/index.html server/test/frontend/dashboard-section-layout.test.js
git commit -m "$(cat <<'EOF'
feat(ui): bo loc thoi gian rieng trong phan Hang moi nhap va Ma moi tao

Thanh tren o tab Hang hoa chi con Trang thai + tim kiem; bo loc thoi gian
tren thanh chi con o Tong quan. Phan 3 ghi co dinh 90 ngay gan nhat.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Tài liệu, kiểm tra toàn bộ, kiểm tra bằng mắt

**Files:**
- Modify: `server/README.md` (mục "API báo cáo tổng hợp theo tab", sau dòng bullet cuối ~dòng 23)
- Modify: `README.md` (mục "Cập nhật gần nhất", ~dòng 74–76)

- [ ] **Step 1: Ghi chú tham số bộ lọc trong `server/README.md`**

Thêm bullet cuối mục "API báo cáo tổng hợp theo tab":

```markdown
- Bộ lọc thời gian theo khối: `pr*` = Tổng quan (doanh thu theo nhóm hàng), `ni*` = Hàng hóa › Hàng mới nhập, `np*` = Hàng hóa › Mã mới tạo; `prStatus` là trạng thái kinh doanh dùng chung Tổng quan + Hàng hóa. Hàng hóa › Phân tích doanh thu luôn 90 ngày gần nhất (`PRODUCT_ANALYSIS_DAYS`), không nhận bộ lọc.
```

- [ ] **Step 2: Ghi chú thay đổi trong `README.md`**

Thêm đoạn mới ngay dưới tiêu đề `## Cập nhật gần nhất` (trước đoạn `2026-09-23 — ...`):

```markdown
2026-09-29 — tab Hàng hóa: phần Phân tích doanh thu cố định 90 ngày gần nhất; Hàng mới nhập (`ni*`) và Mã mới tạo (`np*`) có bộ lọc thời gian riêng đặt trong từng phần; thanh lọc trên cùng ở tab Hàng hóa chỉ còn Trạng thái + tìm kiếm, bộ lọc thời gian trên thanh chỉ còn ở Tổng quan (`pr*`).
```

- [ ] **Step 3: Chạy toàn bộ test**

```bash
cd /d/tks_web/server
npm test 2>&1 | tail -15
```

Expected: `# fail` không lớn hơn mốc ghi ở Task 0 Step 2; mọi test của các file đã sửa đều PASS.

- [ ] **Step 4: Kiểm tra bằng mắt (cần server local có `.env` + Supabase; nếu không chạy được, ghi rõ là chưa kiểm tra và để người dùng tự làm)**

```bash
cd /d/tks_web/server
npm run dev
```

Mở `http://localhost:3000/reports/#products` (đăng nhập bằng tài khoản thật của người dùng — **không** tự nhập mật khẩu; nhờ người dùng đăng nhập). Kiểm tra:
1. Thanh trên cùng ở tab Hàng hóa chỉ có ô tìm kiếm + Trạng thái; mở tab Tổng quan thì bộ lọc thời gian xuất hiện lại.
2. Tiêu đề phần 3 ghi "doanh thu 90 ngày gần nhất"; đổi bộ lọc ở Tổng quan không làm số phần 3 đổi.
3. Phần 5 và 6 mỗi phần có dãy nút 1/7/30/90 ngày/Tùy chọn/Tất cả; bấm ở phần 5 thì nhãn phần 5 đổi, nhãn phần 6 giữ nguyên, và ngược lại. "Tùy chọn" hiện ô Từ ngày/Đến ngày + Áp dụng.
4. Đổi Trạng thái vẫn đổi phần 1–5.
5. Bề rộng 375px (`resize_window` preset mobile) và chế độ tối: bộ lọc xuống dòng gọn, không tràn ngang, nút đủ lớn để bấm.
6. Xuất file "Hàng mới nhập" khi phần 5 đang chọn 7 ngày: file chỉ có mã có ngày nhập đầu tiên trong 7 ngày.
7. Mở DevTools Network: request `/api/dashboard?view=products…` không có `prMode`; ghi lại thời gian phản hồi (so với trước khi sửa nếu có số).

- [ ] **Step 5: Commit tài liệu**

```bash
cd /d/tks_web
git add README.md server/README.md
git commit -m "$(cat <<'EOF'
docs: ghi chu bo loc thoi gian theo khoi cua tab Hang hoa

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Hỏi người dùng về bước tiếp theo**

Không tự `git push`. Báo kết quả test + kiểm tra bằng mắt, rồi hỏi người dùng có muốn push `feature/sua-code` và mở Pull Request vào `main` để đồng nghiệp review không.
