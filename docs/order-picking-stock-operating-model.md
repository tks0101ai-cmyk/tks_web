# Chỉ định vị trí và tính tồn kho — mô hình vận hành đề xuất

Ngày 23/10/2026. Đây là nghiên cứu nghiệp vụ, chưa triển khai lên hệ thống thật hoặc thay đổi prototype.

> **Ghi chú 30/10/2026:** tài liệu nghiên cứu theo thời điểm 23/10/2026. Module `server/stockLocations/` (Vị trí HN/SG đọc Google Sheets, `stock_location_lines`) nhắc tới dưới đây đã bị gỡ; Vị trí hàng nay là VT Hà Nội / VT Sài Gòn (`stockPositions/`, bảng `stock_positions`, SL kho tính từ ghi chú thùng) và Chỉ định vị trí đã triển khai trên Vòng đời đơn hàng (`pickAssignments/`). Các đoạn mô tả "mã hiện tại" bên dưới là lịch sử, không phản ánh hiện trạng.

## 1. Dữ kiện mới quyết định cách thiết kế

Người dùng xác nhận số lượng trong tab Vị trí hiện là số nhập ban đầu hoặc số đã đi, chưa phản ánh tồn còn. Vì vậy số Sheet không phải số khả dụng để thuật toán sử dụng. Những tình huống prototype đã thử chứng minh công thức trên dữ liệu giả định là tồn còn, chưa chứng minh có thể áp dụng trực tiếp cho dữ liệu vận hành.

Mã hệ thống hiện cũng phản ánh hạn chế này: `stockLocationsService.js` đọc HN TỔNG SL, SG TỔNG SL đã đi; `sheetSnapshots/sync.js` đồng bộ dữ liệu định dạng và `stock_location_lines` dùng source_row. Không được đổi tên cột thành Tổng tồn rồi cộng các giá trị này để suy ra hàng còn. Số dòng Sheet không phải định danh vị trí lâu dài. Đồng bộ Sheet không được ghi đè sổ biến động vận hành mới.

## 2. Khởi tạo nguồn tồn đủ tin cậy

Đề xuất dùng Sheet làm danh mục/tham chiếu mã và vị trí; dùng DB hệ thống làm sổ số lượng vị trí và giữ chỗ dùng chung. Kiot tiếp tục là nguồn chứng từ bán hàng, nhập hàng, thanh toán và số liệu tổng để đối chiếu đúng phạm vi.

Cần một mốc khởi tạo T0 cho từng khu/mã được đưa vào vận hành: số đếm còn tại từng vị trí, số đang nhặt/chờ giao gắn đơn, hàng hỏng hoặc chưa được bán nếu có. Các đơn đã được nhặt trước T0 phải được ghi là hàng chờ giao hoặc giao dịch trước mốc, không nhặt trừ lại sau khi mở chức năng. Ghi người xác nhận và thời điểm.

Không cần kiểm đếm toàn bộ kho cùng lúc. Có thể đưa một nhóm mã/khu đã chốt số vào chạy trước. Mã/vị trí chưa được xác minh hiện rõ Chưa có tồn xác nhận, không tự gợi ý số có thể lấy từ số nhập đầu. Kế toán vẫn có thể xem vị trí tham chiếu; muốn giữ số lượng cần xác nhận tồn trước. Phần tổng chỉ bao gồm dữ liệu đã xác nhận phải ghi rõ Tổng đã xác minh, không gọi là tổng đầy đủ.

Nếu muốn tính ngược từ số nhập ban đầu, chỉ làm được khi có đủ mọi phát sinh theo đúng mã và vị trí: nhập thêm, xuất, chuyển, trả, hỏng/điều chỉnh. Hiện chưa có bằng chứng lịch sử đó đầy đủ, nên không chọn cách tính ngược làm nguồn khởi tạo mặc định.

## 3. Bốn số liệu khác nhau

- Tồn tại vị trí: số đang có theo sổ ở kệ/khu chứa.
- Đang giữ chỗ chưa nhặt: phần tồn tại vị trí đã cam kết cho các đơn.
- Khả dụng: phần hợp lệ của tồn tại vị trí chưa bị giữ hoặc tạm ngừng cấp. Chỉ tiêu này dùng gợi ý cho đơn mới.
- Đã nhặt chờ giao: hàng đã ra khỏi vị trí cũ, đang gắn với một đơn; chưa được cấp cho đơn khác.

Tồn vị trí = tồn chốt đầu + nhập vào vị trí + hàng trả thực tế về vị trí − nhặt khỏi vị trí − chuyển sang vị trí khác ± điều chỉnh được xác nhận. Chuyển vị trí cần cả dòng ra và dòng vào.

Với vị trí đang hoạt động và đã xác minh: khả dụng = tồn vị trí − giữ chỗ chưa nhặt. Với vị trí đang nghi thiếu/khóa: không cấp thêm từ vị trí đó; không được tự xóa giữ chỗ của các đơn đang xử lý. Hàng chờ giao không tham gia gợi ý.

Tổng hàng theo sổ trong cơ sở bao gồm vị trí, chờ giao và các khu hợp lệ khác, mỗi phần chỉ cộng một lần. Nhặt là chuyển nội bộ, không mặc định là bán/xuất khỏi cơ sở. Mốc xuất bán Kiot và mốc hàng rời kho cần được đối chiếu, không tự ép hai sổ bằng nhau ở mọi thời điểm.

## 4. Ví dụ để kiểm tra hai đơn không bị trừ kép

Giả sử tổng mã X ở các vị trí đã xác minh là 1.000; đơn A cần 100.

| Mốc | Tồn tại vị trí | Giữ chưa nhặt | Chờ giao | Khả dụng cấp mới |
|---|---:|---:|---:|---:|
| Ban đầu | 1.000 | 0 | 0 | 1.000 |
| Xác nhận chỉ định A:100 | 1.000 | 100 | 0 | 900 |
| Ghi thực nhặt đủ 100 | 900 | 0 | 100 | 900 |
| Xuất/giao 100 ra khỏi cơ sở | 900 | 0 | 0 | 900 |

Đơn B thấy khả dụng 900 ngay khi A xác nhận chỉ định. Khi A nhặt đủ thì B vẫn thấy 900, không bị giảm lần nữa. Tổng hàng vật lý trong cơ sở vẫn 1.000 sau nhặt; sau xuất mới là 900. In, in lại, mở đơn và tự điền ô nhập không tạo biến động.

## 5. Thuật toán gợi ý theo yêu cầu đã chốt

Đầu vào là số lượng còn cần của từng dòng và khả dụng thật tại các vị trí đúng mã, cơ sở/kho và đơn vị chiếc. Quy cách thùng nằm trong ghi chú hoặc danh mục quy đổi đã xác nhận; không tự dùng số thùng thay số chiếc.

Một vị trí đủ: chọn vị trí có khả dụng nhỏ nhất nhưng lớn hơn hoặc bằng nhu cầu. Ví dụ cần 30, có 20/35/100: chọn 35. Không dùng thứ tự vị trí ưu tiên hoặc khoảng cách. Bằng nhau dùng ID ổn định.

Không vị trí nào đủ: giữ cách hiện tại là lấy vị trí nhiều nhất trước rồi tính lại nhu cầu còn lại; đề xuất này cần chốt nếu muốn tối ưu tổ hợp. Ví dụ cần 100, các nơi 60/40/35 thì lấy 60+40. Không hứa thuật toán tham lam luôn cho phương án dư ít nhất trong mọi tổ hợp. Khi tổng chưa đủ, hiển thị phần chưa phân bổ, không chế ra số lượng.

Cho phép kế toán chọn thủ công trong lượng khả dụng. Khi xác nhận, máy chủ kiểm tra lại và ghi giữ chỗ trong cùng giao dịch. Hai kế toán cùng nhìn thấy 100 không có nghĩa cả hai đều giữ được 80: người xác nhận sau phải nhận số mới và chọn lại phần xung đột. Gợi ý chưa xác nhận không tự chiếm hàng. Cùng mã nhiều dòng phải dùng chung số khả dụng để không vượt tồn.

## 6. Nhặt thiếu có hai nguyên nhân, không xử lý giống nhau

Trường hợp giảm nhu cầu: vị trí A có 100, chỉ định 100, kế toán quyết định giao 80 và xác nhận 20 vẫn còn tại vị trí. Ghi nhặt 80, giải phóng 20 giữ chỗ. Phần 20 được cấp cho đơn khác nếu không có sự cố.

Trường hợp kho báo thiếu thực tế: vị trí A theo sổ có 100 nhưng chỉ tìm được 80 và báo hết. Sau nhặt, sổ còn 20 nhưng lượng thực tế này chưa đáng tin. Tạm ngừng cấp mới mã tại A, không đưa 20 vào gợi ý. Kiểm đếm xác nhận A còn 0 thì ghi điều chỉnh -20 có người chịu trách nhiệm; nếu còn hàng thì xác minh/mở lại với số đúng. Các vị trí khác vẫn hoạt động.

Nếu cả mã ban đầu có 1.000 (A:100, B:900), ở trường hợp giảm nhu cầu thì khả dụng còn 920; ở trường hợp A báo hết thì chỉ có B:900 đang đủ tin cậy để cấp mới. Không thể chỉ đọc giá trị 80 trong ô thực nhặt rồi biết trường hợp nào đã xảy ra.

Để giữ ít thao tác: đủ hàng tự điền như yêu cầu. Khi sửa giảm mới đề xuất một lựa chọn ngắn: Giảm số giao / Vị trí không đủ. Đây là đề xuất nghiên cứu, chưa được người dùng phê duyệt để thêm vào UI. Kho báo bằng phiếu giấy, kế toán là người ghi nhận; không yêu cầu nhân viên kho có thêm quy trình nhập phần mềm.

Phần thiếu của đơn và chênh lệch tồn vị trí là hai việc riêng. Đơn có thể lấy bù ở nơi khác hoặc giao theo số đã chốt; thiếu vật lý ở vị trí phải được đối chiếu. Không tự giảm số đặt gốc, không tự hủy phần chưa giao, không tự điều chỉnh tồn bằng số thiếu của đơn nếu chưa biết tồn thực của vị trí.

## 7. Sửa đơn, hủy và hoàn vị trí

- Chưa nhặt: tăng/giảm/hủy chỉ cập nhật phần giữ chỗ. Nếu tăng mà không đủ, giữ kết quả cũ và báo thiếu, không xóa trước để giữ lại sau.
- Đã nhặt: giữ lịch sử; nếu bớt hàng phải xác nhận trả thực tế vào vị trí hoặc chuyển sang đơn khác bằng giao dịch rõ ràng. Bớt số trên đơn không tự sinh hàng ở kệ.
- Đã xuất: dùng chứng từ trả/điều chỉnh, không hủy chỉ định để cộng tồn.
- Đổi mã/số lượng trên Kiot: phát hiện phiên bản mới, yêu cầu xác nhận lại phần bị ảnh hưởng; bảo toàn số thực nhặt đã ghi. Đổi ghi chú không nên tự hủy toàn bộ giữ chỗ.
- Giữ chỗ lâu: nhắc kế toán kiểm tra. Không tự hết hạn sau khi kho đã nhận phiếu và đang nhặt nếu chưa có chính sách được chốt.
- Nhập cùng số hai lần: cùng một kết quả không tạo biến động mới. Sửa số đã chốt cần ghi chênh lệch và lý do, không ghi đè lịch sử.

## 8. Kiot và nguồn tổng tồn

Cần xác minh riêng các chỉ tiêu Kiot: tồn thực, lượng đặt/giữ và lượng có thể bán; không dùng lẫn. Nếu Kiot đã giữ chính đơn này, lấy số có thể bán rồi trừ cùng giữ chỗ TOKOSI một lần nữa sẽ giảm kép. Đề xuất sổ vị trí dùng tồn vị trí đã chốt và giữ chỗ riêng, đối soát Kiot theo mã/cơ sở và cùng thời điểm.

Một sự kiện nhặt chỉ ghi một lần ở sổ vị trí. Giao dịch Kiot được ghép lại bằng ID chứng từ gốc, không trừ lần nữa khi đồng bộ về. Mốc Kiot ghi xuất và mốc hệ thống ghi hàng rời kho phải được xác định trước khi đặt công thức đối soát.

Nhập thêm hàng trên Kiot chưa cho biết hàng đặt ở vị trí nào. Để bổ sung khả dụng vị trí, cần phân vị trí nhập hoặc đưa vào khu Chưa phân vị trí, không tự cộng đều cho mọi nơi. Hàng về HN không được cộng vào SG. Tất cả số hiển thị theo đơn phải đọc cùng một sổ, không có bản tồn riêng theo từng đơn.

## 9. Khoảng cách giữa prototype và vận hành thật

Prototype đã minh họa best-fit, giữ chỗ chung, chuyển giữ chỗ sang số thực nhặt, tự điền ô số và chống ghi trùng trong cùng phiên. Nhưng dữ liệu khởi tạo đang giả định là tồn còn; sổ chỉ ở bộ nhớ; chưa chia sẻ nhiều máy; chưa có khu chờ giao, nhập vị trí/chuyển/hoàn đầy đủ hoặc cơ chế đối soát Sheet/Kiot.

Điểm cần sửa thiết kế: `simple-flow.js` coi mọi số thực nhặt là kết thúc tại vị trí, giải phóng phần chưa nhặt; chưa phân biệt giảm số giao với thiếu thực tế. `summary()` mới tính tổng trên kệ, không phải toàn bộ hàng trong cơ sở. Nút In đơn hiện vừa ghi kết quả vừa mở bản in; nên làm rõ mốc xác nhận kết quả ở cấp nghiệp vụ để việc xem/in lại không trở thành ghi kho ngoài ý muốn. Không tự thay UI hiện tại trong đợt nghiên cứu này.

## 10. Thứ tự thực hiện đề xuất

1. Chọn nhóm mã/khu thử; kiểm đếm tồn đầu, hàng đang giữ/nhặt và chờ giao tại T0. Tạo danh mục vị trí có ID bền vững.
2. Làm sổ dùng chung ở DB với giữ chỗ, nhặt ra chờ giao, nhập/hoàn/chuyển vị trí và lịch sử. Kiểm tra đồng thời và chống gửi trùng ở máy chủ.
3. Chạy luồng chỉ định/in/nhập số thực nhặt tối giản; chỉ hỏi xử lý ngoại lệ khi có lệch.
4. Đối soát với Kiot cùng mã/cơ sở/mốc chứng từ. Đánh giá lệch và sửa quy trình trước khi mở rộng thêm mã/khu.

Nghiệm thu: hai đơn trùng mã; hai người giữ đồng thời; đóng/mở trình duyệt không mất sổ; đầy đủ/một phần/0 thực nhặt; vị trí báo hết không được gợi ý lại; nhập thêm sau T0; chuyển/hoàn; đơn Kiot đổi sau in; in lại; đồng bộ trùng hoặc chậm; tồn chưa xác minh; hàng chờ giao không bị cấp cho đơn khác; nhặt không làm giảm tổng vật lý hai lần.

## Tham khảo

Đây là mô hình đề xuất riêng cho TOKOSI. Các nguyên tắc tách nhặt và giao, cùng xử lý nhặt thiếu được đối chiếu tài liệu chính thức:

- Odoo, Two-step receipt and delivery: https://www.odoo.com/documentation/16.0/applications/inventory_and_mrp/inventory/shipping_receiving/daily_operations/receipts_delivery_two_steps.html
- Microsoft Learn, Set up short picking item reallocation: https://learn.microsoft.com/en-us/dynamics365/supply-chain/warehousing/tasks/set-up-short-picking-item-reallocation
- Mã đã đọc: `server/stockLocations/stockLocationsService.js`, `server/sheetSnapshots/sync.js`, `server/db/migrations/0064_sheet_snapshots.sql`, `server/public/prototypes/order-picking/inventory.js`, `simple-flow.js`, `rules.js`.
