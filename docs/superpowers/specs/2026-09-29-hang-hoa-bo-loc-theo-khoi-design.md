# Tab Hàng hóa: phần 3 cố định 90 ngày, bộ lọc thời gian theo từng khối

## Bối cảnh

Tab **Hàng hóa** hiện dùng chung một bộ lọc thời gian (`state.filters.products`,
thanh lọc cố định trên cùng) cho ba khối và cả tab Tổng quan:

- Phần 3 "Phân tích doanh thu" (top sản phẩm/nhóm cha bán chạy).
- Phần 5 "Hàng mới nhập" (lọc theo ngày nhập đầu tiên, kèm doanh thu).
- Phần 6 "Mã mới tạo" (lọc theo Ngày tạo).
- Tab Tổng quan, khối "Doanh thu sản phẩm theo nhóm hàng" — cùng object
  `state.filters.products`, nên đổi ngày ở Hàng hóa cũng đổi biểu đồ của Tổng quan.

Nguyên nhân là lựa chọn tiện lợi lúc viết code, không phải ràng buộc kỹ thuật:

- Client gửi một bộ lọc `products` cho cả hai tiền tố `pr` và `np`
  (`TAB_FILTER_PREFIXES.products = ['pr', 'np']`, `server/public/index.html`).
- Server dùng một `productsRange` cho một truy vấn `productSales` duy nhất, dùng
  chung cho phần 3, cột Doanh thu của phần 5 và biểu đồ nhóm hàng của Tổng quan
  (`fetchDashboardRollups`, `server/dashboard/dashboardData.js`).

Người dùng chỉ cần phần 3 xem 90 ngày, không cần 1/7/30 ngày, nhưng vẫn bị thanh lọc
trên cùng ảnh hưởng.

## Quyết định (đã thống nhất)

1. **Phần 3 cố định 90 ngày gần nhất**, không có bộ lọc thời gian.
2. **Phần 5 và 6 mỗi khối một bộ lọc riêng**, đặt ngay trong đầu khối, mặc định 30 ngày
   như hiện nay.
3. **Thanh trên cùng ở tab Hàng hóa chỉ còn Trạng thái và ô tìm kiếm.** Bộ lọc thời gian
   trên thanh chỉ còn ở tab Tổng quan, nơi nó điều khiển khối doanh thu theo nhóm hàng.

Phương án đã loại:

- Chỉ đổi mặc định sang 90 ngày, vẫn dùng chung thanh trên: phần 3 vẫn bị ảnh hưởng.
- Bộ lọc riêng cả cho phần 3: thêm điều khiển không ai cần (YAGNI).
- Một bộ lọc chung cho phần 5 + 6 đặt trước phần 5: người dùng chọn tách hẳn từng khối.

## Ngoài phạm vi

- Phần 1, 2, 4 (chỉ số, cơ cấu tồn kho, hàng đã hết, tất cả mã hàng) là ảnh chụp tồn
  kho hiện tại, giữ nguyên.
- Bộ lọc Trạng thái giữ nguyên hành vi: áp cho phần 1–5, **phần 6 vẫn bỏ qua trạng thái**
  như hiện nay.
- Tab Tổng quan không đổi hành vi, ngoài việc không còn dùng chung state với Hàng hóa.
- Không đổi công thức tính, không thêm bộ lọc nào khác.

## Thiết kế

### Client (`server/public/index.html`)

- `state.filters`: giữ `products` (của Tổng quan, tiền tố `pr`), thêm
  `newlyImported` và `newProducts`, mỗi cái mặc định `{ mode: 'days', days: 30 }`.
- `TAB_FILTER_PREFIXES`: `products: ['pr']`, `newlyImported: ['ni']`,
  `newProducts: ['np']`. Cập nhật comment giải thích phía trên hằng số này.
- Nhóm lọc thời gian `products` trong `#filterBar` đổi `data-filter-view` từ
  `"overview products"` thành `"overview"`. Nhóm Trạng thái giữ `"overview products"`.
- Thêm hai instance `.mini-filter` (`data-filter-key="newlyImported"` và
  `"newProducts"`, id `miniFrom-*`/`miniTo-*` tương ứng) vào đầu khối phần 5 và 6. Tái
  dùng component và các hàm `setMiniFilterDays/All`, `applyMiniFilterRange`,
  `syncMiniFilterUI` vì chúng đã nhận `key`. Không đổi CSS chung; `.mini-filter` không
  phụ thuộc `#filterBar`. Trên màn hình hẹp dùng lại media query hiện có; đặt bộ lọc
  xuống dòng dưới tiêu đề khối, vùng bấm giữ nguyên như ở thanh trên.
- Nhóm nút ở mỗi bộ lọc có `aria-label` nêu khối áp dụng (vd "Khoảng thời gian: Hàng
  mới nhập"), và tiêu đề khối luôn hiển thị khoảng đang chọn.
- Phần 3: `#productAnalysisPeriod` thành nhãn tĩnh "doanh thu 90 ngày gần nhất", bỏ đoạn
  JS gán lại theo `d.filters.products.label` trong `renderView('products')`.
- Phần 5: `#newlyImportedPeriod` lấy nhãn từ `d.filters.newlyImported.label`.
- Phần 6: `#tagTodayNewProductsDate` và câu mô tả khối đổi "…ở trên" thành cách nói khớp vị
  trí mới; nhãn lấy từ `d.filters.newProducts`.
- `currentExportFilters()`: `newlyImported` và `newProducts` lấy từ state riêng của
  chúng; `products` vẫn là `state.filters.products` cộng `status` (Tổng quan và
  `products.child-categories` còn dùng).
- Đổi bộ lọc của khối nào chỉ gọi lại `loadData()` như hiện nay; không thêm cơ chế tải
  riêng cho từng khối.

### Server

- `server/routes.js` (`GET /api/dashboard`): thêm `newlyImported: parseFilterSpec(req.query, 'ni')`.
  `newProducts` (`np`) và `products` (`pr`, kèm `prStatus`) giữ nguyên.
- `server/dashboard/dashboardViews.js`:
  - `ALL_ROLLUPS` thêm `productSales90d` và `newlyImportedSales`; `productSales` (theo
    `pr`) chỉ còn phục vụ Tổng quan.
  - Kế hoạch tab `products`: `rollups: ['productSales90d', 'newlyImportedSales', 'firstPurchase']`.
    Kế hoạch tab `overview` giữ `['overviewRevenue', 'productSales']`.
  - `VIEW_FILTER_KEYS.products`: `newlyImported`, `newProducts` và trạng thái từ
    `products`. Khóa cache của tab Hàng hóa **không** được phụ thuộc khoảng `pr` của
    Tổng quan (nếu `pickFilters` chưa tách được `status`, tách trong việc này).
  - `VIEW_PAYLOAD.products.filters` thêm `newlyImported`.
- `server/dashboard/dashboardData.js`:
  - `fetchDashboardRollups`: `productSales90d` gọi `getProductSalesBreakdown` với
    `rangeToDateBounds(resolveFilterRange({ mode: 'days', days: 90 }, now))`, cùng hàm
    và cùng ngữ nghĩa với nút "90 ngày" trước đây. `newlyImportedSales` gọi với
    khoảng `newlyImported`.
  - Tách vòng gom doanh thu (hiện một vòng `productSalesRows.forEach` sinh
    `productSalesMap`, `parentCategorySalesMap`, `childCategorySalesMap`,
    `newlyImportedCategorySalesMap`, `newlyImportedProductSalesMap`) thành hàm dùng lại,
    gọi cho từng tập dòng:
    - dòng `pr` → `childCategorySalesByParent`, `availableParentCategories` (Tổng quan);
    - dòng 90 ngày → `allSellingProducts`, `topSellingProducts`,
      `allSellingParentCategories`, `topSellingParentCategories` (phần 3);
    - dòng `ni` → doanh thu, `topByRevenue`, `salesByCategory`, `countByCategory`,
      `salesRevenue`, `salesQty` của `newlyImported` (phần 5).
  - `newlyImportedProducts` lọc theo `newlyImportedRange` thay cho `productsRange`.
  - `filters` trong payload thêm `newlyImported`.
  - Khi không có tham số `view` (đủ 6 tab, hành vi cũ) cả ba truy vấn đều chạy; payload
    Tổng quan không đổi so với trước.
- `server/dashboard/exportService.js` (`normalizeFilters`): thêm
  `newlyImported: normalizeFilterSpec(raw.newlyImported || raw.products)` (client cũ vẫn
  chạy). Xuất "Sản phẩm bán chạy" theo 90 ngày cố định vì đọc cùng payload;
  "Hàng mới nhập" theo `newlyImported`; "Mã mới tạo" theo `newProducts`.

### Tương thích và cache

- Payload dashboard đã cache trong `sessionStorage` từ bản cũ không có
  `filters.newlyImported`: client coi thiếu là mặc định 30 ngày và không lỗi.
- Đổi ngày của Tổng quan không làm mất cache của tab Hàng hóa và ngược lại.

## Kiểm thử

Server (`node --test`):

- Tab Hàng hóa: `allSelling*`/`topSelling*` luôn ứng với 90 ngày dù đổi `pr`.
- `ni` chỉ đổi `newlyImported` (danh sách, doanh thu, biểu đồ), không đổi phần 3 và 6.
- `np` độc lập với `ni` và `pr`.
- Tab Tổng quan: `childCategorySalesByParent` vẫn theo `pr`, không đổi khi đổi `ni`/`np`.
- `dashboardViews`: `filterKeys` đúng, test "mỗi tab trả đúng lát cắt của bản đầy đủ"
  vẫn xanh.
- `dashboard-route.test.js`: tham số `niMode/niDays/niFrom/niTo` được đọc.
- `exportService`: "Hàng mới nhập" theo `newlyImported`; client cũ không gửi
  `newlyImported` vẫn xuất được.

Giao diện (jsdom, `server/test/frontend`; cập nhật `dashboard-section-layout` và
`dashboard-per-view-loading` nếu cần):

- Ở tab Hàng hóa thanh trên không hiện bộ lọc thời gian; ở Tổng quan vẫn hiện.
- Đổi bộ lọc phần 5/6 gửi đúng `ni*`/`np*`, không đổi `pr*` và ngược lại.
- Nhãn phần 3 luôn là 90 ngày.
- Xuất file gửi đúng bộ lọc từng khối.

## Rủi ro

- Phần lớn công sức nằm ở việc tách vòng gom doanh thu trong `computeDashboardData`.
  Giữ nguyên công thức; các test hiện có của `dashboardData` là lưới an toàn.
- Thêm một truy vấn `daily_product_sales` cho phần 5. Bảng đã tổng hợp sẵn nên nhẹ;
  đo thời gian tab Hàng hóa trước/sau khi làm.
- `.mini-filter` đặt trong đầu khối cần kiểm tra bằng mắt ở màn hình hẹp và chế độ tối.
- Xuất `products.child-categories` (thuộc Tổng quan) phải tiếp tục dùng khoảng `pr`;
  kiểm tra khi làm phần export.
