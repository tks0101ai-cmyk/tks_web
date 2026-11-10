# Sắp xếp nhiều cấp cho bảng "Khách hàng theo sản phẩm" (Hàng hóa 90 ngày) — thiết kế

Ngày: 2026-11-10 · Trạng thái: thiết kế đã duyệt, chờ duyệt bản spec này

## Bối cảnh và mục tiêu

Bảng "Khách hàng theo sản phẩm" (mục 4 tab Hàng hóa, `server/public/product-customer-growth.js`) có ~36.000 dòng, phân trang và sắp xếp ở máy chủ, nhưng chỉ sắp xếp được **1 cột** (`sort` + `dir` → một khóa `ORDER BY`).

Nhu cầu: sắp xếp nhiều cột cùng lúc như Excel. Ví dụ: sort **Khách hàng** → ra các sản phẩm của "HN A An An Khánh" → sort tiếp **% của SP** để xem khách đó biến động thế nào giữa các sản phẩm.

Vì dữ liệu phân trang ở máy chủ nên sort đa cấp phải làm trong SQL, không thể làm ở trình duyệt.

## Quyết định đã chốt

- Cách thao tác: **bấm thường = cộng dồn** (không cần phím Shift, dùng được trên điện thoại).
- Tối đa **4 cấp**.
- Chỉ áp dụng cho bảng này.

## Giao diện (`product-customer-growth.js`)

- `state.sort` / `state.dir` đổi thành `state.sorts = [{ sort, dir }, …]` (khóa `sort` là khóa whitelist hiện có: `product_name`, `customer_name`, `revenue`, `revenue_1_30d`, `revenue_31_60d`, `revenue_61_90d`, `share`, `growth`).
- Bấm tiêu đề một cột (`nextSort` trở thành hàm trên danh sách):
  - Cột chưa có trong danh sách → thêm vào cuối, chiều tăng dần. Nếu đã đủ 4 cấp thì **thay cấp cuối** bằng cột vừa bấm (không chặn người dùng, không báo lỗi).
  - Cột đã có → tăng dần → giảm dần → gỡ khỏi danh sách; các cấp còn lại giữ thứ tự tương đối.
- Mỗi lần đổi sort: về trang 1 và gọi lại API (cơ chế hủy yêu cầu cũ bằng `AbortController` + `seq` giữ nguyên).
- Tiêu đề hiện **số cấp** cạnh mũi tên (`.sort-level`) chỉ khi có từ 2 cấp trở lên; khi chỉ 1 cột sort thì giao diện y như hiện nay.
- `aria-sort` đặt cho từng cột có trong danh sách; tooltip/`aria-label` của nút sort thêm "(cấp N)" khi có từ 2 cấp. Chữ báo hành động kế tiếp (`sortAction`) giữ nguyên.
- Nút **"Xóa sắp xếp (N)"** cạnh ô lọc: hiện khi `sorts.length >= 1`, bấm về thứ tự mặc định (DS 90 ngày giảm dần của máy chủ) và về trang 1. Style dùng lớp nút phụ hiện có, hỗ trợ sáng/tối và mobile.
- `reset()` xóa cả danh sách sort.

## API và SQL

- Thêm tham số `sorts`, định dạng `khóa:chiều` cách nhau dấu phẩy, ví dụ `?sorts=customer_name:asc,share:desc`.
- Kiểm tra trong `parseFilters` (`productCustomerGrowthRepository.js`), dùng chung cho màn hình và xuất file:
  - Mỗi khóa phải nằm trong whitelist `SORT_SQL`; chiều chỉ `asc` hoặc `desc`; sai định dạng → 400.
  - Khóa trùng → 400. Quá 4 cấp → 400. Chuỗi `sorts` dài quá 200 ký tự → 400.
  - Không bao giờ nối chuỗi từ người dùng vào SQL: ánh xạ qua `SORT_SQL` như hiện nay.
- Nếu có `sorts` thì **ưu tiên `sorts`** và bỏ qua `sort`/`dir`. Nếu không có `sorts`, cặp `sort` + `dir` cũ chạy y như trước (tương thích ngược) và được chuẩn hóa thành danh sách 1 cấp.
- `ORDER BY` = các cấp theo thứ tự, mỗi cấp `NULLS LAST`; chiều mặc định khi thiếu (chỉ xảy ra ở đường `sort` cũ) giữ luật cũ: cột chữ tăng dần, cột số giảm dần. Rồi các khóa phụ cố định `product_code ASC, customer_name ASC, customer_key ASC` để thứ tự ổn định giữa các trang. Khóa phụ trùng với một cấp đã chọn thì vô hại (PostgreSQL bỏ qua cột lặp), nên không cần lọc.
- Response: thêm `sorts: [{ sort, dir }]` đã chuẩn hóa; `sort` / `dir` cũ vẫn trả, bằng cấp đầu tiên.
- Mặc định (không gửi sort) vẫn là `revenue DESC`.

## Xuất file (`exportService.js`)

- Context xuất thêm `sorts` (chuỗi cùng định dạng với API). `growthFiltersFromContext` chuyển `sorts` thành `filters.sorts`; `sortKey` / `sortDir` cũ vẫn được nhận. Có `sorts` thì ưu tiên `sorts`.
- `validateFilters` kiểm lại bằng cùng whitelist trước khi xin slot xuất (sai → 400 `EXPORT_INVALID_REQUEST` như hiện nay).
- `exportContext()` ở frontend gửi `sorts` khi có ít nhất 1 cấp (ghi chuỗi `khóa:chiều`), không gửi `sortKey`/`sortDir` nữa.
- File xuất (Excel/HTML) sắp đúng thứ tự đa cấp đang hiển thị.

## Kiểm thử

- `server/test/frontend/product-customer-growth.test.js`: `nextSort` đa cấp (thêm, đảo chiều, gỡ, đầy 4 cấp thì thay cấp cuối), `buildQuery` ra `sorts=…`, `exportContext`, hiện số cấp trên tiêu đề, nút "Xóa sắp xếp", bấm lần lượt Khách hàng rồi % của SP gửi đúng `sorts=customer_name:asc,share:asc`.
- `server/dashboard/productCustomerGrowthRoutes.test.js` (và test repository nếu có): `sorts` hợp lệ; trùng khóa, khóa lạ, chiều lạ, quá 4 cấp, quá dài → 400; `sort`/`dir` cũ vẫn chạy; `sorts` thắng `sort`; `ORDER BY` đúng thứ tự cấp (kiểm tra bằng SQL sinh ra hoặc dữ liệu giả).
- `server/dashboard/exportProductCustomerGrowth.test.js` và `server/test/frontend/export-ui.test.js`: context `sorts` hợp lệ/không hợp lệ; file xuất sắp đa cấp; `sortKey`/`sortDir` cũ còn chạy.
- Chạy toàn bộ test liên quan, 100% xanh (Node v24 cần glob khi `node --test`).

## Tài liệu cần cập nhật (theo skill `update-file`)

`README.md`, `server/README.md` (bảng API: tham số `sorts`), `CURRENT.md`, ngày cập nhật cuối các tài liệu; chạy `graphify update .`. Không có migration hay thay đổi schema.

## Ngoài phạm vi

- Kéo thả đổi thứ tự cấp.
- Lưu sort cho lần mở sau.
- Áp dụng cho các bảng khác (cách làm có thể tái dùng sau này).
- Bảng "Hàng hóa 90 ngày" phía trên (`product-90d-report.js`) không đổi.
