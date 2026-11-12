# Thu mua: import workbook dữ liệu đầy đủ có hướng dẫn

Ngày: 2026-11-12 · Trạng thái: bản spec chờ người dùng duyệt

## Mục tiêu

Buộc người dùng bắt đầu bằng cách tải toàn bộ dữ liệu Thu mua hiện hành, sửa workbook đó rồi tải lên để áp dụng như một snapshot mới. Hỗ trợ kéo thả/chọn file, theo dõi tiến độ, xem trước thay đổi và đồng bộ việc sửa/xóa giữa nhiều phiên.

## Quyết định thiết kế

- Nối luồng vào hộp import hiện có, giữ preview, sửa dữ liệu preview và xác nhận một giao dịch. Không tạo luồng import song song.
- Bấm **Import Excel** mở popup chỉ có bước đầu là tải **toàn bộ dữ liệu hiện tại**. Nút **Tải dữ liệu hiện tại + hướng dẫn** lấy mọi dòng đang hoạt động, không theo bộ lọc hay phân trang; workbook có sheet `Đặt hàng` và sheet `Hướng dẫn`. Chỉ sau khi tải xong mới bật vùng thả/chọn file.
- Người dùng sửa chính workbook vừa tải rồi thả/chọn `.xlsx`, kiểm tra tên/kích thước và bấm **Kiểm tra file** để gửi lên `POST /api/purchase-orders/import/preview`. Workbook tải về kiêm file mẫu, vì vậy không phát hành một mẫu trống riêng có thể nhầm là snapshot đầy đủ.
- Dùng `XMLHttpRequest.upload.onprogress` để hiện phần trăm và dung lượng đã gửi. Sau khi gửi xong, chuyển sang trạng thái kiểm tra không xác định phần trăm cho tới khi máy chủ trả preview. Giữ giới hạn hiện hành 10 MB, tối đa 10.000 dòng và một file.
- Trong lúc upload/kiểm tra, khóa chọn file và nút đóng để tránh bỏ dở yêu cầu; lỗi hiện ngay trong popup và cho phép thử lại. Sau preview thành công, thay phần chọn file bằng preview hiện hành.
- Workbook snapshot có sheet dữ liệu sinh từ catalog hiện hành và sheet hướng dẫn liệt kê từng cột nhập, trường bắt buộc, kiểu/định dạng, quy tắc từng dòng và ví dụ riêng. Sheet dữ liệu có đầy đủ các cột được phép nhập; không đưa cột công thức/chỉ đọc vào tập dữ liệu ghi.
- Workbook mang revision lúc tải. Preview chỉ nhận workbook do luồng tải hiện tại cấp và từ chối revision đã cũ nếu bất kỳ người nào sửa/xóa/thêm dữ liệu sau lúc tải; người dùng phải tải snapshot mới trước khi sửa và upload lại.
- Quy tắc snapshot: mỗi mã một dòng; `Mã dòng` hiện có cập nhật dòng; `Mã dòng` trống tạo dòng mới; giá trị rỗng là rỗng theo file; dòng hiện tại không có trong file sẽ bị xóa mềm như nút Xóa trong bảng (vẫn giữ audit/khôi phục). Preview phải nêu riêng số dòng thêm, sửa, giữ nguyên và xóa; người dùng xác nhận rõ trước khi ghi. Mã trùng, khóa sai, thiếu cột bắt buộc hoặc bất kỳ dòng lỗi nào chặn toàn bộ thao tác.
- Chỉ ghi sau khi snapshot hợp lệ và người dùng bấm xác nhận. Tạo/sửa/xóa cùng transaction và audit; thay đổi phát qua realtime hiện có. Sửa/xóa trên bảng tiếp tục autosave và đồng bộ như hiện tại.
- Không tự nạp dữ liệu thật trong lúc triển khai. Người dùng chọn snapshot, xem rõ tổng thay đổi và xác nhận khi sẵn sàng.

## Phạm vi kỹ thuật dự kiến

- `server/public/thu-mua/dat-hang/index.html`, `workspace.css`, `purchase.js`: dialog bắt buộc tải snapshot trước, drag/drop, tiến độ upload và preview thay đổi gồm xóa.
- `server/purchaseOrders/purchaseOrdersImport.js`, `purchaseOrdersRoutes.js`, `purchaseOrdersService.js`: workbook snapshot + hướng dẫn, metadata revision, preview/commit full snapshot, khóa stale snapshot và xóa có audit/realtime.
- Test hiện có cho UI, workbook, service và routes: xác nhận cần tải snapshot, đủ hướng dẫn/cột, stale snapshot bị từ chối, diff thêm/sửa/xóa đúng, race không ghi một phần, quyền route và giới hạn.
- Tài liệu cập nhật khi triển khai: README, server README (route tải mẫu), SRS/BRD và implementation plan; không đổi schema/migration. Chỉnh một dòng `CURRENT.md` khi trạng thái triển khai thay đổi.

## Tiêu chí nghiệm thu

1. Popup không cho chọn/upload trước khi tải snapshot đầy đủ; workbook tải xuống có cả dữ liệu hiện hành và hướng dẫn.
2. Chọn và thả workbook đã tải đều hiện tên file; upload hiện phần trăm thực, rồi trạng thái kiểm tra không giả lập tiến độ.
3. Preview báo chính xác số tạo/sửa/không đổi/xóa. Dòng vắng mặt được đánh dấu xóa và không ghi trước xác nhận.
4. File sai định dạng/quá giới hạn/thiếu metadata hoặc cũ/lỗi validation hiển thị lỗi; không ghi dữ liệu.
5. Toàn bộ cột ghi được đều có hướng dẫn; file được parser nhận. Ô rỗng áp thành giá trị rỗng; không có cột công thức/chỉ đọc bị ghi đè.
6. Xác nhận thay đổi snapshot chạy nguyên tử, tạo lịch sử, phát sự kiện realtime. Kiểm thử hai phiên xác nhận thêm/sửa/xóa đều được phản ánh; thay đổi phát sinh sau lúc tải làm snapshot bị từ chối.

## Ngoài phạm vi

- Nạp tự động khi chọn file, bỏ bước preview/xác nhận, hay sửa thay đổi quy tắc ánh xạ dữ liệu.
- Nạp hoặc xóa dữ liệu thật thay cho người dùng.
