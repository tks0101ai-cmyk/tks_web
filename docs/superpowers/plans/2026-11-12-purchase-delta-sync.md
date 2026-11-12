# Thu mua: đồng bộ delta cho nhiều người dùng

## Mục tiêu

Giảm tải do một thay đổi khiến mọi tab tải lại toàn bộ danh sách Thu mua. Sau lần tải đầu, tab đồng bộ theo cursor lịch sử và chỉ nhận các dòng đơn hàng thay đổi, các ID bị xóa và danh sách cont (nhỏ). Sự kiện SSE được gộp qua scheduler hiện có. PATCH áp dụng dòng authoritative ngay; bulk/plan áp dụng delta. Full snapshot vẫn là fallback khi cursor sai, response vượt giới hạn hoặc delta không áp dụng an toàn.

## Hợp đồng API

- Thêm `GET /api/purchase-orders/changes?after=<revision>` yêu cầu quyền `purchase.view`.
- `after` nhận revision hiện tại `maxHistoryId:count`; kết quả `{revision, rows, deletedIds, containers, sourceMode, integrationEnabled, employeesChanged, reset}`.
- `rows` là các dòng active cuối cùng cho mọi order ID có operation kể từ cursor; `deletedIds` là ID không còn active; `containers` là snapshot cont nhỏ; `employeesChanged` chỉ ra cần tải lại danh mục nhân viên.
- Giới hạn tối đa 500 ID đơn hàng mỗi delta. Cursor sai/đi sau hiện tại/quá lớn trả `reset:true` để client dùng snapshot chuẩn.
- Delta và cursor đọc trong cùng repeatable-read snapshot. Không đổi schema, quyền, version checks, audit hay Idempotency-Key.

## Phạm vi ảnh hưởng

- `server/purchaseOrders/purchaseOrdersService.js`, `purchaseOrdersRoutes.js`: truy vấn delta có giới hạn và route.
- `server/public/shared/purchase-realtime.js`: comparator cursor và merge delta, giữ draft/conflict/focus và không hạ version.
- `server/public/thu-mua/dat-hang/purchase.js`: SSE/revision chọn delta; own save dùng delta nền; fallback snapshot.
- `server/purchaseOrders/purchaseOrdersService.test.js`, `server/purchaseOrders/purchaseOrdersRoutes.test.js` (hoặc fixture route hiện có), `server/public/shared/purchase-realtime.test.js`, `server/purchaseOrders/purchaseOrdersRealtimePage.integration.test.js`.
- `server/README.md`, SRS, BRD, implementation plan và `CURRENT.md`; schema không đổi.

## TDD và thực hiện

1. Kiểm tra caller/route/fixture/test hiện hành; ghi test service/route cho cursor, delta row, tombstone, cont, employee-only change, giới hạn và idempotent data.
2. Thêm test merge delta: chỉ thay dòng nhận được, giữ dòng/draft không liên quan, phát conflict khi server đổi cùng trường hoặc xóa dòng, bỏ response có version cũ.
3. Thêm integration test: SSE/revision gọi endpoint changes thay vì full list; lưu PATCH và bulk/plan cập nhật dữ liệu qua delta; reset fallback gọi full snapshot; request trùng được gộp.
4. Chạy test mới để xác nhận đỏ trước khi triển khai.
5. Cài service/route delta trong repeatable-read snapshot; bảo đảm cursor invalid/large an toàn fallback.
6. Thêm merge delta trong shared realtime; dùng helper hiện có để bảo toàn focus và drafts, cập nhật revision baseline sau khi áp dụng.
7. Chuyển refresh nền và realtime scheduler từ full snapshot sang delta; chỉ full-fetch khi mở trang hoặc reset; giữ nguyên thao tác đang soạn và thông báo lỗi.
8. Cập nhật API docs, yêu cầu hiệu năng/đồng bộ và trạng thái việc tiếp theo.
9. Chạy toàn bộ test liên quan, syntax, diff check; benchmark lại 20/30 worker ở 500/5000 rows với PATCH + SSE + delta và so sánh payload/p95 với snapshot.

## An toàn và giới hạn

- Nếu delta cursor hỏng, bị vượt giới hạn hoặc dữ liệu thiếu, client full-refresh; không bỏ âm thầm thay đổi.
- Không sửa global advisory lock trong đợt này; benchmark hiện chưa chứng minh an toàn bỏ khóa.
- Harness PGlite hiện chạy client và server cùng tiến trình, không phải phép đo production; báo riêng p50/p95, số byte, lỗi và giới hạn môi trường.
