# Kế hoạch: sửa Xuất kho và đổi chỉ định đơn Đang bốc

Ngày: 02/11/2026. Trạng thái: người dùng đã duyệt; đã sửa DB và cập nhật mã giao diện, kiểm chứng tự động hoàn tất; giao diện chưa deploy.
Người dùng đã cho phép thay thế kế hoạch cũ tại tasks/plan.md và tasks/todo.md.

## Mục tiêu
Khắc phục lỗi Xuất kho bằng Excel/CSV của Vị trí hàng hóa; cho phép thay vị trí/số lượng chỉ định khi đơn Đang bốc mà không cần hủy thủ công. Danh sách việc chi tiết: [todo.md](todo.md).

## Bằng chứng hiện có
- Ảnh cho thấy STOCK_POSITIONS_FAILED: thông báo chung ở stockPositionsRoutes.js; chưa có stack trace hoặc file Excel gốc để kết luận nguyên nhân.
- stockOutFile đọc file, khóa cơ sở, trừ/xóa vị trí và ghi lịch sử trong một giao dịch. Lịch sử dùng action stock_out, được bổ sung bởi migration 0101_stock_position_stock_out_action.sql. Cần kiểm tra migration thực tế; đây chỉ là giả thuyết, chưa xác nhận DB triển khai.
- pick-assign.js đã có nhãn Cập nhật chỉ định & In phiếu và gửi reassign:true cùng version. Không xây thêm cơ chế song song; kiểm tra nhánh mở hộp, điều kiện khóa sửa, khả dụng của chính phần giữ chỗ và phiên bản tài nguyên đang phục vụ.
- Có sẵn test service/API/frontend cho hai tính năng. Git sạch tại thời điểm khảo sát. Chưa chạy kiểm thử và chưa thay mã ứng dụng.

## Quyết định triển khai
- Giữ Express/CommonJS, frontend JavaScript thuần và API hiện tại.
- Tái hiện lỗi bằng fixture cục bộ trước khi sửa. Đọc log/schema môi trường lỗi nếu có quyền truy cập; không dùng thử thao tác trừ tồn trên dữ liệu thật.
- Xuất kho phải giữ phạm vi HN/SG, không trừ phần đơn Đang bốc khác đang giữ; cập nhật tồn và lịch sử cùng commit/rollback.
- Đổi chỉ định dùng reassign nguyên tử: giải phóng giữ chỗ cũ và tạo giữ chỗ mới trong cùng giao dịch. Lưu lỗi giữ nguyên chỉ định cũ. Đóng hộp chưa lưu không ghi máy chủ.
- Chỉ mở rộng hành vi cho Đang bốc theo yêu cầu; không thay đổi quy tắc Đã bốc trong công việc này.
- Chỉ thêm migration khi đã chứng minh cần; thiếu migration hiện hữu thì xử lý quy trình triển khai, không tự tạo migration trùng.

## Thứ tự và phụ thuộc
1. T1: tái hiện, sửa và kiểm chứng Xuất kho (rủi ro tồn kho ưu tiên trước).
2. T2: khắc phục luồng cập nhật chỉ định Đang bốc; không phụ thuộc T1 về nghiệp vụ, thực hiện tuần tự để kiểm soát thay đổi chung.
3. Checkpoint: kiểm thử tích hợp hai luồng và kiểm tra rollback/giữ chỗ.
4. T3: kiểm chứng tổng thể, cập nhật tài liệu và ghi rõ yêu cầu triển khai.

## Rủi ro và cách xử lý
| Rủi ro | Ảnh hưởng | Xử lý |
|---|---|---|
| Thiếu migration 0101 hoặc bản triển khai khác mã cục bộ | Cao | Đối chiếu migration, stack trace và phiên bản tài nguyên trước khi kết luận |
| Xóa dòng hết tồn bị ràng buộc bởi phiếu cũ | Cao | Fixture có lịch sử/phiếu tham chiếu, xác nhận giao dịch rollback đúng |
| Đơn tự giữ vị trí khiến giao diện báo thiếu hàng | Cao | Tính khả dụng theo đúng excludeOrder; kiểm thử đơn khác vẫn giữ chỗ |
| Hai người lưu hoặc Kiot chốt cùng lúc | Cao | Giữ version, trả xung đột rõ ràng và tải dữ liệu mới |
| Sửa UI nhưng trình duyệt vẫn tải JS cũ | Trung bình | Kiểm tra URL/cache-bust và phản hồi tài nguyên của bản triển khai |

## Điểm cần xác minh khi thực hiện
- Stack trace của lần xuất kho lỗi và trạng thái migration ở môi trường xảy ra lỗi.
- File vt_hn_20261102_0802.xlsx chưa được cung cấp; ban đầu tái hiện bằng file mẫu tương đương.
- Trình duyệt đang chạy bản nào và thao tác nào khiến đơn Đang bốc bị khóa sửa.

## Tiêu chí hoàn tất
Các tiêu chí tại todo.md đều đạt; có bằng chứng kiểm thử. Phân biệt sửa cục bộ với xác nhận triển khai thực tế. Không tự đánh dấu đã khắc phục production chỉ từ test cục bộ.

## Kết quả thực hiện 02/11/2026
02/11/2026 — **Sửa Xuất kho và làm rõ đổi chỉ định Đang bốc:** xác nhận DB đã cấu hình thiếu `0101_stock_position_stock_out_action.sql`, ràng buộc lịch sử không nhận `stock_out`. Đã áp dụng riêng 0101 trong giao dịch và kiểm tra lại constraint; không sửa tồn thực tế, không chạy 0102/0103. Test hồi quy tái hiện lỗi 23514, chứng minh rollback cả cập nhật/xóa và xuất thành công sau migration. Đơn Đang bốc đã có reassign nguyên tử; nút mở hộp đổi thành **Thay đổi chỉ định**, JS cache-bust `20261102-1` (thay đổi giao diện chưa deploy). Cách dùng: mở đơn Đang bốc → Thay đổi chỉ định → sửa vị trí/số lượng → Cập nhật chỉ định & In phiếu; không cần hủy trước. Kiểm chứng: 154/154 test service/status/frontend chỉ định, 27/27 API; trang VT 27/30 đạt, 3 lỗi có sẵn (2 bộ lọc cảnh báo, 1 Xuất Excel), các test Xuất kho đều đạt. Build đạt. Chưa thử file Excel gốc hoặc thao tác ghi trên production. Graphify không chạy được do Windows Application Control chặn executable.

Chi tiết kết quả và giới hạn kiểm chứng: xem todo.md. Không thêm bảng/cột/migration hay đổi API, schema contract hiện hữu đã mô tả action stock_out.
