# Nghiệm thu cục bộ Thu mua: grid và sync

Ngày10/11/2026. Bắt đầu trên feat/purchase-workspace-20261107; khi chốt, checkout dùng chung đang ở fix/expected-arrivals-inactive-product-name, HEAD867fb5ce. Không chuyển nhánh hoặc commit trong phần việc grid/sync này; các thay đổi Thu mua còn trong working tree. Chưa merge/deploy; không thêm hoặc áp migration trong phần việc này.

| ID | Phạm vi | Bằng chứng / kết quả |
|---|---|---|
| SG01 | Throttle3giây, burst100events, trailing/no overlap | purchase-realtime.test.js dùng đồng hồ giả kiểm burst, tabẩn, hiện lại, destroy và retry |
| SG02 | Không starvation với snapshot chậm | Coordinator áp phản hồi hợp lệ khi pending rồi tải lượt tiếp; regression đã đổi đúng yêu cầu mới |
| SG03 | Kiểm revision nhẹ | Revision service/route yêu cầu auth+view, no-store, chỉ một history query; fingerprint SQL khớp list; page test skip rows khi revision không đổi |
| SG04 | Gộp polling server | Một timer đọc roster/history dùng chung router, presence từng tab còn riêng; test nhiều client/disconnect/cross-instance |
| SG05 | NV không chặn bảng | Page test directory treo vẫn có hàng và vẫn nhận row mới; directory cập nhật options riêng, giữ modal version |
| SG06 | Vùng theo id/field, nền không nhảy nhóm | Page test giữ selected id qua refresh, row mới chưa gán cont lên nhóm chờ xếp; helper test reorder/filter |
| SG07 | TSV và rowKey | Quoted tab/newline/doubledquote, overflow, unknown/duplicate keys; page hai dòng cùng productCode chỉ đúng rowKey đổi |
| SG08 | Dán cả vùng và undo | Shift chọn hai NCC, scalar paste đổi cả hai, một undo trả cả hai; không có POST/PATCH từ thao tác nháp |
| SG09 | Copy/Ctrl+D/kéo điền | Helper/UI test serialize, copy, Ctrl+D, kéo lặp mẫu; browser copy hai NCC và Ctrl+D giá4→4 giữ NCC |
| SG10 | Escape và điều hướng | Hủy riêng ô đang sửa, giữ draft khác; Arrow/Tab/Enter cập nhật vùng neo; test dán sau ArrowDown và clickdropdown đúng vị trí |
| SG11 | Không vượt quyền ô | Prevalidation cả vùng; phí cha đang tách, NV, công thức/readonly bị chặn; lỗi không để lại draft một phần |
| SG12 | Giữ đồng bộ an toàn cũ | Bộ realtime page test: nháp/caret/version, modal NV, freight xung đột, native change/focusout chỉ ghi một lần |

## Rà soát

Reviewer phát hiện P1 neo dán lệch sau keyboard/dropdown và P2 phí cha đang tách có thể bị sửa qua paste. Đã sửa và thêm ba hồi quy; reviewer xác nhận cả hai đã giải quyết. Kiểm tra Ctrl+D đã bổ sung hồi quy đọc draft mới nhất thay vì row snapshot cũ.

## Lượt chạy

- Module grid và UI:15/15 test theo reviewer; parent đã chạy nhóm14 trước khi thêm ca dropdown, ca mới cũng đạt.
- Backend/scheduler/revision:sub-agent báo78/78 test gồm47/47 service đạt.
- Page mới: scalar/rowKey/atomic quoted/directoryhung, revision dedup, giữ selectedid, Escape, typed-draft Ctrl+D, keyboardpaste, splitparent: đã chạy các nhóm liên quan đạt.
- Lượt toàn phần ban đầu283/288: bốn lỗi do fixture thiếu products sau main thay đổi expected-arrivals và một lỗi focus sau Escape. Đã bổ sung bảng fixture (không đổi production schema), phục hồi focus đúng cell; nhóm sáu hồi quy đạt. Lượt toàn phần sau sửa: **288/288 đạt**, không bỏ qua, log grid-sync-all-final.log. Sau hoàn thiện focus/clipboard, chạy nhóm liên quan **9/9 đạt**, thêm ca Escape bỏ vùng không bỏ nháp **1/1 đạt**, module UI đủ **6/6 đạt**; các lượt có trùng phạm vi, không cộng thành tổng toàn phần.
- Log toàn phần:.codex_tmp/grid-sync-all-final.log; log bổ sung:grid-sync-new-page.log, grid-sync-repairs.log, grid-sync-grid.log.

## Trình duyệt

IAB, server thử4322 dùng8 dòng tổng hợp và API/SSE giả lập; không production. Đã thử Shift chọn2ô NCC, Ctrl+V scalar, một undo, Ctrl+C TSV và Ctrl+D giá tệ4 cho2dòng. Hai phiên: B lưu tên SP dòng8, A nhận tên mới và giữ2ô chọn cùng bản nháp giá. Bản r3 xác nhận focus D00002 Giá tệ sau Ctrl+D, hai giá đều4, tổng vùng8 và NCC không đổi. Sau sửa vị trí neo đã tải script r2 và xác nhận Tab sang Tên SP có đúng vùng chọn, Ctrl+D chỉ đổi Giá tệ, NCC vẫn giữ nguyên. Kéo tay và visibility/tải chậm được kiểm qua test mô phỏng; chưa có load test nhiều người hoặc production nhiều instance.

## Kiểm tra cuối

- node --check cho purchase.js và purchase-grid-ui.js đạt; git diff --check đạt (cảnh báo LF/CRLF).
- graphify update . đã thử nhưng môi trường không nhận lệnh; chưa cập nhật đồ thị.
- Script/CSS cache key20261110-grid-sync-r3 để bản local nhận đúng code cuối.

## Giới hạn

Không loại bỏ pagination50dòng, không triển khai virtualization, chưa đổi cơ chế xác nhận lưu. Chưa tự động áp kết quả mọi loại mutation thay full refresh, chưa thêm telemetry sản phẩm đo query/latency; đây là phần tối ưu tiếp theo cần dữ liệu thực. Bản nháp và outbox vẫn trong sessionStorage của tab.

Cập nhật cuối:10/11/2026.

Ảnh kiểm chứng: C:/Users/Admin/.codex/visualizations/2026/11/06/01a1af8e-12a1-7cc1-abfd-a588c0bd5256/purchase-grid-sync-20261110.png. Server thử4322 và tab thử đã dọn; tab local4321 của người dùng đã tải r3 và được giữ mở.
