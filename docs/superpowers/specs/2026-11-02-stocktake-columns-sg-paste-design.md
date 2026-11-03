# Kiểm kê: đủ cột như T10, Sài Gòn, dán cột từ sheet — Thiết kế

Ngày: 02/11/2026. Bổ sung cho [2026-10-31-stocktake-design.md](2026-10-31-stocktake-design.md). Migration `0103` chưa áp DB nên mọi thay đổi schema sửa thẳng trong `0103_stocktake.sql`.

## 1. Mục tiêu

- Bảng đối chiếu có đủ 23 cột A→W và đúng thứ tự như tab "KIỂM KÊ HN T10", thêm một cột ẩn "Cập nhật" chỉ web có.
- Sort được theo mọi cột.
- Kiểm kê Sài Gòn dùng cùng bảng, đối chiếu chéo với Hà Nội (cột Kiểm SG / Kiểm HN).
- Dán một cột dữ liệu tính ngoài sheet vào web theo mã.
- Web test bằng dữ liệu thật (sheet + DB, chỉ đọc).

Ngoài phạm vi: chia team, thưởng/phạt, cột số đếm theo từng team của sheet SG, đọc file gốc "KIỂM KÊ SG" (service account không có quyền).

## 2. Thứ tự cột

| # | Cột web | Cột T10 | Nguồn |
|---|---|---|---|
| 1 | Mã hàng | A | |
| 2 | Tên hàng | B | `products` |
| 3 | Tổng kiểm | C | đơn TEAM + phần sửa |
| 4 | Tồn KIOT | D | `products` (đợt đóng: bản chụp) |
| 5 | SL chênh | E | C − D |
| 6 | Giá trị chênh | F | E × Giá vốn |
| 7 | Trạng thái | G | ghi chú |
| 8 | Chi tiết lý do | H | ghi chú |
| 9 | Trang in | I | ghi chú, chữ tự do |
| 10 | Giờ in | J | ghi chú, chữ tự do |
| 11 | Người kiểm lại | K | ghi chú |
| 12 | KK trước sai | L | đợt đóng trước, hoặc số dán |
| 13 | Kiểm SG (đợt SG: **Kiểm HN**) | M | đợt đối chiếu, hoặc số dán |
| 14 | Cụm SP | N | tag theo cơ sở |
| 15 | Count | O | số mã cùng cụm trong đợt |
| 16 | Chênh cụm | P | tổng SL chênh của cụm |
| 17 | Do KK trước | Q | (E + L) / L |
| 18 | Lẫn + KK trước | R | (ΣE cụm + ΣL cụm) / ΣE cụm |
| 19 | Do kiểm SG (đợt SG: **Do kiểm HN**) | S | (E + M) / M |
| 20 | Quên KK | T | tồn ≠ 0 và tổng kiểm 0 |
| 21 | Combo | U | tag theo cơ sở |
| 22 | Vị trí kho gần nhất | V | `stock_positions` |
| 23 | Giá vốn | W | `products` (đợt đóng: bản chụp) |
| 24 | Cập nhật (ẩn sẵn) | — | người sửa ghi chú + giờ |

Quy tắc tính:
- Count, Chênh cụm, Lẫn + KK trước chỉ có giá trị khi mã thuộc một cụm; không thì trống.
- Ba tỷ lệ Q, R, S hiện dạng %, làm tròn số nguyên. Trống khi mẫu số trống hoặc bằng 0 (sheet ra `#DIV/0!`). Trong R, L trống tính là 0.
- Xuất Excel theo đúng thứ tự trên, tên hai cột M, S đổi theo cơ sở như bảng; tỷ lệ xuất dạng số % (`0%`).
- `table-controls` vẫn lo ẩn/hiện và độ rộng cột; khóa lưu cấu hình đổi thành `stocktake-board-v2` để cấu hình cột cũ không làm lệch thứ tự mới.

## 3. Sort

- Bấm tiêu đề: tăng dần → giảm dần → mặc định (|Giá trị chênh| giảm dần, rồi theo mã).
- Sort toàn bộ dòng sau khi lọc, rồi mới chia trang 100 dòng; đổi sort quay về trang 1.
- Cột số sort theo số, cột chữ theo `localeCompare('vi')`, cột đánh dấu (Quên KK, Combo) có trước không có. Ô trống luôn nằm cuối ở cả hai chiều.
- Biểu tượng theo kiểu chung (`.sort-button`, `.sort-indicator`, `aria-sort`); `TKSTables.enhance` vẫn gọi với `sort: false`.
- Bỏ ô chọn "Sắp xếp" cũ.

## 4. Sài Gòn

- Hộp tạo đợt có chọn cơ sở (chỉ các cơ sở trong phạm vi người dùng). Backend đã tách theo cơ sở: đơn TEAM, `products`, `stock_positions` (`SG`), tag Cụm/Combo theo `(branch, product_code)`.
- Thanh chọn đợt hiện cơ sở của từng đợt; tên cột M/S đổi theo cơ sở của đợt đang xem.

## 5. Đợt đối chiếu (cột M, S)

- `stocktake_sessions.counterpart_session_id` (FK tới `stocktake_sessions`, ON DELETE SET NULL, NULL được). Đợt đối chiếu phải thuộc cơ sở kia; sai thì 400 `INVALID_COUNTERPART`.
- Khi tạo đợt, web điền sẵn đợt của cơ sở kia có khoảng ngày giao nhau; không có thì đợt có `date_to` gần `date_from` nhất. Người tạo đổi được hoặc bỏ trống.
- Đổi đợt đối chiếu của một đợt đang mở: `PATCH /api/stocktake/sessions/:id` với `{counterpartSessionId, version}` (quyền `edit`, khóa `version`, ghi lịch sử `session_update`).
- Giá trị M của một mã: số dán tay (`other_diff_manual`) nếu có; không thì SL chênh của mã trong đợt đối chiếu (đợt đối chiếu đã đóng: từ bản chụp; đang mở: tính trực tiếp). Không có đợt đối chiếu và không có số dán thì trống.
- Tương tự L: `prev_diff_manual` nếu có, không thì SL chênh ở đợt đóng trước cùng cơ sở.
- Ô có số dán tay hiện dấu nhỏ "dán tay" (tooltip: số web tự lấy là bao nhiêu).

## 6. Bản chụp khi đóng đợt

`stocktake_session_results` thêm `prev_diff NUMERIC` và `other_diff NUMERIC`: lưu L và M lúc đóng. Đợt đóng đọc thẳng hai cột này, không tính lại. Hai tỷ lệ và Count/Chênh cụm của đợt đóng tính lại từ bản chụp + tag hiện tại (giống Chênh cụm hiện nay).

## 7. Nạp sheet

**T10 (đã có, sửa):** đọc thêm cột L (KK Trước Sai) vào `prev_diff`, Trang in/Giờ in (I, J) vào ghi chú. Cột M của sheet không nạp: lấy qua đợt đối chiếu.

**KIỂM SG (mới):** `POST /api/stocktake/import-sheet` nhận `{source: 't10' | 'sg'}` (bỏ trống = `t10` cho tương thích). Tab `KIỂM SG` (gid `1469990159`) trong cùng file. Tạo đợt `saigon`, `closed`, `source = sheet_import`, `source_ref = sheet:<id>:1469990159`, tên "Kiểm kê SG T10", ngày 2026-10-03. Dò cột theo tiêu đề đã bỏ dấu:

| Tiêu đề KIỂM SG | Vào |
|---|---|
| Mã SP (A) | mã |
| Giá vốn (C) | `cost` |
| TỔNG KIỂM (Q) | `counted` |
| Tồn KIOT (R) | `stock` |
| SL Chênh (S) | `diff_qty` |
| Giá trị chênh (T) | `diff_value` |
| KK trước sai (V) | `prev_diff` |
| Lý do sơ bộ (X) | Trạng thái |
| Lý do (W) | Chi tiết lý do |
| Trang in (Y) | Trang in |
| Chắc chắn thừa (U) | Người kiểm lại (chữ; gắn id khi khớp đúng một nhân sự) |

Bỏ dòng tổng (dòng 2) và dòng không có mã. Số đọc bằng `UNFORMATTED_VALUE`. Nạp lại trả 409 `ALREADY_IMPORTED`. Cột team D–P không nạp.

Nạp xong cả hai: đợt nạp sau tự đặt `counterpart_session_id` sang đợt nạp trước và ngược lại (chỉ khi ô đó còn trống).

## 8. Dán cột

**Giao diện:** nút "Dán cột" (quyền `edit`, chỉ đợt mở) mở hộp thoại:
1. Chọn cột đích: Trạng thái, Chi tiết lý do, Trang in, Giờ in, Người kiểm lại, Cụm SP, Combo, KK trước sai, Kiểm SG/HN.
2. Ô dán: hai cột Mã + giá trị, phân cách tab (copy từ Google Sheets). Dòng đầu bỏ qua nếu ô mã không giống mã của đợt và ô giá trị không hợp lệ với cột đích (nhận ra dòng tiêu đề). Dòng trống bỏ qua. Mã chuẩn hóa bằng `codeKey`. Mã lặp: lấy dòng cuối, báo số mã lặp.
3. Tùy chọn ô trống: "bỏ qua" (mặc định) hoặc "xóa giá trị cũ".
4. Xem trước (tính phía trình duyệt từ bảng đang có): số mã khớp; danh sách mã không có trong đợt (bỏ qua); số ô sẽ đổi; số ô không hợp lệ (cột số: không đọc được số theo kiểu `1.234` / `-1,5` / `1234`; bỏ qua). Nút Lưu tắt khi không có ô nào đổi.

**Hiểu giá trị:**
- Chữ: cắt khoảng trắng hai đầu, tối đa 500 ký tự (Trang in, Giờ in: 50).
- Người kiểm lại: khớp đúng một nhân sự cùng cơ sở (so tên đã bỏ dấu, không phân biệt hoa thường) thì gắn id và xóa chữ; không thì lưu chữ vào `recheck_name`, id NULL.
- Combo: `x`, `true`, `1`, `có`, `co` (không phân biệt hoa thường) là có; giá trị khác là không.
- KK trước sai, Kiểm SG: số (có thể âm, lẻ); "xóa" đặt lại NULL tức quay về số tự lấy.
- Cụm SP: chữ; xóa = bỏ khỏi cụm.

**API:** `POST /api/stocktake/sessions/:id/paste` (quyền `edit`) body `{column, mode: 'skip'|'clear', rows: [{code, value}]}`, tối đa 10.000 dòng. Server kiểm lại toàn bộ (cột hợp lệ, đợt mở, mã thuộc đợt hoặc có trong `products` cơ sở đó, giá trị hợp lệ), ghi trong một transaction: upsert `stocktake_code_notes` hoặc `stocktake_product_tags`, tăng `version` từng bản ghi, một dòng `stocktake_history` action `paste` mỗi mã có đổi (`before`/`after`). Không kiểm `version` (ghi đè có chủ đích; xem trước đã báo số ô đổi). Trả `{changed, skipped: {notFound, invalid, unchanged}}`, rồi `announceChanged`. Đợt đóng: 409 `STOCKTAKE_CLOSED`.

## 9. Thay đổi dữ liệu (sửa trong `0103`)

- `stocktake_sessions`: `counterpart_session_id BIGINT NULL REFERENCES stocktake_sessions(id) ON DELETE SET NULL`.
- `stocktake_code_notes`: `print_page TEXT NOT NULL DEFAULT ''`, `print_time TEXT NOT NULL DEFAULT ''`, `prev_diff_manual NUMERIC NULL`, `other_diff_manual NUMERIC NULL`.
- `stocktake_session_results`: `prev_diff NUMERIC NULL`, `other_diff NUMERIC NULL`.
- `stocktake_history.action` thêm `paste`, `session_update`.

Form ghi chú trong hộp chi tiết mã thêm Trang in, Giờ in, KK trước sai (tay), Kiểm SG/HN (tay); `PUT …/codes/:code/note` nhận thêm bốn trường này.

## 10. Web test với dữ liệu thật

Script thử mới trong scratchpad, PGlite chạy migration thật, cổng riêng, người dùng giả như bản thử cũ:
- Đọc (chỉ đọc) từ DB thật qua `DATABASE_URL`: đơn + dòng đơn khách TEAM cả hai cơ sở trong khoảng ngày kiểm T10 (dò từ đơn TEAM tháng 10), `customers` liên quan, `products`, `stock_positions`, `hr_employees`. Chép vào PGlite.
- Nạp T10 và KIỂM SG từ sheet thật (service account chỉ đọc) qua đúng API nạp.
- Tạo hai đợt mở (HN, SG) cùng khoảng ngày, đối chiếu chéo nhau.
- Không ghi gì vào DB thật hay sheet. Tồn của đợt mở là tồn hôm nay nên SL chênh khác sheet; Tổng kiểm phải khớp cột C (HN) / Q (SG) của sheet trong cùng khoảng ngày.

## 11. Kiểm thử tự động

- `stocktakeCompute`: Count, Chênh cụm, Q/R/S kể cả mẫu số 0/trống; ưu tiên số dán tay hơn số tự lấy cho L, M.
- `stocktakeService` (PGlite): đợt đối chiếu (đúng/sai cơ sở, điền M từ đợt mở và đợt đóng); đóng đợt lưu `prev_diff`, `other_diff`; ghi chú lưu bốn trường mới; dán cột cho từng loại cột, `skip`/`clear`, mã không có, giá trị sai, đợt đóng, lịch sử `paste`.
- `stocktakeRoutes`: quyền của `paste` và `PATCH session`.
- `stocktakeSheetImport`: parser KIỂM SG (dò tiêu đề, bỏ dòng tổng); T10 đọc thêm L, I, J; nạp xong tự nối đối chiếu chéo.
- `stocktakeExport`: thứ tự và tên cột theo cơ sở.
- Hàm hiểu dữ liệu dán (tách dòng/cột, nhận dòng tiêu đề, đọc số kiểu VN) viết thuần trong `public/stocktake/stocktakePaste.js`, test bằng `node:test`. Sort kiểm bằng tay trên web test.
