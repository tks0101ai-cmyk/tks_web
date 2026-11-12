# Thu mua: popup import Excel và file mẫu có hướng dẫn

Ngày: 2026-11-12 · Trạng thái: bản spec chờ người dùng duyệt

## Mục tiêu

Giúp người dùng chọn hoặc kéo thả workbook Thu mua, theo dõi tiến độ gửi file, tải được mẫu đúng với danh mục cột hiện hành, rồi kiểm tra dữ liệu trước khi ghi. Luồng này phục vụ việc nạp dữ liệu thật để người dùng tự kiểm tra sửa/xóa và đồng bộ nhiều phiên.

## Quyết định thiết kế

- Nối bước tải file vào hộp import hiện có, giữ nguyên preview, sửa dữ liệu preview và xác nhận toàn bộ file. Không tạo luồng import song song.
- Bấm **Import Excel** mở popup. Người dùng thả hoặc chọn `.xlsx`, xem tên/kích thước file, rồi bấm **Kiểm tra file** để gửi lên `POST /api/purchase-orders/import/preview`.
- Dùng `XMLHttpRequest.upload.onprogress` để hiện phần trăm và dung lượng đã gửi. Sau khi gửi xong, chuyển sang trạng thái kiểm tra không xác định phần trăm cho tới khi máy chủ trả preview. Giữ giới hạn hiện hành 10 MB, tối đa 10.000 dòng và một file.
- Trong lúc upload/kiểm tra, khóa chọn file và nút đóng để tránh bỏ dở yêu cầu; lỗi hiện ngay trong popup và cho phép thử lại. Sau preview thành công, thay phần chọn file bằng preview hiện hành.
- Nút **Tải file mẫu** tải workbook `.xlsx` sinh từ `purchase-columns.js`, không lưu thêm file mẫu tĩnh. Sheet `Đặt hàng` chỉ chứa các cột được phép nhập và dòng trống; sheet `Hướng dẫn` giải thích từng cột, trường bắt buộc, kiểu/định dạng dữ liệu, quy tắc cho từng dòng, và một ví dụ riêng không thể bị import nhầm.
- Quy tắc dòng: để trống `Mã dòng` để tạo dòng mới; điền `Mã dòng` hiện có để cập nhật; ô trống giữ nguyên giá trị cũ; một dòng tương ứng một mã; không cho phép lệnh xóa trong file. Xóa tiếp tục thực hiện trong bảng Thu mua.
- Import chỉ ghi sau khi toàn bộ preview hợp lệ và người dùng bấm xác nhận. Một lỗi bất kỳ chặn ghi toàn bộ file. Sau xác nhận, dùng transaction/audit/realtime hiện có; sửa hoặc xóa từ bảng giữ nguyên autosave và đồng bộ hiện tại.
- Không tự nạp dữ liệu thật và không tự xóa dữ liệu production trong lúc triển khai. Người dùng chọn file, xem preview và xác nhận khi sẵn sàng.

## Phạm vi kỹ thuật dự kiến

- `server/public/thu-mua/dat-hang/index.html`, `workspace.css`, `purchase.js`: dialog chọn file, drag/drop, trạng thái tiến độ, gọi upload có progress và tải template.
- `server/purchaseOrders/purchaseOrdersImport.js`, `purchaseOrdersRoutes.js`: sinh workbook hướng dẫn từ catalog và cung cấp route tải file mẫu có quyền `purchase.import`.
- Test hiện có cho UI, import parser và routes: xác nhận upload/progress/errors, workbook có đủ trường nhập, preview/confirm giữ nguyên semantics, quyền route, giới hạn, và lỗi không ghi một phần.
- Tài liệu cập nhật khi triển khai: README, server README (route tải mẫu), SRS/BRD và implementation plan; không đổi schema/migration. Chỉnh một dòng `CURRENT.md` khi trạng thái triển khai thay đổi.

## Tiêu chí nghiệm thu

1. Bấm Import Excel mở popup; chọn và thả cùng một `.xlsx` đều hiện tên file và cho phép kiểm tra.
2. Upload hiện tiến độ có thật từ request; lúc máy chủ phân tích file hiện trạng thái đang kiểm tra, không giả lập phần trăm.
3. File sai định dạng/quá giới hạn/lỗi validation hiển thị lỗi dễ đọc; không ghi dữ liệu.
4. Tải mẫu `.xlsx` được hai sheet như mô tả; tiêu đề trên sheet `Đặt hàng` được parser hiện tại nhận; toàn bộ cột nhập có lưu ý tương ứng trên `Hướng dẫn`; ví dụ không nằm trên sheet nhập.
5. Hành vi tạo/sửa/ô trống/preview/xác nhận và xóa trong bảng không đổi. Kiểm thử hai phiên xác nhận sửa và xóa được phản ánh ở phiên còn lại qua realtime hiện có.

## Ngoài phạm vi

- Xóa hoặc thay toàn bộ bảng thông qua Excel.
- Nạp tự động khi chọn file, bỏ bước preview/xác nhận, hay sửa thay đổi quy tắc ánh xạ dữ liệu.
- Nạp hoặc xóa dữ liệu thật thay cho người dùng.
