# Công việc: Xuất kho và chỉ định đơn Đang bốc

Ngày: 02/11/2026. Kế hoạch: [plan.md](plan.md).
Các lệnh chạy trong server/. Đã sửa mã giao diện; chưa deploy ứng dụng. Migration 0101 đã áp DB đã cấu hình.

## T1: Khắc phục Xuất kho từ Excel/CSV
**Mô tả:** Tái hiện lỗi từ upload qua stockOutFile đến truy vấn cập nhật/xóa và ghi lịch sử. Kiểm tra migration 0101, ràng buộc phiếu bốc và lỗi SQL thực tế. Chỉ sửa sau khi có bằng chứng nguyên nhân.

**Tiêu chí nghiệm thu:**
- [ ] File hợp lệ trừ đúng mã + vị trí + cơ sở; hết tồn xử lý đúng và có lịch sử Xuất kho, không trả 500.
- [ ] Dòng sai/vượt tồn/đang giữ chỗ bị bỏ qua và báo rõ; không ảnh hưởng cơ sở khác.
- [x] Lỗi ghi DB rollback cả tồn và lịch sử; test hồi quy tái hiện lỗi gốc trước bản sửa.

**Kiểm chứng:**
- [ ] `node --test stockPositions/stockPositionsService.test.js stockPositions/stockPositionsRoutes.test.js test/frontend/vt-positions.test.js`
- [x] `npm run build`
- [ ] Thử trên dữ liệu cục bộ: XLSX/CSV, trừ một phần/hết tồn, dòng trùng, vị trí có phiếu tham chiếu.

**Phụ thuộc:** Không.
**File dự kiến (tối đa 5):** server/stockPositions/stockPositionsService.js; server/stockPositions/stockPositionsService.test.js; server/stockPositions/stockPositionsRoutes.js; server/stockPositions/stockPositionsRoutes.test.js; server/test/frontend/vt-positions.test.js. Nếu bằng chứng cần migration, điều chỉnh phạm vi task trước khi thêm.
**Quy mô:** M.

## T2: Cho sửa chỉ định đơn Đang bốc trực tiếp
**Mô tả:** Kiểm tra và sửa đường mở hộp chỉ định hiện có, cho sửa vị trí/số lượng rồi lưu bằng reassign cùng version; đối chiếu cache/phiên bản phục vụ nếu mã hiện tại đã đạt yêu cầu.

**Tiêu chí nghiệm thu:**
- [x] Mở đơn Đang bốc thấy chỉ định cũ, sửa vị trí/số lượng và lưu bằng Cập nhật chỉ định & In phiếu mà không phải bấm Hủy.
- [x] Lưu thành công thay giữ chỗ nguyên tử, trạng thái cuối vẫn Đang bốc, phiếu in theo chỉ định mới; phần chính đơn đang giữ được tính đúng, giữ chỗ đơn khác được bảo vệ.
- [x] Đóng chưa lưu không thay đổi dữ liệu; lưu lỗi/xung đột không mất lượt cũ, hiển thị lỗi và đồng bộ lại; không mở thêm hành vi cho Đã bốc.

**Kiểm chứng:**
- [x] `node --test pickAssignments/pickAssignmentsService.test.js pickAssignments/pickAssignmentsRoutes.test.js test/frontend/lifecycle-pick.test.js test/frontend/lifecycle-pick-status.test.js`
- [x] `npm run build`
- [ ] Thử mở Đang bốc → đổi vị trí/số lượng → lưu/in; đóng không lưu; hai phiên cùng sửa; Kiot tự chốt trong lúc sửa.

**Phụ thuộc:** Không về chức năng; làm sau T1 để kiểm chứng lần lượt.
**File dự kiến (tối đa 5):** server/public/shipment/lifecycle/pick/pick-assign.js; server/public/shipment/lifecycle/index.html; server/pickAssignments/pickAssignmentsService.js; server/pickAssignments/pickAssignmentsService.test.js; server/test/frontend/lifecycle-pick.test.js.
**Quy mô:** M.

## Checkpoint sau T1–T2
- [x] Các test tập trung đạt, build đạt.
- [x] Xuất kho không lấy phần đơn đang giữ; đổi chỉ định xong số khả dụng cập nhật đúng.
- [x] Rollback, version conflict và phân quyền/cơ sở đều được kiểm chứng.

## T3: Xác minh hoàn tất và tài liệu
**Mô tả:** Chạy kiểm thử tích hợp, kiểm tra giao diện thực tế khi có môi trường, ghi nguyên nhân xác nhận, phạm vi bản sửa và bước triển khai. Cập nhật tài liệu theo thay đổi thực tế.

**Tiêu chí nghiệm thu:**
- [ ] Có kết quả test và thử giao diện hai luồng trên dữ liệu kiểm thử; phần chưa kiểm chứng được nêu rõ.
- [x] Tài liệu API/hướng dẫn phản ánh bản sửa; CURRENT ghi trạng thái cục bộ/triển khai chính xác.
- [x] Mọi yêu cầu migration/cache-bust được ghi cụ thể; không báo đã sửa production khi chưa xác nhận.

**Kiểm chứng:**
- [ ] Chạy lại tập test T1/T2 sau thay đổi cuối, `npm run build`; mở rộng test khi phát hiện ảnh hưởng khác.
- [x] Rà diff và danh sách file sửa; kiểm tra không có dữ liệu nhạy cảm trong log/tài liệu.
- [ ] Nếu thay đổi mã, cập nhật graphify theo quy tắc dự án, ghi rõ nếu công cụ không khả dụng.

**Phụ thuộc:** T1, T2, checkpoint.
**File dự kiến (tối đa 5):** CURRENT.md; server/README.md; README.md; tasks/plan.md; tasks/todo.md. Nếu đổi yêu cầu nghiệp vụ/schema, tách bổ sung task tài liệu liên quan theo update-file.
**Quy mô:** M.

## Checkpoint hoàn tất
- [ ] Mọi tiêu chí nghiệm thu đạt và có bằng chứng.
- [x] Người dùng đã duyệt kế hoạch trước khi triển khai.
- [ ] Sẵn sàng review; phân biệt rõ kiểm chứng cục bộ và triển khai.

## Bằng chứng và việc còn lại (02/11/2026)
- [x] Nguyên nhân xác nhận bằng metadata DB: ledger đến 0100, CHECK thiếu stock_out. Test cục bộ tái hiện 23514 và rollback; áp 0101 thì xuất được cả dòng cập nhật và hết tồn.
- [x] Áp dụng riêng 0101 và ghi ledger cùng giao dịch; kiểm tra constraint sau commit đã có stock_out. Không thay đổi tồn thật.
- [x] Giữ cơ chế reassign hiện có; đổi nhãn nút đơn picking và cache-bust JS. Test nút mới thất bại trước sửa, đạt sau sửa.
- [x] 154/154 test: stockPositionsService, pickAssignmentsService, pickStatusFlow, lifecycle-pick, lifecycle-pick-status.
- [x] 27/27 API: stockPositionsRoutes + pickAssignmentsRoutes (cần chạy ngoài sandbox để localhost không bị EACCES).
- [x] vt-positions: 27/30, tất cả test Xuất kho đạt; 3 lỗi có sẵn trước sửa ở dòng test 340, 369 (kỳ vọng bộ lọc cũ) và 707 (Xuất Excel). Không sửa các chức năng ngoài phạm vi.
- [x] npm run build và git diff --check đạt. Diff được rà để giữ nguyên quyền/cơ sở và trạng thái Đã bốc.
- [ ] Kiểm tra file Excel gốc và thử giao diện trên môi trường đã đăng nhập: chưa có file gốc/môi trường kiểm thử trình duyệt.
- [ ] Deploy thay đổi giao diện; chưa xác minh bản đang chạy tải JS mới. Không cần đợi deploy để DB chấp nhận stock_out.
- [ ] Graphify: đã thử graphify update ., Windows Application Control chặn graphify.exe; đồ thị chưa cập nhật.

Log kiểm thử cục bộ: .codex_tmp/stockout-focused-test.log, .codex_tmp/stockout-routes-test.log, .codex_tmp/stockout-vt-test.log (không commit log).
