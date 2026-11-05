# Kiểm kê: gom đúng đơn TEAM vào Tổng kiểm và giữ giá vốn khớp KiotViet

Ngày: 05/11/2026. Nhánh: `fix/stocktake-team-orders-cost`, tách từ `origin/main`. Không có migration.

## Vấn đề

Đợt Hà Nội "KK 7/11" xuất Excel ngày 05/11 có hai lỗi: Tổng kiểm bằng 0 trên toàn bộ 2.096 dòng, và cột Giá trị chênh lệch +17.406.439 đ so với báo cáo giá trị kho của KiotViet.

### Bằng chứng về Tổng kiểm (DB thật, chỉ đọc)

- Đợt đặt `date_from = date_to = 07/11`. Đơn test `DH048393` (khách `TEAM 1: Quân test`, mã `BGN316-1000`, SL 50) đặt ngày 05/11. `TEAM_LINES_SQL` lọc ngày 05/11 ra đúng dòng này, lọc ngày 07/11 ra 0 dòng. Phần gom đơn vẫn chạy, chỉ là đơn nằm ngoài khoảng ngày.
- Web không có cách đổi ngày của đợt đã tạo: `updateSession` chỉ nhận đợt đối chiếu và đợt KK trước.
- `orders.order_date` lưu giờ VN nhưng gắn nhãn UTC (`purchaseDate` `08:15:11.927`, cột `08:15:11.927Z`). `TEAM_LINES_SQL` lại đổi bằng `AT TIME ZONE 'Asia/Ho_Chi_Minh'`, nên đơn từ 17:00 bị tính sang hôm sau: ngày 29/10 có 27/131 đơn TEAM bị tính thành 30/10. Các module khác đều dùng `AT TIME ZONE 'UTC'` (`kiotOrdersRepository`, `documentsRepository`).
- Đơn test lên DB sau khoảng 42 giây, nhưng trang chỉ tải lại khi có người sửa trên web (SSE `stocktake-changed`), không tải lại khi đơn mới đồng bộ về.
- Điều kiện `LIKE 'TEAM%'` đang gom cả khách `Team Lỗi` ở Sài Gòn. Khách `KH Team Hàng Lỗi` ở Hà Nội thì không bị gom.
- Đợt Sài Gòn tên "KK 7/11" lại đặt ngày 04/11. Đây là dữ liệu, người dùng tự kiểm tra và sửa sau khi có chức năng sửa ngày.

### Bằng chứng về giá (file Excel, đối chiếu KiotViet thật)

399 mã lệch quá 1 đồng, tổng +17.406.439 đ:

| Nhóm | Số mã | Tổng lệch | Ví dụ |
|---|---|---|---|
| Giá vốn trong DB đã cũ | 33 | +16.217.868 đ | `TUOPES`: DB 0, KiotViet 3.300 |
| `PRODUCTS_SQL` làm tròn `ROUND(AVG(cost))` | 366 | +1.188.571 đ | `KB8IBV`: 511,41 thành 511, lệch 974.283 đ |

Cả 33 mã đều có giá trong DB khác `/products/code/{code}`, trong khi `modifiedDate` của mã nhìn chung không đổi. Giá vốn chỉ được cập nhật khi sản phẩm đổi thông tin, vì:

- Poll tăng dần `/products` dựa trên `modifiedDate`, mà đổi giá vốn thường không làm đổi ngày này.
- `/productOnHands` chỉ trả `onHand`/`reserved`, nên `mergeInventories` giữ `cost` cũ.
- Đối soát 24 giờ (`UPDATE_CHANGED_SQL`) cố ý giữ nguyên `raw->'inventories'` để không ghi đè tồn kho.

Danh sách `/products?includeInventory=true&orderBy=id` trả đúng giá mới (32/32 mã tra được đều khớp; mã thứ 33 không tìm thấy khi so nguyên văn theo mã nên chưa so được ở bước này). Quét toàn bộ Hà Nội mất 46 giây (112 trang, 11.122 mã).

## Thiết kế

### 1. Gom đơn TEAM

Trong `server/stocktake/stocktakeService.js`, viết lại điều kiện của `TEAM_LINES_SQL`:

```sql
o.order_date >= ($2::date)::timestamp AT TIME ZONE 'UTC'
AND o.order_date < ($3::date + 1)::timestamp AT TIME ZONE 'UTC'
AND btrim(COALESCE(NULLIF(c.name, ''), o.raw->>'customerName', '')) ~* '^TEAM[[:space:]]*[0-9]'
```

- Ngày theo đúng giờ VN đang lưu trong cột, và dùng được chỉ mục `orders(branch, order_date)`.
- Chỉ gom khách `TEAM` + số (người dùng đã chốt). `Team Lỗi`, `KH Team Hàng Lỗi` không được tính. `TEAM 1: Quân test` vẫn được tính vì đúng mẫu.
- Vẫn tính mọi trạng thái, kể cả đơn đã hủy, như thiết kế ban đầu (đội hủy đơn sau khi đếm).

### 2. Sửa ngày của đợt đang mở

- `updateSession` nhận thêm `dateFrom`, `dateTo`. Kiểm tra bằng `dateField` và `dateTo >= dateFrom` như lúc tạo, ghi `session_update` kèm ngày cũ và mới. Chỉ đợt đang mở sửa được, và cần quyền `stocktake.edit`.
- Nút **Sửa ngày** cạnh ngày của đợt mở hộp thoại có 2 ô ngày, gửi kèm `version`. Lệch `version` thì báo như các thao tác khác.
- Phần sửa dòng đếm vẫn giữ theo `(order_id, line_no)`. Đơn ra khỏi khoảng thì phần sửa không tính, đơn quay lại thì phần sửa có hiệu lực lại. Dòng thêm tay luôn được tính.

### 3. Hiện số đơn đã gom và tự cập nhật

API mới `GET /api/stocktake/sessions/:id/order-status`, quyền `stocktake.view`, trả:

```json
{
  "revision": "12:2026-11-05T01:15:53.948Z",
  "inRange": 12,
  "outOfRange": { "count": 1, "from": "2026-11-05", "to": "2026-11-05" }
}
```

- `inRange`: số đơn TEAM trong khoảng ngày, tính cả đơn đã hủy.
- `revision`: `inRange` + `max(synced_at)` của các đơn đó.
- `outOfRange`: đơn TEAM **chưa hủy**, cách khoảng ngày không quá 14 ngày. Bỏ đơn đã hủy để các đơn test cũ (131 đơn ngày 29/10) không gây nhiễu.
- Đợt đã đóng hoặc đã hủy không gọi API này.

Trên trang:

- Dòng ngày của đợt thêm "Đã gom N đơn TEAM".
- Nếu `outOfRange.count > 0`, hiện cảnh báo "Có M đơn TEAM chưa tính vì nằm ngoài khoảng ngày (05/11)" kèm nút Sửa ngày.
- Khi tab đang hiển thị, cứ 30 giây gọi API một lần và khi quay lại tab thì gọi ngay. `revision` đổi thì `loadBoard({ background: true })`, cơ chế có sẵn nên không đè ô đang gõ. Lỗi mạng thì bỏ qua và thử lại lần sau.

Chọn hỏi định kỳ thay vì phát sự kiện từ luồng đồng bộ, vì cách này vẫn chạy đúng nếu sau này tách worker riêng khỏi web.

### 4. Lượt đồng bộ giá vốn

Entity mới `server/kiotvietSync/entities/productCosts.js`, tên `product_costs`, chạy trong nhóm `slowEntities` nên cập nhật mỗi 20 phút (nhanh hơn mốc 30 phút đã nêu trước đó, không cần thêm cấu hình). Nhóm này không chặn lượt đồng bộ đơn hàng.

- Gọi `/products` với `includeInventory=true&orderBy=id&orderDirection=ASC`, `pollFullSnapshot: true`.
- Một câu `UPDATE` duy nhất, so sánh ngay trong Postgres, chỉ ghi dòng có `cost` khác theo giá trị số (cùng `branchId`). Chỉ đổi trường `cost` trong phần tử `inventories`, không đụng `onHand`, `reserved`, `onOrder`.
- Không chèn sản phẩm mới, không ghi `cost` rỗng. Sản phẩm chưa có trong DB hoặc kho chưa có trong `inventories` thì bỏ qua (poll `/products` sẽ tạo).
- Tranh chấp: `productOnHands` đọc rồi ghi cả mảng `inventories` nên có thể ghi đè giá vừa cập nhật. Khả năng rất nhỏ và lượt sau tự sửa trong 20 phút, nên chấp nhận.
- Lần chạy đầu sau deploy tự sửa toàn bộ giá đang cũ. Các đợt đang mở nhận giá mới ở lần tải bảng kế tiếp; đợt đã đóng giữ nguyên bản chụp.

**Ảnh hưởng ngoài Kiểm kê:** các màn hình khác đọc giá vốn từ `raw->'inventories'` cũng sẽ có số mới đúng hơn, nên giá trị tồn có thể đổi so với trước.

### 5. Giá vốn đủ số lẻ

- `PRODUCTS_SQL` bỏ `ROUND`. `diffValue` vẫn là `Math.round(diffQty * cost)`.
- Cột Giá vốn trên web hiện tối đa 2 số lẻ (dùng `num` thay vì `money`), giá trị chênh vẫn làm tròn đồng. Giữ nguyên độ rộng cột 80px, kiểm tra trên trình duyệt với số lớn như `163,502.86`.
- File Excel giữ giá trị đầy đủ trong ô, định dạng cột không đổi.

## Ngoài phạm vi

- Không tự sửa ngày các đợt có sẵn, người dùng tự kiểm tra.
- Không sửa `stocktake_session_results` của đợt đã đóng.
- Không đổi đối soát 24 giờ và poll `/products` hiện có.
- Không thêm nút làm mới giá bằng tay.
- Không tự cập nhật bảng khi chỉ có tồn kho đổi: bảng lấy tồn mới ở lần tải kế tiếp.

## Kiểm thử

- `stocktakeService.test.js` (PGlite):
  - Đơn 23:30 ngày 29/10 vẫn thuộc 29/10, đơn 00:10 ngày 30/10 không thuộc.
  - Khách `Team Lỗi`, `KH Team Hàng Lỗi` không được tính, `TEAM1 ...` và `TEAM 1: ...` được tính.
  - Sửa ngày: thành công có ghi lịch sử, sai thứ tự ngày, lệch `version`, đợt đã đóng.
  - `order-status`: đếm trong khoảng, ngoài khoảng, bỏ đơn đã hủy, `revision` đổi khi `synced_at` đổi.
  - Giá vốn lẻ cho `diffValue` đúng.
- `stocktakeRoutes.test.js`: route mới và quyền.
- `productCosts.test.js` (PGlite):
  - Chỉ đổi `cost`, giữ `onHand` và `reserved`; dòng không đổi thì không ghi (`synced_at` giữ nguyên).
  - Bỏ qua sản phẩm lạ và `cost` rỗng; `511` so với `511.00` không tính là đổi.
- `scheduler` có test thì cập nhật danh sách entity.
- Đối chiếu sau khi sửa (chỉ đọc): chạy logic mới với file `kiem-ke-KK-7-11.xlsx`, kỳ vọng còn lệch rất nhỏ, phần còn lại do thời điểm lấy số.
- Xem trên trình duyệt: Sửa ngày, cảnh báo ngoài khoảng, tự cập nhật, sáng/tối, 375px, với dữ liệu giả trên PGlite. Không chạy lượt ghi lên DB thật khi kiểm thử.
