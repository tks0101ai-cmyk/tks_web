# Kiểm kê (đối chiếu) — thiết kế đã duyệt 31/10/2026

Chuyển tab `KIỂM KÊ HN T10` của sheet kiểm kê (`1hbYPE1t7vTkpheKdmYpLkD9OyUH4GADcP4xZEoTeF1M`) lên web. Phân tích sheet và dữ liệu DB nằm ở session brainstorming 29–31/10/2026.

## Phạm vi đợt 1

- Chỉ phần **đối chiếu**: số đếm, tồn, chênh lệch, kiểm lại, lý do, Cụm SP, Combo.
- Chỉ **Hà Nội**. Sài Gòn làm sau khi Hà Nội chạy ổn; cột "Kiểm SG" để trống.
- Ngoài phạm vi: chia team/khu, thưởng/phạt, cân bằng kho trên KiotViet (vẫn làm tay), cột Trang in / Giờ in.

## Cách mọi người làm hiện nay (tóm tắt)

Mỗi team là một khách KiotViet tên `TEAM <số> : ...`. Team nhập số đếm thành đơn đặt hàng: ghi chú đơn là khu/ô, ghi chú dòng là quy cách, số lượng là tổng đếm. Đơn được xuất, dán vào sheet, so với tồn KiotViet; ba quản lý kiểm kho (Thắng, Quân, Hưng) giao mã lệch cho người kiểm lại, ghi trạng thái và lý do, rồi hủy các đơn TEAM.

## Nguồn dữ liệu (cách A: tính trực tiếp, phần sửa lưu riêng)

| Cột | Nguồn |
|---|---|
| TỔNG KIỂM | `order_details` của đơn có khách tên bắt đầu `TEAM`, cơ sở và khoảng ngày của đợt, **gồm cả đơn đã hủy**; cộng phần sửa trong `stocktake_line_edits` |
| Khu, quy cách | Ghi chú đơn / ghi chú dòng trong `raw` của đơn |
| Tên hàng, Tồn KIOT, Giá vốn | `products` (tồn hiện tại, đồng bộ mỗi 10 phút) |
| Vị trí kho gần nhất | `stock_positions` |
| KK trước sai | `stocktake_session_results` của đợt đã đóng gần nhất cùng cơ sở |
| Cụm SP, Combo | `stocktake_product_tags` |

Không ghi vào bảng đồng bộ từ KiotViet. Đơn TEAM mới nhập trên KiotViet tự xuất hiện trong đợt đang mở.

**Danh sách mã của đợt** = mã có số đếm ∪ mã có tồn khác 0 (để bắt "Quên KK").

**SL chênh** = TỔNG KIỂM − Tồn KIOT; **giá trị chênh** = SL chênh × giá vốn. Chênh theo Cụm SP = tổng chênh các mã cùng cụm.

## Vòng đời đợt

1. Người có quyền tạo đợt: cơ sở, từ ngày – đến ngày, tên.
2. Trong lúc **mở**: tồn chạy theo tồn hiện tại; được sửa số đếm, giao kiểm lại, ghi lý do.
3. **Đóng đợt**: chụp từng mã (tổng kiểm, tồn, giá vốn, SL chênh) vào `stocktake_session_results`. Đợt đã đóng chỉ đọc từ bản chụp, không trôi theo tồn mới, và là nguồn KK trước của đợt sau.
4. Nạp một lần cột SL Chênh của sheet T10 (đợt 3/10) thành một đợt đã đóng, để đợt đầu trên web có KK trước.

## Migration `0103` và module `server/stocktake/`

| Bảng | Nội dung |
|---|---|
| `stocktake_sessions` | id, cơ sở, tên, từ ngày, đến ngày, trạng thái `open`/`closed`, người tạo, giờ tạo, người đóng, giờ đóng |
| `stocktake_line_edits` | Theo đợt: sửa dòng gốc `(order_id, line_no)` — SL, quy cách, khu, hoặc bỏ dòng — hoặc dòng thêm tay (mã, SL, khu, quy cách, team); `version`, người sửa, giờ sửa |
| `stocktake_code_notes` | Theo `(đợt, mã)`: trạng thái, chi tiết lý do, người kiểm lại (`hr_employees`); `version`, người sửa, giờ sửa |
| `stocktake_history` | Mọi thay đổi theo đợt và mã: loại thay đổi, giá trị trước/sau, người, giờ |
| `stocktake_product_tags` | Theo `(cơ sở, mã)`, giữ qua các đợt: Cụm SP, cờ Combo; `version` |
| `stocktake_session_results` | Bản chụp lúc đóng theo `(đợt, mã)`: tổng kiểm, tồn, giá vốn, SL chênh, giá trị chênh |

Số lượng và tiền dùng `NUMERIC`; giờ theo `Asia/Ho_Chi_Minh`.

## Quyền

- Thêm `stocktake.view` (xem đợt, bảng đối chiếu) và `stocktake.edit` (tạo đợt, sửa số đếm, giao người kiểm lại, ghi trạng thái/lý do, gắn Cụm SP/Combo) vào `featureRegistry`.
- Mặc định chỉ Quản lý có hai quyền này. Admin cấp thêm cho tài khoản Thắng, Quân, Hưng ở trang Quản lý tài khoản.
- **Đóng đợt** và **nạp số liệu T10**: chỉ Quản lý.

## Người kiểm lại

- Chọn từ `hr_employees`, không cần tài khoản web; người kiểm lại báo kết quả cho quản lý.
- Bộ lọc theo Người kiểm lại; bảng nhỏ đếm số mã đã giao cho mỗi người (thay Sheet87, để dành cho phần thưởng sau này).
- Trạng thái và Chi tiết lý do gõ tự do, có gợi ý từ các giá trị đã dùng.

## Ba quản lý sửa chung một bảng

- Mọi bản ghi sửa được (`line_edits`, `code_notes`, `product_tags`) có `version`. Lưu với version cũ bị từ chối (409) kèm bản mới và tên người vừa sửa ("Hưng vừa sửa mã này lúc 10:42"); người dùng xem bản mới rồi mới lưu lại. Không ghi đè lặng lẽ.
- Mỗi mã hiện người sửa cuối và giờ sửa; có lịch sử thay đổi theo mã.
- Bảng tự làm mới khi người khác sửa, dùng kênh SSE sẵn có.

## Giao diện

- Trang danh sách đợt và trang đối chiếu của một đợt, theo mẫu trang VT Hà Nội.
- Bảng đối chiếu dùng `table-controls.js` (ẩn/hiện cột, chỉnh độ rộng, phân trang); hỗ trợ sáng/tối và di động.
- Bộ lọc: chỉ mã lệch, theo người kiểm lại, theo trạng thái, theo Cụm SP, Quên KK.
- Mở một mã thấy các dòng đếm theo team/khu/quy cách (sửa, bỏ, thêm dòng) và lịch sử.

## Kiểm thử

- Unit test `node:test`: gom số đếm (gồm đơn hủy, dòng sửa/bỏ/thêm), danh sách mã gồm Quên KK, chênh theo Cụm SP, xung đột version (409), bản chụp khi đóng và KK trước, kiểm quyền.
- Đối chiếu đợt 3/10: số đếm web so với sheet T10 (đã biết ~1.650 mã khớp, ~150–180 mã lệch do sửa tay sau kiểm lại).
- Kiểm tra trên trình duyệt với server local chế độ chỉ đọc.

## Lưu ý triển khai

- Worktree đang sau `origin/main`; cập nhật nhánh trước khi tạo migration (`0101`, `0102` đã có trên main).
- Cập nhật tài liệu theo skill `update-file` (README, server/README, SCHEMA.md, implementation_plan, SRS/BRD, CURRENT.md).

_Cập nhật: 31/10/2026_
