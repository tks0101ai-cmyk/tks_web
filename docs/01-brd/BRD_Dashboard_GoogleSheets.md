# TÀI LIỆU YÊU CẦU NGHIỆP VỤ

23/10/2026 — Kiểm tra giá bán (Invoice Price Audit) đã hoàn thiện và push 2 remote GitHub (`origin`, `tks_web`): chuẩn hóa danh sách 10 khách bao cước HN sang tên KiotViet mới (giữ dấu), đọc bậc giá theo chiếc (`CT`, `lẻ`) trực tiếp, khóa 4 mức giá Vừa - Lớn - VIP - Cắt lỗ, email 'mới' tính khách Lớn. Gộp PR #16 (Vat Draft paste codes) và PR #17 (Vat Request no hscroll).

22/10/2026 — Quản lý bổ sung Số bảo hiểm qua Excel xuất từ Danh sách nhân sự và nhập lại theo ID nhân sự; chỉ trường bảo hiểm được cập nhật.

*(Business Requirements Document – BRD)*

**HỆ THỐNG DASHBOARD NỘI BỘ — TOKOSI**

| **Thông tin**     | **Nội dung**                                                        |
|-------------------|---------------------------------------------------------------------|
| Tên dự án         | Hệ thống Dashboard nội bộ TOKOSI (KiotViet → Supabase PostgreSQL → Web; Google Sheets bổ trợ) |
| Phiên bản         | 2.3                                                                 |
| Ngày tạo          | 27/07/2026                                                          |
| Ngày cập nhật     | 23/10/2026                                                          |
| Đối tượng sử dụng | Ban lãnh đạo, nhân viên nội bộ công ty                              |
| Trạng thái        | Nội dung nền rà soát tại HEAD `11751c4` (05/10); bổ sung Sổ quỹ đã kiểm chứng cục bộ 06/10, migration `0033` và deploy production còn chờ. |

> **Ghi chú phiên bản 2.2 (05/10/2026):** rà soát lại toàn bộ theo code. Loại các nội dung đã lỗi thời: tab `Trả NCC` đọc từ Google Sheets (nay upload Excel vào Postgres), tab Nhà cung cấp và KPI nhà cung cấp/nhập hàng (đã gỡ), bộ lọc 7/30/90 ngày và tự làm mới 10 phút (nay bộ lọc Từ–Đến theo từng bảng và cập nhật bằng SSE), đăng nhập theo tab `Users`, Khách tự đăng ký (nay khóa), workbook HR (không còn đọc). Bổ sung Vị trí hàng, Vòng đời đơn hàng hợp nhất đơn KiotViet, quản lý ID Telegram và phân quyền theo tính năng.

> **Bổ sung 12/10/2026:** Vòng đời đơn hàng theo 5 luồng (giao xe HN/SG, khách/ship lấy tại kho HN/SG, Bắc-Nam) với 6 cảnh báo có tên tự mất khi xử lý xong: Kế toán sót đơn, Lái xe chưa chụp đơn, Lái xe quên chụp, Chưa nhận đơn quá 6 giờ, Khách/Ship chưa lấy, Chưa chụp bill tàu.

# 1. Giới thiệu

## Bổ sung nghiệp vụ 15/10/2026 — Hàng dự kiến

Sale cần biết số hàng đặt theo mã đang Chưa bốc/Đã bốc và chi tiết từng CONT trong Báo cáo hàng hóa của Tổng quan. Nguồn bổ trợ là workbook TKS2 ĐẶT CONT, chỉ đọc 7 sheet YIWU, VK-DUNG, HÀ BẮC, SD, GDONG, KHÁC, CONT TKS1 mỗi 10 phút (từ 16/10/2026), độc lập đồng bộ KiotViet và doanh số chốt đêm.

- Giữ danh mục mã đang kinh doanh hiện hành. Cột Chưa bốc cộng O của CONT trạng thái 1/2, Đã bốc cộng O của trạng thái 3; không tính 4/5 vào tổng. Tổng chung công ty, trước Tồn HN/SG, đồng nhất web và xuất Excel/HTML. Không có hàng = 0 khi đã có snapshot; chưa có dữ liệu = —.
- *(Cập nhật 21/10/2026: phần Hàng dự kiến đã chuyển khỏi hộp "Chi tiết hàng hóa" sang bảng Dự kiến hàng về — bấm dòng xem mọi CONT cùng mã SP; hộp Báo cáo hàng hóa chỉ còn Doanh số theo khách.)* Hộp chi tiết đồng thời có Doanh số theo khách và Hàng dự kiến. Sale và các nhân viên có quyền báo cáo xem từng dòng CONT trạng thái 1–5: tên CONT, trạng thái, ngày về nếu có, màu, ghi chú sale, số lượng. Không lọc theo người đặt/team, không gộp dòng nguồn. Người có quyền đầy đủ thấy ngay trạng thái 1–5 và thêm người đặt, ngày lên list, số cái/kiện, số kiện, giá hàng về VN; quyền mặc định Quản lý và có thể cấp/thu hồi từng tài khoản.
- Đọc đủ 7 sheet mới công bố snapshot; lỗi giữ dữ liệu thành công gần nhất và thông báo mốc cập nhật. Lỗi cấu trúc CONT/số lượng bỏ phần lỗi và có cảnh báo cho quyền đầy đủ. Không suy đoán ngày về hoặc cảnh báo trễ; không xuất chi tiết CONT trong đợt này.

Trạng thái triển khai 15/10/2026: migration 0053 đã áp DB dùng chung lúc 16:26 ngày 15/10/2026; đã kiểm chứng nguồn thật và Chrome trên DB PGlite cục bộ, toàn bộ 2.463 kiểm thử đạt, 3 skipped, 0 lỗi; chưa kích hoạt website đang triển khai; chưa push/deploy. [Kế hoạch và prompt](../../tasks/plan-product-report-containers.md).

## 1.1. Mục đích tài liệu

Mô tả các yêu cầu nghiệp vụ của Hệ thống Dashboard nội bộ TOKOSI — website tổng hợp dữ liệu KiotViet (qua Supabase PostgreSQL) và một số Google Sheets bổ trợ, hiển thị KPI, biểu đồ, bảng chi tiết gần thời gian thực để theo dõi và ra quyết định kinh doanh, kèm các phân hệ vận hành nội bộ (công nợ, vòng đời đơn hàng, vị trí hàng, nhân sự/nghỉ phép, tài khoản).

## 1.2. Bối cảnh

TOKOSI là tổng kho sỉ phân phối hàng hóa, vận hành trên **KiotViet** (bán hàng, kho, khách hàng) với hai cơ sở **Hà Nội** và **Sài Gòn**. Dữ liệu KiotViet được đồng bộ tự động vào **Supabase PostgreSQL** bằng engine Node.js `server/kiotvietSync/` (hàng hóa, hóa đơn, đặt hàng, trả hàng, khách hàng, nhập hàng, phiếu đặt hàng nhập, thu chi) cùng các bảng tổng hợp. Ba kỳ công nợ 1/3/7 ngày (**CN1 / CN3 / CN7**) được tính từ database. Google Sheets dùng cho Bảng Công nợ, Vòng đời đơn hàng, Vị trí hàng và Báo cáo Marketing.

Trước đây việc theo dõi số liệu phải làm thủ công trên KiotViet và Google Sheets, mất thời gian tổng hợp và khó thấy xu hướng. Công ty cần một **website tập trung** hiển thị chỉ số quan trọng dưới dạng KPI, biểu đồ, bảng có lọc/tìm/xuất, cập nhật gần thời gian thực, và là nền móng để mở rộng thành nền tảng quản trị vận hành.

## 1.3. Phạm vi tài liệu

Giai đoạn 1 đến hiện tại: Báo cáo tổng hợp (6 tab, gồm Khách hàng — tăng trưởng theo tháng — và Báo cáo Marketing), Quản lý công nợ theo cơ sở, kiểm tra đứt hàng, Vòng đời đơn hàng, Vị trí hàng, Quản lý nhân sự & nghỉ phép (kèm bot Telegram), Quản lý tài khoản & phân quyền, xuất Excel/HTML; cùng định hướng mở rộng dài hạn.

# 2. Mục tiêu dự án

- Dashboard nội bộ kết nối **Supabase PostgreSQL** cho dữ liệu KiotViet và **Google Sheets API** cho Bảng Công nợ, Vòng đời đơn hàng, Vị trí hàng và Báo cáo Marketing.
- Hiển thị KPI vận hành: doanh thu thực tế (đã trừ hàng trả), số hóa đơn, giá trị và số lượng tồn kho, **Tồn có thể bán**, hàng đang vận chuyển, hàng hết, công nợ khách hàng, trả hàng, hàng mới nhập.
- Mỗi bảng/biểu đồ có bộ lọc thời gian **Từ – Đến** riêng, tìm kiếm không dấu, sắp xếp trên toàn bộ dữ liệu đã lọc và phân trang 100 dòng.
- Dữ liệu cập nhật **gần thời gian thực**: engine đồng bộ polling KiotViet (nhóm fast 7 phút, nhóm slow 20 phút), rollup tính lại ngay sau mỗi lượt fast, và trình duyệt tự tải lại tab đang xem khi nhận sự kiện SSE `dashboard-updated`.
- Báo cáo tổng hợp **tải dữ liệu theo từng tab** để phản hồi nhanh; cache hai tầng.
- Mọi ngày giờ ("hôm nay", mốc lọc, `updatedAt`) theo múi giờ **Asia/Ho_Chi_Minh (UTC+7)**, không phụ thuộc múi giờ máy chủ.
- **Xuất Excel/HTML** cho các bảng và báo cáo nghỉ phép/danh sách nhân sự, với tùy chọn trường linh hoạt. Bảng Quản lý công nợ còn cho xuất lại bản chốt 15:00 của 7 ngày gần nhất (mặc định bản mới nhất).
- Ba kỳ công nợ **CN1 / CN3 / CN7** do `customerDebtReportRefresh.js` tính 5 phút/lần vào `customer_debt_activity_periods` để phục vụ cảnh báo "Chưa thu" trên màn hình Quản lý công nợ.
- **Kiểm tra đứt hàng** dựa trên dữ liệu đã đồng bộ và dữ liệu Trả NCC do người dùng tự upload (Excel xuất từ KiotViet).
- **Phân hệ nghỉ phép:** tự gửi trên web từ hồ sơ HR hoạt động hoặc bot nhân viên ngoài repo; người được cấp quyền duyệt theo phòng ban/cơ sở. Web có lịch nghỉ phép.
- **Vòng đời đơn hàng:** xem mọi đơn đặt hàng KiotViet cùng trạng thái vòng đời từ Google Sheet (HN, SG và luồng đơn Bắc-Nam của Kiot Hà Nội, tính như đơn Hà Nội); lọc, sắp xếp, phân trang ở máy chủ.
- **Vị trí hàng:** tra cứu vị trí hàng HN/SG từ workbook Google Sheets dùng chung.
- **Sổ quỹ:** Quản lý xem số dư tài khoản ngân hàng và Tiền mặt, sổ phiếu thu chi gộp HN/SG, chốt số dư theo sao kê và xuất Excel/HTML. Code đã kiểm chứng cục bộ; cần migration `0033`, đồng bộ danh mục và chốt ban đầu trước khi dùng production. Từ 19/10/2026 trang đọc sổ phiếu qua view cơ sở dữ liệu để tải nhẹ hơn (không đổi nghiệp vụ).
- **Tài khoản và phân quyền theo tính năng** theo vai trò, Quản lý ghi đè từng tài khoản; ID Telegram do Quản lý quản lý.
- Kiến trúc mô-đun, dễ mở rộng theo lộ trình dài hạn.

# 3. Phạm vi dự án

## 3.1. Trong phạm vi (In-scope)

- **Nguồn dữ liệu:**
  - **Supabase PostgreSQL:** toàn bộ dữ liệu KiotViet (nhóm hàng, hàng hóa, hóa đơn + chi tiết + thanh toán, đặt hàng, trả hàng, khách hàng, nhập hàng, phiếu đặt hàng nhập, thu chi), bảng tổng hợp (rollup theo ngày, báo cáo hàng hóa, chi tiết hóa đơn 90 ngày, giá trị tồn kho theo ngày, CN1/CN3/CN7, doanh số tháng đã chốt của Báo cáo kinh doanh), Trả NCC upload, tài khoản `app_users`, nhân sự `hr_employees`, nghỉ phép và liên kết Telegram, trạng thái xử lý công nợ, tài liệu quy định công ty.
  - **Google Sheets:** Bảng Công nợ (`DEBT_MANAGEMENT_SPREADSHEET_ID`, chỉ đọc); Vòng đời đơn hàng (`ORDER_LIFECYCLE_SPREADSHEET_ID`, đọc `DonHang_HN`/`DonHang_SG`, ghi tab `Lịch sử cập nhật`); Vị trí hàng (`STOCK_LOCATIONS_SPREADSHEET_ID`, chỉ đọc); Báo cáo Marketing (ba workbook `MARKETING_*_SPREADSHEET_ID`, chỉ đọc).
- **Báo cáo tổng hợp (6 tab):** Tổng quan (Xu hướng, Kiểm tra đứt hàng), Hàng hóa (Báo cáo hàng hóa, Dự kiến hàng về, Tăng trưởng mã hàng), Hóa đơn (Chi tiết giao dịch), Khách hàng (Báo cáo doanh thu theo khách, Chỉ số tổng quát, Tăng trưởng Sale, Tăng trưởng Khách hàng; trước đây là tab Báo cáo kinh doanh), Quản lý công nợ, Báo cáo Marketing (BC tháng, Check tỷ lệ nhận số, Sao lưu SĐT, Chi phí).
- **Báo cáo kinh doanh:** thay báo cáo tăng trưởng làm tay trên Google Sheets. Doanh số tháng = hóa đơn hoàn thành trừ hàng khách trả, gộp HN + SG, từ T3/2026; sale = nhóm khách hàng trên KiotViet (khách chưa có nhóm gộp vào "Chưa phân nhóm"); tháng đang chạy quy đổi về 30 ngày để so tăng trưởng với tháng trước, kèm trung bình 4 tháng; các tháng đã qua được chốt cứng mỗi ngày mùng 1, Quản lý có thể tính lại và đổi team của từng sale bằng dropdown ngay trên bảng Tăng trưởng Sale. Từ 19/10/2026 doanh số tháng đang chạy được tính sẵn bằng job nền sau mỗi lượt đồng bộ KiotViet (tối đa 10 phút/lần), nên số liệu trễ khoảng 7–14 phút so với KiotViet; dữ liệu quá 30 phút thì báo cáo tính trực tiếp như trước. Không đổi quy tắc tính.
- **Màn hình Quản lý công nợ:** kết hợp Bảng Công nợ, đối chiếu CN1/CN3/CN7 và trạng thái xử lý lưu trong PostgreSQL.
- **Vòng đời đơn hàng, Vị trí hàng, Sổ quỹ (5 nhóm số dư), Quản lý nhân sự (Quy định công ty kèm Phúc lợi, Danh sách nhân sự theo trạng thái làm việc, Nghỉ phép theo lịch làm việc/hạn nộp và đơn cho tài khoản nội bộ), Quản lý tài khoản (Lịch sử chỉnh sửa tài khoản).**
- **Cập nhật dữ liệu dashboard** bằng nút "Làm mới", SSE `dashboard-updated` và tải bù khi quay lại tab trình duyệt.
- **Đồng bộ tự động** KiotViet → Supabase (polling; webhook chỉ lưu thô).
- **Xác thực & phân quyền:** đăng nhập tài khoản trong `app_users` (kể cả Google Sign-In cho tài khoản đã có), phân quyền theo tính năng; tự đăng ký tài khoản mới đang **khóa**.
- **Bot Telegram quản lý nghỉ phép** (mục 5.8).
- **Triển khai trên Render.com**, domain `tokosi.onrender.com`.

## 3.2. Ngoài phạm vi hiện tại (Out-of-scope)

- Ghi dữ liệu ngược lên KiotViet; ghi lên Google Sheets ngoài tab `Lịch sử cập nhật` của Vòng đời đơn hàng và cập nhật Khách mới / Ghi chú của Báo cáo Marketing.
- Bot xin nghỉ của nhân viên (chạy ngoài repo, chỉ ghi/đọc các bảng nền nghỉ phép trong Postgres).
- Tab Nhà cung cấp và KPI nhà cung cấp/nhập hàng (đã gỡ ngày 30/09/2026).
- Toàn bộ các module ở mục 3.3 (POS, Kho đa chi nhánh, Phân tích, AI).
- Xuất báo cáo PDF của toàn dashboard (hiện chỉ có Excel/HTML; tài liệu quy định có "Tải về PDF").

## 3.3. Định hướng mở rộng dài hạn

- **Bán hàng/POS:** tạo đơn bán, quản lý khách hàng, công nợ, in hóa đơn tương đương KiotViet.
- **Kho đa chi nhánh:** nhập/xuất/chuyển kho, kiểm kê, quản lý 5.000–20.000 SKU.
- **Phân tích & phát hiện bất thường:** xu hướng, dự đoán nhập hàng, sai lệch tồn kho/giá.
- **Danh bạ phòng ban:** sơ đồ tổ chức và danh bạ nhân sự.
- **Trợ lý AI:** hỏi-đáp số liệu bằng ngôn ngữ tự nhiên.
- **Định hướng cuối:** thay thế hoàn toàn KiotViet.

# 4. Đối tượng liên quan (Stakeholders)

| **Vai trò**                    | **Mô tả trách nhiệm / nhu cầu**                                                               |
|--------------------------------|-----------------------------------------------------------------------------------------------|
| Ban lãnh đạo / Quản lý         | Theo dõi KPI tổng quan, ra quyết định; duyệt nghỉ phép; quản lý tài khoản, phân quyền, ID Telegram. |
| Trợ lý                         | Xem báo cáo, xuất file, cập nhật trạng thái công nợ.                                          |
| Nhân viên sale / kế toán / kho | Xem báo cáo (sale), tra cứu vòng đời đơn hàng, vị trí hàng, nhân sự theo quyền được cấp.     |
| Người quản trị hệ thống (IT)   | Cấu hình biến môi trường, migration, webhook KiotViet, bot Telegram, Service Account Google.  |
| Đội phát triển (Dev team)      | Xây dựng, kiểm thử, triển khai; giữ tài liệu khớp code.                                       |

# 5. Yêu cầu nghiệp vụ chi tiết

## 5.1. Nguồn dữ liệu & kết nối

- Dữ liệu KiotViet đọc từ **Supabase PostgreSQL**; thông tin kết nối (`SUPABASE_DB_URL`), Service Account Google (`GOOGLE_SERVICE_ACCOUNT_JSON`) và các ID workbook cấu hình qua biến môi trường, không hard-code.
- Google Sheets dùng cho Bảng Công nợ (Viewer), Vòng đời đơn hàng (Editor — để ghi tab Lịch sử), Vị trí hàng và ba workbook Marketing (Viewer). Thiếu ID workbook chỉ tắt tính năng tương ứng (trả 503), không làm sập dashboard.
- Một bảng/nguồn lỗi tạm thời chỉ làm rỗng hoặc cảnh báo phần tương ứng, các phần khác vẫn hiển thị.

## 5.2. KPI tổng quan

| **Nhóm**                  | **KPI**                                                                                          |
|---------------------------|--------------------------------------------------------------------------------------------------|
| Bán hàng hôm nay          | (Đã gỡ 05/10/2026 — không còn KPI "hôm nay"; mọi số liệu bán hàng tính theo kỳ lọc)               |
| Kỳ lọc (Từ – Đến)         | **Doanh thu thực tế** (hóa đơn hoàn thành trừ tiền hàng khách trả lại), số hóa đơn hoàn thành, số hóa đơn hủy, biểu đồ doanh thu theo ngày |
| Hàng hóa                  | Tổng mã hàng, mã đang có hàng, mã hết hàng, giá trị tồn kho (theo giá vốn), Tồn có thể bán, hàng đang vận chuyển |
| Khách hàng                | Tổng khách hàng, số khách có công nợ, tổng công nợ khách hàng                                   |
| Giao dịch (tab Hóa đơn)   | Số giao dịch, doanh thu, giảm giá, thực thu trong kỳ lọc                                         |
| Công nợ (tab riêng)       | Tổng nợ hiện tại, tổng nợ quá hạn, số khách cần xử lý, tỷ lệ nợ quá hạn so với doanh số         |

Chỉ hàng **Đang kinh doanh** được tính; không còn KPI nhà cung cấp/nhập hàng.

## 5.3. Biểu đồ & bảng dữ liệu chi tiết

- **Tổng quan:** biểu đồ doanh thu thực tế theo ngày; biểu đồ cột chồng **Giá trị tồn kho theo ngày** (HN + SG, bản chụp 23:59 mỗi ngày); **Kiểm tra đứt hàng** (nhập Trả NCC, hàng đứt gần đây, kiểm tra 30/90 ngày).
- **Hàng hóa:** Báo cáo hàng hóa gộp hai cơ sở (34 cột theo thứ tự sheet BC CHUNG từ 19/10/2026: tồn thực, có bán, SL bán 30 ngày, số ngày đứt hàng, số ngày bán hết, số đơn 30/90 ngày và tăng trưởng, giá trị có bán và đơn giá từng cơ sở, tổng, số ngày cần đặt, mô tả; cột mới ẩn mặc định, bật bằng "Cột hiển thị"; giá trị có bán và đơn giá chỉ Quản lý/Trợ lý thấy và xuất được; bấm dòng xem doanh số 90 ngày từng khách; từ 21/10/2026 Hàng dự kiến xem ở bảng Dự kiến hàng về) và Tăng trưởng mã hàng theo tháng. Các mục cũ (Cơ cấu tồn kho, Sản phẩm bán chạy, Tất cả mã hàng, Hàng mới nhập, Mã mới tạo) đã gỡ ngày 16/10/2026.
- **Hàng hóa — Dự kiến hàng về (20/10/2026, mục 2 của tab):** nhu cầu xem một chỗ toàn bộ hàng sắp về của mọi cont (trước đây chỉ tra theo từng mã trong hộp chi tiết Báo cáo hàng hóa). Bảng 11 cột (Nguồn, Lịch / Trạng thái, Tên Cont, Mã SP, Tên SP, Màu sắc, Ghi chú sale, Người đặt, Số cái/kiện, Số kiện, Tổng số lượng), lọc theo Nguồn, Cont và Trạng thái, xuất Excel/HTML theo bộ lọc; cột Lịch / Trạng thái là trạng thái + ngày dự kiến về lấy từ dòng nhãn CONT của Google Sheet. Dữ liệu tính sẵn trong DB từ snapshot CONT 10 phút, người xem chỉ đọc. Quyền riêng `reports.products.expected` cho Quản lý, Trợ lý, Nhân viên sale, Kế toán, Nhân viên marketing, Nhân viên mua hàng, Nhân viên kho (không cần quyền Báo cáo hàng hóa); Khách không xem. Ngoài phạm vi: sửa dữ liệu từ dashboard, đồ thị, cảnh báo. **Bổ sung 21/10/2026:** bấm dòng mở hộp chi tiết mọi CONT cùng mã SP kèm tổng số lượng theo từng trạng thái 1–5 (thay mục Hàng dự kiến trong hộp Chi tiết hàng hóa); thêm cột Giá SP (tệ) và Giá hàng về VN chỉ cho người có quyền `reports.overview.containers.full` (Quản lý, Trợ lý) — người này Màu sắc/Ghi chú sale ẩn mặc định, bật bằng "Cột hiển thị"; xuất file chỉ có cột giá khi có quyền; người khác không nhận dữ liệu giá từ máy chủ.
- **Hóa đơn:** bảng Chi tiết giao dịch; bấm một dòng để xem chi tiết hóa đơn (dòng hàng, tổng tiền, thanh toán).
- **Khách hàng:** báo cáo tăng trưởng Sale / Khách hàng / Mã hàng theo tháng (tab Báo cáo kinh doanh cũ). Bảng Top khách theo doanh thu và Chi tiết khách nợ của tab Khách hàng cũ đã gỡ (16/10/2026); công nợ theo khách xem ở tab Công nợ.
- **Công thức Tồn có thể bán** = Tồn thực tế − Đặt hàng Phiếu tạm của khách (không kẹp về 0; không cộng hàng đang vận chuyển).
- **Giá vốn / giá trị tồn tab Hàng hóa:** quyền `reports.products.cost` đã gỡ cùng các mục cũ của tab (Báo cáo hàng hóa không hiển thị giá vốn).
- Mọi bảng có cột **Cơ sở**; cột thời gian sắp xếp theo thời gian thật.

## 5.4. Bộ lọc thời gian

- Mỗi bảng/biểu đồ có bộ lọc **Từ – Đến** riêng; xóa cả hai ô nghĩa là "Tất cả". Mặc định 30 ngày gần nhất (Top khách theo doanh thu: toàn thời gian). Giá trị tồn kho theo ngày chỉ hiển thị ngày có bản chụp, bắt đầu từ 30/09/2026.
- Không còn bộ lọc chung 7/30/90 ngày và không còn thanh tìm kiếm chung đầu tab; mỗi bảng có ô tìm kiếm riêng.
- Ranh giới "hôm nay", các ngày trong kỳ lọc và `updatedAt` theo **Asia/Ho_Chi_Minh (UTC+7)**.

## 5.5. Cập nhật dữ liệu

**Trên dashboard:**
- **Gần thời gian thực:** server phát SSE `dashboard-updated` sau mỗi lượt đồng bộ + rollup; trình duyệt tải lại tab đang xem (chỉ render lại khi dữ liệu thật sự đổi), các tab khác tải lại khi được mở.
- **Thủ công:** nút "Làm mới".
- **Khi quay lại tab:** nếu đã quá 60 giây kể từ lần tải gần nhất thì tải lại ngay và nối lại SSE.

**Đồng bộ nguồn (Node.js Sync Engine):**
- **Polling** là nguồn dữ liệu: nhóm fast (hóa đơn, đơn hàng, tồn kho, phiếu đặt hàng nhập) mỗi 7 phút; nhóm slow (nhóm hàng, hàng hóa, khách hàng, trả hàng, nhập hàng, thu chi) mỗi 20 phút; tồn kho được quét toàn bộ tối đa 10 phút/lần.
- **Webhook KiotViet** (`/api/kiotviet/webhook/<secret>`) hiện chỉ được lưu thô để phân tích, không cập nhật bảng nghiệp vụ.
- **Job tổng hợp:** rollup theo ngày; CN1/CN3/CN7 mỗi 5 phút; Báo cáo hàng hóa và chi tiết hóa đơn 90 ngày tính 1 lần/đêm; giá trị tồn kho chụp lúc 23:59.

## 5.6. Truy cập & bảo mật

- Xác thực bằng JWT cookie, mật khẩu băm bcrypt, khóa đăng nhập 5 phút khi sai 5 lần liên tiếp, khôi phục mật khẩu bằng OTP 6 số (email/SĐT khôi phục).
- Tài khoản, vai trò, quyền riêng và Telegram ID lưu trong PostgreSQL `app_users`.
- **Tự đăng ký tài khoản mới bị khóa từ 03/10/2026**; tài khoản mới do Quản lý tạo (có thể mở lại bằng cấu hình `ALLOW_SELF_REGISTRATION`). Đăng nhập Google chỉ dành cho tài khoản đã có.
- **Phân quyền theo tính năng:** mỗi vai trò có bộ quyền mặc định; Quản lý cấp/rút từng quyền cho từng tài khoản; một số quyền phụ chỉ có hiệu lực khi có quyền gốc (vd các quyền của Vòng đời đơn hàng). Quản lý thường không được thao tác nhạy cảm trên Quản lý khác; chỉ Quản lý cấp cao (admin cứng) giữ đủ quyền.
- **ID Telegram** chỉ Quản lý thêm/sửa được (kể cả hộ nhân viên); hệ thống chống trùng ID giữa tài khoản, liên kết bot và nhân sự.
- **Email và SĐT là định danh** để suy vai trò từ danh sách nhân sự nên không được tự đổi tùy ý (từ 05/10/2026): hồ sơ cá nhân chỉ đổi họ tên và email khôi phục; email/SĐT của tài khoản nhân sự chỉ Quản lý đổi ở trang quản trị (đồng bộ sang danh sách nhân sự); tài khoản thường (Khách, nội bộ không gắn nhân sự) tự đổi email bằng mã OTP gửi tới email mới, có giới hạn số lần gửi/nhập sai. Tài khoản đã gắn một nhân sự không tự chuyển sang nhân sự khác khi email/SĐT thay đổi.
- Dữ liệu nhạy cảm (Service Account, DB URL, JWT secret, KiotViet secret, token Telegram) chỉ ở biến môi trường, không commit; toàn bộ giao tiếp qua HTTPS.

## 5.7. Phạm vi dữ liệu theo cơ sở (Hà Nội / Sài Gòn / Cả hai)

- Mọi dữ liệu nghiệp vụ gắn với một **cơ sở vật lý** (`Hà Nội` hoặc `Sài Gòn`). **Cơ sở chỉ là bộ lọc xem:** mọi tài khoản xem được Hà Nội, Sài Gòn và **`Cả hai`**; cơ sở gán cho tài khoản (để trống = `Cả hai`) chỉ là cơ sở **mặc định** lúc đăng nhập.
- `Cả hai` là **phạm vi xem**, không phải cơ sở thứ ba, và không bao giờ được lưu vào dữ liệu nghiệp vụ.
- **Báo cáo tổng hợp ở `Cả hai`:** KPI và biểu đồ cộng dồn hai cơ sở. Hàng hóa và giao dịch cùng mã ở hai cơ sở là **hai dòng riêng** `(cơ sở, mã)` kèm nhãn Cơ sở; **khách hàng gộp theo tên** (mã khách khác nhau giữa hai cơ sở). Riêng Cơ cấu tồn kho và Báo cáo hàng hóa gộp 1 dòng/mã với cột HN/SG riêng.
- **Tìm kiếm trong bảng & xuất file:** chạy trên dữ liệu đã gộp theo đúng quy tắc của màn hình; file xuất ở `Cả hai` thêm cột `Cơ sở` cho bảng giao dịch và dùng tiền tố tên file `TKS_` thay `HN_`/`SG_`.
- **Quản lý công nợ:** mỗi khách là một dòng gộp theo khóa khách hàng kèm chi tiết từng cơ sở. Đổi trạng thái xử lý ở `Cả hai` ghi cho **cả hai cơ sở trong một giao dịch database**: hoặc cả hai cùng đổi hoặc không có gì đổi; mỗi cơ sở lưu chữ ký cảnh báo của chính nó. File Excel công nợ ở `Cả hai` tách một dòng cho mỗi cơ sở.
- **Nhân sự, Vòng đời đơn hàng, Đứt hàng:** nhân sự/nghỉ phép hiển thị cả hai cơ sở kèm cột và bộ lọc cơ sở; ghi nhận đơn nghỉ ở `Cả hai` lấy cơ sở từ hồ sơ nhân sự, không xác định được thì yêu cầu chọn. Vòng đời đơn hàng gắn nhãn cơ sở cho từng đơn. Kiểm tra đứt hàng ở `Cả hai` quét lần lượt từng cơ sở rồi gộp; một cơ sở lỗi thì cả lần quét báo lỗi.

## 5.8. Bot Telegram riêng cho quản lý nghỉ phép

- Bot chạy cùng máy chủ dashboard, dùng chung đơn PostgreSQL với bot xin nghỉ của nhân viên (ngoài repo). Mọi đơn **Xin nghỉ phép** mới gửi cho quản lý phù hợp, kể cả đơn `Vi phạm`; khi bật hệ thống, gửi bù đơn `Chưa duyệt`/`Vi phạm` chưa gửi. Bản ghi **Tự ý nghỉ (HR ghi nhận)** không gửi qua bot này.
- Người duyệt đang hoạt động, có `hr.leave.manage`, phòng ban được cấp và cơ sở được gán phù hợp với đơn; nhân viên được cấp quyền cũng được duyệt và được tự duyệt. Gửi tất cả người phù hợp, một quyết định thành công chốt phiên bản. Nếu không có người phù hợp, dùng quản trị cao nhất đang hoạt động; thiếu cả dự phòng thì giữ chờ và cảnh báo. Telegram ID/Start chỉ quyết định khả năng giao tin, không quyết định có người duyệt web.
- Người duyệt chọn Phê duyệt hoặc Từ chối. Từ chối mở Mini App tên nhân viên, OK/Hủy, lý do tùy chọn trim tối đa 500 ký tự; initData 15 phút. Phiên reply cũ tiếp tục đến hết hạn.
- Đã duyệt/Từ chối khóa thao tác tiếp trên Telegram; người đủ quyền vẫn đổi được trên web (chuyển về trạng thái chưa kết thúc mở lại Telegram). Các tin đã gửi cập nhật theo quyết định mới; thao tác cũ/trùng/đồng thời không ghi đè quyết định mới hơn.
- Trạng thái đơn nghỉ: `Chưa duyệt`, `Đã duyệt`, `Từ chối`, `Vi phạm` (đã gỡ `Tạm duyệt` ngày 02/10/2026).
- Bot nhân viên tiếp tục nhận đơn và báo kết quả cho nhân viên; bot quản lý không thay đổi quyền sở hữu liên kết Telegram hay phiên xin nghỉ của bot đó.
- Thông báo gần thời gian thực chỉ khi máy chủ chạy liên tục (quét mặc định 5 giây); máy chủ ngủ/tắt thì trì hoãn đến khi chạy lại. Hướng dẫn: [thiết lập bot](../telegram-manager-leave-setup.md).

## 5.9. Vị trí hàng

- Mọi tài khoản nội bộ (không phải Khách) tra cứu vị trí hàng Hà Nội/Sài Gòn từ workbook Google Sheets dùng chung. Nhóm riêng trên sidebar có hai tab theo cơ sở đang chọn; bảng 6 cột (Mã hàng, Tên hàng, Tổng SL, Ghi chú hàng hóa, Ngày về, Vị trí), tìm mã/tên/vị trí không dấu, 100 dòng/trang, không xuất file.
- Giữ từng dòng nguồn kể cả mã trùng, SL = 0 hoặc vị trí trống. Dữ liệu đọc mới mỗi lần mở tab/tải lại. Khách bị chặn hoàn toàn, kể cả khi được ghi đè cấp quyền. Xem [thiết lập/nguồn](../stock-locations-setup.md).

## 5.10. Vòng đời đơn hàng

- Trang liệt kê **mọi đơn đặt hàng KiotViet** của hai cơ sở (Phiếu tạm, Đã xác nhận, Đang giao hàng, Hoàn thành, Đã hủy) ghép với Google Sheet theo (cơ sở, mã đơn) để lấy trạng thái vòng đời (Đơn chưa gửi kế toán → Đã gửi kế toán → Đang được giao → Đã giao thành công → Đã nhận (Tại kho) → Đã nhận (Đi giao xong); thêm Sự cố/Đã hủy qua ghi đè).
- Có Trạng thái KiotViet, Ghi chú, Giá trị đơn và **Giá trị có bán** (đơn Phiếu tạm: Σ min(SL đặt, tồn) × đơn giá); lọc, sắp xếp, phân trang chạy ở máy chủ; bấm dòng xem chi tiết đơn.
- Tra cứu theo mã, Lịch sử cập nhật, Ghi đè trạng thái (mặc định chỉ Quản lý) và Xuất Excel (mặc định chỉ Quản lý, tối đa 20.000 dòng) đều là quyền phụ của quyền Vòng đời đơn hàng. Nhân viên kho, marketing, mua hàng và Khách không có trang này.

## 5.11. Báo cáo Marketing

Tab cấp 2 `/reports/#marketing` giúp Quản lý, Trợ lý và Nhân viên Marketing đọc BC tháng, Check tỷ lệ nhận số, Sao lưu SĐT và Báo cáo chi phí từ ba workbook Google Sheets. Bộ lọc mỗi phần độc lập; ba báo cáo tháng mặc định tháng hiện tại theo giờ Việt Nam, SĐT mặc định toàn bộ các tab CHUẨN. Bấm dòng tổng quan mở khung chi tiết giữa màn hình để tra cứu theo cùng phạm vi và đối chiếu số tổng nguồn với các dòng tìm thấy.

Dữ liệu chỉ đọc, giữ kết quả công thức, không gộp trùng SĐT giữa page, không cộng dòng tổng tháng chi phí với dòng ngày. Tự làm mới mỗi 5 phút khi đang xem; lỗi nguồn giữ dữ liệu cũ và thời điểm cũ. Tuân thủ Design System và giao diện các tab báo cáo hiện có. Không sửa Sheets, xuất file, dựng lịch sử từ THÔ hoặc truy vấn KiotViet. Nghiệm thu đủ nguồn cần Viewer cho service account trên cả ba workbook, gồm workbook SĐT. Xem [cấu hình và nghiệm thu](../marketing-report-setup.md); chưa xác nhận triển khai production.

Từ 19/10/2026 (không đổi nghiệp vụ, chỉ đổi độ tươi/hiệu năng): chi phí ADS được chép từ Google Sheets vào Postgres mỗi 30 phút nên khi bảng đã có dữ liệu, báo cáo Chi phí không còn gọi Google Sheets lúc mở trang (số có thể chậm tới ~30 phút so với sheet; bảng chưa có hoặc quá 3 giờ thì đọc Sheets như cũ); doanh số KiotViet theo tên khách và tổng hợp SĐT Pancake được tính sẵn trong cơ sở dữ liệu, thiếu thì tự dùng cách tính cũ.

## 5.12. Quản lý nhân sự

- **Quy định công ty:** hai tài liệu dựng sẵn (Giờ giấc làm việc, Quy định nghỉ phép) và PDF do Quản lý tải lên; gỡ/khôi phục mặc định; thêm/gỡ tài liệu báo lên chuông thông báo.
- **Danh sách nhân sự:** xem và xuất Excel; là nguồn đối chiếu vai trò theo bộ phận cho tài khoản.
- **Nghỉ phép:** bảng đơn có lọc cơ sở/phòng ban/ngày, phân trang, cảnh báo nghỉ gấp, xuất Excel; Quản lý nhập tay "Tự ý nghỉ" và duyệt/từ chối; lịch nghỉ phép ở thanh header cho mọi trang; thông báo chuông cho đơn mới. Quy tắc nghiệp vụ theo CSNS-NP-01.

# 6. Lợi ích kỳ vọng

- Tiết kiệm thời gian tổng hợp báo cáo thủ công từ KiotViet và Google Sheets.
- Ra quyết định nhanh hơn nhờ số liệu trực quan, cập nhật gần thời gian thực từ Supabase PostgreSQL.
- Chuẩn hóa cách theo dõi số liệu nội bộ, giảm phụ thuộc vào đọc sheet thô.
- Tập trung vận hành (công nợ, vòng đời đơn hàng, vị trí hàng, nghỉ phép) vào một hệ thống có phân quyền rõ ràng.
- Nền tảng kiến trúc dễ mở rộng theo lộ trình dài hạn.

# 7. Giả định & ràng buộc

## 7.1. Giả định

- Supabase PostgreSQL lưu toàn bộ dữ liệu nghiệp vụ với schema trong `server/db/SCHEMA.md`, đã thiết kế đến migration `0044`.
- Service Account Google được cấp Viewer trên Bảng Công nợ, Vị trí hàng và ba workbook Marketing, Editor trên workbook Vòng đời đơn hàng.
- Scheduler Node.js hoạt động liên tục (một instance) để dữ liệu được cập nhật gần thời gian thực.
- Bot xin nghỉ của nhân viên vận hành ngoài repo và ghi trực tiếp vào Postgres.
- Số người dùng đồng thời khoảng 10–50 (nội bộ).

## 7.2. Ràng buộc

- Dữ liệu KiotViet phụ thuộc tốc độ polling và hạn mức KiotViet API; webhook không phải nguồn cập nhật.
- Bảng Công nợ, Vòng đời đơn hàng, Vị trí hàng, Báo cáo Marketing phụ thuộc cấu trúc header của Google Sheets; đổi tên tab/cột có thể làm tính năng báo lỗi cấu hình.
- Job nặng chạy một lần/đêm (Báo cáo hàng hóa, chi tiết hóa đơn 90 ngày) nên số liệu hôm nay chỉ xuất hiện ở đêm sau; giao diện ghi rõ mốc.
- Hiệu năng: cache hai tầng, phân trang, tải theo tab; hạn chế IO Postgres (job chỉ ghi dòng thay đổi).

# 8. Tiêu chí nghiệm thu (Acceptance Criteria)

- Dashboard hiển thị đủ KPI, biểu đồ, bảng với dữ liệu đúng từ Supabase PostgreSQL; chỉ tab/mục tài khoản có quyền mới hiện.
- Bộ lọc Từ – Đến của từng bảng đổi dữ liệu đúng khoảng ngày thực tế; "xóa cả hai ô" nghĩa là Tất cả.
- Sau mỗi lượt đồng bộ + rollup, tab đang xem tự cập nhật qua SSE; nút "Làm mới" và quay lại tab ≥ 60 giây tải lại dữ liệu.
- Mốc ngày lọc, chuỗi ngày trên biểu đồ và `updatedAt` thống nhất theo Asia/Ho_Chi_Minh.
- Doanh thu thực tế đã trừ hàng khách trả ở mọi nơi (theo ngày, theo khách, theo hàng hóa, Báo cáo hàng hóa).
- Xuất Excel/HTML các bảng với tùy chọn trường; tối đa 2 file xuất đồng thời.
- Bảng lớn phân trang 100 dòng/trang, tìm/sắp xếp trên toàn bộ dữ liệu đã lọc, cột thời gian sắp theo thời gian thật.
- CN1/CN3/CN7 tính chính xác và lưu trong `customer_debt_activity_periods`; cảnh báo "Chưa thu" đối chiếu đúng.
- Tài khoản chọn `Cả hai` thấy KPI/biểu đồ cộng dồn hai cơ sở, giao dịch trùng mã giữ hai dòng kèm nhãn cơ sở, không có giá trị `Cả hai` nào được ghi vào dữ liệu nghiệp vụ.
- Đổi trạng thái công nợ ở `Cả hai` cập nhật cả hai cơ sở hoặc không đổi gì khi có lỗi.
- Vòng đời đơn hàng hiển thị đủ đơn KiotViet, lọc/phân trang ở máy chủ, quyền phụ gắn đúng quyền gốc.
- Vị trí hàng đọc đúng 6 cột của hai sheet, Khách bị chặn.
- Tự đăng ký trả `REGISTRATION_DISABLED` khi chưa bật; ID Telegram chỉ Quản lý sửa được và chống trùng.
- Bot quản lý giao đơn đúng cơ sở, loại tài khoản không đủ điều kiện và bản ghi tự ý nghỉ; Phê duyệt/Từ chối đồng bộ với web và mọi bản tin; nút cũ/đồng thời không ghi đè; phiên lý do chỉ nhận reply đúng tin, giới hạn 500 ký tự, hết hạn 15 phút; webhook không secret hợp lệ bị từ chối.
- Bộ kiểm thử tự động vượt qua: **2.207 test đạt (2.207/2.214, 3 bỏ qua)** ghi nhận 12/10/2026; 4 test lỗi cũ ở xuất Excel tồn kho không thuộc phạm vi.
- Hệ thống ổn định trên Render.com, uptime ≥ 99% trong giờ hành chính.

# 9. Kế hoạch triển khai tổng quan

## 9.1. Giai đoạn 1 & chuyển đổi PostgreSQL (đã hoàn thiện)

| **Bước**                          | **Nội dung**                                                                                      | **Trạng thái** |
|-----------------------------------|---------------------------------------------------------------------------------------------------|----------------|
| 1. Phân tích & thiết kế            | BRD, SRS, BPMN; thiết kế kiến trúc Supabase PostgreSQL                                           | Hoàn thành     |
| 2. Engine đồng bộ KiotViet        | `server/kiotvietSync/`: polling fast/slow, rollup, backfill, reconcile, job nền                  | Hoàn thành     |
| 3. Backend Node.js/Express         | API báo cáo theo tab, công nợ, auth/phân quyền, nhân sự, vòng đời đơn hàng, vị trí hàng          | Hoàn thành     |
| 4. Frontend HTML/CSS/JS            | Báo cáo tổng hợp, Quản lý công nợ, Vòng đời đơn hàng, Vị trí hàng, Nhân sự, Tài khoản             | Hoàn thành     |
| 5. Lớp hiệu ứng 3D                 | Đã gỡ bỏ hoàn toàn; giao diện 2D tối ưu hiệu năng                                                 | Đã gỡ bỏ       |
| 6. Xuất file                       | `exportService.js`: Excel/HTML nhiều worksheet, tùy chọn trường                                   | Hoàn thành     |
| 7. Bot Telegram quản lý nghỉ phép  | Code, migration `0029`/`0030`, tài liệu thiết lập; bật production theo hướng dẫn vận hành        | Code hoàn thành; vận hành chờ cấu hình |
| 8. Triển khai Render.com           | `tokosi.onrender.com`, kết nối Supabase                                                           | Hoàn thành (xác nhận phiên bản deploy ngoài phạm vi tài liệu) |

## 9.2. Lộ trình dài hạn (định hướng)

| **Giai đoạn**                                   | **Nội dung chính**                                                                                      | **Ghi chú**                                                          |
|-------------------------------------------------|---------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------|
| Giai đoạn 2 — Phân quyền & báo cáo              | Phân quyền theo tính năng, quản lý tài khoản (đã hoàn thành); xuất PDF cho báo cáo (chưa làm)          | Phần còn lại: PDF                                                    |
| Giai đoạn 3 — Bán hàng/POS                      | Tạo đơn bán, quản lý khách hàng, công nợ, in hóa đơn — tương đương nghiệp vụ KiotViet                  | Sau Giai đoạn 2                                                      |
| Giai đoạn 4 — Kho đa chi nhánh                  | Nhập/xuất/chuyển kho, tồn kho theo từng kho, kiểm kê định kỳ cho 5.000–20.000 SKU                      | Phụ thuộc dữ liệu chuẩn hoá từ Giai đoạn 3                           |
| Giai đoạn 5 — Phân tích & phát hiện bất thường  | Phân tích doanh số, dự đoán nhu cầu nhập hàng, phát hiện sai lệch tồn kho/giá bất thường               | Cần dữ liệu lịch sử đủ lớn từ Giai đoạn 3–4                          |
| Giai đoạn 6 — Danh bạ phòng ban                 | Sơ đồ tổ chức, danh bạ nhân sự (dạng xem thông tin)                                                    | Có thể triển khai song song, độc lập                                 |
| Giai đoạn 7 — Trợ lý AI                         | Chatbot hỏi-đáp số liệu bằng ngôn ngữ tự nhiên; AI dự đoán & phát hiện bất thường                      | Ưu tiên chatbot trước                                                |
| Giai đoạn 8 — Thay thế KiotViet                 | Ngừng sử dụng KiotViet, chuyển hoàn toàn nghiệp vụ sang hệ thống mới                                   | Chỉ thực hiện khi Giai đoạn 3–4 đã ổn định và nghiệm thu             |

*— Hết tài liệu BRD v2.2 —*


## Bổ sung 05/10/2026 — nghỉ phép và tài khoản

Người duyệt đang hoạt động, có `hr.leave.manage`, phòng ban được cấp và cơ sở được gán phù hợp với đơn; nhân viên được cấp quyền cũng được duyệt và được tự duyệt. Gửi tất cả người phù hợp, một quyết định thành công chốt phiên bản. Nếu không có người phù hợp, dùng quản trị cao nhất đang hoạt động; thiếu cả dự phòng thì giữ chờ và cảnh báo. Telegram ID/Start chỉ quyết định khả năng giao tin, không quyết định có người duyệt web.

Nhân viên HR hoạt động tự gửi đơn web bằng danh tính server, giữ phòng ban lúc gửi, tính thời gian Việt Nam. Quản lý mới chọn phòng ban; quản lý cũ mọi phòng ban một lần; cấp nhân viên lần đầu mặc định phòng ban mình, grant không đổi theo chuyển phòng ban. Tự ý nghỉ có quyền riêng. Web/Telegram version chống ghi đè; web sửa/mở lại. Mini App có tên nhân viên,lý do tùy chọn500 ký tự,OK/Hủy; `/donnghi`10 đơn/trang. Bảng người dùng chọn trường theo danh mục Excel,tên cố định,lưu riêng tài khoản,mặc định lọc hoạt động. [Hợp đồng](../hr-leave-upgrade.md). Migration `0031` và staging trước production.

## Bổ sung 09/10/2026 — ngày đặc biệt

Nhu cầu: nhắc mọi người dùng nội bộ biết ngày lễ Việt Nam và sinh nhật Nguyễn Ngọc Việt Thắng (27/10) ngay trên web, không cần thêm kênh khác. Giải pháp: thông báo chuông cho tài khoản có quyền xem lịch nghỉ phép và hiệu ứng pháo hoa thay sao băng trong các ngày đó; lịch nghỉ phép giữ nguyên. Ngày nghỉ bù hoặc nghỉ thêm do Chính phủ công bố từng năm không được tự tính.

## Marketing Pancake — cập nhật 12/10/2026

Mục tiêu giảm thao tác xuất/import SĐT hằng ngày bằng đồng bộ 23:55 Việt Nam, giữ lịch sử và doanh số KiotViet. Chỉ Quản lý nhập BC tháng trên web, ADS vẫn Sheets. Mã T3–T6 đã triển khai và qua kiểm thử; nguồn chính thức vẫn là Sheets. Ngày 12/10/2026 đã khôi phục ID tin nhắn từ sáu bản xuất đầy đủ (migration 0046): 18.304 dòng lịch sử thật đều có liên kết (18.294 duy nhất, 7 chỉ khác cách viết số +84/0 thừa đã kiểm cùng giây-cùng nhân viên, 3 dòng thuộc cặp tin tương đương = 6 liên kết); chỉ còn dòng tiêu đề lặp BL THÔ!1950 (không phải quan sát). 3.148 tin trong kỳ nằm ngoài nền Sheets được ghi sổ riêng, không tính. Đồng bộ thật đủ sáu page đạt (slot 12/10): 11.797 fact, 2.478 quan sát cùng ngày ghi nhận 12/10 (thay đổi nhân viên tích lũy từ lúc dán Sheets và 861 tin mới), 0 mục chưa giải quyết, 0 dòng lịch sử chưa liên kết; nền lịch sử khớp CHUẨN (11.942 nhóm SĐT); tổng khớp chi tiết 100/100 (T10) và 80/80 (T9). Công tắc job vẫn TẮT và nguồn vẫn Sheets: chưa có ba đợt hằng đêm đối soát, chưa cấu hình token trên Render. Lưu ý nghiệm thu: lần đồng bộ đầu dồn các thay đổi nhân viên cũ vào ngày 12/10 nên "chào lại" tháng 10 tăng mạnh (179 → 1.660); cần Quản lý xác nhận cách tính trước khi chuyển nguồn.

## Bổ sung 12/10/2026 — Vòng đời đơn hàng, Detail panel & Giảm egress

- **Khung chi tiết dùng chung (`detail-panel.css`):** Chuẩn hóa toàn bộ các hộp xem chi tiết trên dashboard (Chi tiết giao dịch, Báo cáo hàng hóa theo khách, Báo cáo kinh doanh Sale/Khách/Mã hàng, Chi tiết đơn Vòng đời, Chi tiết nghỉ phép, Chi tiết Marketing) thành thiết kế thống nhất: có hàng chỉ số tổng quan ở đầu hộp (`.dp-stats`), 1 khung cuộn mượt mà, tiêu đề dính. Từ 16/10/2026 mọi bảng thống nhất một kiểu tiêu đề sắp xếp (▲▼ chưa sắp, ▼ tăng dần, ▲ giảm dần, biểu tượng cố định ở mép phải ô) và bảng trong hộp chi tiết cũng có sắp xếp, kéo độ rộng cột, chọn "Cột hiển thị".
- **Vòng đời đơn hàng:** Bổ sung dải thẻ chỉ số tổng quát và lọc nhanh đầu trang; hỗ trợ 6 luồng đơn (HN, SG, Bắc-Nam `DonHang_MienNam`, Khách/Ship lấy tại kho `Khách_HN`/`Khách_SG`, Kế toán/Chứng từ `KeToan_ChungTu` dùng chung HN+SG với 2 trạng thái Đơn chưa gửi kế toán / Hoàn thành) và 6 loại cảnh báo có tên (Kế toán sót đơn [chỉ khi ở trạng thái Đơn đã gửi kế toán], Lái xe chưa chụp đơn, Lái xe quên chụp, Chưa nhận đơn quá 6 giờ, Khách/Ship chưa lấy, Chưa chụp bill tàu).
- **Phân trang Nhân sự & Tài khoản:** Bổ sung điều khiển phân trang chuẩn (`table-controls.js`) cho bảng nhân sự, chấm công, nghỉ phép và quản trị người dùng.
- **Giảm egress Supabase (migration 0044):** Tối ưu hóa đối soát phiếu nhập bằng hash (`purchases.raw_hash`), cache hóa đơn theo sự kiện, nạp lazy bot Telegram và realtime nghỉ phép rút gọn.

## Bổ sung 13/10/2026 — Báo cáo công nợ theo lịch thanh toán

Quy tắc cố định 1-3-7-Hàng tuần được thay bằng lịch thanh toán riêng cho từng khách tại từng cơ sở (số ngày nợ tối đa). Báo cáo chốt lúc 15:00 mỗi ngày, cảnh báo quá hạn khi có nợ vượt lịch, Sale và Quản lý phản hồi trực tiếp trên bảng (lưu DB, làm mới mỗi chu kỳ), mọi thay đổi có lịch sử.

Bổ sung 14/10/2026: bổ sung điểm/thưởng trực tiếp vào bảng phạt trong Chỉ số then chốt của tab Công nợ. Điểm theo từng khách (cơ sở + mã): số hóa đơn Hoàn thành và doanh số sau trừ trả hàng trong tháng; >=30 điểm mới xếp hạng chung HN + SG theo phạt gốc/điểm tăng dần, điểm giảm dần; bằng tỷ lệ và điểm thì đồng hạng kiểu 1–2–2–4, tên chỉ dùng sắp dòng hiển thị. Top 1–20 miễn phạt; Top 10 nhận quỹ max(80% phạt phải nộp, 3 triệu), 50% theo trọng số hạng 19–17–15–13–11–9–7–5–3–1 và 50% theo tỷ trọng điểm; thiếu 10 người chuẩn hóa trọng số, chia hết quỹ đến đồng. Sửa phạt chỉ thay phạt gốc từng khách; miễn phạt áp ở mức sale. GET /api/debt-management/penalty-board?month=YYYY-MM trả bảng từ backend (mặc định tháng chu kỳ đang mở), lọc cơ sở sau khi tính hạng/quỹ toàn công ty. Giao diện, hộp chi tiết và xuất Excel/HTML dùng cùng kết quả; context.debtRewardMonth chọn tháng xuất. Kết quả tháng cũ lưu bất biến trong debt_reward_months sau bản chốt 15:00 đầu tháng mới, khi đã chốt hết sổ phạt và doanh số tháng. Lỗi chốt thử lại mỗi phút; thiếu lịch sử phạt có cảnh báo rõ, không bù thành 0.

Bổ sung 17/10/2026: tab Công nợ có thêm bảng **Tuổi nợ theo hóa đơn** cập nhật cận thời gian thực (theo lần đồng bộ KiotViet, không chờ chốt 15:00) để tra cứu mỗi khách đang nợ tương đương bao nhiêu ngày hóa đơn và còn bao nhiêu ngày trước khi chạm lịch thanh toán (Còn hạn ≤ 0 bôi đỏ). Số liệu tính sẵn trên máy chủ vào bảng riêng, trình duyệt chỉ đọc; xuất Excel/HTML theo bộ lọc đang xem. Cập nhật cùng ngày: mục được **đổi tên "Kiểm tra công nợ" và đặt đầu tab Công nợ** (trước các khung Chỉ số then chốt / Danh sách thao tác, đánh lại số 1–3); bấm 1 dòng khách mở **hộp chi tiết hóa đơn** (hộp `#docModalBackdrop` dùng chung, kind `debtAgingInvoices`) liệt kê hóa đơn Hoàn thành của khách từ ngày hết nợ đến nay (Mã hóa đơn · Khách hàng · Nhân viên bán hàng · Ngày · Số tiền, tối đa 500, mới nhất trước) kèm hàng chỉ số tổng quan, sort cột và "Cột hiển thị"; API `GET /api/debt-management/aging/invoices?branch=&customerId=` (quyền `reports.debt`, chặn cơ sở ngoài quyền, đọc `invoices` trực tiếp, không migration mới).

2026-10-17 (bổ sung) — Tab Công nợ, mục 3 Tuổi nợ: **Ngày nợ tương đương = hôm nay − ngày hết nợ + 1** (tính cả ngày hết nợ; hết nợ hôm nay = 1 ngày, khách vượt khoảng tra cứu 30 ngày hiện ≥ 30), **Còn hạn** vẫn = Lịch TT − Ngày nợ tương đương. Cột Còn hạn tô màu theo dấu: âm đỏ, 0 vàng, dương xanh lá — áp dụng cả trên bảng web, hộp chi tiết hóa đơn, file Excel (màu chữ) và file HTML (cột đánh dấu `signTone`); cột số căn phải (table-align.js nhận diện cả ≥/≤). Độ rộng cột mặc định của bảng được đặt lại. Không migration; bảng tính sẵn `0059` tự cập nhật ở lượt `debtAgingRefresh` kế tiếp.

17/10/2026 — Báo cáo hàng hóa thêm hai cột **Đơn giá HN / Đơn giá SG** sau Tên sản phẩm (giá bán chung KiotViet từng cơ sở, migration `0063`), mặc định hiện cho Quản lý/Trợ lý (19/10/2026) và có trong file Excel/HTML xuất, chỉ Quản lý và Trợ lý (quyền `reports.products.price`) được thấy; API không trả giá cho tài khoản khác.

19/10/2026 — Báo cáo hàng hóa thay phần ghép tay của sheet **BC CHUNG** (VLOOKUP từ ONRENDER + gõ tay SL 30 ngày HN/SG, Đứt HN/SG, SL đơn 90/30 ngày, giá vốn): bảng web và file Excel/HTML nay có đủ 34 cột cùng thứ tự BC CHUNG, dữ liệu tính sẵn trong DB và cập nhật cận thời gian thực. Cột mới: Giá trị có bán HN/SG (Có bán × Đơn giá cùng cơ sở), SL bán 30 ngày HN/SG, Đứt HN/SG (tổng số ngày đứt hàng 30 ngày gần nhất, cập nhật sau mỗi lần chạy "Quét đứt hàng 30 ngày"; chưa quét = 0, không có lịch tự chạy), Ngày SG + ĐC / Ngày HN / Ngày 2 miền (số ngày bán hết), SL đơn 90/30 ngày và Tăng trưởng (= SL đơn 30 ngày × 3 ÷ SL đơn 90 ngày − 1), cùng DS khách lớn nhất. Đơn giá (chính là "giá vốn" của BC CHUNG) dời xuống cuối bảng; Giá trị có bán và Đơn giá chỉ Quản lý/Trợ lý (`reports.products.price`). Migration `0067` phải áp trước khi deploy; nhắc người dùng chạy "Quét đứt hàng 30 ngày" cơ sở "Cả hai" lần đầu.

Cập nhật gần nhất: 22/10/2026.

Điều chỉnh 15/10/2026: trong tháng hiển thị điểm/hạng, thưởng tạm tính và tổng phạt từ các ngày ĐÃ CHỐT, không cộng chu kỳ đang mở. Lúc 14:59 giờ Việt Nam lưu bản cuối của chu kỳ 15:00 hôm trước–14:59 hôm sau, mỗi chu kỳ đúng một lần và không ghi đè; 15:00 mới reset. Nhiều lần Tính lại trong chu kỳ chỉ cập nhật bản đang mở, không cộng thành nhiều ngày. Tiền thưởng hiện mỗi ngày với nhãn Thưởng tạm tính, thay đổi theo điểm và tổng phạt đã chốt ngày; chỉ chốt/lưu thưởng chính thức một lần khi kết thúc tháng. Web, hộp chi tiết và file xuất đều phân biệt tạm tính/đã chốt.

Đồng hạng (15/10/2026): bằng Phạt gốc/Điểm và tổng điểm thì cùng hạng, xếp 1–2–2–4. Tất cả đồng hạng 10 nhận thưởng, đồng hạng 20 miễn phạt. Nhóm đồng hạng gộp trọng số các vị trí chiếm trong Top 10 rồi chia đều, các vị trí ngoài 10 không thêm trọng số; giữ nguyên tổng quỹ, thưởng theo điểm chia trong toàn bộ nhóm nhận thưởng. Bản tháng đã chốt giữ nguyên quy tắc cũ; bản mới dùng debt-reward-2026-10-v2-shared-ranks.

Cùng khách ở 2 cơ sở (15/10/2026): ở bảng tổng thưởng/phạt sale, cùng 1 khách (cùng tên, không phân biệt hoa/thường và khoảng trắng thừa) bị phạt ở cả HN và SG trong cùng 1 ngày chốt chỉ tính mức phạt cao nhất ở 1 cơ sở, không cộng dồn (bằng nhau lấy Hà Nội); khách đó đếm 1 lần trong "Khách phạt", tổng các dòng ngày ở hộp chi tiết sale khớp Phạt gốc. Chỉ đổi lúc đọc (`debtRewardService.DAYS_SQL`); sổ `debt_penalty_daily`, bảng chi tiết khách và tháng đã chốt giữ nguyên, không migration. Quy tắc mới debt-reward-2026-10-v4-cross-branch-max.


Khách hoạt động (15/10/2026): toàn bộ tính năng Công nợ chỉ dùng khách đang hoạt động, kể cả khách đã hết nợ khi tính điểm. Lọc danh sách/KPI/bản chốt đang xem, phạt theo ngày và tháng, điểm thưởng, hộp chi tiết, xuất file và nhập lịch TT; khách không còn hồ sơ không được chuyển thành điểm Chưa phân nhóm. Lọc trước bước chọn khách mới nhất theo cơ sở+mã. Đồng bộ chuẩn hóa raw.isActive, xử lý removedIds và đối soát toàn bộ lần đầu/mỗi ngày; chỉ đánh dấu khách vắng mặt sau một lượt đầy đủ đã kiểm tra tổng/trang/ID. Không xóa dữ liệu nguồn hoặc sổ phạt; kết quả thưởng tháng đã chốt vẫn bất biến. Quy tắc mới debt-reward-2026-10-v3-active-customers; không migration.


21/10/2026 — Nhu cầu nghiệp vụ: Sài Gòn tạo đơn đặt hàng Phiếu tạm (khách "Điều chuyển SG", KH010020) tại Kiot Hà Nội nhưng Hà Nội chưa xuất kho nên chưa vào cột Điều chuyển SG. Báo cáo hàng hóa thêm cột **YC điều chuyển** hiển thị số lượng này theo mã hàng và cộng vào Tổng có bán + ĐC, Tổng tồn thực + ĐC.
16/10/2026 — Theo yêu cầu, Báo cáo hàng hóa (Tổng quan) thêm cột **Điều chuyển SG** giữa **Tồn HN** và **Tồn SG**, giữ Chưa bốc/Đã bốc. API và Excel/HTML dùng chung inTransitSource: tổng số lượng Đặt hàng nhập Đã xác nhận NCC của Kiot Sài Gòn trong DB, ghép mã trim/không phân biệt hoa thường. Theo yêu cầu tiếp theo, Tồn có bán = Có bán HN + Có bán SG + Điều chuyển SG, áp dụng riêng Báo cáo hàng hóa; hai cột Chưa bốc/Đã bốc không cộng vào công thức. Snapshot DB giữ số nền HN+SG đã trừ phiếu tạm, repository cộng điều chuyển đúng một lần khi đọc cho web/xuất file. Không migration, không sửa nguồn Sheets.

16/10/2026 — Gỡ tab Khách hàng cũ (Top khách theo doanh thu, Chi tiết khách nợ, quyền `reports.customers`, `view=customers`); tab Báo cáo kinh doanh đổi tên thành **Khách hàng** (giữ khóa quyền `reports.business`), Báo cáo tổng hợp còn 6 tab.

16/10/2026 — Tab Hàng hóa còn Báo cáo hàng hóa (từ Tổng quan) + Tăng trưởng mã hàng (từ tab Khách hàng); các mục cũ của tab Hàng hóa và quyền `reports.products.cost` đã gỡ.

16/10/2026 — **Báo cáo hàng hóa cơ cấu lại theo file HÀNG HÓA.xlsx (migration `0057`)**: bảng (tab Hàng hóa, `/reports/#products`) còn 19 cột — Mã sản phẩm, Tên sản phẩm, Chưa bốc, Đã bốc, Tồn thực HN, Có bán HN, Điều chuyển SG, Tồn thực SG, Có bán SG, Mô tả HN, Mô tả SG, Tổng tồn thực + ĐC, Tổng có bán + ĐC, SL bán 30 ngày, Ngày cần đặt, DS 90 ngày, SL khách bán, Khách lớn nhất, Tỉ trọng khách lớn nhất. **Có bán HN/SG** = tồn thực từng cơ sở trừ phiếu tạm của chính cơ sở đó (cộng hai cột = cột Tổng có bán đã lưu trừ phần Điều chuyển SG); **Mô tả HN/SG** = trường Mô tả sản phẩm trên KiotViet từng cơ sở (nhân viên ghi bảng giá cho sale tra cứu); **Ngày cần đặt** = (Tổng có bán + Chưa bốc + Đã bốc) × 30 ÷ SL bán 30 ngày, 1 số thập phân, để trống khi không bán được trong 30 ngày hoặc chưa có snapshot hàng dự kiến. **Khung nhìn mặc định**: Nhân viên sale hiện cột 1–11 + DS 90 ngày; Quản lý (và mọi vai trò khác) ẩn Tồn thực HN → Mô tả SG; chỉ là mặc định hiển thị, ai cũng đổi lại được bằng "Cột hiển thị". **Hộp chi tiết** đảo thứ tự: Hàng dự kiến lên đầu, sau đó Doanh số theo khách (kèm bảng Khách hàng); bấm số Chưa bốc/Đã bốc mở hộp ở mục Hàng dự kiến, bấm Tỉ trọng khách lớn nhất mở hộp và cuộn tới Doanh số theo khách. Migration `0057` thêm 4 cột nullable vào `product_report` (`available_hanoi`, `available_saigon`, `description_hanoi`, `description_saigon`; NULL = chưa tính lại, hiện "—"); job đêm và job tăng dần cùng ghi các cột này nên cận thời gian thực khi bật `REPORTS_INCREMENTAL_ENABLED`. Xuất Excel/HTML theo cùng thứ tự cột (nhãn viết đủ chữ). **Triển khai: áp `0057` TRƯỚC khi deploy mã mới**; sau khi áp, job đêm tự tính lại ở lượt kiểm tra 5 phút kế tiếp (hoặc chạy tay `node kiotvietSync/productReportRefresh.js` trong `server/`).

## Marketing 16/10/2026
Phương án B đã duyệt: tập SĐT/KPI Pancake riêng trong PostgreSQL, ngày tạo tin UTC+7, assignment chỉ từ nhật ký quan sát; không phụ thuộc đối soát hay baseline Sheets. BC chốt nhập web/DB có nguồn riêng, chưa đủ thì —. Doanh số KiotViet; chi phí ADS/VAT/phí thuê Sheets. Xem docs/marketing-report-setup.md về nguồn, coverage và trạng thái kích hoạt.

## Bổ sung 17/10/2026 — Kế toán – Nháp VAT

- **Vấn đề**: kế toán phải xuất file "Danh sách chi tiết hóa đơn" từ KiotViet cho từng lô hóa đơn khách cần VAT rồi upload vào app riêng (vat-draft-app) để phân bổ nguồn nháp và tạo QR; dữ liệu này tks_web đã có sẵn trong Postgres.
- **Giải pháp**: trang "Kế toán – Nháp VAT" trong tks_web có đủ 3 chức năng của app cũ (Xử lý hóa đơn, Tra cứu nguồn, Tạo QR), chọn thẳng hóa đơn và đơn đặt hàng chưa xuất hóa đơn theo mã sale báo (không cần xuất/nhập file), thêm cột **Ghi chú tổng** cạnh Ghi chú hàng hóa để biết ngữ cảnh cả đơn khi nháp.
- **Người dùng**: mặc định Quản lý; kế toán nào được dùng thì Quản lý bật quyền riêng.
- **Thành công**: dán mã HD/DH → ra đúng bảng phân bổ và QR như app cũ (đã đối chiếu khớp 100%), có ghi chú tổng, không mở KiotViet xuất file.
- **Ngoài phạm vi**: chuyển Gộp VAT/Khớp mã vào DB, 2 trang quản trị của app cũ, xuất template hóa đơn điện tử, tra MST, đổi thuật toán; tắt vat-draft-app làm sau khi nghiệm thu.
- **Điều chỉnh 17/10/2026 (chiều)**: bỏ chức năng Tra cứu nguồn (không còn dùng). Tạo QR hiện mã QR to ở cột phải cho dễ quét. Nhân viên sale được dùng riêng Tạo QR (tạo QR thu tiền cho khách) mà không thấy Xử lý hóa đơn.
- **Điều chỉnh 19/10/2026**: hóa đơn kế toán nhận thường là ảnh chụp/screenshot hoặc PDF scan nên đọc lớp text PDF không dùng được. Tạo QR chuyển sang cho AI (xKiro, model Qwen vision miễn phí) đọc ảnh/PDF: lấy tên công ty bán hàng và Tổng cộng tiền thanh toán, tự chọn tài khoản công ty và tạo QR; người dùng chỉ kiểm tra lại số tiền. Ảnh hóa đơn (gồm thông tin người mua) đi qua dịch vụ bên thứ ba xKiro — đã được chấp thuận.

19/10/2026 — Tính sẵn báo cáo (migration `0068`–`0070`): doanh số tháng hiện tại Báo cáo kinh doanh, chi phí ADS/doanh số theo tên/tổng hợp SĐT của Báo cáo Marketing, view đọc Sổ quỹ. Chỉ đổi độ tươi dữ liệu và hiệu năng, không đổi quy tắc nghiệp vụ.

## Bổ sung 20/10/2026 — Kế toán – ORDER VAT

- **Vấn đề**: sale gửi ORDER VAT qua Google Form vào sheet ORDER VAT 1; ai cũng sửa được mọi cột, không có lịch sử, tên sale gõ tay không thống nhất, cột Tên mã KT lỗi `#REF!`, Tồn VAT là số dán tĩnh, sale vẫn sửa được sau khi kế toán đã khai.
- **Giải pháp**: trang "Kế toán – ORDER VAT" (`/vat-request/`). Sale tạo yêu cầu (chọn mã SP, khách, SL, giá chưa VAT, Full VAT / Không full VAT, ghi chú), xem được toàn bộ bảng; chỉ Kế toán được cấp quyền xử lý riêng và Quản lý mới đổi trạng thái 0–4 theo quy ước sheet cũ, ghi chú (tên lô/cont), ngày về, làm hàng loạt. Yêu cầu đã xử lý (0, 1, 2) tự khóa với sale; lịch sử ghi ai đổi gì lúc nào. Tồn VAT, SLG cần khai, Dự kiến hàng về, Ngày về gần nhất tính live.
- **Người dùng**: Nhân viên sale, Kế toán, Quản lý có quyền xem/tạo mặc định; quyền xử lý mặc định chỉ Quản lý và được cấp riêng cho từng Kế toán ở `/account/`.
- **Thành công**: không còn sửa đè sau khi khai; kế toán lọc ra việc cần làm (chờ xử lý, 3, 4) và xử lý theo lô; số tồn / hàng về không còn là số dán tay.
- **Ngoài phạm vi**: thông báo (chuông, email, Zalo), ghi ngược ra Google Sheets, nối với Nháp VAT, chia Q/R theo công ty, tách cơ sở HN/SG. 3 sheet phụ XỬ LÝ VAT LÂU, HẢI - VAT, Chạy tồn VAT bỏ hẳn.
- **Xuất Excel (21/10/2026)**: kế toán / quản lý tải đúng danh sách đang lọc ra Excel (đủ cột, từng yêu cầu) để đối soát hoặc gửi đi; sale không có nút này.
- **VAT sẵn nhiều (22/10/2026)**: tách các yêu cầu "0. Không khai được" mà kế toán ghi là còn nhiều hàng VAT thành trạng thái riêng để sale biết lý do; kế toán thấy trạng thái + ngày về của cont gần nhất ngay trên bảng.
- **Dữ liệu cũ**: nhập toàn bộ sheet ORDER VAT 1 (1.357 dòng, nhập 20/10/2026) bằng script, map sale theo email.
- **Gợi ý nhập liệu**: khách tìm theo tên không dấu, mã khách hoặc các từ đảo thứ tự; gợi ý từ KiotViet và yêu cầu VAT trước đây. Giá chưa VAT lấy từ yêu cầu gần nhất cùng mã SP và chỉ áp dụng khi sale chọn. Tồn VAT đọc tab GỘP MỚI của sheet công khai được chỉ định (`gid=39032`).

## Bổ sung 20/10/2026 — Kiểm tra giá bán

- **Vấn đề**: việc soát hóa đơn bán dưới giá quy định (theo mô tả giá từng mã trên KiotViet, bậc số lượng, cấp khách, VAT, cước) làm tay trên Excel với nhiều bảng riêng, dễ sót và không có chốt trách nhiệm.
- **Giải pháp**: mục "Kiểm tra giá bán" trong tab Hóa đơn. Mỗi đêm 23:00 hệ thống chụp hóa đơn của 7 ngày gần nhất và đối chiếu giá min; sale giải thích dòng sai của khách mình phụ trách; Quản lý chốt Ok hoặc Phạt (tiền phạt = SL × chênh/đơn vị).
- **Người dùng**: Quản lý, Trợ lý, Nhân viên sale xem; sale giải thích; Quản lý (hoặc người được cấp) chốt.
- **Thành công**: không còn đối chiếu thủ công, kết quả không đổi theo giá hiện tại, có dấu vết ai giải thích/chốt gì khi nào.
- **Ngoài phạm vi**: bảng giá cắt lô riêng theo khách–mã, ghi ngược KiotViet/Google Sheets, lưu lịch sử quá 7 ngày.
- **Trạng thái**: code + test xong, **đã hoàn thiện, merge vào `main` và push cả 2 remote GitHub (`origin` và `tks_web`)**; chuẩn hóa 10 khách bao cước HN sang tên KiotViet mới (giữ dấu), đọc bậc giá theo chiếc (`CT`, `lẻ`) trực tiếp, khóa 4 mức giá Vừa - Lớn - VIP - Cắt lỗ, email 'mới' tính khách Lớn; 24/24 unit test đạt; giao diện và xuất Excel/HTML hoàn chỉnh; bước vận hành tiếp theo: áp migration `0077` lên DB production, deploy và bật cờ `INVOICE_PRICE_AUDIT_ENABLED`.

Cập nhật gần nhất: 23/10/2026.


21/10/2026 — **CONT TKS1 và cột Nguồn (mã cục bộ trên main, chưa deploy):** nguồn thứ bảy `CONT TKS1` sau KHÁC dùng chung snapshot, số Chưa bốc (1+2), Đã bốc (3) và chi tiết CONT; trạng thái 4 giữ trong Dự kiến hàng về, không cộng hai số tổng. Tên SP vẫn tra `product_report` theo mã. Bảng Dự kiến hàng về có 11 cột; Nguồn (`sheetName`) đứng đầu, mặc định hiện và được chọn khi xuất Excel/HTML; chọn riêng các cột cũ vẫn hợp lệ. Giữ tìm kiếm, ba bộ lọc Nguồn/Cont/Trạng thái, quyền, phân trang và cấu hình cột trong phiên. Đọc thiếu/lỗi bất kỳ nguồn nào giữ snapshot thành công gần nhất. Không thêm migration, dependency hoặc endpoint; bộ lọc Nguồn được bổ sung theo phê duyệt tiếp theo cùng ngày; không ghi Sheets hay chạy job ghi DB production trong lượt triển khai này.


21/10/2026 — **Dropdown Nguồn cho Dự kiến hàng về (main cục bộ, chưa deploy):** thêm dropdown trước Cont với Tất cả nguồn và đủ bảy tên YIWU, VK-DUNG, HÀ BẮC, SD, GDONG, KHÁC, CONT TKS1. Chọn một nguồn lọc chính xác sheetName, kết hợp Cont/Trạng thái/tìm kiếm; cập nhật KPI, số dòng, về trang 1, giữ lựa chọn khi render lại. Xuất Excel/HTML và số dòng trong hộp chọn trường áp cùng tham số source; HTML ghi bộ lọc Nguồn. Không đổi API đọc, DB/job, schema, dependency, endpoint hoặc quyền. Đây là bổ sung đã duyệt, thay điều kiện không thêm bộ lọc nguồn trong đợt CONT TKS1 trước đó. **Phân quyền cột Nguồn (21/10/2026):** cột Nguồn, dropdown Nguồn, cột Nguồn của file xuất và bộ lọc `source` chỉ dành cho người có quyền `reports.overview.containers.full` (Quản lý + người được phân quyền). Thiếu quyền này: `/api/expected-arrivals` trả `sheetName` ẩn danh `#1`, `#2`… (JSON không chứa tên nguồn thật); tham số `source` bị bỏ qua ở `/export` và `/export/fields`; file xuất không có cột Nguồn (10 trường thay vì 13) và HTML không có ghi chú lọc Nguồn; giao diện ẩn tiêu đề cột và dropdown.


21/10/2026 — **Chuyển Hàng dự kiến sang bảng Dự kiến hàng về + cột giá (mã cục bộ trên main, migration `0078` chưa áp DB, chưa commit/push/deploy):** mục "Hàng dự kiến" (bảng CONT theo mã SP) bị gỡ khỏi hộp "Chi tiết hàng hóa" của Báo cáo hàng hóa (hộp chỉ còn "Doanh số theo khách") và chuyển sang bảng **Dự kiến hàng về** (tab Hàng hóa, mục 2). Bấm một dòng bảng Dự kiến hàng về mở hộp chi tiết mới (loại `expectedArrival`, cỡ rộng, dùng chung `.dp-*`) liệt kê **mọi CONT của cùng mã SP**, kèm các chỉ số tổng số lượng theo từng trạng thái 1–5; hộp lọc từ dữ liệu bảng đã tải, không gọi API riêng. Bảng thêm hai cột **Giá SP (tệ)** và **Giá hàng về VN** (tổng 13 cột, colspan 13), chỉ hiện với quyền `reports.overview.containers.full` (Quản lý, Trợ lý); với quyền này **Màu sắc** và **Ghi chú sale** ẩn mặc định và bật lại bằng "Cột hiển thị"; không có quyền thì giữ nguyên 11 cột như cũ (không cột giá). Migration `0078_product_container_expected_prices.sql` thêm `listed_at`, `unit_price_cny`, `vietnam_price` vào `product_container_expected`; `expectedRefresh.js` sao ba cột từ `product_container_lines`. `GET /api/expected-arrivals` trả thêm `fullAccess` và bỏ `listedAt`, `unitPriceCny`, `vietnamPrice` khỏi từng dòng khi thiếu quyền (lọc ở lớp route trên bản sao, cache giữ bản đầy đủ); xuất Excel/HTML chỉ có hai cột giá khi có quyền. API `GET /api/product-report/containers` và `getContainerDetails` được giữ nguyên (Vòng đời đơn hàng còn dùng), chỉ bỏ lời gọi từ hộp Báo cáo hàng hóa. **Thứ tự triển khai:** áp `0078` (`npm run db:migrate`) → deploy → chạy tay MỘT LẦN `node productContainers/expectedRefresh.js` trong `server/` để đổ giá vào các dòng đã có; chưa áp migration thì hai cột giá trống, không lỗi (bắt `42703`).


### Cập nhật 21/10/2026 — Nhóm sale trong Công nợ

Quản lý có thể theo dõi và xuất công nợ/thưởng phạt theo Nhóm sale. Đổi nhóm tại Khách hàng được phản ánh tại Công nợ, bao gồm công nợ hiện có và nhãn nhóm của tháng thưởng/phạt đã chốt; số tiền/hạng đã chốt không tính lại.


21/10/2026 — **Tìm kiếm gần đúng theo từ + tìm ngay khi gõ + chỉ số theo bộ lọc (không migration; mã đã commit trên `codex/debt-sale-teams`, chưa deploy):** mọi thanh tìm kiếm văn bản thường dùng một luật chung — bỏ dấu và phân biệt hoa/thường không còn ảnh hưởng, tách câu tìm thành từng từ: 1 từ thì từ đó phải khớp; 2 từ thì khớp cả 2; từ 3 từ trở lên khớp quá nửa; kết quả xếp theo số từ khớp, khớp nguyên cụm đứng đầu. Ví dụ "combo 100 set" ra cả dòng "combo set". Ô tìm theo mã chính xác (mã hàng, mã đơn…) giữ nguyên. Frontend dùng `public/shared/fuzzy-search.js` (UMD, `window.TKSFuzzySearch`: `fold/tokens/score/matches/filter`, kiểm thử `fuzzy-search.test.js`); server dùng `shared/fuzzySearch.js` (CommonJS, `createMatcher`) và `shared/fuzzySql.js` (cùng luật ngay trong SQL, tham số hóa, dùng cho bảng lớn cần lọc + phân trang + tổng ở Postgres). Áp ở Vòng đời đơn hàng (`orderLifecycleQuery` — `filterRows`, `sortExplicit`, xếp hạng), Sổ quỹ, Nhân sự/Nghỉ phép, lịch sử tài khoản và xuất người dùng, Kiểm tra giá bán, Dự kiến hàng về (xuất), Nháp VAT (chứng từ), Báo cáo tổng hợp, Marketing, Vị trí hàng. **Sửa lỗi:** xóa hết từ khóa (Backspace) không làm mới kết quả — nay lọc lại ngay qua sự kiện `input`. **Tìm ngay khi gõ, gỡ nút "Tìm kiếm" thừa:** Vòng đời đơn hàng (`bulkSearchInput` debounce 300ms phía máy chủ, `historySearchInput` lọc phía client); ORDER VAT (`vat-request`) lọc client trên dữ liệu đã tải (tối đa `LIST_LIMIT` 5000) thay vì gửi `q` lên máy chủ. **Chỉ số/thẻ KPI nhảy theo từ khóa + bộ lọc** của bảng trên toàn bộ dòng đã lọc (không chỉ trang hiện tại): hook `afterRender` trong `renderPaginatedRows` (`index.html`, Sổ quỹ, Tài khoản, Nhân sự, Marketing); Vòng đời đơn hàng tính qua `countSummary` phía máy chủ. **Vòng đời đơn hàng:** chế độ tìm mặc định đổi sang "Theo tên khách" (`parseParams` phía máy chủ vẫn mặc định `mode='code'`). **Kiểm thử:** có 3 test đỏ nền từ trước, không do thay đổi này — quyền marketing `/api/product-report*` trong `test/overview-endpoints-access.test.js`. Không migration nên `SCHEMA.md` không đổi.

## Bổ sung 22/10/2026 — Ghi chú và Tiếp khách lần cuối theo khách

- **Vấn đề**: bảng Doanh số theo khách chỉ có số liệu doanh số; thông tin nghiệp vụ về từng khách (kho ở đâu, quy mô, đối thủ, kênh bán, lần gặp gần nhất, lịch sử trao đổi) nằm rời rạc ngoài hệ thống.
- **Giải pháp**: hai cột mới trên bảng — **Ghi chú** (nút Chi tiết) và **Tiếp khách lần cuối**. Hộp Chi tiết khách có Thông tin chung (định vị kho, số lượng kho, ảnh kho, quy mô kho, đối thủ, hình thức bán hàng) và Note kiểu tin nhắn, mới nhất ở trên.
- **Quy tắc nghiệp vụ**:
  - Xem: Quản lý, Trợ lý, Nhân viên sale (quyền mới `reports.business.customerNotes`, cần quyền Khách hàng); Khách bên ngoài không xem.
  - Sửa Thông tin chung, ảnh và Note: Quản lý, hoặc người được Quản lý gán riêng cho từng khách (Quản lý chọn từ danh sách tài khoản nội bộ đang hoạt động). Người không được gán chỉ xem.
  - Mỗi khách tối đa 1 note mỗi ngày; chỉ sửa được trong ngày tạo (theo giờ Việt Nam), sang ngày sau note bị khóa; ai trong danh sách được sửa cũng sửa được note của ngày đó.
  - Ảnh kho: tối đa 5 MB mỗi ảnh, tối đa 10 ảnh mỗi khách.
  - Ngày tiếp khách chỉ Quản lý chọn (lịch chọn nhiều ngày đã đi, không chọn ngày tương lai); "Tiếp khách lần cuối" luôn là ngày lớn nhất trong các ngày đã chọn.
- **Người dùng**: Quản lý (toàn quyền, gán người sửa), Trợ lý và Nhân viên sale (xem; sửa nếu được gán).
- **Thành công**: sale/quản lý mở một hộp là thấy đủ hồ sơ và lịch sử trao đổi của khách; biết ngay lần tiếp khách gần nhất mà không cần hỏi miệng.
- **Ngoài phạm vi**: xuất note/ảnh ra file (file xuất chỉ thêm cột Tiếp khách lần cuối), xóa note, lịch sử chỉnh sửa note, tự chuyển ghi chú khi khách đổi tên (liên kết theo tên chuẩn hóa nên khách đổi tên sẽ mất liên kết).
- **Trạng thái**: code + test xong, đã commit trên `main`; migration `0080` đã áp DB dùng chung (22/10/2026); chưa push/deploy. Spec: `docs/superpowers/specs/2026-10-22-customer-notes-design.md`.
### Cập nhật 22/10/2026 — Nháp VAT: dán mã hóa đơn là xử lý luôn

- **Vấn đề**: kế toán luôn biết sẵn hóa đơn cần sửa nên không dùng bảng tick chọn từng chứng từ; dán mã xong vẫn phải bấm "Thêm vào danh sách" rồi "Xử lý chứng từ đã chọn", và không xem được nội dung hóa đơn ngay trên trang.
- **Giải pháp**: chỉ còn ô dán mã + Cơ sở + nút Xử lý (một bước); danh sách hóa đơn đã dán bấm được để xem chi tiết như hộp "Chi tiết giao dịch" ở dashboard.
- **Thành công**: dán mã, bấm một nút là có kết quả phân bổ; mã lỗi được chỉ rõ mà không chặn các mã đúng.
- **Ngoài phạm vi**: chế độ "Dán dữ liệu" (cột Excel), tab Tạo QR, thuật toán phân bổ và bảng kết quả không đổi.

## Cập nhật Chi tiết khách — 23/10/2026

Bổ sung Diện tích, kênh bán Khác và đánh giá Rất to. Đánh giá quy mô do Quản lý thực hiện riêng, cạnh danh sách người sửa và lịch tiếp khách gọn. Thông tin dài xuống dòng, Note cũ xem bằng cuộn trong khung; xem ảnh lớn chuyển được ảnh trước/sau. Bảng doanh số chỉ hiển thị ngày tiếp khách; chỉnh ngày trong Chi tiết khách. Quy tắc Note và quyền sửa thông tin chung giữ nguyên. Thiết kế đã duyệt trong `docs/superpowers/specs/2026-10-23-customer-profile-refinement-design.md`; migration 0084 chưa áp DB thật, chưa deploy.


23/10/2026: Dự kiến hàng về bổ sung **Ghi chú khác** từ cột G của 7 nguồn CONT; quyền riêng `reports.products.expected.otherNote`, mặc định Quản lý, cho phép cấp riêng từng tài khoản; áp dụng bảng, chi tiết, API và xuất Excel/HTML. Migration 0086 đã áp DB, đã nạp 5.839 ghi chú trên 13.044 dòng; code chưa deploy.

## Bổ sung 23/10/2026 — Kế toán – Tra cứu VAT

- **Vấn đề**: sale tra tồn VAT và hàng sắp về bằng một app Apps Script riêng (link khác, đăng nhập khác) trước khi báo khách và tạo ORDER VAT.
- **Giải pháp**: trang "Tra cứu VAT" trong menu Kế toán của web, giữ nguyên cách dùng và kết quả của app cũ (2 tab Hàng VAT có sẵn / Hàng sắp về, dán nhiều mã), có nút qua lại với ORDER VAT.
- **Người dùng**: Nhân viên sale (chính), Kế toán, Quản lý.
- **Thành công**: tra cùng một mã cho cùng dòng VAT và dòng sắp về như app cũ logic v12 (đối chiếu 23/10/2026: 3.142 sản phẩm; `TALEWS` 3 dòng VAT11629, CONT 10-10Y "Đang chờ khai" 972); sau đó có thể bỏ link Apps Script.
- **Ngoài phạm vi**: cột tình trạng vận chuyển từ bảng CONT, nút tạo ORDER VAT điền sẵn mã, đổi tab nguồn của Nháp VAT / ORDER VAT, lưu dữ liệu vào DB.
- **Việc cần xác nhận với người làm sheet**: "DK về 2" có lấy dữ liệu bằng IMPORTRANGE không (nếu có, có thể trả `#REF!` như sheet DK VỀ cũ; trang sẽ báo lỗi rõ).

Cập nhật gần nhất: 23/10/2026.

# Cập nhật nghiệp vụ 23/10/2026 — quản lý level giá trên Dashboard

Quản lý lọc khách theo kênh bán/quy mô đánh giá và xuất thông tin Chi tiết không kèm Note. Level giá được quản lý độc lập với email KiotViet sau bước sao lưu ban đầu, dùng chung các mã cùng tên HN/SG; Quản lý hoặc người được gán sửa được thay trực tiếp trên bảng. Thay đổi chỉ ảnh hưởng các hóa đơn kiểm tra được chụp sau đó; bản chụp cũ giữ nguyên để đối soát. Mã đang kiểm chứng cục bộ, chưa chuyển dữ liệu vận hành hoặc deploy (migration 0087).
