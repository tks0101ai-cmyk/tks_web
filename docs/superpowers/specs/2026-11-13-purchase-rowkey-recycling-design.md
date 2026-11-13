# Thu mua: tái sử dụng Mã dòng sau khi xóa

**Trạng thái:** Đã được người dùng duyệt
**Ngày:** 13/11/2026

## Mục tiêu

Khi một đơn hàng bị xóa, số Mã dòng được trả lại bộ cấp mã để có thể dùng lại. Khi xóa hết các đơn đang hoạt động, lần tạo/import mới có thể bắt đầu lại từ `D00001`. Không làm lẫn lịch sử của đơn cũ với đơn mới dù hai đơn dùng lại cùng mã hiển thị.

## Quy tắc đã chốt

- Mã mới dùng **số trống nhỏ nhất** trước; nếu không còn số trống thì lấy số kế tiếp chưa từng phát.
- Khi một đơn bị xóa, mã gốc chỉ được trả lại nếu không còn nhánh nào đang hoạt động thuộc cùng đơn gốc.
- Nhánh tách dùng hậu tố hiện tại (`.01`, `.02`). Mã gốc được tái sử dụng khi cả nhóm gốc không còn dòng hoạt động; hậu tố nhánh thuộc chu kỳ của nhóm đó.
- Import snapshot có các dòng để trống Mã dòng sẽ tạo dòng mới; các mã cũ vắng mặt bị xóa mềm. Trong cùng giao dịch, mã vừa giải phóng có thể được cấp lại cho dòng mới. Vì vậy không cần import một file rỗng trước.
- Nếu xóa mềm nhưng sau đó phục hồi đơn cũ khi mã cũ đã được dùng lại, phục hồi giữ nguyên đơn nội bộ nhưng cấp cho nó một mã gốc trống mới và remap hậu tố các nhánh cùng nhóm. Nếu mã cũ chưa bị dùng lại thì phục hồi lại mã cũ.
- Không xóa vật lý lịch sử. Undo, audit, thùng rác và lịch sử theo dòng vẫn phải chỉ đúng đơn nội bộ ban đầu.

## Thiết kế dữ liệu đề xuất

Hiện `row_key` vừa là mã hiển thị, vừa là khóa nhóm, vừa được dùng trong lịch sử; cột này có unique constraint toàn bảng và `purchase_key_history` cấm dùng lại mã đã nghỉ. Chỉ giảm `purchase_order_key_seq` sẽ gây trùng mã và có thể nối lịch sử của hai đơn khác nhau.

Tách danh tính bất biến khỏi mã hiển thị:

- Giữ `purchase_orders.id` làm định danh bất biến của từng dòng.
- Thêm định danh gốc nội bộ bất biến (`root_order_id`) để gom các nhánh tách qua mọi lần tái sử dụng Mã dòng.
- Thay unique toàn bảng của `row_key` bằng unique index chỉ trên dòng đang hoạt động. Thùng rác có thể lưu cùng mã với một đơn mới.
- Chuyển truy vấn lịch sử/undo/restore từ ghép bằng `row_key`/`root_key` sang `id`/`root_order_id`.
- Giữ `purchase_key_history` làm audit các lần mã được gán; cho phép cùng một chuỗi Mã dòng xuất hiện ở nhiều chu kỳ, phân biệt bằng định danh nội bộ.
- Thêm kho mã trống và khóa/reservation có hạn dùng để cấp mã trống nhỏ nhất an toàn khi nhiều người cùng bấm Thêm mã. Mã bị giữ nhưng không lưu sẽ được trả lại kho khi hủy hoặc hết hạn.
- Bộ sequence hiện tại tiếp tục làm mốc cho số chưa từng phát; không kéo sequence lùi. Việc “đếm lại” xảy ra qua kho mã đã giải phóng, không qua việc xóa dấu vết mã từng dùng.

## Luồng thao tác

1. **Tạo mã:** endpoint cấp mã khóa một lượt phân bổ; lấy số nhỏ nhất trong kho trống, nếu không có thì cấp sequence mới. `claimKey` chỉ nhận mã reservation còn hiệu lực của người dùng và tiêu thụ reservation một lần.
2. **Xóa:** giữ soft-delete/audit. Khi không còn dòng hoạt động trong cùng `root_order_id`, giải phóng số gốc vào kho mã trong cùng transaction.
3. **Import snapshot:** xác định trước các dòng bị xóa; khóa phân bổ, giải phóng mã của nhóm sắp xóa, rồi cấp mã cho dòng mới trong cùng transaction. Snapshot cũ vẫn bị từ chối theo revision.
4. **Phục hồi/undo:** giữ nguyên `id`/`root_order_id`. Nếu mã cũ đã bị cấp cho đơn khác, lấy mã trống mới và ghi rõ đổi mã trong audit; không ghi đè đơn đang dùng mã đó.
5. **Tách dòng:** tất cả nhánh giữ cùng `root_order_id`; không giải phóng mã gốc cho tới khi nhóm không còn dòng hoạt động.

## Migration và tương thích

- Migration mới, không sửa migration đã phát hành.
- Điền `root_order_id` cho dữ liệu cũ theo quan hệ `root_key` hiện tại; xác nhận mọi nhánh trỏ đúng một gốc trước khi áp unique/index mới.
- Nạp các mã gốc của nhóm đã soft-delete và không có nhánh hoạt động vào kho mã trống; không cấp lại mã đang hoạt động.
- Cập nhật API reserve/claim/create/import/delete/restore/undo và truy vấn lịch sử.
- Dữ liệu lịch sử hiện tại tiếp tục giữ mã cũ trong snapshot; lookup sau migration dùng ID nội bộ để không nhập hai chu kỳ cùng mã.
- Không thay định dạng hiển thị `D#####` và hậu tố nhánh.

## Kiểm thử chấp nhận

- Xóa một gốc rồi tạo mới: mã nhỏ nhất vừa trống được cấp lại; mã lịch sử vẫn truy vấn đúng hai đơn riêng biệt bằng ID.
- Xóa nhóm tách một phần: chưa giải phóng mã gốc; xóa nhánh cuối: giải phóng đúng một lần.
- Import đầy đủ với mọi Mã dòng để trống: các dòng cũ xóa mềm, dòng mới nhận lại dãy mã trống nhỏ nhất trong cùng transaction; không cần file rỗng trung gian.
- Hai người cùng xin mã: reservation khác nhau, không thể cùng nhận một mã; reservation hủy/hết hạn được trả lại.
- Phục hồi/undo trước khi mã được tái sử dụng khôi phục mã cũ; sau khi tái sử dụng thì cấp mã mới hoặc báo xung đột theo quy tắc trên, tuyệt đối không chiếm mã của đơn mới.
- Trash, history, departures, split, import stale-snapshot, realtime và các bản audit tiếp tục truy đúng `id`/nhóm gốc sau khi mã hiển thị được tái sử dụng.

## Rủi ro và giới hạn

- Đây là thay đổi định danh xuyên suốt Thu mua, không chỉ thay cách tính sequence. Dùng mã cũ để tra lịch sử thủ công sẽ còn nhiều chu kỳ; giao diện lịch sử phải dùng ID nội bộ để chọn đúng đơn.
- Reservation chưa lưu tạo ra số trống tạm thời; cần giới hạn thời gian và thu hồi mã khi hết hạn.
- Thao tác phục hồi có thể trả một Mã dòng khác nếu mã cũ đã được dùng lại; popup/audit phải thể hiện việc đổi mã.
- Chỉ triển khai sau khi chạy migration trên staging/copy dữ liệu và xác nhận liên kết nhóm tách cũ không mơ hồ.

## Ngoài phạm vi

- Xóa vật lý order/audit để “dọn sạch” lịch sử.
- Đổi định dạng Mã dòng hoặc tái đánh số mọi dòng đang hoạt động mỗi khi xóa.
- Reset thủ công sequence PostgreSQL về 1.
