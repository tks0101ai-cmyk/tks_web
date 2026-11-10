# Báo cáo kiểm thử Thu mua — 07/11/2026

Nhánh: `feat/purchase-workspace-20261107`. Chưa merge `main`, chưa deploy, chưa áp migration lên production.

## Phạm vi và tiêu chí nghiệm thu

| ID | Chức năng | Ca kiểm thử bắt buộc | Kết quả |
|---|---|---|---|
| TM-01 | Tổng tệ | Tổng SL × Giá tệ; VC trước trống = 0, có số dương/âm thì cộng đúng; thiếu số lượng/giá vẫn báo thiếu | Đạt: helper, SQL, export và đối soát dùng cùng quy tắc; trình duyệt 600/595 đúng khi VC trống/−5. |
| TM-02 | Hoàn tác ô | Gõ nhiều ký tự → một lần hoàn tác về giá trị trước khi sửa; hai ô/hai lần sửa là hai bước | Đạt: gõ 12345 → hoàn tác một lần về 10; 9 test helper và hồi quy giao diện. |
| TM-03 | Nét số | Số liệu dùng nét thường ở sáng/tối, không thay đổi giá trị lưu | Đạt kiểm tra cục bộ: số/input font-weight 400 ở sáng/tối; giá trị giữ nguyên. |
| TM-04 | Danh sách NV riêng | Thêm, sửa, ngừng dùng tên; chọn NV từ danh mục Thu mua; không đọc danh bạ HR hoặc cho nhập tên tùy ý trên dòng | Đạt CRUD/quyền/legacy tự động và thêm NV trên trình duyệt; đã chặn phiên bản cũ trong modal bằng snapshot danh mục lúc mở. |
| TM-05 | Màu cảnh báo | Độ lệch tuyệt đối >10% đỏ chữ, ≤10% xanh chữ; VC trước âm đỏ chữ; không tô nền đỏ | Đạt: ±10% xanh, ±11% đỏ qua test; +20% đỏ, 0% xanh và VC −5 đỏ chữ/nền trong suốt trên trình duyệt. |
| TM-06 | Thứ tự chờ xếp | Nhóm chờ xếp luôn ở đầu khi sắp theo mã, ngày và tiêu đề cột, kể cả có dòng tách | Đạt tự động mọi kiểu sort; trình duyệt nhóm chưa gán cont đứng trước các dòng có cont. |
| TM-07 | Thêm mã | Thêm/reorder luôn vào cont chờ xếp, bất kể đang ghim/lọc cont nào | Đạt: thêm mới khi đang ghim vẫn contId rỗng; reorder/plan/import được kiểm tra tự động. |
| TM-08 | Đồng bộ nhiều người | Cập nhật hiện ở phiên khác khi người đó đang gõ; không mất bản nháp; xung đột cùng ô không bị ghi đè | Đạt hai phiên dữ liệu giả lập: cập nhật khác ô, giữ bản nháp/con trỏ; cùng ô hiện đối chiếu và không ghi đè. |
| TM-09 | Mất kết nối | Kết nối lại lấy đủ thay đổi, không để phản hồi cũ ghi đè phản hồi mới; đóng phiên dọn kết nối | Đạt tự động reconnect, revision, listener cleanup và pagehide; đã ngắt server thử qua trình duyệt: báo mất kết nối, giữ nháp/focus; tự nối lại và nhận cập nhật mới. |
| TM-10 | Chỉnh chỉ số cont | Sửa tên, xe, lịch, nhà VC, người xếp, cont TQ, cước và sức chứa; số tổng hợp vẫn chỉ đọc | Đạt API và payload ngày/version; trình duyệt sửa tên/nhà VC được; đã giữ mốc phiên bản tiền VC lúc bắt đầu sửa, kể cả cont ghim. |
| TM-11 | Tác động xuống mã | Tên/trạng thái cont phản ánh trên mọi mã; thay cước đổi giá NET; ngày dùng chung lan truyền đúng, có audit và chặn phiên bản cũ | Đạt SQL: ngày lan truyền nguyên tử và xung đột rollback; trình duyệt đổi tên phản ánh cả sáu dòng thuộc cont ở phiên khác. |
| TM-12 | Bảng trạng thái | Đủ 5 nhóm: chờ xếp, chưa có lịch, chưa bốc, đã bốc, đã về; hiển thị chỉ số và bấm để lọc | Đạt: đủ 5 nhóm; test toggle/lưu bộ lọc; trình duyệt chờ xếp lọc đúng hai dòng và bỏ lọc được. |
| TM-13 | Bố cục | Bỏ dashboard tổng hợp; chỉ số cont nằm dưới đặt hàng; cont ghim nằm trên bộ lọc | Đạt DOM và giao diện hẹp: bảng chỉ số sau phân trang, ghim trước bộ lọc, không có dashboard cũ; desktop chưa xác minh. |
| TM-14 | Bảo toàn thao tác | Tách dòng, nhập biểu thức, dán, sort toàn bộ trước phân trang, import/export và lưu có xác nhận | Đạt hồi quy tự động; trình duyệt biểu thức (10×20×30)/1000000 = 0.006, tổng tệ = 1.200, thêm và hoàn tác đúng. |

## Bằng chứng thực chạy

- Toàn bộ `server/purchaseOrders/*test.js`, `server/public/shared/purchase-*.test.js` và `server/db/ensurePurchaseSchema.test.js`: **251/251 đạt**, 0 bỏ qua. Log: `.codex_tmp/workspace-all-final.log`.
- Sau khi thêm các ca board/pin/NV/biên màu, khóa phiên bản và focusout, chạy lại Live + RealtimePage: **69/69 đạt**. Log: `.codex_tmp/workspace-ui-final.log`. Hai lượt có phạm vi trùng nhau, không cộng số ca.
- Helper lịch sử/cont/realtime và SSE SQL: **26/26 đạt**. Log: `.codex_tmp/workspace-helpers-final.log`.
- Đối soát + công thức: sub-agent xác nhận **37/37 đạt**; lỗi VC trống tại đường đối soát đã sửa bằng helper chung.
- Test dùng biến môi trường giả `GOOGLE_SERVICE_ACCOUNT_JSON={}`, `JWT_SECRET=test-secret`; SQL dùng PGlite trong bộ nhớ, không ghi database thật.
- `node --check purchase.js`, kiểm tra cú pháp các mô-đun bởi sub-agent và `git diff --check` đạt; có cảnh báo LF/CRLF của Git.

## Kiểm tra hai phiên và trực quan

Dùng đúng HTML/CSS/JS đang sửa tại `http://127.0.0.1:4321/thu-mua/dat-hang/`, hai tab IAB độc lập, dữ liệu tổng hợp trong server thử `.codex_tmp/purchase-workspace-browser.cjs`. API/SSE của lượt trình duyệt được giả lập; không coi đây là kiểm chứng triển khai SSE nhiều instance thật. SQL, transaction và SSE backend được kiểm tra riêng bằng test tự động.

1. A nhập “Bản nháp A” vào NCC; B lưu tên sản phẩm ở dòng khác: A nhận tên mới, giữ NCC, focus và con trỏ.
2. B lưu NCC cùng ô: A giữ bản nháp, ô có class conflict và tiêu đề giá trị mới; bấm lưu hiện bảng đối chiếu, lưu 0 dòng.
3. A chỉ mới chọn ô, B sửa ô đó; A tiếp tục gõ: bảng đối chiếu vẫn ghi giá trị NCC ban đầu, không lấy phiên bản mới làm mốc cũ.
4. Gõ số thùng 12345 rồi hoàn tác: về 10 trong một lần.
5. Nhập giá `(10 * 20 * 30) / 1000000`: hiển thị 0.006, tổng tệ 1.200 cho 200 sản phẩm.
6. Thêm NV trong danh mục: xuất hiện trong SELECT cột NV; không phải ô nhập tên tự do.
7. Đang ghim cont, thêm mã: mã mới thuộc chờ xếp, trước nhóm có cont.
8. Bấm thẻ chờ xếp: chỉ hai dòng chưa gán; bấm lại bỏ lọc.
9. Sửa tên cont thành 12-7V và nhà VC: phiên khác cập nhật cả sáu mã thuộc cont.
10. Ngắt server thử khi B đang gõ: hiển thị mất kết nối, giữ nháp; chạy lại server với revision tăng, B tự kết nối, nhận thay đổi dòng khác do A lưu và vẫn giữ nháp.
11. Computed style: âm VC chữ đỏ, nền trong suốt, số weight400 ở sáng/tối; cân đo +20% đỏ, 0% xanh; Mã SP display table-cell, padding2px, animation none.

Ảnh bằng chứng nằm tại `C:/Users/Admin/.codex/visualizations/2026/11/06/01a1af8e-12a1-7cc1-abfd-a588c0bd5256/`: `purchase-workspace-conflict.png`, `purchase-workspace-light.png`. Các ảnh có tên desktop được chụp khi override không có hiệu lực: viewport đo thực tế 707px, không dùng làm bằng chứng desktop. Chrome extension không mở được tab kiểm thử; chưa xác nhận 1600px hoặc trình duyệt khác.

## Rà soát độc lập

Phát hiện hai lỗi cần thêm test sau lượt xanh ban đầu: tiền VC dùng version cont mới trong lúc ô đang sửa; danh mục NV dùng version mới với ô tên cũ trong modal. Đã sửa cả hai. Bốn test hồi quy tái hiện thất bại trước sửa và đạt sau sửa: tiền VC bảng/ghim giữ version ban đầu; rename/toggle NV giữ version modal. Reviewer xác nhận cả hai đã xử lý; lượt toàn phần sau tất cả sửa đổi đạt251/251. Browser phát hiện thêm input cont dựng lại sau refresh không phát native change khi Tab ra. Đã sửa focusout thật, bỏ qua node tách khỏi DOM, chống gửi trùng native change/focusout; thêm năm test. Kiểm tra hai phiên sau sửa: local123 / remote888, Tab gửi version cũ → báo “Thông tin cont đã thay đổi.”, local123 còn giữ, remote888 không bị ghi đè.

## Trạng thái cuối và điều kiện trước merge

Mã đã tích hợp, các lỗi phát hiện trong vòng này đã sửa; lần chạy cuối251/251 đạt, không bỏ qua. Hai phát hiện khóa phiên bản đã được reviewer xác nhận xử lý; lỗi focusout phát hiện sau đó đã có hồi quy và được kiểm tra lại trên hai phiên trình duyệt. Các giới hạn desktop/môi trường thật và graphify ở trên vẫn chưa được xác minh. Không coi251 test là xác nhận production hoặc người dùng đã nghiệm thu; chưa merge/deploy.

## Checklist trước merge

- Đọc lại thay đổi của từng sub-agent và giải quyết xung đột tích hợp.
- Chạy các kiểm thử liên quan, đối chiếu từng tiêu chí trong bảng.
- Kiểm tra trực quan sáng/tối, cuộn ngang, thao tác bàn phím và hai phiên làm việc.
- Ghi rõ migration mới, dữ liệu cũ, quyền truy cập và các trường hợp chưa kiểm được trên production.
- Báo cáo này phải có kết quả thật trước khi merge vào `main`.

Cập nhật cuối: 07/11/2026.

### Lệnh tái chạy toàn bộ (PowerShell tại thư mục repository)

```powershell
$env:GOOGLE_SERVICE_ACCOUNT_JSON='{}'
$env:JWT_SECRET='test-secret'
$allPurchase=Get-ChildItem server/purchaseOrders/*test.js | ForEach-Object FullName
$sharedPurchase=Get-ChildItem server/public/shared/purchase-*.test.js | ForEach-Object FullName
node --test --test-concurrency=1 $allPurchase $sharedPurchase server/db/ensurePurchaseSchema.test.js
```

`graphify update .` đã thử nhưng thất bại do lệnh không có trong môi trường hiện tại. Đồ thị chưa được cập nhật; không ghi nhận bước này đạt.
