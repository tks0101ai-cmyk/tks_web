> Bản phát hành PR 05/11/2026: migrations 0110–0113 (thêm 0115, 0116 ngày 06/11/2026), tự khởi tạo schema riêng trước HTTP; nguồn vẫn Sheets, chưa seed/cutover. Chuyển dữ liệu/bật ghi theo ROLLOUT.md là bước riêng. Nội dung theo ngày bên dưới ghi lại tiến trình, không xác nhận đã deploy.

# Mức hoàn thiện Thu mua — 05/11/2026

Phạm vi: 40 tiêu chí rút từ các yêu cầu đã chốt trong phiên này. 38/40 đã có code và bằng chứng kiểm tra cục bộ (95% về triển khai). Đây **không phải** 95% nghiệm thu production: hai mục chưa đạt là điều kiện bắt buộc trước cutover. Không được dùng tỷ lệ này để bỏ qua chúng.

| # | Yêu cầu | Trạng thái / bằng chứng |
|---|---|---|
| 1 | Bấm một lần để sửa ô; công thức chỉ đọc | Có — UI mockup/live, workflows/live tests |
| 2 | Ô số không có spinner; cột số gọn và kéo được | Có — purchase-workspace.css, kiểm cột mockup |
| 3 | Giữ độ rộng cột riêng theo người dùng | Có — session state/table-controls |
| 4 | Sáng/tối, màu số lượng/tấn/m³/tiền/cảnh báo | Có — shared purchase-workspace.css; còn nghiệm thu nhìn thực tế ở mục 40 |
| 5 | Đổi VI/中文 chỉ tác động tiêu đề bảng đặt hàng | Có — purchase-headers và test |
| 6 | Dấu phẩy hàng nghìn, chấm thập phân; tổng tệ 3 số lẻ | Có — columns/workbook/live/mockup tests |
| 7 | Cột ngày có lịch và lưu được giờ-phút | Có — service/workbook/live tests |
| 8 | Tên cont là dropdown ngay tại ô | Có — live/mockup tests |
| 9 | NV dropdown theo HR ID, không tự ghép tên trùng | Có — directory API, active employee tests |
| 10 | Trạng thái cont dropdown, cập nhật các dòng cùng cont | Có — status API/live tests |
| 11 | Tấn/m³ cont nguồn/đích tính lại theo bản nháp | Có — live/mockup tests |
| 12 | Xe 17.5/18.5 dùng 32 T và tham chiếu 160–170 m³ | Có — containers/service/UI |
| 13 | Thiếu số đo và vượt tải/khối có cảnh báo | Có — shared helpers/UI, không khẳng định phù hợp khi thiếu dữ liệu |
| 14 | Chọn cont và ghim đúng dòng chỉ số khi cuộn | Có — mockup và live test; không tự đổi bộ lọc mã |
| 15 | Bỏ khối cân đối/bảng xếp hai bên khỏi luồng chính | Có — UI live/mockup, không dựng bảng xếp ẩn |
| 16 | Tách mã cha .01/con .02, lặp lại theo nhánh | Có — service/key tests |
| 17 | Mã con số lượng trống, chưa nhập không cho lưu | Có — service/live/mockup tests |
| 18 | Nhân viên tự sửa số lượng; không tự chia thùng | Có — manual plan tests |
| 19 | Các dòng vừa tách lên đầu; giữ liên hệ gốc | Có — split ordering and keys |
| 20 | Lấy thông tin lần lên list gần nhất khi đặt lại | Có — latest service test, add/reorder UI |
| 21 | Thêm mã bất kỳ vào bản thử, cấp khóa lúc lưu | Có — newRows + atomic plan |
| 22 | Sửa hàng loạt ngay trên bảng, có xác nhận ngắn | Có — bulk/live tests |
| 23 | Chuyển cont nhiều dòng một lần | Có — batch plan/UI |
| 24 | Đặt lại nhiều mã, giữ đơn cũ | Có — reorder private rows tests |
| 25 | Dán Excel kiểm toàn vùng trước khi nhận | Có — paste tests, chặn cột chỉ đọc/ô lỗi |
| 26 | Enter/Tab và chiều ngược để di chuyển | Có — keyboard/live/mockup tests |
| 27 | Bộ lọc nhanh và xem riêng dòng đã sửa | Có — private filter state |
| 28 | Lọc/sắp xếp riêng không phát sang người khác | Có — SSE payload/private filter tests |
| 29 | Bản nháp riêng theo tài khoản; tải lại còn giữ | Có — session/outbox tests |
| 30 | Khác ô có thể gộp, cùng ô chặn ghi đè | Có — service hai actor + live conflict tests |
| 31 | Mất mạng/đứt phản hồi vẫn giữ lần gửi để kiểm tra | Có — outbox reload/recovery tests |
| 32 | Gửi lặp không tạo trùng dòng/audit | Có — request key + cache chung giao dịch, replay/rollback tests |
| 33 | Hoàn tác bản nháp từng thao tác | Có — draft undo, paste/split/child quantity tests |
| 34 | Hoàn tác sau lưu của chính người dùng, kiểm cả hai nhánh | Có — operation snapshots, ownership/CAS/multi-step tests |
| 35 | Xóa mềm, xác nhận và khôi phục | Có — delete/restore/projection tests |
| 36 | Log trọng điểm và lịch sử chỉ mở khi nháy đúp Mã SP | Có — audit operation link + row family history tests |
| 37 | Import lỗi bất kỳ không ghi, preview/version/idempotence | Có — import/service/routes tests |
| 38 | Dùng chung cont/read models; Đã về không cộng tồn | Có — projection/service tests |
| 39 | Đối chiếu bản nguồn Sheet đã chốt và ánh xạ dữ liệu legacy | **Chưa** — công cụ đối chiếu đã có, chưa có bản seed nguồn được chốt/đối chiếu |
| 40 | Nghiệm thu nhiều tài khoản, hình ảnh và hạ tầng staging thật | **Chưa** — hiện là jsdom/PGlite; chưa áp migration/cutover/deploy |

## Kiểm tra dữ liệu lớn

Đã có ca 5,001 dòng ở UI, chỉ dựng 50 dòng/trang và không dựng bảng xếp ẩn; ca 5,000 dòng/500 dòng sửa ở service kiểm projection đầy đủ. Thời gian kiểm tra cục bộ chỉ là tham khảo, không phải cam kết độ trễ trên trình duyệt/mạng thực tế.

## Những việc cần chốt để nghiệm thu

- Chọn snapshot Sheet cuối cùng; chuẩn hóa khóa, ngày/giờ, NV cũ chưa có ID; đối chiếu từng cont bằng purchaseOrdersReconcile.js.
- Chốt quyền từng vai trò (các thao tác xóa/khôi phục/undo hiện cần purchase.edit).
- Chạy migration 0110/0111/0112/0113 trên staging; thử hai tài khoản, mạng mất giữa lúc lưu, gửi lại, import lỗi, tải lại trang và phục hồi.
- Kiểm hình ảnh trên màn hình làm việc thật và xác nhận nghiệp vụ. Chỉ sau đó mới chốt thời điểm chuyển nguồn và kế hoạch quay lại.

Kết quả kiểm tra cuối đợt: 78 ca service/live UI/routes/import/reconcile/header đạt. Các ca dùng PGlite/jsdom, không thay thế hai mục nghiệm thu thực tế còn thiếu.


05/11/2026 — Theo công thức nguồn mới: Tiền VC cont tự tính = freight_base / freight_capacity × tổng m³ bản nháp (mặc định 202,000,000 / 170), làm tròn đồng; VC/m³ lấy cùng định mức. Có nhập đè trực tiếp (mode manual), Dùng tự tính và sửa tiền/m³ chuẩn; dòng chờ xếp có ước tính. Không tự phân bổ hay sửa chi phí/giá NET từng mã. Shared purchase-freight.js dùng chung mock/live; mock freight.js, xuất Excel cont dùng số hiển thị. Migration 0104 chưa chạy giữ cước hiện có ở manual; cont tạo mới chọn formula. API cập nhật mode/định mức kiểm phiên bản/quyền/audit và giá trị hợp lệ. Kiểm tra mẫu 120 m³=142,588,235; 170 m³=202,000,000.


05/11/2026 — Quyết định mới thay thế quy tắc VC dòng nhập tay: Tiền VC từng mã = tổng m³ mã × VC/m³ cont. Tính lại khi đổi số thùng, số đo, cont hoặc cước cont; Tiền VC dòng là cột suy ra, không nhập/import đè. Giá NET và projection dùng cùng phân bổ. Cước cont nhập tay chia cho tổng m³ cont; thiếu số đo thì chưa phân bổ để tránh tính sai. Giữ độ chính xác đơn giá khi tính, làm tròn đồng khi hiển thị. Dòng cont ghim cho sửa Tiền VC và công thức qua cùng luồng kiểm tra/lưu của bảng gốc. Chưa áp migration hoặc deploy.

05/11/2026 — Xóa/để trống Tiền VC cont khôi phục tự tính chuẩn 202,000,000 / 170 × tổng m³; nhập 0 vẫn là cước tay bằng 0. Dùng chung ở bảng gốc, bản ghim và API freight:null.


### Thu mua — chuẩn công thức 05/11/2026 (thay quy tắc VC dòng nhập tay cũ)

Nguồn kiểm chứng: công thức Sheet đã ghi nhận trong memory phiên d23eeb66 và các quyết định mới của người dùng. Lần rà này đối chiếu code, bộ kiểm thử và PostgreSQL cục bộ; chưa nghiệm thu dữ liệu Sheet hiện hành/staging.

| Chỉ số | Công thức / đơn vị |
|---|---|
| Tổng SL | SL/thùng × số thùng |
| Tổng tệ | Tổng SL × giá tệ + VC trước (CNY) |
| Tiền hàng | Tổng tệ × tỉ giá VND/CNY |
| Tổng tấn | kg/thùng × số thùng / 1,000 |
| Tổng m³ | m³/thùng × số thùng |
| VC cont tự tính | 202,000,000 / 170 × tổng m³ (hoặc định mức đã sửa) |
| VC/m³ | Tiền VC cont / m³ giả định nếu có; nếu đã xóa giả định thì chia cho tổng m³ đang xếp |
| Tiền VC mã | Tổng m³ mã × VC/m³ cont |
| Giá NET VND/cái | (Tiền hàng + Tiền VC mã + Phụ phí % × Tiền hàng + VC sau CNY × 3,920) / Tổng SL; hằng số 3,920 chỉ áp dụng VC sau |
| L/c TQ; g/c TQ | m³/thùng × 1,000 / SL/thùng; kg/thùng × 1,000 / SL/thùng |
| Lệch số đo | (Số đo TQ − số đo kho) / số đo kho; hiển thị % |
| Tỉ lệ | Tổng tấn / tổng m³; hiển thị % |

Ô trống = chưa biết, không mặc định bằng 0. Giá/chi phí 0 hợp lệ; tỉ giá phải >0 hoặc trống. Số thùng và SL/thùng là số nguyên dương; chặn số không hữu hạn, âm, nhóm phẩy sai và tích vượt Number.MAX_SAFE_INTEGER. Kg/m³/số đo kho 0 được coi là chưa có số đo sử dụng được. Không chia cho 0 và không xuất NaN/Infinity. Tổng tải/khối chỉ cộng phần biết và giữ cảnh báo thiếu số đo. Có m³ giả định thì cước nhập tay vẫn phân bổ cho các mã đã có m³; dòng thiếu m³ giữ cước trống. Không có m³ giả định thì chỉ chia cước khi tổng m³ đang xếp đầy đủ.

Chuẩn nhập/xuất: 1,234.56; số Excel thật giữ nguyên độ chính xác. Giá tệ hiển thị 2 chữ số thập phân; Tổng tệ hiển thị làm tròn đến đơn vị và bấm/nhấn Enter hoặc Space để hiện 3 chữ số ngay trong ô; khi mất focus trở về số làm tròn. VND hiển thị đồng. Không làm tròn giữa chừng hoặc lấy số đã hiển thị làm đầu vào phép tính. Tổng các dòng đã làm tròn hiển thị có thể chênh vài đồng với tổng làm tròn một lần; dữ liệu gốc không bị điều chỉnh để bù chênh. Xóa tiền cont khôi phục chuẩn 202,000,000 / 170; nhập 0 là cước 0. Tách mã con chưa nhập số thùng thì chưa cộng vào tải/khối/cước. Đổi cont cập nhật cả nguồn và đích.

Mã dùng chung: public/shared/purchase-calculations.js và purchase-freight.js; mockup/live/export dùng cùng phép tính, SQL projection kiểm chéo với export qua PGlite. Bộ đối soát bổ sung FX, VC sau, Phụ phí và số đo kho. Chưa migrate/cutover/deploy.

14/11/2026 — Thuế đã được thay bằng Phụ phí %. Nhập số phần trăm, nhân với cột Tiền hàng của dòng; VC sau tiếp tục nhân 3,920. Migrations 0127–0128 và UAT trước rollout là bước tiếp theo. Giá tệ hiển thị 2 chữ số, Tổng tệ làm tròn đến đơn vị; bấm/Enter/Space hiện phần lẻ 3 chữ số trong ô tới khi blur. M³/thùng hiển thị 3 chữ số.
11/11/2026 — Migration 0122 thêm `purchase_orders.measurement_overrides` để sửa riêng 9 trường nhóm Đối chiếu theo dòng; bỏ giá trị riêng thì dùng lại nguồn/tự tính. Nguồn Cân đo không bị ghi. Migration được đăng ký ở startup; chưa áp hoặc kiểm chứng DB production.

Cập nhật gần nhất: 11/11/2026.


05/11/2026 — Triển khai đợt 1–2 trang Thu mua thật: index.html dùng header/sidebar chung, tổng quan 6 chỉ số, Chỉ số cont trên/Đặt hàng dưới/Nhật ký riêng; thêm workspace.css riêng cho trang production. Bảng cont có 15 cột gồm cước/m³, tỉ lệ, ngày về/lịch bốc, nhà VC/cont TQ/người xếp; giữ chỉnh cước/trạng thái và bản ghim có cùng độ rộng. Tạo cont chuyển lên panel cont và khóa khi chỉ xem.
Bộ lọc đặt hàng có trạng thái, HR ID/tên legacy, NCC, VAT, ngày lên list và cảnh báo, tìm không dấu. Lọc cont độc lập. Bộ lọc lưu riêng theo tài khoản, giữ nguyên khi người khác sửa mất giá trị đang lọc; xuất file/dán bảng dùng cùng tập dòng. Tổng quan tính theo lọc/bản nháp, cảnh báo thiếu số liệu thay 0 giả. Thêm mã ưu tiên thông tin chính, phần phụ thu gọn, lấy cont đang theo dõi và không mang ngày đã phát/đã đến từ đơn cũ.
107 ca kiểm thử module đạt, trong đó 32 ca trang thật; kiểm thêm ID HTML không trùng và asset tồn tại. Đây là jsdom/PGlite, chưa nghiệm thu CSS/ảnh thực tế trên trình duyệt. Không có SUPABASE_TEST_DB_URL trong môi trường local hiện tại (chỉ kiểm cờ, không in secret); chưa chạy app kết nối DB thật, migration/seed/deploy/cutover. Cần môi trường thử nghiệm/DB độc lập để mở link trang thật và nghiệm thu bước 3–4. Câu hỏi môi trường thử nghiệm đã gửi người dùng.

## 14/11/2026 — Công thức cước cont
Ô Tiền VC giờ nhận công thức an toàn (`=...`) bên cạnh số tiền thủ công. `D2`/`M3_CONT` là tổng m³ cont, `M3_XE` là sức chứa; parser hỗ trợ số học và `SUM`, `ROUND`, `MIN`, `MAX`, `ABS` (512 ký tự). Biểu thức lưu vào `product_containers.freight_formula` qua migration `0126`, và dùng chung cho phân bổ VC/mã, Giá NET và projection. Kết quả âm/không hợp lệ sau khi m³ đổi bị rollback và trả API 400 `FREIGHT_FORMULA_INVALID`. Chưa chạy migration trên DB thật/chưa deploy; staging phải kiểm trường hợp công thức và thay đổi m³ trước khi phát hành.
