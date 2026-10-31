# Nghiệp vụ chỉ định vị trí và thực nhặt TOKOSI

Ngày nghiên cứu: 23/10/2026. Đề xuất thiết kế, chưa phải chức năng production đã triển khai. Nguồn ngoài là đối chiếu nghiệp vụ; các quyết định áp dụng TOKOSI dưới đây là đề xuất cần chốt với người dùng.

> **Ghi chú 30/10/2026:** tài liệu nghiên cứu theo thời điểm 23/10/2026. Module `server/stockLocations/` (Vị trí HN/SG đọc Google Sheets, `stock_location_lines`) nhắc tới dưới đây đã bị gỡ; Vị trí hàng nay là VT Hà Nội / VT Sài Gòn (`stockPositions/`, bảng `stock_positions`, SL kho tính từ ghi chú thùng) và Chỉ định vị trí đã triển khai trên Vòng đời đơn hàng (`pickAssignments/`). Các đoạn mô tả "mã hiện tại" bên dưới là lịch sử, không phản ánh hiện trạng.

## 1. Kết luận chính

Giữ nguyên bảng/chi tiết Vòng đời. Tách bốn khái niệm: gợi ý (không ghi tồn), giữ chỗ (cam kết cho đơn), thực nhặt (chuyển vật lý khỏi kệ sang chờ giao), xuất giao (rời kho). Không đồng nhất chỉ định với trừ tồn tổng KiotViet.

Nguồn Vị trí hiện tại chưa đủ để làm sổ tồn thực tế: `stock_location_lines` khóa `(branch, source_row)`, số lượng là TEXT, đọc FORMATTED_VALUE, đồng bộ Sheets 3 phút/lần. SG dùng cột `TỔNG SL đã đi`. Không được giả định đó là số còn tại từng vị trí; không sửa trực tiếp bảng snapshot vì lần đồng bộ sau có thể ghi đè. Số dòng Sheet không phải định danh vị trí lâu dài.

## 2. Dữ liệu và sổ tồn

- Cần danh mục cơ sở, kho, vị trí có ID ổn định; mã hàng chuẩn và đơn vị cơ sở. HN/SG tuyệt đối tách biệt.
- Một hàng tồn xác định theo kho + vị trí + sản phẩm + trạng thái chất lượng; nếu cần quản lý lô, bổ sung lô. Không gộp mù các dòng Sheet trùng mã/vị trí vì có thể là lịch sử nhập/xuất hoặc lô khác.
- Quy đổi thùng/hộp/chiếc theo cấu hình sản phẩm đã xác nhận. Không đoán từ ghi chú. Các sản phẩm phụ kiện/VAT/dịch vụ phải phân loại riêng.
- Sổ biến động ghi nhập vị trí, chuyển vị trí, chuyển ra chờ giao, hoàn về kệ, xuất giao, kiểm đếm điều chỉnh. Mỗi sự kiện có ID duy nhất, người, thời gian và chứng từ nguồn; sửa bằng bút toán đối ứng.
- Tồn tại kệ = tồn đầu + nhập vào kệ − chuyển khỏi kệ ± điều chỉnh. Khả dụng = tồn hợp lệ chưa khóa − giữ chỗ chưa nhặt của mọi đơn. Không dùng clamp về 0 để che mất việc giữ vượt tồn; phải báo xung đột.
- Giữ chỗ lưu tập trung trong DB. Kiểm tra và ghi trong cùng giao dịch, khóa các hàng theo thứ tự ổn định. Một yêu cầu gửi lại cùng ID không tạo thêm giữ chỗ hoặc trừ thêm tồn.
- Sheet chỉ làm nguồn khởi tạo/tham chiếu hoặc nguồn biến động có mã sự kiện. Không được mỗi 3 phút thay sổ tồn bằng số Sheet không có mốc chốt và đối soát.

## 3. Quy tắc gợi ý đã thống nhất và phần cần bổ sung

1. Chỉ lấy đúng cơ sở/mã/đơn vị; loại tồn khóa, hỏng và hàng chưa được phép lấy.
2. Đọc khả dụng sau giữ chỗ của mọi đơn khác. Khi sửa đơn đang giữ, chỉ cộng lại phần giữ chỗ chưa nhặt của chính đơn.
3. Có một vị trí đủ: chọn vị trí có khả dụng nhỏ nhất nhưng >= lượng cần. Bằng đúng ưu tiên trước. Ví dụ cần 30, có 20/35/100: chọn 35.
4. Không vị trí nào đủ: đây là chính sách chưa được người dùng chốt đầy đủ. Đề xuất ưu tiên ít vị trí nhặt; giữa các phương án cùng số vị trí, ưu tiên phần dư ít hơn. Giới hạn số ứng viên khi tìm tổ hợp để tránh tính toán quá lớn.
5. Lưu ý: thuật toán hiện tại lấy vị trí lớn nhất khi không có nơi đủ, nên hạn chế số vị trí nhưng không bảo đảm tối thiểu phần dư của tổ hợp. Ví dụ cần 100, có 45/40/35/30/25/20: chọn 45 rồi 40 rồi 20 là ba vị trí; cũng có ba vị trí với phần dư nhỏ hơn như 45+35+20=100. Cần phân biệt tối thiểu số vị trí và tối thiểu phần dư của tổ hợp.
6. Nếu bằng điểm, dùng ID ổn định để kết quả không nhảy giữa các lần mở. Không tự thêm ưu tiên gần–xa. FIFO/FEFO chỉ thêm khi có yêu cầu hàng theo lô/hạn sử dụng.
7. Sau xác nhận không tự đổi vị trí vì một vị trí tốt hơn vừa có hàng. Gợi ý lại phải là thao tác rõ ràng, hiển thị phần thay đổi và xác nhận lại.

## 4. Quy trình đề xuất

Sale gửi kế toán → Kế toán xem và sửa gợi ý → Xác nhận giữ chỗ → In phiếu có phiên bản → Kho bắt đầu nhặt → Ghi nhận thực nhặt → Kiểm hàng → Chờ giao → Xuất giao.

Trạng thái nhặt nằm riêng với trạng thái Vòng đời: chưa chỉ định, giữ chỗ một phần/đủ, đang nhặt, nhặt thiếu, nhặt đủ, chờ xử lý chênh lệch, đã hủy. Một đơn có thể nhặt thiếu trong khi vẫn có phần hàng khác đã chờ giao; không gộp tất cả thành một trạng thái đơn duy nhất.

Phiếu phải có mã đơn/cơ sở, phiên bản, mã dòng hàng và vị trí, số chỉ định; quét mã hoặc kiểm tra mã đơn khi xác nhận. In lại không giữ thêm tồn. Sửa phương án tạo phiên bản mới và đánh dấu bản trước không còn hiệu lực.

## 5. Nhặt thiếu và kiểm đếm

- Kho nhập thực nhặt theo từng dòng và vị trí. Giao diện nên hiển thị số lũy kế, nhập lũy kế mới rồi hệ thống tính chênh lệch; tránh mặc định số lấy thêm bằng toàn bộ giữ chỗ như prototype.
- Phân biệt: chưa lấy xong; hết hàng tại vị trí; có hàng nhưng hỏng/sai mã; vị trí không tiếp cận được. Chỉ chưa lấy xong thì tiếp tục giữ chỗ. Có sự cố thì tạm dừng nhiệm vụ và gợi ý bù theo lý do.
- Báo hết phải khóa cặp sản phẩm–vị trí liên quan, không khóa cả kho và không tự đặt tồn bằng 0. Xem và xử lý mọi đơn đang giữ hàng ở vị trí đó, không chỉ đơn vừa báo thiếu.
- Nhặt thiếu 30 không mặc nhiên chứng minh thất thoát 30. Tạo yêu cầu kiểm đếm, ghi nhận thời điểm đếm và các chuyển động phát sinh sau đó; Quản lý xác nhận chênh lệch.
- Vị trí đã kết thúc lấy trong lần xử lý này bị loại khỏi gợi ý lấy bù, trừ khi đã kiểm đếm/bổ sung và người có quyền cho phép sử dụng lại.
- Không còn nơi đủ bù: giữ đơn nhặt thiếu. Sale/Kế toán quyết định chờ hàng, giao một phần hoặc hủy phần thiếu. Kho không tự giảm số lượng bán.

## 6. Hủy, sửa đơn và hàng chờ giao

- Chưa nhặt: sửa/hủy giải phóng hoặc điều chỉnh đúng phần giữ chỗ trong một giao dịch; không xóa trước rồi chờ giữ lại.
- Đã nhặt: phần chưa lấy được giải phóng; phần ở khu chờ giao chỉ được trở về khả dụng sau khi có thao tác trả thực tế về vị trí.
- Đã xuất giao: xử lý trả hàng bằng nghiệp vụ riêng, không dùng hủy chỉ định để cộng lại tồn.
- Đơn Kiot đổi mã/số lượng: phát hiện phiên bản nguồn thay đổi, báo cần đối chiếu; không âm thầm áp phiếu nhặt cũ.
- Không tự hết hạn giữ chỗ chỉ dựa thời gian sau khi đã in/đang nhặt. Với đơn giữ lâu chưa bắt đầu, nhắc kiểm tra; giải phóng theo chính sách và quyền được chốt.

## 7. Đồng bộ Kiot và đối soát

Giai đoạn nhặt chuyển hàng từ kệ sang chờ giao, tổng hàng còn trong cơ sở chưa nhất thiết giảm. Kiot có thể ghi nhận xuất kho ở một mốc khác, cần xác minh trên dữ liệu thực tế. Không phát sinh lệnh trừ Kiot chỉ vì người dùng bấm thực nhặt.

Đối soát theo sản phẩm/cơ sở: tổng vị trí + chờ giao + các khu hàng hợp lệ khác, đối chiếu tồn Kiot cùng phạm vi và cùng mốc dữ liệu. Tách hàng đang điều chuyển/hỏng/chờ kiểm thành nhóm rõ ràng, không cộng hai lần. Chênh lệch tạo cảnh báo điều tra thay vì tự ghi đè sổ.

## 8. Các lỗ hổng prototype cần xử lý trước production

- Sổ trong bộ nhớ, tải lại mất, nhiều trình duyệt không chia sẻ giữ chỗ.
- Chưa mô hình hóa khu chờ giao và đối soát Kiot; trừ ở vị trí chưa có bút toán đích.
- Mô phỏng quyền Kế toán/Kho/Quản lý chung; cần quyền thực trên backend.
- Chưa có hủy/hoàn hàng đầy đủ, version phiếu, cập nhật nguồn và idempotency cấp DB.
- Còn dùng ID vị trí theo index JSON và phụ thuộc thứ tự dòng; cần ID bền vững.
- Trường thực nhặt đang nhập số bổ sung, dễ xác nhận trùng; cần UI lũy kế và sự kiện duy nhất.
- Chưa xử lý toàn bộ giữ chỗ của các đơn khác khi kiểm đếm phát hiện thiếu.

## 9. Thứ tự triển khai đề xuất

1. Xác minh ý nghĩa số lượng Sheet, đơn vị, nguồn tồn và mốc Kiot ghi xuất; chốt danh mục vị trí.
2. Làm sổ vị trí và giữ chỗ dùng chung, sửa/hủy trước nhặt, phiên bản/in lại phiếu.
3. Thực nhặt → chờ giao, báo thiếu/lấy bù/kiểm đếm, trả về kệ.
4. Đối soát Kiot và xử lý xuất giao; chạy song song đối chiếu trước khi dùng số liệu để điều hành thật.

Tình huống nghiệm thu bắt buộc: hai kế toán xác nhận đồng thời; gửi lại cùng yêu cầu; cùng mã nhiều dòng; thay đổi thùng/chiếc; nhặt thiếu ảnh hưởng nhiều đơn; hủy sau nhặt; đơn nguồn đổi; in phiếu cũ; Sheet đổi thứ tự; đồng bộ bị chậm; kiểm đếm trong khi có chuyển động; quay lại lấy hàng đã trả về kệ.

## Nguồn tham khảo chính thức

- Odoo, reservation methods: https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/shipping_receiving/reservation_methods.html
- Odoo, two-step delivery (pick → output → ship): https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/shipping_receiving/daily_operations/receipts_delivery_two_steps.html
- Odoo, inventory adjustments / history / changes between counting and applying: https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/management/inventory_adjustments.html
- Microsoft, short picking and reallocation: https://www.microsoft.com/en-us/dynamics-365/blog/business-leader/2016/11/07/automatic-and-manual-item-reallocation-during-the-short-picking-dynamics-365-for-operations-1611/
- Microsoft Learn, location directives: https://learn.microsoft.com/en-us/dynamics365/supply-chain/warehousing/create-location-directive

Mã đã đối chiếu: `server/stockLocations/stockLocationsService.js`, `server/sheetSnapshots/sync.js`, `server/db/migrations/0064_sheet_snapshots.sql`, các file prototype trong `server/public/prototypes/order-picking/`.
