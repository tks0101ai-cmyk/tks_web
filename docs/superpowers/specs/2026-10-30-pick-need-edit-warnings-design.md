# Chỉ định vị trí: sửa "Cần nhặt", 2 cảnh báo mới, phiếu in giữ thứ tự Kiot

Ngày: 30/10/2026. Đã được người dùng duyệt (hội thoại cùng ngày). Không migration.

## Quyết định đã chốt

- Thay cảnh báo cũ **Lệch SL bốc** (+ nút **Đã xử lý**, route `POST /api/shipment/pick/mismatch-ack`) bằng 2 cảnh báo mới. Migration `0098` giữ nguyên.
- Phiếu in cột SL ghi **SL đã sửa** (không phải SL gốc Kiot).

## 1. Phiếu in giữ thứ tự đơn Kiot
`public/shipment/lifecycle/pick/invoice.js`: bỏ bước sắp dòng theo tên vị trí đầu tiên; dòng in theo đúng thứ tự `order.lines` của snapshot (thứ tự Kiot), TT đánh 1, 2, 3…

## 2. "Cần nhặt" sửa tay (hộp chọn vị trí)
- Ô "Cần nhặt" là ô nhập số nguyên ≥ 1; khi khác SL Kiot hiện thêm dòng nhỏ "Kiot: N".
- Dòng đỏ (`picking-mismatch`) khi tổng SL chọn ≠ "Cần nhặt" đang hiển thị; khớp thì hết đỏ.
- Với đơn Đang nhặt, sửa "Cần nhặt" là thay đổi chưa lưu (`dirty()`), bật "Cập nhật chỉ định & In phiếu".
- `POST /api/shipment/pick` nhận thêm `needs: { "<mã hàng>": SL }` (tùy chọn; mã thiếu = SL Kiot). Máy chủ kiểm tra: mã có trong đơn, số nguyên ≥ 1 trong giới hạn an toàn, rồi validate phân bổ theo SL đã sửa.
- Snapshot đơn: mã nào có SL sửa khác SL Kiot thì các dòng Kiot của mã đó gộp thành một dòng (giá bình quân như `mergeOrderLines`), `quantity` = SL đã sửa, kèm `kiotQuantity` = SL Kiot lúc chỉ định. Thành tiền/tổng tiền trên phiếu tính lại theo SL đã sửa.
- `GET candidates`/`GET assignment`: hộp lấy "Cần nhặt" ban đầu từ snapshot của chỉ định Đang nhặt/Đã bốc (cộng SL các dòng cùng mã), không có chỉ định thì lấy SL Kiot.

## 3. Hai cảnh báo mới (chỉ chỉ định Đang nhặt / Đã bốc; chỉ người có `shipment.pick`)
- `PICK_KIOT_DIFF` — **Lệch Kiot**: SL cần nhặt của một mã trong snapshot ≠ SL mã đó trên đơn Kiot hiện tại (đọc lại mỗi lần, tự hết khi Kiot sửa khớp và sync).
- `PICK_ORDER_DIFF` — **Lệch SL trong đơn**: tổng `planned_qty` theo mã ≠ SL cần nhặt của mã trong snapshot (= dòng đỏ đã được xác nhận lưu), tự hết khi chỉ định lại cho khớp.
- Máy chủ: `pickAssignmentsService.pickWarnings()` trả `Map 'HN|ma don chu thuong' -> [codes]` cho MỌI chỉ định hoạt động (số ít); fail-soft (lỗi DB → Map rỗng).

## 4. Bộ lọc / KPI
- `orderLifecycleService.queryOrders` (và `exportOrders`) cộng 2 mã vào `row.warnings` của các đơn liên quan trước khi lọc/đếm (bản sao nông chỉ cho các dòng đổi, bộ nhớ đệm theo tham chiếu mảng + chữ ký) nên chúng nằm trong ô lọc cảnh báo, thẻ KPI "Đơn vi phạm theo loại cảnh báo", "Có cảnh báo"/"Tổng đơn vi phạm", cột Cảnh báo và xuất Excel.
- `WARNING`/`WARNING_LABEL`/`WARNING_FILTERS`/ô lọc `#bulkWarningFilter`/`WARNING_LABEL` phía client thêm 2 mã.
- Bỏ: `pickMismatch`, `pickMismatches`, `acknowledgeMismatch`, `markHandled`, route `mismatch-ack`, nút Đã xử lý, nhãn "Lệch SL bốc", lớp `lc-row-handled`. Dòng đơn có 2 cảnh báo mới vẫn tô đỏ (`lc-row-mismatch`).

## 5. Kiểm thử
`mergeOrderLines`/`makeOrderSnapshot`/`assign` có `needs`; `pickWarnings`; đếm + lọc cảnh báo; ô "Cần nhặt"; phiếu in thứ tự Kiot; cập nhật các test của "Lệch SL bốc"/"Đã xử lý".
