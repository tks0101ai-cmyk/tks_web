# Prototype: Vòng đời đơn hàng → Chỉ định vị trí

> **Cập nhật 27/10/2026:** tính năng này nay đã có **bản thật** trên trang Vòng đời đơn hàng `/shipment/lifecycle/` (nhánh `feat/lifecycle-pick-assign`: migration `0096`, module `server/pickAssignments/`, API `/api/shipment/pick`, giao diện `public/shipment/lifecycle/pick/`, quyền `shipment.pick`). Bản thử này **giữ làm demo** (đơn demo, bộ nhớ phiên, không ghi DB); mọi mô tả “chưa có API ghi / chưa nối Vị trí hàng thật” bên dưới chỉ đúng với bản thử. Chạy lại `node prototype-build.cjs` mỗi khi `public/shipment/lifecycle/index.html` đổi.

## Thùng, ST và trạng thái nhặt (26/10/2026) — thay thế mọi mô tả cũ về SL, tồn và trạng thái bên dưới

Phạm vi: chỉ prototype chạy trên trình duyệt (bộ nhớ phiên), không DB/API, chưa nối trang Vị trí hàng thật.

### Ghi chú hàng hóa là nguồn SL
- Quy cách: `<số thùng>T x <SL/thùng>`, ví dụ `5Tx100` = 500. Chịu T/t, dấu x hoặc * hoặc ×, khoảng trắng. **Số thùng và SL/thùng phải là số nguyên dương** (`0.5Tx100`, `0Tx50` không hợp lệ).
- Dấu phẩy cũng nối nhiều quy cách như `+` khi đứng ngay sau SL/thùng của số hạng trước: `9tx14, 5tx 14` = `9tx14,5tx14` = 196 (vẫn cảnh báo nhiều quy cách). Dấu phẩy thập phân (`0,5Tx100`) không bị tách. Khi ghi lại ghi chú sau trừ thùng, dấu nối được chuẩn hóa thành ` + `. `2X20` (thiếu chữ T), `1t`, `1b*200`, `1tx40 + 1t39` vẫn sai định dạng.
- Dấu nhân giữa thùng và SL/thùng là x, X, * hoặc × và tùy chọn khi có khoảng trắng: `1t 11` = `1t x 11` = `1T*11` (bắt buộc có chữ T; `1t11` cũng hợp lệ (= 11 chiếc); `1t`, `2X20`, `1b*200` vẫn sai định dạng).
- **Chuẩn hóa khi lưu** (sửa tại chỗ, nhập tay, import, và khi hệ thống ghi lại sau trừ): ghi chú đọc được về `<thùng>T x <SL/thùng>`, nhiều quy cách nối ` + `, trừ lẻ ` - N`, T hoa, c thường (`1t 11`, `1T X 11`, `1t*11` → `1T x 11`; `9tx14,5tx 14` → `9T x 14 + 5T x 14`). Ghi chú sai định dạng giữ chữ người dùng gõ, chỉ cắt đầu/cuối và gộp khoảng trắng liên tiếp; rỗng giữ rỗng. Chuỗi chỉ khác khoảng trắng thì không ghi lịch sử thừa; hoàn tác vẫn khôi phục đúng chuỗi đã lưu.
- Số hạng cùng SL/thùng được gộp thành một khi đọc và khi chuẩn hóa (cộng thùng, thứ tự theo lần xuất hiện đầu tiên): `9tx14, 5tx 14` → `14T x 14`, `1Tx50 + 2Tx25 + 1Tx50` → `2T x 50 + 2T x 25`; phần trừ lẻ giữ ở cuối. Cảnh báo nhiều quy cách tính sau khi gộp nên `14T x 14` không còn cảnh báo.
- Hậu tố `c` (cái) sau SL/thùng chỉ là đơn vị: `1T x 50c`, `5Tx100c`, `1Tx50c + 2Tx25c - 30` (c hoa/thường, có hoặc không khoảng trắng; 50c = 50). Khi trừ thùng, mỗi số hạng giữ hậu tố c như đã nhập; phần trừ lẻ ` - N` thêm mới luôn không có c (cách đơn giản nhất, không đoán phong cách).
- **Ghi chú rỗng (kể cả chỉ có khoảng trắng) là hợp lệ: SL 0, không cảnh báo**, nhưng chưa có hàng nên không chỉ định nhặt được (như hết hàng). Ghi chú có chữ mà sai định dạng (vd `abc`) vẫn cảnh báo.
- Một khu có thể nhiều quy cách nối bằng dấu +: `1Tx50 + 2Tx25` = 100 (ngoại lệ vẫn tính SL, nhưng dòng bị cảnh báo). Có thể kèm phần trừ lẻ `- N` ở cuối: `1Tx50 + 2Tx25 - 30` = 70.
- SL của một vị trí **luôn suy ra từ ghi chú**, kể cả khi import. Cột Số lượng của file kiểm kê chỉ là dự phòng cho dòng chưa có ghi chú đọc được (khi đó dòng vẫn bị cảnh báo). Số "khả dụng" trong JSON dữ liệu thử không còn là nguồn chính.
- Mỗi (cơ sở, mã hàng, khu) có một ghi chú. Cùng một mã ở nhiều khu và ở cả HN lẫn SG đều được; các khu khác nhau được khác quy cách (A01 là 1T x 50, B02 là 1T x 60). Đơn thuộc cơ sở nào chỉ tìm và chỉ định vị trí của cơ sở đó. Hai dòng kiểm kê cùng mã + vị trí được gộp: cùng SL/thùng thì cộng thùng, khác SL/thùng thì thành nhiều quy cách.
- Ghi chú `Hết hàng` nghĩa là SL 0 (do hệ thống ghi khi nhặt hết), không cảnh báo. Hệ thống **không bao giờ tự sinh số thùng thập phân**.

### Trừ hàng và hoàn tác
- Xác nhận nhặt: SL nhặt khớp trọn số thùng của một quy cách (và chưa có phần trừ lẻ) thì giảm số thùng của quy cách đó (200 từ `5T x 100` còn `3T x 100`; về 0 thì bỏ số hạng, hết sạch thì `Hết hàng`). Không khớp thì ghi vào phần trừ lẻ: `1Tx50` nhặt 25 thành `1T x 50 - 25` (SL còn 25); bốc 30 từ `1Tx50 + 2Tx25` thành `... - 30` (SL 70). Đã có phần trừ lẻ thì mọi lần bốc sau cộng dồn vào đó (`- 30` rồi bốc 25 thành `- 55`).
- Hủy nhặt hoặc chỉ định lại sau Xác nhận hoàn tác đúng chuỗi ghi chú trước đó (lưu theo từng nhiệm vụ nhặt, không suy ngược). Nếu vị trí đã bị đơn khác đổi tiếp thì cộng trả lại số đã nhặt thay vì ghi đè.

### Trạng thái của CẢ ĐƠN
- Chỉ định xong (Xác nhận & In phiếu nhặt) → **Đang nhặt**: giữ chỗ như đơn treo, tổng SL chưa đổi, "Nhặt được" = tổng − đang nhặt.
- **Xác nhận nhặt** trừ thùng thật; **Hủy nhặt** trả giữ chỗ (đơn đã Xác nhận cũng Hủy nhặt được = hoàn tác). Cả Xác nhận nhặt và Hủy nhặt đều cho **Chỉ định lại** (sau Xác nhận phải bấm hai lần để hoàn tác số thùng).
- Popup có chip trạng thái và nút Xác nhận nhặt / Hủy nhặt / Chỉ định lại; chi tiết đơn có chip "Đã chỉ định · trạng thái". Danh sách Vòng đời có chip lọc **Đang nhặt / Xác nhận nhặt / Hủy nhặt** kèm số đơn (lọc ở máy khách trên trang đang hiển thị; số đếm tính trên mọi đơn đã chỉ định trong phiên).

### Gợi ý và cột ST
- Mặc định: nếu có tổ hợp thùng nguyên cộng đúng SL cần thì dùng (ít vị trí nhất); không có thì làm tròn lên thùng nguyên (ví dụ cần 100 từ 1T x 50 và 1T x 60 → 50 + 60 = 110, ST 2). Người dùng sửa SL từng khu; bước ± theo thùng; SL thực nhặt được vượt SL cần nhưng ít hơn một thùng.
- **ST** = SL nhặt / SL mỗi thùng, cộng theo khu. Với khu nhiều quy cách: thùng nguyên theo từng quy cách, phần lẻ chia SL/thùng của số hạng đầu (giả định, chưa được người dùng xác nhận). ST lẻ (vd 25 từ 1T x 50 = 0.5) hiện **đỏ**.
- ST nằm ngay bên phải cột SL ở popup, bảng Hàng hóa trong đơn của chi tiết đơn và phiếu in (9 cột). Trống khi chưa chỉ định hoặc dòng chưa đủ SL phân bổ (giả định "khớp" = SL phân bổ ≥ SL đơn và `R.validate` đạt); trống lại sau Hủy nhặt, giữ số sau Xác nhận nhặt; phiếu in lấy từ record chỉ định nên in lại ra cùng số. Cột SL vẫn là SL đơn đặt; SL thực nhặt ở cột Thực tế nhặt của phiếu. Định dạng số en-US (0.5).

### Sổ vị trí (nút "Sổ vị trí" ở banner)
- Hai tab Vị trí HN / Vị trí SG: Tổng SL (kèm "Đang nhặt X" và "Nhặt được Y"), ô sửa ghi chú tại chỗ (SL nhảy theo), bộ lọc **Cảnh báo (n)** (đếm riêng từng tab) và nút **Lịch sử chỉnh sửa**.
- Dòng cảnh báo bôi đỏ cả dòng (class `.loc-warning`, kèm `.loc-multi-spec` cho nhiều quy cách; màu theo biến theme nên đủ sáng/tối) và có nhãn chữ + tooltip. Hàm quyết định duy nhất: `PickingCarton.warnings(ghi chú)`. Cảnh báo hiện hành: (1) nhiều quy cách (`Nhiều quy cách`); (2) có phần trừ lẻ ` - N`, kể cả chỉ một quy cách như `1Tx100 - 30` (`Có phần trừ lẻ`); (3) ghi chú có chữ nhưng sai định dạng (`Ghi chú sai định dạng`); (4) số thùng hoặc SL/thùng không phải số nguyên dương; (5) chỉ với dòng nhập tay: mã hàng chưa có trong danh mục. Loại (1) và (2) vẫn tính đúng SL (`1Tx100 - 30` = 70) nên vẫn chỉ định nhặt bình thường; loại (3) và (4) hiện SL 0 và không chỉ định được cho tới khi sửa ghi chú. Sửa về dạng sạch (vd `1Tx70`) thì hết cảnh báo ngay. Bốc lẻ ra `1T x 50 - 25` cũng làm dòng đó cảnh báo (SL 25 vẫn đúng). Nhãn ghi rõ từng loại trên dòng và ở Lịch sử chỉnh sửa (tô đỏ khi ghi chú sau rơi vào cảnh báo). Ghi chú sửa tay sai định dạng vẫn được lưu để dòng hiện đỏ.
- Lịch sử chỉnh sửa theo từng cơ sở (HN không lẫn SG), mới nhất lên đầu: thời gian giờ Việt Nam, mã hàng, khu/vị trí, ghi chú trước → sau, SL trước → sau, nguồn (Sửa tay, Import, Xác nhận nhặt, Hủy/hoàn tác nhặt, Chỉ định lại) kèm mã đơn, người thực hiện ("Người dùng demo" vì prototype chưa có đăng nhập). Chỉ ghi khi ghi chú hoặc SL đổi, qua một hàm duy nhất (`setText` trong `inventory.js`). Giữ tối đa 500 dòng mỗi cơ sở trong bộ nhớ và lưu thêm vào localStorage (`tks-picking-location-history-v1`, bọc try/catch). Esc đóng hộp.
- Nhập tay ngay trên bảng (song song với import file): dòng "Thêm dòng" của từng tab có ba ô Mã hàng, Ghi chú, Vị trí; Tên hàng và SL tự nhảy khi gõ, Enter hoặc nút **Lưu** thêm dòng vào đúng cơ sở của tab đang mở (`PickingInventory.addLocation`). Dùng đúng parser và hàm cảnh báo như import (`importSpecs`), nên ghi chú gõ dở cho SL/cảnh báo tức thì; dòng cảnh báo vẫn lưu được (hiện đỏ, không chỉ định nhặt được); ghi chú trống lưu được với SL 0.
  - Tên hàng tra theo Mã hàng từ dữ liệu đã có trong prototype, theo thứ tự: tên của dòng kiểm kê đã import, dòng vị trí có tên (`demo.js`), rồi dòng đơn cùng mã (`demo.js`, `kiem-ke-demo.js`). Prototype chưa có bảng sản phẩm riêng nên đó là danh mục. Mã không tra được thì Tên hàng trống và dòng bị cảnh báo "Mã hàng chưa có trong danh mục" (chỉ áp dụng cho dòng nhập tay).
  - Giả định: ngày về mặc định hôm nay theo giờ Việt Nam. Nhập trùng (cơ sở, mã hàng, vị trí; không phân biệt hoa thường) thì không tạo dòng thứ hai: báo trùng, bỏ bộ lọc và nhảy tới dòng sẵn có để sửa. Sửa ghi chú trên dòng sẵn có tự cập nhật SL. Mỗi lần thêm/sửa tay ghi Lịch sử chỉnh sửa với nguồn "Sửa tay". Dòng nhập tay chỉ nằm trong bộ nhớ phiên (mất khi tải lại trang), không bị khóa bởi sổ kiểm kê chưa chốt khu.
- Bấm một dòng hàng hóa để mở panel **Lịch sử chỉnh sửa của mã hàng đó** ngay dưới dòng (bấm lại, nút Đóng hoặc Esc để đóng; Esc đóng panel trước rồi mới đến sổ vị trí). Giả định: gồm các bản ghi lịch sử của mã đó trong đúng cơ sở của tab (không lẫn HN/SG), có cột khu/vị trí; bản ghi của khu vừa bấm xếp lên đầu và được làm nổi bật; chip **Chỉ khu này** lọc còn khu đó. Cùng nguồn dữ liệu và hàm ghi lịch sử với hộp Lịch sử chung (`PickingInventory.historyFor`). Bấm vào ô đang sửa (ghi chú, nút) hoặc trong panel không mở/đóng panel.
- Cột **Cập nhật lần cuối**: giờ Việt Nam `dd/mm HH:mm` (tooltip đủ giờ và nguồn), dòng nhỏ bên dưới ghi nguồn (`Sửa tay`, `Import`, `Tự trừ · đơn X` khi xác nhận nhặt, `Tự cộng lại · đơn X` khi hủy/hoàn tác/chỉ định lại). Lấy từ bản ghi lịch sử mới nhất của đúng dòng (một nguồn sự thật, không lưu trường riêng); trống khi chưa từng đổi; giá trị không đổi thì không ghi nên cột không đổi. Bảng sổ vị trí đặt `data-table-controls="off"` và `data-table-sort="off"` nên không có hộp Cột hiển thị hay sắp xếp để gắn thêm. Cột chỉ vẽ lại khi mở sổ, đổi tab hoặc lọc (sổ là hộp modal nên không thể đổi từ popup trong lúc mở).
- Dữ liệu demo từ file kiểm kê thật (`kiem-ke-demo.js`): sau khi nhận hậu tố c, coi ghi chú rỗng là hợp lệ và thêm cảnh báo phần trừ lẻ (dữ liệu demo không có dòng nào có ` - N` nên con số không đổi), HN còn 688/3619 dòng cảnh báo (434 nhiều quy cách, 0 phần trừ lẻ, 254 sai định dạng, ví dụ `vin 19/9 gọi vỏ`, `1t`, `1/10 đi sửa`, `1b*200`, `2T X 20` chưa có số, `1tx40 + 1t39`, `9tx14, 5tx 14`); SG còn 1/42 (khu E36 ghi chú tự do). 76 dòng rỗng không cảnh báo, SL 0.

### Nguồn dữ liệu vị trí (đọc từ VT Hà Nội / VT Sài Gòn thật)
- Khi prototype được phục vụ từ server (http/https) và đã đăng nhập, `locations-source.js` ĐỌC dòng vị trí HN và SG từ `GET /api/stock-positions?branch=HN|SG` (module `server/stockPositions`, quyền `stockLocationsV2.view`, bảng `stock_positions`; module Vị trí hàng cũ `/api/stock-locations` đã gỡ), map `notes` → ghi chú, `name` → tên hàng, `location` → vị trí/khu, `arrivalDate` → ngày về. SL luôn tính từ ghi chú; `quantity` của API chỉ được giữ làm dự phòng như cột SL của file import. Không sửa server. Mở file HTML trực tiếp, chưa đăng nhập hoặc một cơ sở lỗi thì dùng dữ liệu demo cho cả hai (không trộn). Nhãn nguồn: "Vị trí: Từ VT Hà Nội / VT Sài Gòn" hoặc "Vị trí: Dữ liệu demo" ở banner, đầu Sổ vị trí và dòng nguồn trong popup.
- `lifecycle-data.js` vẫn chặn mọi ghi /api/* bằng 403; chỉ GET /api/stock-positions đi ra server thật. Cảnh báo ghi chú trên dữ liệu thật hiển thị như dữ liệu demo; mọi sửa, nhặt và lịch sử chỉ ở bộ nhớ phiên, không ghi ngược DB, không migration, không đụng đồng bộ Sheets. Đơn hàng vẫn là dữ liệu demo.
- Hướng sau này (người dùng chốt): Vị trí hàng trên web là nguồn chính, bỏ Google Sheets. Việc cần cho bản thật: migration lưu ghi chú và lịch sử chỉnh sửa (kèm người thực hiện thật), API ghi (sửa/thêm dòng, trừ và hoàn tác khi xác nhận/hủy nhặt, giữ chỗ Đang nhặt), quyền ghi riêng, tên hàng từ danh mục sản phẩm, bỏ đồng bộ Sheets cùng cột SL/total_quantity, lưu đơn Đang nhặt/Xác nhận/Hủy ở DB.

### Tệp
`../../shared/carton.js` (đã chuyển lên public/shared; parser, trừ thùng, ST, gợi ý thùng nguyên, cảnh báo), `inventory.js` (SL từ ghi chú, vòng đời đơn, lịch sử), `locations-ui.js` (Sổ vị trí), `locations-source.js` (đọc Vị trí hàng thật, dự phòng demo), `app.js` (popup, cột ST, chip lọc), `invoice.js` + `order-template.html` (cột ST trên phiếu). Kiểm thử: `../../shared/carton.test.js`, `carton-ui.test.js`, `locations-ui.test.js`, `locations-entry.test.js`, `locations-detail.test.js`, `inventory.test.js`, `ui.test.js`, `rules.test.js`, `stocktake.test.js` và `node prototype-smoke.cjs` (sau `node prototype-single.cjs`). Ví dụ ABC/DEF/GHI nằm ở đơn `DH-DEMO-013`.


## Đã bỏ luồng thực nhặt (26/10/2026) — thay thế các mục mô tả thực nhặt bên dưới

Popup có 6 cột: Mã hàng, Tên hàng, Cần nhặt, ST, Tồn kho, Vị trí kho. Đã gỡ cột Kho nhặt thực và Còn thiếu cùng các luồng đi kèm: nhập/lưu nháp/xác nhận thực nhặt, lấy bù và phiếu bổ sung, chốt phiếu giao thiếu, `workflow.js`, `simple-flow.js`, `PickingInventory.confirmActual/fill`. Luồng hiện tại: **Xác nhận & In phiếu nhặt** → giữ chỗ và mở phiếu; mở lại popup có **Xác nhận nhặt**, **Hủy nhặt** và **In đơn** theo trạng thái; in lại không trừ tồn. Cột giấy "Thực tế nhặt" trên phiếu in (theo mẫu được cấp) vẫn để trống cho người nhặt. Hộp Kho nhặt hàng/kiểm đếm trong `inventory.js` không còn lối vào từ giao diện.

## Mẫu in và giao diện hiện tại — thay thế mô tả các phiên bản bên dưới

Đường dẫn Kiot: chi tiết đơn có **Mở đơn trên Kiot ↗** cạnh trạng thái KiotViet, ngoài popup nhặt. HN mở chhanoi, SG mở chsaigon, trang `/man/#/Orders?code=...`; query `code` được đối chiếu với mã OrderCtrl của giao diện Kiot. Link lọc theo mã để kế toán chọn/kiểm tra rồi tự bấm Kết thúc trên Kiot. Mã DH-DEMO được ghi rõ là mô phỏng, không tồn tại như đơn thật. File HTML không gửi lệnh hoàn thành và không tự đọc lại trạng thái Kiot; phần cập nhật trạng thái qua đồng bộ thuộc hệ thống máy chủ hiện có, chưa kết nối vào prototype. Không chứa khóa API trong link hoặc mã HTML.

<details>
<summary>Lịch sử các phiên bản trước — mô tả thực nhặt, số cột và số test bên trong không áp dụng cho bản hiện tại</summary>

Kho nhặt thực tự điền theo số đã chỉ định ở từng vị trí sau khi xác nhận chỉ định. Kế toán chỉ sửa những ô lệch. Đây là giá trị đề xuất trong ô nhập, chưa tự ghi thực nhặt hoặc trừ tồn. Giữ nguyên giá trị nháp đã sửa (kể cả 0 hoặc ô bị xóa), không ghi đè khi mở lại; đã ghi nhận thì hiển thị số thực nhặt đã lưu. Nhấn In đơn mới kiểm tra và ghi số thực nhặt theo luồng hiện tại. Phiếu nhặt lần đầu vẫn để trống cột giấy Thực tế nhặt.

Tồn kho sỉ mới nhất: các mã bổ sung tăng 100 lần, mã mẫu cũ có số tồn đã biết tăng 1.000 lần. Ví dụ HN: COC123 3.000.000; KEP78 600.000; HOP1000 và BANCHAIGC 300.000; BINH500 và KHAN30 150.000; THAU28 90.000; KETO3 60.000; ADN3LYU 155.000; BN2L 70.000. Số đặt giữ nguyên. Cặp 005/006: COC123 từ 3.000.000 còn 2.990.000 khi giữ 10.000, hoặc 2.992.000 nếu kết thúc với thực nhặt 8.000. Các số tồn thấp trong mô tả lịch sử bên dưới đã được thay thế.

Dữ liệu thử mở rộng: 12 đơn, 56 dòng vị trí, 8 mã mới dùng chung giữa nhiều đơn. Cặp `DH-DEMO-005` / `DH-DEMO-006` (HN) cùng 8 mã; cặp `011` / `012` (SG) kiểm tra tồn riêng cơ sở. COC123 HN có A05=12.000, B05=10.000, C05=8.000, tổng 30.000. Trước xác nhận đơn 005, đơn 006 thấy khả dụng 30.000. Xác nhận 005 lấy 10.000: khả dụng còn 20.000 do giữ chỗ; nhập thực nhặt đủ 10.000: tồn vật lý còn 20.000, giữ chỗ được giải phóng, khả dụng vẫn 20.000 (không trừ kép). Nếu thực nhặt 8.000: khả dụng 22.000. Mở các đơn trong cùng một phiên; tải lại trang sẽ khởi tạo lại dữ liệu. Kiểm tra tự động gồm cả mở popup đơn 006 trước/sau khi xử lý 005, giữ chỗ và nhập thực nhặt, in lại không trừ thêm, cùng mã ở SG không bị ảnh hưởng.

Cập nhật cuối: bỏ cột Nhặt, còn tám cột; thu khoảng cách và giới hạn bảng trong vùng in 186 mm. Các bảng phiếu đều đặt `data-table-controls="off"` và `data-table-sort="off"` để trình quản lý cột dùng chung không chèn thanh công cụ hoặc kéo rộng bảng. CSS xuất/in chỉ dùng `invoice-a4.css`. Nút **In** dùng iframe cùng trang gọi `print()` sau khi ảnh tải xong, mở hộp chọn máy in của trình duyệt và không tạo tab mới. Đã đo trên Chrome: bảng rộng 703 px, tám cột nằm trọn trong phiếu, không có cuộn ngang.

Mẫu mới nhất lấy từ `order-template-source.html` (người dùng cung cấp), chuẩn hóa bằng `prototype-template.cjs` khi dựng. Giữ đủ phần tổng tiền, người nhận, ngày tháng, nhân viên nhặt/xuất và lưu ý. `invoice-a4.css` đặt A4 dọc, lề 10 mm, vùng nội dung 190 mm, chín cột có tỷ lệ cố định, lặp tiêu đề khi sang trang và tránh tách dòng hàng. Nút chỉ hiển thị biểu tượng máy in + **In**, mở trang riêng và gọi hộp in sau khi ảnh tải xong để người dùng chọn máy in vật lý. Không tự gửi lệnh tới một máy in cụ thể hoặc xác nhận đã in xong. Tắt đầu/chân trang trình duyệt và dùng tỷ lệ 100% khi in.

In và lưu file: bản xem trước cho sửa trực tiếp nội dung; **Lưu file HTML** tải phiếu riêng đã nhúng CSS và ảnh cùng nội dung sửa, mở lại vẫn sửa/in/lưu được. **In / Lưu PDF** mở trang in riêng để tránh in cả giao diện popup; bấm nút In trên trang đó và chọn máy in hoặc Lưu thành PDF. Nếu môi trường nhúng chặn cửa sổ, tải HTML rồi mở bằng Chrome/Edge. Sửa bản in không cập nhật sổ tồn hoặc số liệu đơn; nhập số thực nhặt ở bảng chỉ định để ghi nhận nghiệp vụ. Hộp in/PDF thực tế cần trình duyệt hỗ trợ; kiểm thử JSDOM chỉ xác nhận nội dung xuất và gọi chức năng in, không giả lập máy in hệ điều hành.

Cập nhật theo ảnh phiếu đặt hàng: dùng `order-template.html` với chín cột Nhặt / TT / Tên hàng / SL / Đơn giá / Thành tiền / Vị trí / Ghi chú / Thực tế nhặt. Vị trí luôn là vị trí đã chỉ định, không ghép vào ghi chú. Lần đầu Thực tế nhặt để trống; in sau khi kế toán nhập sẽ điền kết quả vào cột này (kể cả 0). Nhiều vị trí in số thực nhặt theo tên vị trí. SL và tiền hàng giữ theo đơn gốc, không bị số thực nhặt ghi đè. Mô tả tính lại tiền theo thực nhặt ở phiên bản trước bên dưới đã được thay thế.

Luồng chính: **Xác nhận & In phiếu nhặt** → nhập ô text **Kho nhặt thực** theo từng vị trí → **In đơn**. Đã bỏ khối xử lý thiếu, lý do, xử lý khác và ghi chú cho kho theo yêu cầu. Nhập thiếu vẫn in theo thực nhặt; không tự giảm số lượng đơn gốc. Ô trống cần nhập kết quả, 0 là không nhặt được. In lại cùng kết quả không trừ tồn thêm.

Mẫu người dùng gửi nằm tại `invoice-template.html`; `invoice.js` giữ đầu TOKOSI, thông tin khách, bảng hàng, tổng tiền/công nợ, chữ ký và lưu ý. Phiếu nhặt thêm cột trống Thực nhặt; vị trí cùng số lượng nằm trong ghi chú mỗi mã. Hóa đơn giao dùng số thực nhặt, tính lại thành tiền và tổng tiền hàng. Trường chưa có dữ liệu hiển thị —; không tự giả định công nợ hoặc chiết khấu bằng 0. Đơn giá trong dữ liệu thử là giá minh họa. Ba ảnh gốc được lưu ở `invoice-assets` và nhúng vào bản HTML duy nhất, không cần mạng.

Sổ tồn chung có giữ chỗ giữa các đơn và trừ tồn theo thực nhặt trong cùng phiên thử. Chưa ghi hệ thống thật; mở lại trang sẽ đặt lại sổ tồn mô phỏng.

Kiểm tra hiện tại: 19 bài kiểm tra trong `rules.test.js`, `ui.test.js`, `inventory.test.js`; `node prototype-smoke.cjs` kiểm tra cả mẫu in, ảnh nhúng, tính tiền theo thực nhặt, dữ liệu thiếu và in lại không trừ tồn hai lần. Dựng file bằng `node prototype-single.cjs` từ thư mục `server`.

## Luồng rút gọn — áp dụng mới nhất

Hai thao tác chính cho đơn đủ hàng: **Xác nhận & In phiếu nhặt** → nhập trực tiếp số Thực nhặt trong bảng → **Chốt & In giao hàng**. Không cần bật chế độ nhập, lưu nháp, xác nhận thực nhặt riêng hoặc chọn loại phiếu trên luồng chính. Dữ liệu đang gõ giữ nháp trong phiên, chưa đổi tồn. Ô trống bị chặn, nhập 0 để xác nhận không nhặt được. Nhiều vị trí mới cần mở chi tiết nhập theo vị trí.

Thiếu hàng mới mở **Lấy bù & In phiếu bổ sung** hoặc **Giao theo thực nhặt**. Lấy bù ghi thực nhặt, kết thúc giữ chỗ chưa lấy và cấp phần bổ sung ở nơi khác; các dòng bổ sung trong cùng lần xử lý dùng chung một batch/phiếu. Nếu không đủ khả dụng thì giữ thiếu, không tự giảm đơn. Giao thiếu cần quyết định chờ/hủy phần thiếu và lý do chấp thuận. Kiểm đếm/lịch sử và in lại nằm trong Xử lý khác. Phiếu giao là snapshot đã chốt; dữ liệu mới cần chốt lại.

Luồng tối giản coi số nhập theo phiếu trả là kết quả kết thúc nhặt tại vị trí; không tự kết luận vị trí hết hàng hoặc điều chỉnh tồn về 0. Cần báo hết/kiểm đếm thì dùng Xử lý khác. Các mô tả toolbar nhiều nút bên dưới thuộc phiên bản trước và được thay thế bởi mục này.

## Luồng thực nhặt mới đã triển khai — cập nhật mới nhất

Nút In và Nhập kho nhặt thực nằm trong popup Chỉ định vị trí; ngoài chi tiết chỉ giữ nút Chỉ định vị trí. Bảng có Kho nhặt thực và Còn thiếu, nhập lũy kế theo từng nhiệm vụ/vị trí, trống = chưa báo và 0 = đã báo không lấy được. Lưu nháp giữ trong phiên không đổi tồn; Xác nhận kết quả kiểm tra toàn bộ trước khi ghi phần chênh lệch, cùng số lưu lại không trừ lại. Sửa giảm số đã xác nhận bị chặn để xử lý hoàn/sửa sai riêng.

Nhặt thiếu chỉ phân bổ bù phần còn thiếu, giữ kết quả đã nhặt. In chọn ba loại: nhặt ban đầu (có cột giấy Thực nhặt), nhặt bổ sung mới nhất (chỉ các dòng bổ sung, ghi rõ không nhặt lại), giao hàng đã chốt. Chốt giao yêu cầu mọi vị trí đã báo và kết thúc nhặt; giao thiếu cần quyết định chờ/hủy phần thiếu và lý do chấp thuận. Không thay SL đơn gốc hoặc sửa KiotViet. Lấy bù/thực nhặt mới làm hết hiệu lực bản giao đã chốt để buộc chốt lại. Prototype chỉ mô phỏng một lần giao được chốt tại một thời điểm, chưa theo dõi nhiều lần xuất giao thực tế. Kiểm đếm tồn là phần mở rộng riêng, không trộn vào màn hình nhập kết quả.

### Nguồn tổng tồn chung — cập nhật mới nhất

Cột Tổng tồn chung lấy từ `PickingInventory.summary(branch, code)`, không phụ thuộc đơn đang mở: hiển thị khả dụng chung, tồn vị trí và tổng giữ chỗ mọi đơn. Ví dụ tồn 150, đơn 1 xác nhận 30: mọi đơn thấy khả dụng 120. “Đơn này chọn / Dự kiến sau xác nhận” là dự tính riêng, chỉ hiển thị phụ; chưa xác nhận không làm giảm khả dụng chung. Thay thế cách hiển thị trước đó bên dưới. Sổ chỉ dùng chung trong một phiên mở file HTML, chưa chia sẻ giữa nhiều máy/tab.

### Cột Tổng tồn còn lại — 23/10/2026

Popup có thêm cột Tổng tồn còn lại: tổng khả dụng đúng mã/cơ sở sau giữ chỗ của đơn khác, trừ tổng số đang chọn cho mã này trong đơn hiện tại. Tự cập nhật khi chọn/bỏ chọn, không trừ hai lần khi mở lại chỉ định đã xác nhận. Ví dụ 100 + 35 + 20 = 155, đang chọn 30 thì còn 125. Hiển thị thêm “Trước chọn” và “Đang chọn”. Nếu một vị trí chưa rõ số lượng, hiển thị Chưa xác định thay vì coi là 0. Thay đổi ở bước chọn là dự tính khả dụng; chỉ xác nhận mới giữ chỗ dùng chung, không phải trừ tồn vật lý.

## Bản HTML duy nhất và luồng kho thực nhặt

Chạy `node prototype-single.cjs` từ `server` để tạo `TOKOSI-prototype-nhat-don.html` ở gốc repository. File này nhúng toàn bộ CSS, JavaScript, logo, ảnh nền và dữ liệu mô phỏng; mở trực tiếp bằng trình duyệt, không cần cài đặt hay mạng. Không yêu cầu các file nguồn đi kèm. Font chuyển sang font có sẵn trên máy khi không có font hệ thống.

Sau xác nhận chỉ định, bấm **Kho nhặt hàng** trong chi tiết đơn. Giữ chỗ làm giảm khả dụng; nhập thực nhặt thêm chỉ trừ đúng số lấy lần này. Kết thúc vị trí sẽ giải phóng phần giữ chỗ chưa lấy và loại vị trí đó khỏi gợi ý lấy bù của dòng đơn. Báo đã hết sẽ khóa vị trí chờ kiểm đếm. Có thể gợi ý/giữ chỗ lấy bù, nhập số kiểm đếm và lý do rồi dùng **Quản lý xác nhận** để điều chỉnh/mở khóa. Bản thử mô phỏng cả vai trò kế toán/kho/quản lý trong một màn hình; bản thật cần phân quyền riêng.

Sổ tồn/giữ chỗ chỉ nằm trong bộ nhớ phiên thử, tải lại file sẽ đặt lại. Không ghi DB/Sheet/KiotViet. Kiểm thử: `node --test public/prototypes/order-picking/inventory.test.js`; kiểm tra toàn luồng file offline: `node prototype-smoke.cjs`.

Cập nhật 23/10/2026 theo ảnh chụp và bản vẽ người dùng. Chỉ là bản thử, chưa sửa luồng vận hành hoặc triển khai lên máy chủ.

</details>

## Chạy thử

Từ thư mục `server`: `node prototype-preview.cjs`, mở `http://127.0.0.1:4178/prototypes/order-picking/`.

`prototype-build.cjs` đọc `public/shipment/lifecycle/index.html`, giữ markup bảng/chi tiết, bỏ các link CSS/script của `/shipment/lifecycle/pick/` để tránh trùng global/id với bộ popup/in demo, thêm adapter dữ liệu và popup rồi tạo `public/prototypes/order-picking/index.html`. Không sửa file Vòng đời nguồn. Muốn dựng lại khi nguồn thay đổi: `node prototype-build.cjs`. Không chỉnh tay file index đã sinh.

## Luồng

1. Bảng Toàn bộ đơn hàng và hộp Chi tiết dùng nguyên template hiện tại, giữ bộ lọc, cột, sắp xếp, bảng hàng hóa và theme.
2. Bấm một dòng đơn để mở chi tiết. Chỉ đơn `SENT_TO_ACCOUNTANT` có nút **Chỉ định vị trí** ngay trên bảng Hàng hóa trong đơn.
3. Bấm nút để mở popup sáu cột **Mã hàng / Tên hàng / Cần nhặt / ST / Tồn kho / Vị trí kho**. Từng vị trí hiển thị dưới dạng ô chọn có tên, khả dụng, số lấy và trạng thái đã chọn.
4. Gợi ý mới: trong các vị trí đủ lượng còn cần lấy, chọn vị trí có khả dụng nhỏ nhất (phần dư nhỏ nhất, ưu tiên khớp chính xác). Ví dụ cần 100: chọn 100 trước 120, 200, 500; nếu không có 100 thì chọn 120. Không dựa khoảng cách hoặc thứ tự vị trí. Nếu không vị trí nào đủ, chia từ vị trí nhiều hàng nhất rồi tính lại cho lượng còn thiếu. Khả dụng đã trừ giữ chỗ của các đơn khác.
5. Bấm vị trí đủ hàng để chuyển sang vị trí đó; bấm các vị trí không đủ để chia nhiều nơi. Bấm ô đang chọn để bỏ chọn. Không xác nhận khi thiếu, thừa, vượt khả dụng hoặc mã chưa có vị trí.
6. **Xác nhận & In phiếu nhặt** lưu localStorage riêng `tks-picking-popup-v2`, đóng popup, hiện dấu đã xác nhận và nút **In đơn** tại chi tiết. Bản lưu có fingerprint đơn/vị trí để chặn in phương án cũ khi dữ liệu đổi.
7. Nút In đơn mở mẫu `order-template.html` chín cột (có ST, không còn cột Nhặt); in qua hộp in trình duyệt.

## Dữ liệu

Adapter `lifecycle-data.js` cung cấp JSON theo hợp đồng API hiện có cho trang Vòng đời gốc, từ `demo.js`. Mọi yêu cầu GET API cùng origin được xử lý ở adapter; thao tác ghi bị từ chối, không gửi dữ liệu ra hệ thống. Tài khoản Kế toán trên giao diện là tài khoản mô phỏng.

Nút **Nguồn dữ liệu** cho tải mẫu/nhập JSON `{orders,locations}`, tối đa 10 MB, 1.000 đơn, 50.000 dòng vị trí. `orders`: `branch` HN/SG, `orderCode`, `status.code`, `lines` với `productCode`, `productName`, `quantity`. `locations`: `branch`, `code`, `location`, `available` (số đã xác nhận cùng đơn vị với dòng đơn).

Chưa kết nối DB hoặc API thật. Không coi `totalQuantity` trên sheet, đặc biệt “TỔNG SL đã đi” SG, là tồn còn tại vị trí. Vị trí thiếu `available` cần người thử xác nhận trước khi chọn. Có giữ chỗ giữa các đơn và trừ/hoàn tác tồn mô phỏng trong bộ nhớ phiên; không migration hoặc ghi tồn thật. Bản in và giao diện ghi nhãn mô phỏng.

## Kiểm thử

Từ gốc repo: `node server/prototype-build.cjs`. Sau đó từ thư mục `server`: `node --test "public/prototypes/order-picking/*.test.js"` (dùng glob, không truyền thư mục).

Kết quả 2026-10-27: build thành công; 91 test sẵn có đạt. Ca hồi quy mới “bản demo không nạp popup/phiếu in thật dùng trùng global với demo” thất bại trước sửa vì còn 4 asset pick thật; sau sửa `prototype-build.cjs`, toàn bộ **92/92 đạt, 0 lỗi, 0 bỏ qua**. Test giữ nguyên markup bảng/chi tiết nguồn vẫn đạt. Không sửa nguồn lifecycle. Chưa kiểm máy in/trình duyệt thật trong phiên này.

Bản thật dùng `public/shipment/lifecycle/pick/order-template.tpl`; bản thử giữ `order-template.html`. API thật: GET `/api/shipment/pick/candidates?branch&order`, GET `/api/shipment/pick?branch&order` (assignment mới nhất kể cả đã hủy), POST `/api/shipment/pick`, POST `/api/shipment/pick/:id/confirm` và `/:id/cancel` với version. Các route thật có quyền `shipment.pick`; adapter demo chặn ghi, không gọi các route này để thay đổi tồn.

Cập nhật lần cuối: 2026-10-27 (đối chiếu bản thật, dựng lại prototype và 92 test).
