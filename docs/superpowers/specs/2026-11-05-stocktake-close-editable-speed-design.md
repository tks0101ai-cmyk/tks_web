# Kiểm kê: đóng đợt vẫn sửa được, sửa file xuất, luật tên, tăng tốc

Ngày: 05/11/2026. Nhánh: `feat/stocktake-close-editable-speed`, tách từ `origin/main`. Migration `0114`.

## Bối cảnh

- Đóng đợt hiện chỉ chụp số tổng theo mã vào `stocktake_session_results`, không giữ dòng đơn, và khóa mọi sửa đổi. Quy trình thật: đóng đợt rồi xóa khách TEAM trên KiotViet, sau đó anh kho kiểm lại và số phải được ghi vào đợt.
- Đọc DB thật ngày 05/11/2026: Hà Nội có 238 đơn tên TEAM không còn khách trong bảng `customers`, nên không thể dựa vào dữ liệu Kiot sau khi đóng.
- Có 2 đợt web đang mở, chưa có đợt web nào đã đóng, nên không cần nạp bù dữ liệu cũ.
- File xuất dùng định dạng `#,##0.##`, Excel hiện `60.` với số nguyên.
- Luật tên hiện tại chỉ nhận `TEAM` + số.
- Số đo production ngày 05/11/2026:

| Thao tác | Thời gian |
|---|---|
| Cập nhật đơn Kiot, Sài Gòn, không có đơn cần ghi | 2,8 giây |
| Tải bảng đợt Sài Gòn | 2,8–6,1 giây |
| Tải bảng đợt Hà Nội | 1,0–1,2 giây |
| Mỗi truy vấn từ web tới DB | khoảng 175 ms |

Chưa tái hiện được mức chờ 1 phút người dùng gặp; log hiện không ghi thời gian API Kiểm kê. Đợt T10 có đơn Sài Gòn trung bình 28 dòng, nhiều nhất 81 dòng; Hà Nội trung bình 44, nhiều nhất 116. Mỗi dòng là một lượt ghi, nên 10 đơn cần ghi mất khoảng 50 giây theo ước tính.

## Thiết kế

### 1. Đóng đợt: chốt dữ liệu Kiot, vẫn sửa được

**Migration `0114_stocktake_frozen_lines.sql`** (kèm `db/rollbacks/0114_stocktake_frozen_lines.down.sql`, rollback test cập nhật):

```sql
ALTER TABLE stocktake_sessions ADD COLUMN IF NOT EXISTS lines_frozen_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS stocktake_session_lines (
  session_id   BIGINT  NOT NULL REFERENCES stocktake_sessions (id) ON DELETE CASCADE,
  order_id     BIGINT  NOT NULL,
  line_no      INTEGER NOT NULL,
  order_code   TEXT    NOT NULL DEFAULT '',
  order_status TEXT    NOT NULL DEFAULT '',
  team         TEXT    NOT NULL DEFAULT '',
  zone         TEXT    NOT NULL DEFAULT '',
  spec         TEXT    NOT NULL DEFAULT '',
  product_code TEXT    NOT NULL DEFAULT '',
  product_name TEXT    NOT NULL DEFAULT '',
  quantity     NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, order_id, line_no)
);
```

**Khi đóng đợt web** (`closeSession`, cùng giao dịch hiện có):

- Ghi các dòng `TEAM_LINES_SQL` chưa áp phần sửa vào `stocktake_session_lines`, đặt `lines_frozen_at = now()`.
- `stocktake_session_results` chụp như hiện tại, trừ `prev_diff`, `other_diff` nay lưu **số tự lấy** (`prevDiffAuto`, `otherDiffAuto`). Số nhập tay vẫn ở `stocktake_code_notes` nên sửa hoặc xóa sau khi đóng đều đúng.

**Một đợt là "đã chốt, còn sửa được"** khi `status = 'closed'`, `source = 'web'`, `lines_frozen_at` có giá trị và chưa hủy. API `shapeSession` trả thêm `frozen: boolean`. Đợt nạp từ sheet và đợt không có `lines_frozen_at` vẫn chỉ đọc.

**Đọc bảng đợt đã chốt:** `loadInputs` lấy nguồn theo trạng thái rồi dùng chung `buildBoard`:

| Đầu vào | Đợt đang mở | Đợt đã chốt |
|---|---|---|
| Dòng đơn | `TEAM_LINES_SQL` | `stocktake_session_lines` |
| Tồn, giá vốn, tên | `PRODUCTS_SQL` | `stocktake_session_results`, `active: true` |
| KK trước, đối chiếu | Tính từ đợt khác | `prev_diff`, `other_diff` đã lưu |
| Phần sửa, ghi chú, cụm | Như nhau | Như nhau |

`closedBoard` giữ nguyên cho đợt chỉ đọc. Mã mới thêm tay không có trong bản chụp thì `inKiot = false`, tồn 0, giá vốn 0.

**Ghi vào đợt đã chốt:** thay `openSessionForWrite` bằng kiểm tra `session.status === 'open' || session.frozen` cho `saveLine`, `addLine`, `saveNote`, `saveCells`. `updateSession`, `closeSession`, `refreshOrders` vẫn chỉ cho đợt đang mở. `saveLine` kiểm dòng nguồn trong `stocktake_session_lines` khi đợt đã chốt.

**Giữ `stocktake_session_results` luôn đúng:** sau `saveLine`, `addLine` trên đợt đã chốt, trong cùng giao dịch, tính lại các mã bị đụng (mã cũ và mã mới của dòng) và ghi `counted`, `diff_qty`, `diff_value`; mã chưa có dòng kết quả thì thêm mới. Đợt đang mở dùng đợt này làm KK trước hoặc đối chiếu nhờ đó thấy số mới. Đợt khác đã đóng giữ số đã lưu lúc đóng.

**Giao diện:**

- `editable()`, `canWrite()` nhận đợt đang mở hoặc `frozen`; phần dòng đếm hiện khi `frozen`.
- Dòng thông tin: `Đã chốt dữ liệu Kiot lúc HH:mm, vẫn sửa được`.
- Ẩn hoặc khóa Sửa ngày, Cập nhật đơn Kiot, Đóng đợt, đổi Đối chiếu, đổi KK trước. Không hỏi `order-status`.
- Nội dung hộp xác nhận Đóng đợt: chốt đơn, tồn, giá vốn tại thời điểm này, không cập nhật từ KiotViet nữa; vẫn sửa được số đếm, khu, quy cách, trạng thái; không mở lại được; hãy đóng đợt trước khi xóa khách TEAM.

Xuất Excel và Xuất thống kê của đợt đã chốt đọc bản đã chụp, nên không còn lệch khi đơn đổi sau khi đóng.

### 2. Bỏ dấu chấm thừa

Hàm `numberFormat(value)` trong `stocktakeExport.js`: số nguyên dùng `#,##0`, số lẻ dùng `#,##0.##`. Đặt theo từng ô cho cột Số lượng của file thống kê và mọi cột dùng `NUMBER` của Xuất Excel (Tổng kiểm, Tồn KIOT, SL chênh, KK trước sai, Kiểm SG/HN, Count, Chênh cụm).

### 3. Cột Đơn trong file thống kê

Thêm cột `Đơn` ở cuối: dòng từ Kiot ghi `line.orderCode`, dòng thêm tay ghi `Thêm tay`. Dòng từ Kiot đã sửa trên web vẫn ghi mã đơn.

### 4. Luật tên khách

Đổi `TEAM_NAME_MATCH_SQL` thành có **từ** `team`, không phân biệt hoa thường:

```sql
... ~* '(^|[^[:alpha:]])team([^[:alpha:]]|$)'
```

`isTeamOrder` trong `stocktakeOrderRefresh.js` dùng biểu thức tương ứng với `\p{L}`. `TEAM 1`, `TEAM1`, `KH Team Hàng Lỗi`, `Team Lỗi` được tính; `Steam`, `Teamwork` không tính. Dữ liệu thật hiện không có tên nào chứa `team` lọt trong từ khác; so với luật cũ có thêm đúng 2 khách `KH Team Hàng Lỗi` (HN) và `Team Lỗi` (SG), chưa có đơn trong khoảng ngày của 2 đợt hiện tại. Sửa cả chữ giải thích trong hộp Tạo đợt.

### 5. Tăng tốc

- **Ghi đơn gộp:** bật `batchDetails: true` cho `entities/orders.js`. Mỗi đơn ghi các dòng trong một `INSERT`. Áp dụng cho cả nút và lượt đồng bộ nền.
- **Sắp dòng ngoài giao dịch:** `documentEntityFactory` tách `prepareItems` thành hàm dùng được riêng và cho `upsertPage` nhận tùy chọn đã sắp. `stocktakeOrderRefresh` gọi sắp dòng trước `BEGIN`. Lượt nền giữ nguyên.
- **Nút trả lời sớm:** `bindRefreshOrders` nhả nút và báo kết quả ngay khi `refresh-orders` trả về, sau đó tải bảng nền. Dừng chờ sau 60 giây bằng `AbortController`, báo lỗi rõ.
- **Đối chiếu không dựng lại bảng mỗi lần:** `counterpartResults` của đợt đối chiếu đang mở dùng `cached('counterpart:' + id)` với TTL 60 giây. `closeSession` bỏ cache này để chụp số mới nhất. Cột Kiểm SG/HN có thể trễ tối đa 1 phút.
- **Gộp tải lại khi có người khác sửa:** `startLive` tải lại tối đa 1 lần mỗi 3 giây, có lần chờ cuối để không bỏ sót; tab ẩn thì đánh dấu và tải khi quay lại. Lưu trong tab hiện tại không đổi.
- **Đo thời gian:** gắn `startTiming` cho `/api/stocktake` trong `routes.js`, trừ route SSE `/events` vì kết nối dài. `refresh-orders` đánh dấu các bước lấy đơn, sắp dòng, ghi đơn. Yêu cầu từ 500 ms ghi một dòng `[timing]` trên log Render.

## Thứ tự triển khai

Áp `0114` lên DB **trước khi deploy**: các câu đọc đợt đều chọn cột `lines_frozen_at`, nên chưa áp thì mọi API Kiểm kê sẽ lỗi. Migration chỉ thêm một cột cho phép rỗng và một bảng mới, nên bản web đang chạy không bị ảnh hưởng khi áp trước. Chỉ áp lên DB thật khi người dùng đồng ý.

## Ngoài phạm vi

- Không có nút mở lại đợt đã đóng.
- Đợt T10 nạp từ sheet vẫn chỉ đọc.
- Không chuyển vùng web sang Singapore (đề xuất riêng).
- Không đổi lượng dữ liệu của `PRODUCTS_SQL`.
- Không tự thêm mã vào đợt đã chốt khi có hàng mới trên KiotViet.

## Kiểm thử

- `stocktakeService.test.js` (PGlite):
  - Đóng đợt chụp đủ dòng; xóa khách, sửa, hủy, xóa đơn sau đó không đổi bảng.
  - Tồn, giá vốn giữ nguyên khi `products` đổi; `refreshOrders`, `updateSession` bị chặn.
  - Sửa SL, khu, quy cách, bỏ dòng, thêm dòng tay sau khi đóng: Tổng kiểm, SL chênh, Giá trị chênh và `stocktake_session_results` đều đổi.
  - Mã thêm tay không có trong bản chụp được tạo trong kết quả; đợt đang mở dùng đợt đã chốt làm KK trước thấy số mới.
  - Số nhập tay KK trước sửa và xóa sau khi đóng đều đúng; đợt nạp từ sheet và đợt không có `lines_frozen_at` vẫn chặn; đợt đã hủy chặn.
  - Luật tên: nhận `TEAM 1`, `TEAM1`, `KH Team Hàng Lỗi`, `team-5`; bỏ `Steam`, `Teamwork`.
- `stocktakeOrderRefresh.test.js`: luật tên trùng SQL; gọi sắp dòng trước `BEGIN`.
- `stocktakeExport.test.js`: số nguyên `#,##0`, số lẻ `#,##0.##`, ở cả hai file; cột Đơn.
- `entities` test: đơn nhiều dòng ghi một `INSERT`, `line_no` đúng thứ tự; `upsertPage` với tùy chọn đã sắp không sắp lại.
- `stocktakeRoutes.test.js`: `frozen` trong API; có header `Server-Timing`; SSE không bị đo.
- Hàm thuần gộp tải lại trong `stocktakeGrid.js`: tối đa 1 lần mỗi 3 giây, có lần cuối.
- Rollback test cho `0114`.
- Xem trên trình duyệt với server PGlite: đóng đợt, sửa ô, sửa dòng, thêm dòng, không còn nút thừa, nút trả lời sớm, sáng/tối, 375px, tài khoản chỉ xem.
- Sau deploy: đọc log `[timing]` của `refresh-orders` và `board` trên đợt Sài Gòn thật.
