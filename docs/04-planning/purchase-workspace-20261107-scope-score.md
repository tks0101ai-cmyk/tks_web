# Đối chiếu phạm vi và điểm nghiệm thu từng chức năng

Ngày lập: 07/11/2026. Nhánh: `feat/purchase-workspace-20261107`.

Đây là báo cáo đối chiếu yêu cầu, bổ sung cho [báo cáo kiểm thử](purchase-workspace-20261107-test-report.md). Điểm mục tiêu là tiêu chuẩn nghiệm thu, không phải kết quả đã đạt. Đã cập nhật điểm theo bằng chứng cục bộ bên dưới. Điểm không thay thế quyết định nghiệm thu hoặc bằng chứng triển khai production.

## Cách chấm điểm

Mỗi chức năng tối đa 10 điểm, mục tiêu 10/10:

- Phạm vi (2 điểm): đáp ứng đủ yêu cầu và các tình huống liên quan nêu trong hàng tương ứng.
- Hành vi thực tế (3 điểm): kết quả đúng qua kiểm tra tích hợp, gồm lưu và tải lại khi có dữ liệu lưu.
- Kiểm thử tự động (3 điểm): có ca kiểm tra hành vi chính và biên, đã chạy trên bản tích hợp hiện tại và có kết quả lưu lại.
- Kiểm tra trình duyệt (2 điểm): thao tác trên giao diện thực, có ghi nhận kết quả; chức năng đồng bộ phải kiểm tra hai phiên.

Mỗi phần ghi điểm kèm bằng chứng. Chưa kiểm chứng ghi `CĐG` (chưa đánh giá), không quy đổi thành điểm đạt hoặc điểm 0. Không lấy số lượng test làm tỷ lệ đáp ứng yêu cầu. Điểm tổng chưa được tính khi còn phần CĐG.

Lỗi sai tiền, mất dữ liệu, ghi đè bản nháp, vượt quyền hoặc sai xung đột phiên bản chặn merge bất kể điểm các mục khác. Mục tiêu 10/10 là quy ước đánh giá đề xuất cho báo cáo này; người dùng chưa xác nhận một ngưỡng điểm riêng.

## Phạm vi và tiêu chí theo chức năng

| ID | Yêu cầu / phạm vi phải đạt | Tiêu chí để nhận đủ điểm | Mục tiêu | Điểm thực tế | Đánh giá phạm vi hiện tại |
|---|---|---|---|---|---|
| TM-01 | Tổng tệ = tổng SL × giá tệ + VC trước nếu có | Trống VC tính 0; số dương/âm cộng đúng; thay đầu vào cập nhật đúng; giao diện và máy chủ thống nhất; không biến đầu vào thiếu hoặc sai thành kết quả hợp lệ | 10/10 | Xem bảng điểm kết quả bên dưới | Đúng yêu cầu; cần kiểm tra cả tính trên giao diện và truy vấn máy chủ |
| TM-02 | Hoàn tác theo giá trị cũ của ô | Gõ nhiều ký tự chỉ tạo một bước; chuyển ô, quay lại sửa tạo bước mới; hoàn tác không tự lưu dữ liệu lên máy chủ; thao tác dán/hàng loạt không làm hỏng lịch sử | 10/10 | Xem bảng điểm kết quả bên dưới | Đúng yêu cầu; các ca lịch sử bổ sung nhằm tránh mất dữ liệu |
| TM-03 | Nét số mảnh hơn | Số và ô nhập số dùng nét thường; kiểm tra sáng/tối, ô có bản nháp và ô cảnh báo; không thay đổi dữ liệu | 10/10 | Xem bảng điểm kết quả bên dưới | Đúng yêu cầu; cần kiểm tra trực quan, test mã nguồn chưa đủ |
| TM-04 | Bảng cấu hình NV riêng cho Thu mua | Thêm/sửa/ngừng dùng tên trong danh mục riêng; cột NV chỉ chọn từ danh mục; không nhập tên tự do trên dòng, không lấy HR; tên lịch sử vẫn đọc được; quyền sửa được kiểm tra tại máy chủ | 10/10 | Xem bảng điểm kết quả bên dưới | Theo yêu cầu mới nhất, thay thế yêu cầu nhập tên tự do trước đó; ngừng dùng thay cho xóa để giữ lịch sử |
| TM-05 | Cảnh báo bằng màu chữ | Độ lệch tuyệt đối >10% đỏ, ≤10% xanh theo trao đổi trước; kiểm tra cả âm/dương và đúng ±10%; VC trước âm đỏ; nền ô không bị tô đỏ, kể cả khi đang sửa | 10/10 | Xem bảng điểm kết quả bên dưới | Đúng cách tô màu yêu cầu; giữ quy tắc biên đã thống nhất trước đó |
| TM-06 | Cont chờ xếp luôn ở trên | Dòng chưa gán cont đứng đầu khi sắp theo mã, ngày hoặc cột; sắp xếp trước phân trang; dòng tách không làm đảo nhóm | 10/10 | Xem bảng điểm kết quả bên dưới | Đúng yêu cầu; ưu tiên chờ xếp phải áp dụng cho mọi kiểu sắp xếp |
| TM-07 | Thêm mã luôn vào cont chờ xếp | Thêm mới và đặt lại mã đều tạo dòng chưa gán cont; cont đang ghim hoặc bộ lọc không thay đổi đích; máy chủ cũng bảo đảm quy tắc | 10/10 | Xem bảng điểm kết quả bên dưới | Đúng yêu cầu; cần chứng minh dòng mới tồn tại dù bộ lọc hiện tại có thể ẩn nó |
| TM-08 | Nhiều người cùng thao tác | Thay đổi đã lưu xuất hiện ở phiên khác kể cả đang nhập; giữ giá trị, con trỏ và bản nháp; sửa cùng ô báo xung đột; không ghi đè âm thầm | 10/10 | Xem bảng điểm kết quả bên dưới | Phạm vi là đồng bộ dữ liệu đã lưu; bản nháp chưa lưu của từng người giữ riêng. Đây là cách triển khai cần nêu rõ khi nghiệm thu |
| TM-09 | Đồng bộ ổn định khi kết nối lại | Mất mạng/kết nối lại lấy được thay đổi; phản hồi cũ không đè dữ liệu mới; dọn kết nối khi rời trang; không phát sinh nhiều luồng tải cạnh tranh | 10/10 | Xem bảng điểm kết quả bên dưới | Là phần kiểm chứng độ tin cậy của TM-08, không tính thành một yêu cầu người dùng mới |
| TM-10 | Bảng chỉ số cho sửa thông tin cont | Sửa thông tin nguồn như tên, xe, lịch, đơn vị VC, người xếp, cước, sức chứa; lưu/tải lại đúng; kiểm tra giá trị sai và phiên bản cũ | 10/10 | Xem bảng điểm kết quả bên dưới | Cần phân biệt thông tin nguồn có thể sửa với tổng số mã/tấn/m³ được tính từ các dòng; tổng dẫn xuất tiếp tục chỉ đọc |
| TM-11 | Thông tin chỉ số tác động các mã trong cont | Tên/trạng thái hiển thị thống nhất; cước ảnh hưởng tính NET; các trường dùng chung lan truyền đúng cho mọi dòng; cont khác không bị đổi; có kiểm tra phiên bản và dấu vết thay đổi | 10/10 | Xem bảng điểm kết quả bên dưới | Đúng yêu cầu; phải đối chiếu rõ từng trường được lan truyền, không kết luận chỉ từ việc sửa được bảng chỉ số |
| TM-12 | Bảng trạng thái vừa chỉ số vừa bộ lọc | Đủ chờ xếp, chưa có lịch, chưa bốc, đã bốc, đã về; số liệu khớp dữ liệu; bấm lọc đúng và bỏ lọc được; trường hợp không có dữ liệu vẫn hiển thị hợp lý | 10/10 | Xem bảng điểm kết quả bên dưới | Đúng yêu cầu; dùng chung dữ liệu với bảng để tránh chỉ số lệch bộ lọc |
| TM-13 | Đổi bố cục các bảng | Bỏ dashboard tổng hợp trên cùng; bảng chỉ số dưới bảng đặt hàng; cont ghim trên bộ lọc, không mất khi dòng gốc ra ngoài vùng nhìn; kiểm tra cuộn ngang và sáng/tối | 10/10 | Xem bảng điểm kết quả bên dưới | Đúng cả ba yêu cầu bố cục; cần bằng chứng trên trình duyệt |
| TM-14 | Không làm hỏng chức năng đang có | Công thức số, ngày dd/mm, thanh toán dropdown, mũi tên, ô gọn, tách dòng, dán, lưu, nhập/xuất hoạt động sau tích hợp | 10/10 | Xem bảng điểm kết quả bên dưới | Là phạm vi hồi quy từ các yêu cầu trước; không cộng thêm tính năng ngoài yêu cầu |

## Mẫu kết quả bắt buộc cho từng chức năng

Mỗi ID ở trên phải có một mục kết quả trong bản nghiệm thu cuối, gồm:

1. Phạm vi đã thực hiện và phần còn thiếu so với hàng yêu cầu.
2. Kết quả mong đợi và kết quả quan sát được của từng ca kiểm tra.
3. Bằng chứng: tên test, lệnh chạy, kết quả; bước thao tác trình duyệt và ảnh khi cần.
4. Điểm thành phần: phạm vi `/2`, hành vi `/3`, tự động `/3`, trình duyệt `/2`.
5. Kết luận: đạt / chưa đạt / chưa đủ bằng chứng; lỗi còn lại và có chặn merge hay không.

## Điểm sau tích hợp và kiểm thử cục bộ

Bằng chứng chi tiết và giới hạn môi trường nằm trong báo cáo kiểm thử liên kết ở đầu tài liệu. Điểm trình duyệt có thể là 1/2 khi mới thao tác được một phần luồng; không coi việc chưa kiểm đủ là đã đạt trọn vẹn. Bảng dưới là kết quả hiện tại; ma trận đầu mô tả phạm vi mục tiêu.

| ID | Phạm vi /2 | Hành vi /3 | Tự động /3 | Trình duyệt /2 | Điểm /10 | Kết luận / phần còn thiếu |
|---|---:|---:|---:|---:|---:|---|
| TM-01 | 2 | 3 | 3 | 2 | 10 | Đạt cục bộ: tính, SQL, xuất và đối soát thống nhất; VC trống/âm đúng |
| TM-02 | 2 | 3 | 3 | 2 | 10 | Đạt: hoàn tác một lần từ 12345 về 10; lịch sử nhiều ô được test |
| TM-03 | 2 | 3 | 2 | 2 | 9 | Nét400 đúng sáng/tối; test CSS không chứng minh mọi tổ hợp font/trạng thái |
| TM-04 | 2 | 3 | 3 | 1 | 9 | CRUD/quyền được test; trình duyệt đã thêm/chọn NV, chưa thao tác đủ rename/deactivate/reactivate |
| TM-05 | 2 | 3 | 3 | 2 | 10 | Đạt cục bộ: biên ±10%, chữ đỏ/xanh, không nền đỏ |
| TM-06 | 2 | 3 | 3 | 1 | 9 | Các sort có test; trình duyệt xác minh thứ tự ban đầu, chưa thao tác hết mọi kiểu sort |
| TM-07 | 2 | 3 | 3 | 2 | 10 | Thêm mã thực tế vào chờ xếp khi đang ghim; reorder/plan/import có test |
| TM-08 | 2 | 3 | 3 | 2 | 10 | Hai phiên API/SSE giả lập đạt; backend SQL và SSE có test riêng, chưa kiểm production nhiều instance |
| TM-09 | 2 | 3 | 3 | 2 | 10 | Ngắt server thử: báo mất kết nối, giữ nháp; tự nối lại và nhận cập nhật khác dòng |
| TM-10 | 2 | 3 | 3 | 1 | 9 | API/ngày/snapshot có test; trình duyệt đã lưu tên/nhà VC, chưa thao tác đủ mọi trường |
| TM-11 | 2 | 3 | 3 | 1 | 9 | SQL kiểm tra lan truyền và rollback; trình duyệt xác nhận đổi tên trên sáu mã ở phiên khác, chưa kiểm mọi công thức NET/ngày bằng browser |
| TM-12 | 2 | 3 | 3 | 2 | 10 | Đủ5 nhóm, số liệu và toggle được test; chờ xếp lọc/bỏ lọc đúng trên browser |
| TM-13 | 2 | 3 | 3 | 1 | 9 | DOM đúng và giao diện707px đã kiểm; công cụ chưa thực hiện được kiểm tra desktop1600px |
| TM-14 | 2 | 3 | 3 | 1 | 9 | Hồi quy tự động đạt; browser kiểm công thức/hoàn tác/thêm mã, chưa thao tác hết import/export/tách/dán |

Các điểm trên phản ánh mức bằng chứng, không phải tỷ lệ số dòng code đã viết. Hàng dưới10 chưa đạt mức mục tiêu10/10; phần thiếu được liệt kê ngay trong hàng, không ngầm coi đã được người dùng chấp thuận.

## Điều kiện chốt

Rà soát độc lập phát hiện hai lỗi dùng phiên bản mới với giá trị nhập cũ tại tiền VC và modal NV. Cả hai đã sửa và reviewer xác nhận. Lỗi focusout sau khi dựng lại ô cũng đã sửa, có test hồi quy và kiểm tra hai phiên. Bộ test cuối251/251 đạt. Điểm trên có hiệu lực trong phạm vi cục bộ đã mô tả; giới hạn bằng chứng mỗi hàng vẫn giữ nguyên.

Phạm vi bao phủ yêu cầu mới nhất. Bản nháp chưa lưu giữ riêng và các tổng dẫn xuất chỉ đọc vẫn là hai cách hiểu triển khai cần nêu khi nghiệm thu. Chưa merge, chưa deploy, chưa áp migration production.

Cập nhật cuối: 07/11/2026.
