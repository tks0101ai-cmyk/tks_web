# Phát hành riêng Tồn VAT và ORDER VAT từ chi tiết chứng từ

Ngày: 21/11/2026. Trạng thái: người dùng đã duyệt thiết kế; triển khai theo kế hoạch tách phát hành.

## Mục đích

Cho sale dùng ngay phần xem Tồn VAT và chuyển dòng thiếu sang ORDER VAT, trong khi luồng tạo yêu cầu xuất hóa đơn VAT tiếp tục được phát triển và phát hành sau. Tái sử dụng phần đã làm trên nhánh `claude/vat-stock-document-detail`.

## Phương án

Chọn tách một PR riêng từ `origin/main` mới nhất, chỉ lấy các thay đổi cần cho Tồn VAT / ORDER VAT. Người dùng chốt phạm vi này ngày 21/11/2026. Không ghép toàn nhánh rồi giấu luồng xuất hóa đơn bằng nút / quyền: cách đó vẫn đưa các phụ thuộc và migration chưa phát hành lên main, trái với việc để luồng này lên sau.

Đây là một đợt tách phát hành nhỏ, không thiết kế lại giao diện hoặc nghiệp vụ ORDER VAT. Cách thực hiện do Codex đề xuất: dùng nhánh / worktree riêng từ main để giữ nguyên nhánh phát triển cùng các sửa đổi review còn trong working tree.

## Phạm vi phát hành

- Hộp chi tiết hóa đơn của tab Hóa đơn và hộp Chi tiết đơn ở Vòng đời đơn hàng có cột Tồn VAT và ô tick ORDER VAT theo quyền hiện có.
- Tồn lấy từ cùng snapshot / bộ đệm với Tra cứu VAT trên main: mã SP khớp chính xác sang mã VAT, lấy tổng TỒN CÓ THỂ NHÁP của mã VAT trên các công ty. Không phải số tồn Kiot và không phải giữ chỗ VAT.
- Nhiều dòng chung mã VAT chia tồn theo thứ tự dòng để tính phần thiếu; không tính lặp toàn bộ tồn cho từng dòng. Dòng phí mã bắt đầu bằng VAT, dòng thiếu mã hoặc SL không dương không được xét.
- Dòng thiếu hiển thị màu đỏ; mã chưa có liên kết VAT hiển thị rõ tình trạng thiếu mã. Tick các dòng cần order rồi bấm Order VAT.
- Mở trang ORDER VAT với form đã điền khách, mã / tên hàng, giá chưa VAT, số lượng còn thiếu và ghi chú chứng từ nguồn. Sale được sửa và chọn Full VAT trước khi gửi. Không tự tạo yêu cầu chỉ bằng việc bấm chuyển trang.
- Giữ nháp ORDER VAT đang có; thêm các dòng được chuyển sau các dòng đã nhập, dùng dòng trống trước. Giữ giới hạn số dòng và thông báo dòng vượt giới hạn hiện có.
- Dữ liệu chuyển trang chỉ dùng một lần, hết hạn sau 10 phút; không đưa tên khách / giá lên URL. Khi trình duyệt không lưu được, báo rõ và hỗ trợ chép dữ liệu để dán như phần đã triển khai.
- Trong lúc tải tồn hiện dấu chờ. Khi lỗi, hiện thông báo; cho chọn dòng để order nguyên SL khi không biết phần thiếu. Bản tồn cũ phải có dấu nhận biết. Kết quả trả muộn không điền sang chứng từ khác.
- Chứng từ đã hủy vẫn xem được tồn nhưng không có thao tác order. Đổi / đóng chi tiết thì dọn các tick và thao tác đang gắn với chứng từ cũ.

Luồng sử dụng: mở chi tiết hóa đơn / đơn hàng → xem dòng thiếu VAT → tick dòng → Order VAT → kiểm tra form điền sẵn → gửi bằng thao tác ORDER VAT hiện có.

## Quyền và dữ liệu

- Xem tồn cần `accounting.vatLookup`; order cần thêm `accounting.vatRequest`. Không tạo quyền mới hoặc mở rộng quyền mặc định của các vai trò.
- Thêm `POST /api/vat-lookup/stock` vào router Tra cứu VAT trên main, dùng chung nguồn / bộ đệm hiện có; giữ kiểm tra quyền, giới hạn mã và cache response như phần đã làm.
- Giữ các cải tiến nguồn dữ liệu, dùng chung bộ đệm và làm mới nền đã có trên main. Không chép đè nguyên file từ nhánh cũ khi file đó chứa các thay đổi khác.
- Không nối `draftStock`, `applyDraftDeductions` hoặc truy vấn bảng nháp web của luồng xuất hóa đơn vào API tồn. Số tồn đợt này phải khớp Tra cứu VAT đang phát hành.
- Chỉ đọc Google Sheet VAT TKS. Thao tác Gửi ORDER VAT tiếp tục ghi theo API / cơ sở dữ liệu hiện hành của ORDER VAT.
- Không migration, không bảng mới, không biến môi trường hoặc thư viện mới.

## Phần để phát hành sau

- Nút / đường dẫn Tạo yêu cầu xuất VAT trong hai hộp chi tiết; tab / trang / quyền / API mới của luồng Xuất hóa đơn.
- Module `invoiceRequests`, bảng nháp web, chốt / gửi nháp, QR, bill, ký và ảnh / PDF vin-hoadon; toàn bộ migration 0127–0132 của luồng này.
- Sandbox, script refresh / chia sẻ, các sửa đổi review vin-hoadon và các tính năng khác nằm chung trong lịch sử nhánh.
- Đổi vị trí các mục của tab Hóa đơn, thiết kế lại form ORDER VAT hoặc đổi cách tính cột tồn hiện có của form này.

Không được tạo tình trạng sale thấy nút dẫn đến trang chưa phát hành, hoặc main cần bảng của luồng xuất hóa đơn mới chạy được.

## Ranh giới thay đổi dự kiến

- API / mô hình Tra cứu VAT: phần khớp mã chính xác và trả tồn cho danh sách mã.
- Module giao diện dùng chung `vat-stock` và phần chuyển dữ liệu ORDER VAT của `vat-handoff`; bỏ các phụ thuộc sang tạo yêu cầu xuất VAT trong bản tách.
- Tích hợp vào hộp chi tiết của `public/index.html` và `public/shipment/lifecycle/index.html`; tiếp nhận dữ liệu ở trang / form ORDER VAT.
- Chọn từng phần thay đổi và các bản sửa liên quan; không lấy nguyên file hoặc nguyên commit có kèm luồng Xuất hóa đơn / sandbox. Tăng phiên bản JS / CSS ở các trang nạp file.
- Theo quy tắc bàn giao, PR giữ nguyên bảy file tài liệu dùng chung như main; nội dung cập nhật tương ứng được gom vào một tài liệu riêng để áp sau merge. Nhánh phát triển hiện tại được giữ nguyên.

Danh sách file / commit chính xác và cách giải quyết xung đột sẽ được chốt khi lập kế hoạch từ main mới nhất. Snapshot đã kiểm tra khi thảo luận: `origin/main` ở `de3b2985`.

## Điều kiện nghiệm thu

- Kiểm thử API khớp mã / quyền / giới hạn / nguồn lỗi và xác nhận dùng cùng snapshot với Tra cứu VAT, không phụ thuộc bảng nháp web.
- Kiểm thử hai hộp chi tiết: chia tồn đúng khi trùng mã VAT, màu thiếu, dòng không xét, lỗi / dữ liệu cũ, tick / đổi chứng từ / phản hồi về muộn và chứng từ đã hủy.
- Kiểm thử chuyển ORDER VAT: đúng phần thiếu, thông tin khách / hàng / giá, giữ nháp cũ, dữ liệu hết hạn, giới hạn số dòng, lỗi localStorage và không tự gửi.
- Không có nút Tạo yêu cầu xuất VAT hoặc phụ thuộc runtime vào module / migration của luồng xuất hóa đơn trong bản phát hành.
- Giữ giao diện sáng / tối, bảng cuộn và thanh thao tác dùng được trên điện thoại; không đổi cách mở chi tiết hiện có.
- Chạy test liên quan và phần có thể bị ảnh hưởng theo graphify; rà diff toàn PR. Thử ghi chỉ trên sandbox local đã kiểm tra, không dùng DB production để thử.

## Bước tiếp theo

Duyệt thiết kế này → lập kế hoạch → tách code từ main và kiểm thử → review PR trước khi đưa lên main. Việc chốt phạm vi không có nghĩa là đã merge / deploy. Sandbox hiện tại tiếp tục phục vụ nhánh phát triển đang được người dùng test.

Cập nhật gần nhất: 21/11/2026.
