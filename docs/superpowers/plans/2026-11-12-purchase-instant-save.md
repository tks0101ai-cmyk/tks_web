# Thu mua: lưu nhanh và trạng thái đang lưu

## Mục tiêu

Khi người dùng xác nhận lưu, hiển thị trạng thái `Đang lưu…` ngay lập tức và khóa nút để ngăn gửi lặp. Sau phản hồi thành công từ API, đóng hộp xác nhận ngay, báo đang đồng bộ nền và không chờ tải lại toàn bộ snapshot trước khi kết thúc thao tác. Khi lỗi xác định hoặc lỗi mạng, giữ hộp thoại và bản nháp; yêu cầu idempotency/outbox tiếp tục bảo vệ lỗi kết quả chưa rõ.

## Phạm vi ảnh hưởng

- `server/public/thu-mua/dat-hang/purchase.js`: luồng confirm save và retry outbox, trạng thái loading accessible, áp row PATCH authoritative ngay và đồng bộ snapshot nền.
- `server/purchaseOrders/purchaseOrdersRealtimePage.integration.test.js`: regression test cho trạng thái loading, đóng hộp thoại sau write thành công nhưng trước khi GET snapshot kết thúc, giữ hộp thoại khi lỗi.
- Không đổi API/schema, không thay đổi nghiệp vụ version/conflict/idempotency, không thêm dependency hay migration.

## Các bước TDD

1. Thêm test integration xác nhận nút có trạng thái đang lưu và hộp thoại vẫn mở trong khi write đang chờ.
2. Thêm test xác nhận phản hồi write thành công đóng hộp thoại và kết thúc thao tác trước khi request snapshot nền hoàn thành; snapshot sau đó vẫn cập nhật bảng và xóa draft.
3. Thêm test hồi quy để lỗi 4xx/5xx vẫn giữ hộp thoại/draft và hành vi retry hiện có.
4. Chạy test để thấy test mới thất bại vì save đang chờ full refresh và không có loading.
5. Sửa luồng lưu tối thiểu: trạng thái text/`aria-busy`/live status; PATCH áp row authoritative có version ngay sau 2xx; đóng ngay sau khi API write thành công; phát động refresh nền không await; giữ lỗi ở modal và phục hồi nút khi request dứt khoát thất bại. Không tự suy diễn row chuẩn từ kết quả bulk/plan thiếu rows.
6. Chạy test tích hợp Thu mua và các kiểm tra cú pháp/diff liên quan.

## Giới hạn đo lường

Thời gian đến phản hồi lưu vẫn phụ thuộc API/database/network và chưa được đo trên production. Thay đổi này loại bỏ việc chờ full snapshot sau write khỏi thao tác UI; nó không thể bảo đảm phản hồi mạng tức thời.
