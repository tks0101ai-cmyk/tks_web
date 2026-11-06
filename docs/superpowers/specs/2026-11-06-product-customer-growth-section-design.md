# Mục 4 tab Hàng hóa: bảng Sản phẩm × Khách hàng có cột Tăng trưởng

Ngày: 06/11/2026 · Trạng thái: chờ người dùng duyệt spec

## 1. Mục tiêu

Thay phần giao diện của mục 4 "Hàng hóa 90 ngày" (tab Hàng hóa, `#product90dSection`) bằng bảng
"khách hàng theo sản phẩm" lấy từ khung chi tiết hàng hóa (ảnh người dùng gửi), mở rộng thành bảng
chung cho mọi sản phẩm, kèm:

- cột **Tăng trưởng** (T.này so với trung bình 2 kỳ liền trước),
- bộ lọc theo **tên sản phẩm**, **tên khách hàng**, **nhóm tăng trưởng**,
- tô **đỏ + nhãn "Cần check"** khi tăng trưởng dưới −50%,
- giữ nút **Xuất file**.

Quyết định đã chốt với người dùng:

| Câu hỏi | Chốt |
|---|---|
| Ngưỡng đỏ | Tăng trưởng < −50% (giảm quá 50%) |
| Mục 4 cũ | Thay giao diện; **giữ** job 02:00, API `/api/product-report/90d`, xuất file `products.product90d` ở máy chủ |
| Bộ lọc tăng trưởng | Danh sách chọn nhanh theo nhóm (không nhập khoảng %) |
| Xuất file | Có, cho bảng mới |

Ngoài phạm vi: gỡ job/API/bảng `product_90d_report` cũ; sửa khung chi tiết hàng hóa (modal) hiện có;
đổi cách tính 3 kỳ của `product_report_customers`.

## 2. Nguồn dữ liệu

Bảng `product_report_customers` (migration 0023 + 0108) đã có từng cặp (`product_key`, `customer_key`) với
`customer_name`, `revenue` (90 ngày), `revenue_1_30d`, `revenue_31_60d`, `revenue_61_90d`. Được làm mới tăng dần
sau mỗi lượt đồng bộ (`productReportIncremental.js`) nên mới hơn bảng tính 02:00. Không cần migration mới.

- Tên/mã sản phẩm: JOIN `product_report` theo `lower(btrim(product_code)) = product_key`. Cặp không có dòng ở
  `product_report` (mã đã xóa) bị bỏ qua (INNER JOIN).
- Ngày kết thúc cửa sổ: `product_report_state.customer_window_end`. Ba kỳ dựng bằng đúng hàm `customerPeriods` hiện có
  (`productReportRepository.js`) để khớp khung chi tiết. Kỳ là **30 ngày cuốn chiếu**, không phải tháng dương lịch.
- `customer_window_end IS NULL` hoặc cột kỳ NULL (kỳ chưa tính) → API trả `available: false` /
  giá trị kỳ `null`, giao diện hiện thông báo "Chưa tính dữ liệu kỳ", không hiện 0 giả.
- Khách gộp theo tên chuẩn hóa (quy tắc sẵn có của bảng); không thay đổi.

## 3. Công thức

```
base   = (T.trước + T.trước nữa) / 2
growth = T.này / base − 1          khi base > 0
```

| Tình huống | Hiển thị | Nhóm lọc |
|---|---|---|
| base > 0, growth < −0.5 | % đỏ + nhãn **Cần check** | Cần check |
| base > 0, −0.5 ≤ growth < 0 | % thường (âm) | Giảm dưới 50% |
| base > 0, growth ≥ 0 | % thường | Đang tăng |
| base ≤ 0 và T.này > 0 | nhãn **Mới** | Khách mới |
| base ≤ 0 và T.này ≤ 0 | "—" | không thuộc nhóm nào (chỉ có ở "Tất cả") |
| T.này = 0, base > 0 | −100% đỏ + Cần check | Cần check |
| Có kỳ NULL | "—" | chỉ ở "Tất cả" |

- Ranh giới: đúng −50% **không** đỏ (so sánh `< −0.5`); đúng 0% thuộc "Đang tăng".
- "Đang tăng" gồm cả tăng 0%. Nhãn nhóm trên giao diện: *Tất cả · Cần check (giảm quá 50%) · Giảm dưới 50% ·
  Đang tăng · Khách mới*.
- Tính ở SQL bằng NUMERIC (không dùng float JS); client chỉ định dạng. Hiển thị làm tròn 1 chữ số lẻ
  ("−62.5%"), nhóm lọc/màu đỏ dùng giá trị gốc chưa làm tròn.
- `% của SP` = `revenue / SUM(revenue của sản phẩm đó trên TẤT CẢ khách)`, tính trước khi lọc để không đổi theo bộ lọc;
  tổng ≤ 0 → "—". Cùng định nghĩa với khung chi tiết.

## 4. Giao diện

Vị trí: giữ nguyên `#product90dSection` (mục 4, quyền `reports.products` + `reports.products.sales`); tiêu đề mục
vẫn là "Hàng hóa 90 ngày", panel con đổi thành "Khách hàng theo sản phẩm" kèm tag số dòng.

- **Cột** (khóa cột cho `table-controls.js`): `product` (mã + tên 2 dòng), `customer`, `revenue` (DS 90 ngày),
  `revenue_1_30d` (T.này), `revenue_31_60d` (T.trước), `revenue_61_90d` (T.trước nữa), `share` (% của SP, có thanh
  như ảnh), `growth` (Tăng trưởng). Tiêu đề kỳ có `title` ghi khoảng ngày thật.
- **Bộ lọc** (thanh phía trên bảng): ô "Tìm tên/mã sản phẩm", ô "Tìm tên khách hàng", danh sách thả xuống tăng
  trưởng. Debounce 150 ms như bảng cũ; có nút xóa ô; đổi bộ lọc → về trang 1.
- **Dòng trạng thái** (`role="status"`): "N dòng khớp · M cần check" (đếm trên toàn bộ kết quả đã lọc, không chỉ trang
  hiện tại), kèm "Dữ liệu cập nhật lúc …" và ngày chốt.
- **Sắp xếp**: mặc định DS 90 ngày giảm dần; bấm tiêu đề: tăng → giảm → bỏ (quy tắc `nextSort` sẵn có). Sắp xếp theo
  Tăng trưởng: giá trị không tính được (NULL / "Mới") luôn cuối ở cả hai chiều.
- **Phân trang**: 50 dòng/trang, tùy chọn như bảng cũ, tối đa 200.
- **Tô đỏ**: chỉ ô Tăng trưởng (chữ đỏ + nhãn "Cần check"), không tô cả dòng để bảng không nhiều màu; màu lấy từ
  token trong `shared.css`, đủ tương phản ở cả Sáng/Tối.
- Hỗ trợ Sáng/Tối, mobile (≤ 600px dùng độ rộng cột hẹp như bảng cũ), ẩn/hiện cột + kéo độ rộng qua `TKSTables`.
- Chữ "Cột hiển thị", ghi chú tiêu đề cột bằng tiếng Việt có dấu theo quy ước dự án.

**Mã nguồn giao diện**: tạo `server/public/product-customer-growth.js` (+ `.css`) thay `product-90d-report.js/.css`
trong `index.html`. Phần đầu file là hàm thuần (định dạng %, `growthState`, `buildQuery`, `rowHtml`, `exportContext`)
để Node `require()` test, giống file cũ. `product-90d-report.js` còn bị `exportService.js` require
(`PERIODS`, `topCustomerLines`) cho xuất file cũ → **giữ file** để không phá phần máy chủ cũ, chỉ gỡ khỏi `index.html`
và dọn thead/CSS không còn dùng. (Tách hàm dùng chung ra khỏi file giao diện là việc dọn sau, không làm ở đây.)

## 5. API mới

`GET /api/product-report/customer-growth` — guard `requireFeature('reports.products.sales')`, đặt cạnh
`/api/product-report/90d` trong `server/routes.js`, nằm dưới tiền tố `/api/product-report` nên kế thừa guard
`reports.products`.

Query (kiểm tra chặt như `product90dReportRepository`, sai → 400):

| Tham số | Quy tắc |
|---|---|
| `product` | chuỗi ≤ 200, tìm gần đúng bỏ dấu (`fuzzySqlParts`) trên `mã || ' ' || tên` |
| `customer` | chuỗi ≤ 200, tìm gần đúng bỏ dấu trên `customer_name` |
| `growth` | một trong `all` (mặc định) · `check` · `drop` · `up` · `new` |
| `sort` | whitelist: `product_code`, `product_name`, `customer_name`, `revenue`, `revenue_1_30d`, `revenue_31_60d`, `revenue_61_90d`, `share`, `growth` |
| `dir` | `asc` / `desc` |
| `page`, `pageSize` | số nguyên dương, pageSize ≤ 200, mặc định 1 / 50 |

Tên cột sắp xếp chỉ lấy từ whitelist, tuyệt đối không nối chuỗi người dùng vào SQL; từ khóa đi qua tham số.

Phản hồi:

```json
{ "available": true,
  "state": { "customerWindowEnd": "2026-11-05", "computedAt": "…", "version": 123 },
  "periods": [ {"key":"1_30d","label":"T.này","from":"…","to":"…"}, … ],
  "summary": { "totalRows": 1234, "checkRows": 56 },
  "rows": [ { "productCode":"…","productName":"…","customerName":"…","revenue":0,
              "revenue1_30d":0,"revenue31_60d":0,"revenue61_90d":0,
              "share":0.855,"growth":-0.62,"growthState":"check" } ],
  "page":1, "pageSize":50, "sort":"revenue", "dir":"desc" }
```

Chưa có `customer_window_end` → `200 { available:false, rows:[], summary:{totalRows:0,checkRows:0} }`.
Một câu SQL duy nhất (CTE: dòng trạng thái + dòng tính sẵn growth/share + đếm tổng) để trang, tổng và số "cần check"
cùng đọc một ảnh chụp, giống mẫu `getProduct90dReport`. Thứ tự ổn định: khóa sắp xếp → `product_key` → `customer_key`.

Hiệu năng: `product_report_customers` khóa chính `(product_key, customer_key)`; window function `SUM(...) OVER
(PARTITION BY product_key)` chạy trên toàn bảng (đã cần để có `share`). Cần đo số dòng thực tế bằng `EXPLAIN` ở bước lập kế hoạch; nếu chậm, tính `share` bằng subquery gộp theo `product_key` thay vì window. Không thêm migration
trừ khi số liệu đo cho thấy cần.

**Quy mô web**: pool DB chỉ 5 kết nối (xem nghẽn pool trước đây) → truy vấn phải nhẹ, có `statement_timeout`/timedQuery
như mẫu hiện có, không gọi lặp theo từng phím gõ (debounce + hủy request cũ bằng `AbortController`).

## 6. Xuất file

Khóa mới `products.productCustomerGrowth`, tiêu đề "Hàng hóa 90 ngày – Khách theo sản phẩm", đăng ký trong
`exportService.js` song song `products.product90d` (không sửa nhánh cũ).

- Cột: Mã hàng, Tên hàng, Khách hàng, DS 90 ngày, T.này, T.trước, T.trước nữa (nhãn có khoảng ngày thật như file
  cũ), % của SP, Tăng trưởng (số %, ô trống khi không tính được), Trạng thái (Cần check / Giảm dưới 50% / Đang tăng / Mới).
- Dùng đúng bộ lọc đang áp dụng: `context: { productQuery, customerQuery, growthGroup }` + `tableSort` theo nhãn cột
  (như `exportContext` cũ). Máy chủ kiểm tra lại giá trị (cùng whitelist) rồi gọi `getProductCustomerGrowthForExport`.
- Quyền: `reports.export` + `reports.products` + `reports.products.sales` (cùng điều kiện nhánh cũ, `canViewProducts`/
  `canViewSales`, thiếu cờ → 403 `EXPORT_TABLE_NOT_ALLOWED`).
- Không phân trang; trần `EXPORT_MAX_ROWS` (mặc định 50.000 dòng). Vượt trần → 413 `EXPORT_TOO_MANY_ROWS` với lời nhắn
  "gõ từ khóa/chọn nhóm để thu hẹp"; không bao giờ cắt ngầm. Không có dòng → `EXPORT_NO_DATA`, không tạo file rỗng.
- Ghi chú đầu file: thời điểm cập nhật, ngày chốt, 3 kỳ, phạm vi (toàn công ty), từ khóa/nhóm đã lọc, số dòng.
- Báo cáo HTML (định dạng `html`): dùng khung chung `exportHtmlReport`, không viết biểu đồ riêng cho bảng này
  (không đặt `periodTrend`). Nếu khung chung bắt buộc có KPI/biểu đồ thì dùng cấu hình tối thiểu (`summaryKeys` =
  `revenue`); việc này được xác minh ở bước lập kế hoạch.

## 7. Kiểm thử

Chạy trên Node `--test` (nhớ truyền glob rõ ràng trên Node v24):

1. `server/dashboard/productCustomerGrowthRepository.test.js`: kiểm tra tham số (400 cho giá trị sai, whitelist sort),
   ranh giới tăng trưởng (đúng −50% không đỏ, base = 0, T.này = 0, kỳ NULL, base âm), nhóm lọc loại trừ nhau, `share`
   không đổi theo bộ lọc, đếm `checkRows`, kẹp trang, trạng thái chưa có dữ liệu.
2. `server/dashboard/productCustomerGrowthRoutes.test.js`: quyền (thiếu `reports.products.sales` → 403), 400/200.
3. `server/test/frontend/product-customer-growth.test.js`: hàm thuần (định dạng, nhãn "Cần check"/"Mới", `buildQuery`
   bỏ tham số rỗng, thứ tự sắp xếp, `exportContext`), thead khớp `COLUMNS`.
4. Sửa `dashboard-section-layout.test.js`, `export-ui.test.js` và các test khóa mục 4 cũ cho khớp giao diện mới;
   test của phần máy chủ cũ giữ nguyên và phải vẫn xanh.
5. `exportService.test.js`: nhánh `products.productCustomerGrowth` (quyền, bộ lọc, trần dòng, không dữ liệu).
6. Kiểm tra bằng trình duyệt (server local chỉ đọc theo `launch.json`): gõ lọc, đổi nhóm, đỏ ở dòng đã biết, Sáng/Tối,
   rộng 375px, mở "Cột hiển thị", xuất thử một tệp.

Hai test đã đỏ sẵn trên `main` (mục 4.1 của CLAUDE.md) không tính vào kết luận; mọi lỗi khác tên hoặc số lỗi khác 2 là
lỗi mới.

## 8. Tài liệu phải cập nhật (CLAUDE.md §3)

`README.md` (cây thư mục, danh sách cập nhật), `server/README.md` (bảng API), `server/db/SCHEMA.md` (ghi rõ **không**
đổi schema; nêu bảng nguồn), `docs/04-planning/implementation_plan.md`, `docs/02-srs/SRS_Dashboard_GoogleSheets.md`,
`docs/01-brd/BRD_Dashboard_GoogleSheets.md`, `CURRENT.md`; ngày cập nhật cuối mỗi tài liệu; cuối cùng chạy
`graphify update .`.

## 9. Rủi ro và giả định

- "Tháng" = kỳ 30 ngày cuốn chiếu (khớp ảnh); người dùng chưa phản đối. Nếu muốn tháng dương lịch thì phải đổi nguồn
  (`product_report_customers` không lưu theo tháng dương lịch).
- Số dòng bảng nguồn chưa đo; trần xuất 50.000 và truy vấn phân trang là biện pháp an toàn, đo thật ở bước lập kế hoạch.
- Người dùng cũ đã lưu cấu hình bảng `dashboard-table-product-90d` (độ rộng/ẩn cột): bảng mới dùng `data-table-key` mới
  `dashboard-table-product-customer-growth`, không đọc nhầm cấu hình cũ.
- Job 02:00 và bảng `product_90d_report` vẫn chạy tốn tài nguyên dù UI không dùng; xem xét gỡ ở một đợt riêng sau khi
  người dùng yên tâm.
