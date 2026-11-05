# Chỉ định vị trí: gỡ ghi ngược KiotViet, gỡ 2 cảnh báo chỉ định, Xóa dòng nội bộ, phiếu in theo thứ tự hộp

Ngày: 02/11/2026. Không migration. Chưa commit, chưa deploy. Thay phần cảnh báo của spec [2026-10-30-pick-need-edit-warnings-design.md](2026-10-30-pick-need-edit-warnings-design.md) và phần ghi ngược Kiot ngày 30/10/2026.

## Bối cảnh

- 30/10/2026: hộp Chỉ định vị trí (Vòng đời đơn hàng) có 2 cảnh báo `PICK_KIOT_DIFF` “Lệch Kiot” và `PICK_ORDER_DIFF` “Lệch SL trong đơn” (thay “Lệch SL bốc”), đồng thời nút **Xóa dòng** và **SL cần nhặt** sửa tay ghi ngược lên đơn đặt hàng KiotViet qua `kiotviet/kiotOrderEditor.js` (`PUT /orders/{id}`, cờ `KIOT_ORDER_WRITE_ENABLED`, nhật ký `order_kiot_edit_log` migration `0102`).
- 02/11/2026: quyết định dashboard **không sửa đơn Kiot** nữa; mọi thao tác trong hộp chỉ tác động lên chỉ định/phiếu in nội bộ.

## Quyết định

1. **Gỡ 2 cảnh báo chỉ định:** bỏ `PICK_KIOT_DIFF`/`PICK_ORDER_DIFF` khỏi `pickAssignmentsService.pickWarnings()`, `orderLifecycleService.withPickWarnings`, lựa chọn trong ô lọc cảnh báo, thẻ KPI, tô đỏ dòng đơn và xuất Excel. Vòng đời đơn hàng chỉ còn 6 cảnh báo giao hàng.
2. **Gỡ toàn bộ ghi lên KiotViet:** xóa `server/kiotviet/kiotOrderEditor.js` (+ test), biến `KIOT_ORDER_WRITE_ENABLED`, endpoint `POST /api/shipment/pick/order-lines/remove`, `updateOrder`/helper PUT trong `kiotVietApiClient.js`. Bảng `order_kiot_edit_log` (migration `0102`) giữ nguyên nhưng không còn được ghi từ 02/11/2026; áp hay chưa áp đều không ảnh hưởng.
3. **SL cần nhặt sửa tay giữ, chỉ nội bộ:** `needs` vẫn lưu vào snapshot (`quantity` = SL sửa, `kiotQuantity` = SL Kiot) và in trên phiếu; đơn Kiot không đổi; bỏ hộp hỏi “Ghi lên đơn KiotViet?”.
4. **Xóa dòng nội bộ:** `POST /api/shipment/pick` nhận tùy chọn `removed: [mã hàng]` (`applyRemovals` trong `pickAssignmentsService.js`) — bỏ mọi dòng cùng mã khỏi snapshot và phân bổ. Mã không có trong đơn hoặc bỏ hết mọi dòng → 400 `VALIDATION` (`field: 'removed'`). Khi mở lại chỉ định, mã có trên đơn Kiot nhưng vắng trong snapshot được coi là đã bỏ và hiện dòng “Đã bỏ: MÃ ↺” trong hộp để khôi phục. Đơn Kiot không đổi. Job dọn dòng ma (`kiot_line_missing`, migration `0103`) giữ nguyên; lý do `line_removed` không còn được ghi.
5. **Phiếu in theo thứ tự trong hộp:** in đúng thứ tự dòng đang hiện — thứ tự kéo-thả **hoặc** sort cột (trước đây sort cột bị bỏ qua khi in); không sort thì theo thứ tự đơn Kiot.

## File đụng tới

- Máy chủ: `server/pickAssignments/{pickAssignmentsService,pickAssignmentsRoutes,pickKiotData}.js`, `server/shipment/{orderLifecycleService,orderLifecycleQuery,orderLifecycleRoutes}.js`, `server/kiotviet/{kiotVietApiClient,orderLineOrder}.js`; xóa `server/kiotviet/kiotOrderEditor.js` + `kiotOrderEditor.test.js`.
- Giao diện: `server/public/shipment/lifecycle/index.html`, `server/public/shipment/lifecycle/pick/pick-assign.{js,css}` (hộp chỉ định, dòng “Đã bỏ”, thứ tự in).
- Test: `server/pickAssignments/{pickAssignmentsService,pickStatusFlow}.test.js` và các test lifecycle/frontend liên quan.
- Tài liệu: `README.md`, `server/README.md`, `server/db/SCHEMA.md`, `docs/04-planning/implementation_plan.md`, SRS (FR-PK.15 đánh dấu đã gỡ, FR-PK.24 mới), BRD, `CURRENT.md`.

## Kiểm thử (phạm vi cần phủ)

- `applyRemovals`: bỏ mã hợp lệ, mã lạ → 400, bỏ hết dòng → 400; `assign` với `removed` + `needs`.
- Lifecycle: không còn `PICK_KIOT_DIFF`/`PICK_ORDER_DIFF` trong lọc/đếm/KPI/xuất; route `order-lines/remove` trả 404.
- Frontend hộp chỉ định: Xóa dòng không gọi Kiot, dòng “Đã bỏ: MÃ ↺” khôi phục được, phiếu in theo thứ tự kéo-thả/sort.
- Chưa kiểm trên trang Vòng đời thật với dữ liệu thật.
