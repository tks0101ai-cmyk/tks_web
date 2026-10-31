# VT Hà Nội / VT Sài Gòn: cập nhật thời gian thực (SSE)

Ngày: 2026-10-30. Trạng thái: đã duyệt thiết kế, chờ lập kế hoạch.

## Vấn đề
Bảng `/vt-positions/` chỉ tải dữ liệu một lần khi mở trang hoặc đổi tab. Khi nhiều người cùng sửa, máy còn lại giữ bản cũ (số đếm theo bộ lọc không đổi) và chỉ biết khi bị 409 `VERSION_CONFLICT`. `render()` còn xóa và dựng lại toàn bộ `<tbody>`, nên nếu chỉ gọi lại nó sẽ mất focus, vị trí cuộn và gây nháy.

## Mục tiêu
- Thay đổi từ người khác (tạo, sửa, xóa, ack, trừ thùng, import, trừ tồn theo đơn, giữ chỗ khi đơn "Đang bốc") hiện trên các máy đang mở trong vài giây.
- Không dựng lại bảng: giữ cấu trúc, độ rộng/ẩn hiện cột, tìm kiếm, lọc, sắp xếp, trang, vị trí cuộn; chỉ vá ô/dòng thay đổi.
- Không phá hộp chi tiết hay ô đang gõ.

## Thiết kế

### Server
- `server/stockPositions/stockPositionsEvents.js`: `EventEmitter` trong tiến trình (hệ thống chỉ chạy 1 instance, cùng kiểu `dashboardRollupEvents`). Hàm `notifyChanged(branch)` phát `{ branch, rev }` (`rev` tăng dần trong tiến trình).
- Route `GET /api/stock-positions/events?branch=HN|SG` (SSE), cùng quyền xem `stockLocationsV2.view` và kiểm tra phạm vi cơ sở như `GET /api/stock-positions`. Header: `text/event-stream`, `no-cache, no-transform`, `X-Accel-Buffering: no`; `req.socket.setTimeout(0)`; flush sau mỗi lần ghi (compression); heartbeat 25 giây; gỡ listener và timer khi đóng. Sự kiện tên `positions-changed`, chỉ gửi khi cơ sở khớp. Đặt trước `/:id`.
- Phát sau `COMMIT` ở mọi đường ghi: `stockPositionsService` (tạo, sửa, xóa, ack, deduct, import, xóa lịch sử không cần), `pickAssignmentsService` (trừ tồn theo đơn bằng tay hoặc job Kiot, đổi giữ chỗ khi đổi trạng thái bốc, hủy). Gom thành một điểm gọi sau giao dịch, không phát trong lúc giao dịch còn mở và không phát khi ROLLBACK.

### Client (`public/vt-positions/vt-positions.js`)
- Mở `EventSource` cho tab đang xem; đổi tab thì đóng và mở lại.
- Nhận `positions-changed`: gộp (debounce 300 ms) rồi tải nền `GET /api/stock-positions?branch=…` mà không đặt `loading` và không xóa `rows`. Dùng `requestVersion` bỏ kết quả cũ.
- Đối chiếu thay vì `replaceChildren`: so theo `data-id` và `version`; dòng không đổi giữ nguyên node; dòng đổi chỉ sửa ô khác nhau; dòng mới chèn đúng vị trí; dòng mất gỡ đúng dòng. Ô đổi nháy nền nhẹ khoảng 1,5 giây (tắt theo `prefers-reduced-motion`).
- Cập nhật tại chỗ các số phụ thuộc: số đếm lọc cảnh báo, "x–y / tổng dòng", số trang. Không đụng header, colgroup, `TKSTables` (chỉ gọi lại khi tập cột đổi).
- Hộp chi tiết/ô đang gõ không bị đóng. Nếu dòng của hộp đổi `version` thì hiện dải "Dòng này vừa được người khác sửa" cùng nút "Xem bản mới"; Lưu vẫn trả 409 như hiện nay.
- Mất kết nối: `EventSource` tự nối lại; khi nối lại hoặc khi tab được focus lại tải bù một lần; nếu SSE lỗi liên tục thì tải bù mỗi 60 giây.

## Kiểm thử
- Server: phát sau commit, không phát khi rollback; route SSE lọc theo cơ sở và quyền; dọn listener khi đóng.
- Client (test trích code từ HTML/JS như quy ước): đối chiếu giữ nguyên node dòng không đổi, chỉ đổi ô thay đổi, chèn/xóa đúng chỗ, cập nhật số đếm, không đụng hộp đang mở.
- Chạy các test VT, pick và nav liên quan.

## Tài liệu cần đồng bộ
`README.md`, `server/README.md` (bảng API), `CURRENT.md`; cập nhật `graphify update .`.

## Ngoài phạm vi
Nhiều instance (cần `LISTEN/NOTIFY` hoặc Redis), tab Vị trí HN/SG cũ, hộp lịch sử.
