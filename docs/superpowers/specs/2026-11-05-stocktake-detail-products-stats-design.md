# Kiểm kê: gọn hộp chi tiết, sửa dòng đếm, hiện đủ sản phẩm, xuất thống kê

Ngày: 05/11/2026. Nhánh: `feat/stocktake-detail-products-stats`, tách từ `origin/main`. Không có migration.

## Bối cảnh

- Hộp chi tiết mã lặp lại phần đã xem và nhập được trên bảng: 6 ô số, khối Kiểm lại, khối Cụm SP / Combo.
- Bảng dòng đếm chỉ sửa được SL và không sort được.
- `buildBoard` chỉ đưa vào danh sách mã có dòng đếm, có tồn khác 0 hoặc có ghi chú. Mã có Tổng kiểm dương và Tồn = 0 đã hiện (đợt T10 có 60 mã như vậy); mã chưa ai đếm và không có tồn thì không hiện.
- Số hàng trên DB thật ngày 05/11/2026:

| Cơ sở | Đang hoạt động (`is_active IS NOT FALSE`) | Có tồn | Tổng dòng |
|---|---|---|---|
| Hà Nội | 4.131 | 2.093 | 11.145 |
| Sài Gòn | 2.799 | 1.835 | 3.893 |

- Tab THỐNG KÊ của sheet kiểm kê (gid `1663139112`) có 3.598 dòng, mỗi dòng là một dòng đơn TEAM, gồm 8 cột: Tên khách hàng, Ghi chú, Mã hàng, Tên hàng, Ghi chú hàng hóa, Số lượng, Trang in, Paste vào đây. Dòng sắp gần như theo tên hàng (3.547/3.597 cặp liền nhau đúng thứ tự). Cột Trang in chỉ có 3 ô có giá trị, một ô là lỗi `#REF!`. Cột Paste vào đây trống.

## Thiết kế

### 1. Gọn hộp chi tiết mã

Trong `public/stocktake/`:

- Bỏ `#stDetailStats`, form `#stNoteForm`, form `#stTagForm` và code đi kèm: phần điền form trong `renderDetail`, `checkStale`, `fillStatusSelect`, các listener submit, danh sách gợi ý `stRecheckSuggestions`, `stReasonSuggestions`.
- Hộp còn tiêu đề, `#stDetailError`, `#stConflict`, **Dòng đếm theo team / khu** và **Lịch sử thay đổi**.
- `#stConflict` chỉ còn dùng cho xung đột khi lưu dòng đếm.
- Đợt đã đóng vẫn ẩn phần dòng đếm như hiện tại, nên hộp chỉ còn lịch sử.

Giữ nguyên API `PUT .../note`, `PUT .../tag` và dữ liệu đã nhập. Không xóa API trong đợt này vì không cần thiết để đạt mục tiêu. Các cột đã bỏ trong hộp vẫn sửa được trên bảng qua `POST .../cells`.

### 2. Bảng dòng đếm

**Sửa Khu và Quy cách**

- Ô Khu và Quy cách thành ô nhập chữ giống ô SL, rời ô (`change`) thì gọi `saveLine` với `{ zone }` hoặc `{ spec }`. `saveLine` ở máy chủ đã nhận hai trường này, không đổi API.
- Dòng gốc từ đơn có giá trị khác đơn thì hiện dòng nhỏ `gốc …`, như SL. Dòng thêm tay không có `gốc`.
- Dòng đã bỏ hoặc người không có quyền sửa: ô nhập bị khóa.
- Để trống rồi lưu thì giá trị thành rỗng, không quay về giá trị gốc.

**Sort**

- Bấm tiêu đề Team, Khu, Quy cách, SL, Đơn, Sửa bởi: tăng, giảm, rồi về thứ tự gốc của `row.lines`. Cột thao tác không sort.
- Chữ so bằng `localeCompare(..., 'vi', { numeric: true })` nên `TEAM 2` đứng trước `TEAM 10`. Ô trống luôn nằm cuối.
- Hàm thuần `sortLines(lines, key, dir)` đặt trong `stocktakeGrid.js`, có test.
- Giữ trạng thái sort khi bảng vẽ lại sau lưu hoặc tải nền; đặt lại khi mở mã khác.

**Không mất chữ đang gõ**

`renderLines` đang xóa và dựng lại `tbody`, nên tải nền (SSE, hỏi định kỳ 30 giây) làm mất ô đang gõ, và lưu xong thì mất con trỏ ở ô kế tiếp khi nhấn Tab. Trước khi dựng lại, ghi nhớ ô đang focus theo khóa dòng (`orderId:lineNo` hoặc `editId`) và trường, cùng giá trị đang gõ và vị trí con trỏ. Dựng xong thì tìm lại đúng ô và trả lại. Nếu dòng không còn thì bỏ qua.

### 3. Hiện đủ sản phẩm

- `PRODUCTS_SQL` trả thêm `is_active` và bỏ các dòng có mã đã nhường (`code` chứa `#`, xem `RELEASE_CODES_SQL` trong `entities/products.js`).
- `buildBoard` thêm mọi mã có `active !== false` vào danh sách. Điều kiện cũ giữ nguyên, nên hàng đã ngừng mà còn tồn, có số đếm hoặc có ghi chú vẫn hiện.
- `totalsOf`, `forgotten`, bộ lọc giữ nguyên ý nghĩa: mã 0/0 không phải Quên KK và không phải mã lệch.
- Sắp mặc định vẫn là giá trị chênh lớn trước, nên mã 0/0 nằm cuối.
- `Status.summarize` không đếm mã có `counted = 0`, `stock = 0` và chưa có trạng thái (thẻ Chưa XL). Mã 0/0 đã có trạng thái vẫn được đếm theo trạng thái đó.
- `closeSession` chụp đủ danh sách mới. Đợt đã đóng giữ nguyên bản chụp.
- Tốc độ: 4.131 dòng tương đương đợt T10 3.975 dòng đang chạy; bảng vẫn vẽ dần 200 dòng khi cuộn.

### 4. Xuất file thống kê

**API:** `GET /api/stocktake/sessions/:id/export-lines`, quyền `stocktake.view` như Xuất Excel. Trả file `kiem-ke-thong-ke-<tên đợt>.xlsx`, một tab `THỐNG KÊ`.

**Cột:**

| Cột | Nguồn |
|---|---|
| Tên khách hàng | `line.team` |
| Ghi chú | `line.zone` |
| Mã hàng | `row.code` |
| Tên hàng | `row.name` |
| Ghi chú hàng hóa | `line.spec` |
| Số lượng | `line.quantity` |
| Kiểm quy cách | Kết quả so quy cách với số lượng, xem bên dưới |
| Trang in | `row.note.printPage` |

**Cột Kiểm quy cách:** hàm thuần `checkSpec(spec, quantity)` dùng `parseSpec` có sẵn trong `public/shared/carton.js` (đọc `3Tx40+1Tx17`, `1T x 40c`, `9*12`, `1th x 60c`, phần lẻ `3T x 100 - 20`), lấy số lượng tính được so với SL, sai số dưới 0,000001 coi là khớp.

| Trường hợp | Nội dung ô | Màu ô |
|---|---|---|
| Khớp | Để trống | Không tô |
| Lệch | `Lệch: quy cách 240, SL 210` | Đỏ nhạt |
| Không đọc được quy cách | `Không nhân được quy cách` | Vàng nhạt |
| Quy cách trống | `Thiếu quy cách` | Vàng nhạt |

Chỉ dùng trình đọc nghiêm có sẵn, không đoán: quy cách kèm chữ như `12tx30 chưa thay vỏ`, `LẤY PIN 1t*60`, `1t` thuộc nhóm không nhân được, để người kiểm xem lại. Cột có bộ lọc Excel để lọc nhanh các dòng cần xem.

Chạy thử trình đọc này trên 3.598 dòng của tab THỐNG KÊ thật: 3.265 dòng khớp, 25 dòng lệch (ví dụ `CLNSH8` `8t*30` = 240, SL 210), 216 dòng không nhân được, 92 dòng quy cách trống.

**Quy tắc:**

- Dùng số sau khi áp phần sửa trên web. Bỏ dòng có `removed`, gồm cả dòng thêm tay. Cộng theo mã phải bằng Tổng kiểm.
- Sắp theo tên hàng (`localeCompare` tiếng Việt), rồi team, rồi khu. Xuất cả đợt, không theo bộ lọc đang chọn.
- Chữ đi qua `safeText` để chặn công thức Excel, như file hiện tại.
- Dùng `applyFullTableBorder`, `frozenNoGridlinesView`, `HEADER_FONT` như file hiện tại.

**Đợt theo trạng thái:**

- Đợt đang mở: lấy từ bảng đang tính.
- Đợt đã đóng tạo trên web: `loadInputs` đọc lại đơn và phần sửa, nên có thể lệch bản chụp nếu đơn bị sửa sau khi đóng. Trang in lấy từ ghi chú của đợt.
- Đợt nạp từ sheet: không có dòng đơn, trả 409 `STOCKTAKE_NO_LINES` với thông báo rõ.
- Đợt đã hủy: xuất như đợt đã đóng hoặc đang mở tương ứng, vì Xuất Excel hiện cũng không chặn.

**Giao diện:** nút **Xuất thống kê** cạnh **Xuất Excel**, tải file như nút hiện có, lỗi thì hiện ở `#stNotice`.

## Ngoài phạm vi

- Không xóa API `note`, `tag`.
- Không cho sửa Team trong bảng dòng đếm.
- Không đưa hàng đã ngừng và không còn tồn vào danh sách.
- Không có cột Paste vào đây.
- Không xuất các tab thưởng / phạt của sheet.

## Kiểm thử

- `stocktakeCompute.test.js`: mã đang hoạt động 0/0 có trong bảng và không là Quên KK; mã đã ngừng 0/0 không có; mã đã ngừng còn tồn, có số đếm, có ghi chú vẫn có; mã đếm dương tồn 0 có `diffQty` dương.
- `stocktakeService.test.js` (PGlite): `getBoard` có mã 0/0; bỏ mã chứa `#`; đóng đợt chụp đủ; sửa `zone`, `spec` có lịch sử; dữ liệu xuất thống kê bỏ dòng `removed`, có dòng tay, cộng theo mã bằng `counted`; đợt nạp từ sheet báo `STOCKTAKE_NO_LINES`.
- `stocktakeStatus.test.js`: `summarize` không đếm mã 0/0 chưa có trạng thái, vẫn đếm mã 0/0 có trạng thái.
- `stocktakeGrid.test.js`: `sortLines` tăng, giảm, bỏ sort, số tự nhiên, ô trống cuối.
- `stocktakeExport.test.js`: `checkSpec` khớp, lệch, không nhân được, trống, nhiều số hạng, phần lẻ, số lẻ thập phân ở SL; chữ và màu ô trong file.
- `stocktakeRoutes.test.js`: route mới, quyền, tên và kiểu file, đọc lại đúng cột bằng ExcelJS.
- Xem trên trình duyệt với server PGlite: hộp gọn, sửa Khu và Quy cách, Tab sang ô sau, sort, không mất chữ khi tải nền, mã 0/0 hiện cuối bảng, thẻ Chưa XL, tải file, sáng/tối, 375px, tài khoản chỉ xem.
- Đối chiếu chỉ đọc với DB thật: Hà Nội ra khoảng 4.131 mã trở lên, đợt thật cộng theo mã bằng Tổng kiểm.
