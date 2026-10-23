# Bộ lọc khách, xuất thông tin chi tiết và level giá nội bộ

Ngày: 23/10/2026. Trạng thái: người dùng đã duyệt trong chat; mã cục bộ đã kiểm chứng; chưa áp dữ liệu thật hoặc deploy.

## Quyết định đã xác nhận

Người dùng chọn level chung cho một dòng khách gộp: tất cả mã khách cùng tên ở Hà Nội và Sài Gòn cùng dùng một level. Khóa sử dụng đúng `nameKey` của bảng Doanh số theo khách hiện hữu. Giữ hạn chế hiện tại của khóa theo tên: đổi tên khách cần đối soát liên kết, không tự ghép khách bằng so khớp gần đúng.

## Phương án

Đề xuất lưu level nội bộ theo khách gộp, có dữ liệu nguồn ban đầu theo từng hồ sơ để đối soát. Lưu riêng level theo mã khách sẽ khiến một dropdown không thể hiện rõ nhiều giá trị HN/SG; tiếp tục đọc email không đáp ứng việc tách liên kết. Không thay đổi email trên KiotViet.

## Bộ lọc

Thêm hai dropdown cạnh bộ lọc Sale và Level giá trên bảng Doanh số theo khách:

- Hình thức bán hàng: Tất cả, Chưa có và các giá trị hiện có trong hộp Chi tiết. Khách có nhiều hình thức khớp khi chứa hình thức được chọn.
- Quy mô khách (Quản lý đánh giá): Tất cả, Chưa có và các mức hiện có trong hộp Chi tiết.

Kết hợp các bộ lọc bằng AND với Sale, Level giá, tìm kiếm và công tắc khách không hoạt động; lọc trước phân trang. Màn hình, danh sách trường xuất và file xuất sử dụng cùng điều kiện. Không cần mở hộp Chi tiết để nạp thông tin lọc. Việc xem dữ liệu hồ sơ tiếp tục yêu cầu quyền xem Chi tiết khách hiện có.

## Xuất Excel

Giữ các cột doanh số và lựa chọn cột xuất hiện có. Bổ sung Định vị kho, Số lượng kho, Diện tích, Đối thủ, Hình thức bán hàng, Quy mô khách, Người được sửa, Các ngày tiếp khách và Ảnh kho; giữ Tiếp khách lần cuối. Các danh sách hiển thị nhãn tiếng Việt, ngày theo định dạng DD/MM/YYYY. Ảnh kho xuất danh sách đường dẫn đầy đủ tới ảnh, vẫn yêu cầu đăng nhập và quyền truy cập như ảnh trên web. Không nhúng ảnh nhị phân vào Excel.

Không xuất nội dung Note. Các trường chi tiết chỉ có cho người có quyền xem Chi tiết; API xuất kiểm tra quyền phía server. Nạp hồ sơ theo lô thay vì truy vấn riêng từng khách. Không âm thầm xuất hồ sơ trắng nếu lỗi đọc dữ liệu; thông báo lỗi để người dùng thử lại. Giữ xử lý chống công thức Excel cho văn bản.

## Lưu level trước khi tách email

Chuẩn bị migration mới, không sửa các migration đã áp. Trong một giao dịch, lưu level suy ra từ email hiện tại cho toàn bộ hồ sơ khách đang có trong database, cả hồ sơ chưa phát sinh doanh số, với cơ sở, mã/ID, tên và giá trị email nguồn để đối soát. Quy tắc email giữ như hiện tại: trống hoặc Lớn/Mới là Lớn, VIP là VIP, giá trị khác là Vừa.

Tạo level chung theo đúng kết quả đang hiển thị của bảng khách ở thời điểm chuyển đổi. Khi nhiều hồ sơ cùng tên khác level, ưu tiên kết quả bảng đang dùng; với khách chưa có dòng báo cáo, chọn hồ sơ có level khác Vừa trước rồi thứ tự cơ sở/ID xác định. Lưu lại các khác biệt nguồn để đối soát, không làm mất level riêng ban đầu. Migration chạy lại không được ghi đè level đã lưu hoặc đã sửa.

Chỉ chuyển bảng báo cáo và lần chụp kiểm tra giá sang dữ liệu nội bộ khi bước khởi tạo hoàn tất. Sau chuyển đổi, đồng bộ KiotViet vẫn hoạt động bình thường nhưng email không còn quyết định level. Khách mới hoàn toàn mặc định Lớn để giữ hành vi hiện tại của khách chưa gán email; khách mới cùng khóa tên dùng level chung đã có. Mọi lần đọc sau chuyển đổi không fallback về email. Thiếu dữ liệu nền tảng thì báo chưa sẵn sàng, không chụp hóa đơn bằng level đoán tạm.

## Dropdown và quyền sửa

Ngay cột Level giá, hiện dropdown Vừa / Lớn / VIP với level nội bộ hiện hành. Người chỉ có quyền xem nhận văn bản. Quyền sửa dự kiến dùng cơ chế hiện có: người có quyền quản lý khách hoặc người được gán trong Người được sửa của đúng khách đó; yêu cầu cả quyền xem Chi tiết. Quyền gán người vẫn thuộc người có quyền quản lý khách.

Chọn level lưu ngay qua API; khóa dropdown khi lưu, thất bại trở lại giá trị đã lưu và báo lỗi. Server kiểm tra quyền theo khách, enum và khách tồn tại. Lưu lịch sử gồm khách, level cũ/mới, người sửa và thời điểm; dùng phiên bản để phát hiện sửa đồng thời, yêu cầu nạp lại khi xung đột. Sau lưu, cập nhật dòng và bộ lọc level ngay.

## Hóa đơn kiểm tra sai giá

Lần chụp tiếp theo đọc level nội bộ trong cùng giao dịch chụp, áp dụng cho mọi mã khách thuộc khóa tên chung. Một lượt chụp dùng một phiên bản dữ liệu level nhất quán. Hóa đơn chưa từng chụp dùng level ở thời điểm chụp, kể cả ngày bán trước ngày thay đổi level.

Giữ cơ chế chỉ thêm hóa đơn chưa có dấu chụp trong `invoice_price_audit_invoices`. Không tính lại, xóa hoặc cập nhật dòng kiểm tra đã chụp khi sửa level hoặc khi KiotViet đồng bộ. Ví dụ: khách từ Lớn sang VIP; hóa đơn đã chụp theo Lớn giữ nguyên, hóa đơn chụp mới dùng VIP. Giữ nguyên các luật số lượng, cắt lỗ, VAT và cước.

## Kiểm chứng và triển khai

Kiểm thử migration trên database giả lập: đủ mọi hồ sơ, gộp HN/SG, trùng tên khác level, khách không doanh số, chạy lại và không ghi đè chỉnh sửa. Kiểm thử lọc kết hợp và Excel với dữ liệu đa lựa chọn, thiếu hồ sơ, quyền xem, ngày/ảnh và không có Note. Kiểm thử server từ chối đổi level trái quyền, sửa đồng thời và ghi lịch sử. Kiểm thử chụp trước/sau đổi level, thay email sau tách và hóa đơn đã chụp bất biến.

Kiểm tra trình duyệt desktop/mobile, sáng/tối, lưu lỗi và dropdown; chạy toàn bộ test theo quy định dự án, cập nhật tài liệu API/schema và đồ thị nếu công cụ sẵn có. Việc áp migration DB thật và triển khai sẽ được báo riêng sau khi mã được kiểm chứng; bản thiết kế này không xác nhận dữ liệu đã được sao lưu hay chuyển đổi.

## Tự rà soát

Đã phân biệt quy mô do quản lý đánh giá với level giá; xác định khóa gộp, khách mới, trường Excel, quyền sửa, xung đột dữ liệu nguồn và thời điểm hiệu lực. Không có thay đổi schema hay hành vi chạy thực tế trong giai đoạn thiết kế này.
