# Nghiên cứu Kiểm kê → bài học cho bảng Thu mua

Ngày: 10/11/2026. Nguồn: checkout hiện tại trên nhánh feat/purchase-workspace-20261107, nền main a13213e4 và thay đổi Thu mua cục bộ. Phạm vi: đọc mã và chạy test, không sửa chức năng, không deploy, không truy cập dữ liệu production.

## Kết luận

Kiểm kê có trải nghiệm bảng kiểu spreadsheet hoàn chỉnh hơn và có các biện pháp giảm tải đáng học. Thu mua hiện có lớp bản nháp, xử lý mất phản hồi và đồng bộ giữa instance tốt hơn ở một số mặt. Nên tái sử dụng quy tắc tương tác và điều phối tải, không thay toàn bộ cơ chế Thu mua bằng Kiểm kê.

## 1. Kiểm kê đang hoạt động thế nào

| Phần | Cách triển khai thực tế | Nguồn |
|---|---|---|
| Ghi và lịch sử | Ghi trong transaction, khóa bản ghi/phạm vi phiên; COMMIT rồi invalidation cache và phát sự kiện | stocktakeService.js:293, :320, :331 |
| Sửa nhiều ô | POST /cells nhận code, column, value và expected. Ô xung đột bị bỏ qua; ô hợp lệ vẫn ghi. Trả applied/conflicts/skipped cùng note/tag và version mới | stocktakeService.js:835; stocktake.js:899 |
| Sửa dòng đếm | Kiểm version, lỗi409 trả latest và tên người sửa; client xếp các lần lưu nối tiếp, nhớ version vừa trả về | stocktakeService.js:244, :664; stocktake.js:1619 |
| Đồng bộ | SSE theo sessionId, chỉ truyền tín hiệu và mã tab by; bỏ qua sự kiện do chính tab tạo | stocktakeEvents.js; stocktakeRoutes.js:80; stocktake.js:190 |
| Giảm tải phía client | Gộp sự kiện, khoảng cách tải3giây, không chồng lượt, có lượt cuối. Tab ẩn chỉ đánh dấu dirty; hiện lại mới tải | stocktakeGrid.js:187; stocktake.js:75, :201, :2143 |
| Dữ liệu phụ | Order-status hỏi mỗi30giây khi đợt mở và tab hiện. Revision đơn đổi mới tải lại bảng. Status-load chậm không chặn bảng | stocktake.js:151, :215, :243 |
| Chống phản hồi cũ | loadVersion tăng mỗi lần tải; phản hồi không thuộc lượt mới nhất không áp dụng | stocktake.js:153 |
| Giảm tải phía server | getBoard kiểm quyền mỗi request, gộp phần tính đang chạy theo session/version. Không giữ kết quả board sau khi hoàn tất | stocktakeService.js:597; test singleflight tại stocktakeService.test.js:875 |
| Cập nhật sau lưu | Áp kết quả máy chủ vào dòng ngay; chỉ tải toàn bảng khi xung đột hoặc sửa trường làm đổi công thức tổng hợp | stocktake.js:885, :899, :930 |
| Giữ vị trí thao tác | Tải nền giữ thứ tự mã và số dòng đã vẽ; mã mới nối sau. Dòng đếm giữ input và con trỏ qua render | stocktake.js:455, :510, :1424 |
| Tương tác bảng | Chọn một ô/vùng, Shift mở vùng, kéo chọn và tự cuộn ở mép, F2/Enter sửa, Escape bỏ, Delete xóa vùng; editor nổi riêng | stocktake.js:737, :806, :1013 |
| Copy/dán/kéo điền | Parse TSV có quoted tab/newline; dán theo vị trí hoặc mã; dán một giá trị cho cả vùng; kéo lặp mẫu; bỏ cột ẩn | stocktakeGrid.js:16, :41, :91, :130 |
| Hoàn tác | Một thao tác gồm nhiều ô là một bước. Undo là yêu cầu ghi ngược lên máy chủ, expected bằng giá trị sau thao tác, tránh ghi đè người khác | stocktake.js:986 |
| Hiệu năng vẽ | Vẽ200 dòng đầu, thêm từng đợt200 khi cuộn. Đây là vẽ tăng dần, không phải virtualization loại bỏ dòng cũ | stocktake.js:9, :510, :553 |

## 2. Đối chiếu với Thu mua hiện tại

| Nội dung | Kiểm kê | Thu mua | Rút kinh nghiệm |
|---|---|---|---|
| Khi nào lưu | Xác nhận ô/dán/kéo là lưu ngay | Đa số ô vào bản nháp, bấm Lưu + xác nhận; thông tin cont/NV có đường lưu riêng | Giữ mô hình bản nháp hiện tại; chưa đổi sang auto-save nếu chưa có yêu cầu |
| Khác ô cùng dòng | /cells so expected từng ô | update/bulkEdit đã có before theo trường khi row version đổi; plan và cont cần snapshot nghiêm ngặt | Thu mua đã có nền phù hợp; không gọi mọi chênh version là xung đột |
| Cùng ô | Bỏ ô xung đột và hiện giá trị máy chủ | Giữ bản nháp, bảng đối chiếu lựa chọn rồi xác nhận | Giữ cách Thu mua, phù hợp dữ liệu mua hàng/tiền |
| Tải sau sự kiện | Throttle3giây, tab ẩn không tải board, bỏ sự kiện bản thân | Coordinator nối tiếp và gộp pending, nhưng chưa có khoảng chờ/visibility gate; ready/changed/poll đều refresh | Bổ sung điều phối giảm tải, không bỏ coordinator giữ focus/baseline |
| Nguồn đồng bộ giữa instance | Bus EventEmitter trong process | Bus cộng kiểm fingerprint history trong DB mỗi3giây | Giữ kiểm revision DB của Thu mua; không quay về bus nội bộ đơn thuần |
| Gửi lại khi mất phản hồi | Đường /cells được đọc không có khóa idempotency tương đương | Idempotency-Key, purchase_requests, outbox trong sessionStorage và nút kiểm tra lần lưu | Giữ Thu mua; không đánh đồng mất phản hồi với chưa ghi |
| Giữ bản nháp qua reload | Không thấy cơ chế bản nháp phiên tương đương ở luồng ô chính | sessionStorage giữ drafts, history, outbox | Giữ Thu mua; sessionStorage chỉ trong phiên tab, không phải bảo đảm tồn tại sau mọi lần đóng trình duyệt |
| Giữ editor khi vẽ lại | Bảng chính dùng editor overlay tách khỏi tbody; dòng đếm có guard drawingLines và so dataset.saved | Khôi phục input/focus/caret, giữ baseline; cont có focusout riêng tránh mất native change | Học overlay cho ô đang sửa, đặc biệt tránh tiếp tục chồng nhiều handler |
| Chọn vùng | Có range anchor/focus, copy, fill, tổng/đếm/trung bình vùng | Có ô neo dán, mũi tên/F2 và chọn hàng hàng loạt; chưa có cùng lớp chọn vùng | Đây là phần UX nên bổ sung rõ nhất |
| Khóa nhận diện dòng | Bảng tổng hợp theo product code | Một mã SP có nhiều dòng/cont và dòng tách | Dán theo khóa dòng rowKey/id; không dùng productCode đơn thuần |
| Sắp xếp | Cả danh sách trước vẽ, nền giữ thứ tự để không nhảy | Đã lấy multi-sort từ main; sort trước phân trang, chờ xếp ưu tiên | Giữ chờ xếp trước và anchor theo id/field khi nhận dữ liệu mới |
| Bảng lớn | Tải board đầy đủ, vẽ tăng dần | Tải rows đầy đủ, vẽ50 dòng/trang | Không bỏ phân trang để bắt chước; chọn theo dữ liệu đo thật |

## 3. Những điểm không nên sao chép nguyên trạng

1. SSE Kiểm kê dùng bus nội bộ process; heartbeat chỉ giữ kết nối. Poll order-status đo revision đơn TEAM, không phải revision mọi chỉnh sửa note/tag. Từ mã này chưa có cơ sở khẳng định mọi thay đổi đều lan giữa nhiều instance hoặc sau sự kiện SSE bị lỡ.
2. /cells cho phép thiếu expected và khi đó không so giá trị cũ. Thu mua nên tiếp tục yêu cầu baseline/version cho ghi có xung đột, đặc biệt tiền và cont.
3. Dòng đếm Kiểm kê giữ chữ/con trỏ nhưng snapshot focusedLineInput không giữ version ban đầu; render tạo closure từ line mới và sendLine dùng version lớn hơn đã biết. Có nguy cơ baseline cũ bị thay sau remote refresh. Đây là nhận định từ mã, chưa có ca hai phiên tái hiện trong lượt này; không coi là lỗi đã chứng minh.
4. Khi sendCells lỗi mạng, Kiểm kê báo lỗi rồi tải bản máy chủ. Thu mua nên giữ bản nháp/outbox và kiểm tra kết quả idempotent; không tải đè rồi bỏ phần người dùng vừa gõ.
5. Undo Kiểm kê là ghi DB; undo bản nháp Thu mua cần tiếp tục là thay đổi local. Phần hoàn tác dữ liệu đã lưu phải là luồng riêng có xác nhận.
6. Dán theo mã của Kiểm kê có heuristic nhận diện mã, bỏ mã thiếu và lấy dòng cuối cho mã trùng. Thu mua có nhiều dòng cùng sản phẩm nên phải xem trước và định danh rowKey, tránh sửa nhầm cont.

## 4. Việc nên làm cho Thu mua, theo ưu tiên

### Ưu tiên1 — giảm tải và không chặn bảng

- Thêm throttle trailing + visibility gate quanh refresh tự động; giữ reconnect/focus/baseline hiện có. Phản hồi một lượt đang chạy không được liên tục bị bỏ đến mức bảng không bao giờ render khi sự kiện đến dày.
- Không để /employees chậm chặn snapshot bảng. Hiện fetchSnapshot chờ Promise.all cả rows và directory; nên áp rows trước, danh mục cập nhật riêng, giữ phiên bản modal đang mở.
- GET list Thu mua hiện chưa trả revision, nên nhánh so revision của coordinator chưa bảo đảm được từ snapshot thực. Cần thống nhất revision trong snapshot với tín hiệu DB; không chỉ thêm so sánh chuỗi hoặc max(id) đơn thuần.
- Chỉ tải lại khi revision đổi; bỏ/gộp sự kiện tự phát sau khi đã áp kết quả lưu. Cần bổ sung mã tab ở request/event, không chỉ mã người dùng.
- Giảm timer DB theo số tab: hiện mỗi connection Thu mua gọi presence upsert, cleanup, roster và history fingerprint mỗi3giây. Có thể gộp kiểm fingerprint/roster theo process, giữ presence và phạm vi quyền đúng; đây là cơ hội giảm tải, chưa phải benchmark DB.

### Ưu tiên2 — tương tác ô nhất quán

- Tách phần chọn ô/editor/phím/copy-paste thành một module có API rõ; có thể chia sẻ các hàm thuần, không chia sẻ quy tắc nghiệp vụ.
- Chọn vùng, Shift, kéo điền, thanh đếm/tổng/trung bình vùng; F2 là sửa, Enter/Tab là kết thúc một lần sửa, Escape trả ô về giá trị đầu lần sửa.
- Parse TSV có dấu ngoặc kép; dán theo rowKey; trước khi ghi bản nháp phải báo ô không sửa được, cột tính, NV dropdown và các dòng không khớp.
- Anchor theo id/field thay cho chỉ số DOM; snapshot selection/filter/sort không bị thay khi remote thêm, xóa hoặc đổi cont. Chờ xếp vẫn đứng đầu theo yêu cầu.

### Ưu tiên3 — tải nhanh và quan sát được

- Áp kết quả lưu trả về thay vì mọi lần đều tải toàn bộ bảng và danh mục; chỉ tải lại khi phép tính liên quan hoặc cấu trúc cont thực sự đổi.
- Đo thời gian API, render, số query và kích thước payload với số dòng/số người dùng thực trước khi đổi pagination/rendering.
- Giữ transaction + audit + idempotency và kiểm cả version cont lẫn thành viên dòng khi sửa ngày dùng chung.

## 5. Ca nghiệm thu cần có trước khi áp dụng bài học

| Tình huống | Điều kiện đạt |
|---|---|
| 100 sự kiện cập nhật liên tiếp | Request được gộp, có lượt cuối, giao diện vẫn cập nhật; không tạo100 full reload |
| Snapshot mất5giây, sự kiện mỗi3giây | Có dữ liệu được render, không bỏ phản hồi mãi |
| Tab ẩn nhận20 thay đổi | Không tải board liên tục; hiện tab tải đủ trạng thái mới một lượt |
| Danh mục NV phản hồi chậm10giây | Bảng hàng vẫn hiện trước, giá trị dropdown hiện hành và modal version giữ đúng |
| Hai người khác ô/cùng ô | Khác ô lưu được; cùng ô không tự ghi đè; giữ nháp và mốc cũ |
| Nhận SSE khi đang gõ rồi Tab | Không mất giá trị/caret; commit đúng một lần với baseline ban đầu |
| Mất phản hồi sau COMMIT | Gửi lại cùng khóa chỉ tạo một thao tác; không tạo mã mới hai lần |
| Dán hai mã SP giống nhau khác cont | Chỉ sửa dòng được định danh rowKey, không tự đoán productCode |
| Remote thêm/xóa/sort | Ô đang chọn và vùng chọn gắn đúng dòng; chờ xếp giữ ưu tiên |
| Undo vùng dán | Một lần hoàn tác trả toàn bộ vùng về trước thao tác; không đổi dữ liệu đã lưu của người khác |

## Kiểm chứng và giới hạn

Đã đọc mã frontend, service, routes, realtime và test của cả hai module. Đã chạy nhóm stocktakeGrid, stocktakeInteractions, stocktakeRoutes, stocktakeService, purchase-realtime và purchaseOrdersRealtime.integration: **115/115 đạt**, không thất bại, không bỏ qua (78.276 giây theo runner). SQL dùng môi trường test/PGlite, biến môi trường giả. Log: .codex_tmp/stocktake-purchase-research-20261110.log. Chưa thử load test nhiều người, chưa truy cập production. Các mục ưu tiên là đề xuất, chưa được triển khai trong lượt nghiên cứu này.

Cập nhật cuối: 10/11/2026.
