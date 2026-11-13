# Bàn giao Thu mua — 05/11/2026

## Đọc trước

Người dùng yêu cầu bàn giao, tạm dừng triển khai. Bản dùng thử đang làm **chưa commit, chưa tạo PR, chưa deploy**. Không báo rằng các yêu cầu mới nhất đã hoàn thành.

- Repo: `C:\Users\Admin\Desktop\Web tks\tks_web`.
- Branch đã kiểm tra: `feat/purchase-isolated-trial`.
- Base biết gần nhất: main `ae77aaf114cbbe3d739576820b5820cc0d8b9b5d` (PR #52). Fetch để kiểm tra main có tiến thêm không.
- Git cần `git -c safe.directory='C:/Users/Admin/Desktop/Web tks/tks_web' ...`.
- Đọc AGENTS.md và CURRENT.md trước khi tiếp tục. Không đè các thay đổi đang có.

## Mục tiêu đang làm

Cho nhân viên thao tác thật trên dữ liệu mẫu tách biệt, cùng giao diện và nghiệp vụ Thu mua. Người dùng đã chọn **dùng thử dữ liệu mẫu riêng**, chưa cho chuyển nguồn dữ liệu chính sang web.

Production: https://tokosi.onrender.com/thu-mua/dat-hang/

Đường dẫn dự kiến sau deploy: https://tokosi.onrender.com/thu-mua/dat-hang/?trial=1

Hiện production nguồn `sheets`, nên các nút ghi bị khóa có chủ đích. Không sửa bằng cách bật ghi trên dữ liệu chính. Không chuyển `source_mode` public sang `web`.

## Yêu cầu mới nhất — CHƯA GHÉP XONG

1. **Cả bảng Đặt hàng và Chỉ số cont luôn lấp đầy chiều ngang màn hình**, bất kể số cột bật. Vẫn kéo chỉnh cột được, cột số gọn, nhiều cột thì cuộn ngang. Quyết định này thay thế kiểu thu bảng vừa nội dung ở PR #52.
2. Kiểm tra sửa tay thực sự, lưu được và phản ánh lên chỉ số cont.
3. Kiểm tra hai người làm đồng thời: bộ lọc riêng không ảnh hưởng nhau; sửa khác dòng/khác trường; sửa cùng trường phải xử lý xung đột, không âm thầm ghi đè.
4. **Mã SP: nhấp một lần mở Tách dòng; nhấp đúp mở lịch sử.** Phải phân biệt click/dblclick bằng hẹn giờ rồi hủy khi doubleclick, tránh mở cả hai popup.
5. **Thêm mã phải có tìm kiếm/gợi ý như mockup**, chọn mã tự điền thông tin theo lần đặt gần nhất. Giữ ngày lên list mới, không mang cont cũ sang, xóa thông tin phát/đến thực tế. Hiện chỉ tra mã chính xác khi onchange, chưa đạt yêu cầu.

Người dùng đã nói tiếp tục ghép các phần này vào bản dùng thử; sau đó yêu cầu bàn giao.

## Phần đã viết cục bộ

### Backend dùng thử

- `server/purchaseOrders/purchaseOrdersTrial.js` (mới): API `/api/purchase-trial`, dùng schema PostgreSQL **purchase_trial**, cùng pool của ứng dụng. Không fallback về public.
- Khởi tạo schema và migration Purchase 0110–0113 trong transaction, khóa advisory riêng. Seed 12 dòng + 3 cont mẫu **một lần**; ba nhân viên giả An/Bình/Chi. Các lần khởi động sau không reset dữ liệu đã sửa.
- `source_mode='web'` chỉ trong schema dùng thử. Projection, invalidation và event được tách, không ghi Dự kiến hàng về hoặc tồn kho chính.
- Pool adapter SET search_path khi lấy connection và RESET trước khi trả connection; reset lỗi thì loại connection.
- `purchaseOrdersRoutes.js`: root API có thể cấu hình; module mặc định gắn thêm router trial, tránh sửa file routes trung tâm.
- `purchaseOrdersService.js`: tham số lockKey/invalidate có mặc định giữ hành vi production; trial truyền project/invalidate no-op và EventEmitter riêng.
- `seedSampleData.js`: tùy chọn manageTransaction để seed nằm trong transaction khởi tạo; CLI mặc định không đổi.
- `purchaseOrdersTrial.test.js` (mới): 8 ca kiểm tra cách ly, chống fallback public, connection reset, ghi đồng thời, undo/delete/restore, chưa đăng nhập không khởi tạo, không reset seed, rollback lỗi seed.

**Không dùng PGlite ở runtime production**. PGlite chỉ phục vụ test/preview cục bộ. Phương án PGlite runtime từng thử tiêu tốn bộ nhớ nên đã bỏ.

### Frontend dùng thử

- `purchase.js`: `?trial=1` chọn API riêng, banner rõ là dữ liệu thử, tên trang, export có tên dùng thử.
- Draft/filter/table preferences tách namespace trial theo user.
- Nút ghi khóa trong lúc chờ auth/data, không lóe trạng thái cho phép ghi trước khi tải xong.
- `index.html`: link Dùng thử dữ liệu mẫu; cache version `20261105-trial-v1`.
- `workspace.css`: kiểu link/banner trial. Còn CSS width:fit-content từ PR #52 cần sửa theo yêu cầu mới.
- `purchaseOrdersLive.test.js`: thêm thử đường dẫn API trial, scope draft, banner/button.
- README, server/README, SCHEMA, BRD, SRS, implementation_plan, CURRENT đã có mô tả bản dùng thử; cần cập nhật tiếp theo kết quả cuối cùng.

## Điểm cần sửa cụ thể

- CSS hiện có `#orderTable,#containerTable { width:fit-content; max-width:100%; min-width:0 }`: đây là nguồn khoảng trống bên phải trong ảnh mới. Chuyển wrapper full width; phối hợp shared table-controls thay vì tạo bộ resize thứ hai. Kiểm tra cả số ít/nhiều cột và độ rộng lưu sẵn.
- `renderWatchedCont` đang sao chép style.width của bảng gốc; khi full width cần kiểm tra độ rộng render thực tế để bảng ghim khớp cột.
- `refreshTasks()` gọi `PurchaseTasks.actions(..., true)` thêm nút Tách dòng vào ô mã có input; làm ô mã chật. Cân nhắc đổi ô mã thành mục bấm duy nhất theo yêu cầu mới, tránh sửa shared helper ảnh hưởng trang khác.
- Handler dblclick hiện bỏ qua target button/select; phải điều chỉnh khi mã trở thành button. Chỉ mã SP mở lịch sử, các ô khác không mở.
- Add modal hiện dùng `/latest?code=` chính xác trong onchange. API latest lấy dòng chưa xóa theo listed_at DESC NULLS LAST, id DESC. Có thể tạo gợi ý từ data.rows đã tải rồi lấy latest mới nhất khi chọn, bảo vệ kết quả async cũ không điền nhầm mã vừa gõ khác.
- Mockup có datalist `purchaseCodeSuggestions`; tham khảo luồng điền lại dữ liệu và quy tắc reset ngày/thông tin vận chuyển.

## Kiểm chứng đã làm — phạm vi giới hạn

- Các đợt test liên quan đã xanh: 254 ca ở một mốc trước; sau điều chỉnh wiring 49; sau seed/error guard 47; trial cuối 8; live UI cuối 36. **Không phải một lần chạy cuối cùng bao trùm mọi thay đổi hiện có.** Chạy lại các test liên quan sau khi ghép yêu cầu mới.
- Trình duyệt thật preview cục bộ: mở trial, nút ghi bật; đổi số thùng D90006.01 từ 8 thành 9; lưu qua xác nhận; reload vẫn 9; đã thao tác hoàn tác. Cần đọc lại kết quả hoàn tác và chạy lại bản code cuối.
- Chưa kiểm tra được đủ hai người bằng trình duyệt thật; chưa xác nhận trial trên production vì chưa deploy.
- jsdom không chứng minh được layout. Cần đo/screenshot thật ở nhiều số cột và viewport.

## Preview/tiến trình có thể còn chạy

- Port 4319: `.codex_tmp/purchase-trial-preview.cjs`, session exec từng là 19823. Dùng PGlite chỉ để mô phỏng DB cục bộ, router/service thật và auth giả quản lý. URL http://127.0.0.1:4319/thu-mua/dat-hang/?trial=1
- Port 4318: preview stub cũ `.codex_tmp/purchase-ui-preview.cjs`, session từng là 46155.
- Kiểm tra tiến trình thực tế trước khi dùng. Preview 4319 khởi động trước vài sửa backend cuối nên cần restart để nạp code mới.
- Browser IAB từng có tab production đã đăng nhập và tab preview; tìm lại tab, không giả định binding của REPL còn tồn tại.

## Git/deploy và quyền đã chốt

- Quy trình người dùng muốn: branch GitHub → PR → kiểm tra → merge main → Render tự deploy.
- Cho phép xem trang Thu mua production để kiểm tra; **không mở dashboard Render**.
- Chỉ thử ghi dữ liệu mẫu tách biệt. Chưa cho cutover dữ liệu chính.
- Stage các file cụ thể. **Không đưa `server/public/prototypes/thu-mua/` vào PR**: mockup riêng chưa theo dõi, có dữ liệu nghiệp vụ.
- Không dùng worktree cũ `.worktrees/purchase-release`: branch cũ, có sửa chưa commit.
- Chưa có PR cho branch trial, chưa commit các thay đổi trial.

## CI

PR #48 đã đổi CI chạy theo phạm vi module. Check vẫn tên “Full server suite” để giữ tương thích branch protection. Purchase-only chạy các test module; thay file shared/trung tâm/migration/package có thể làm chạy toàn bộ.

Ca đỏ nền từng có trên main: `server/test/frontend/hr-leave-deadlines.test.js:18`, test “timing remains independent after approval and legacy violation is readable without a new violation decision”, assertion '0' !== '2'. Không coi mọi check đỏ đều chấp nhận được; phải xem lỗi cụ thể, không có lỗi mới.

Trước merge xác nhận CI đúng head commit. Nếu auto-review từ chối thao tác, báo đúng lý do và hoàn thiện các kiểm tra an toàn còn thiếu; không tìm cách vượt.

## Những việc cũ chưa xong

- Dữ liệu người dùng gửi tại `C:\Users\Admin\.codex\attachments\b97c3618-706e-44fb-834d-1f7facf91e74\Pasted text.txt` **chưa được dùng làm seed**. Trial vẫn 12 dòng giả + 3 cont.
- File TSV khoảng 624 bản ghi logic, có header lặp, dòng lệch cột, thiếu số lượng, mã “Mới”, dữ liệu #N/A/#REF. Không âm thầm bỏ lỗi hoặc bịa số lượng. Người dùng chốt import **đúng toàn bộ mới ghi, lỗi thì 0 dòng được ghi**.
- Chốt snapshot Sheet/cutover vẫn giai đoạn sau. Không đổi tồn kho khi chỉ đổi trạng thái cont về 4.
- PR #47 fix grid cũ đã bị thay thế bởi shared shell ở #50; không merge mù. PR #41 lifecycle ngoài phạm vi.

## Quy tắc nghiệp vụ không được mất

- Xe 17.5m/18.5m cùng 32T tạm chốt, mốc thể tích 160–170m³; thiếu số đo không được kết luận vừa xe.
- Trạng thái: 1 Chưa có lịch; 2 Chưa bốc; 3 **Đã bốc**; 4 Đã về.
- Tách khóa đệ quy: cha thêm .01, con thêm .02 mỗi lần. Tách dòng không tự chia lượng; cha giữ lượng, con để trống số lượng, bắt buộc nhập trước lưu.
- Tiền VC cont mặc định = 202000000 / 170 × m³ cont; nhập tay thì override; xóa override trở về công thức; số 0 có ý nghĩa riêng.
- Tiền VC dòng = m³ dòng × VC/m³ của cont, tính trên giá trị chưa làm tròn. Thiếu dữ liệu là chưa xác định, không biến thành 0.
- Dấu nghìn ',', thập phân '.'; tổng tệ hiển thị 3 chữ số thập phân. Không spinner tăng/giảm số.
- Bộ lọc riêng từng người; optimistic concurrency; bulk sửa mọi trạng thái, xác nhận ngắn gọn, log đủ trước/sau.
- Chọn cont ở bảng chỉ số để ghim theo dõi, chỉ số cập nhật theo thao tác bảng dưới; không khôi phục panel chọn/so sánh xếp cont cũ. Ghim không che tiêu đề bảng đặt hàng.

## Thứ tự tiếp tục

1. Đọc diff hiện tại, fetch main an toàn; giữ nguyên công việc chưa commit.
2. Ghép 5 yêu cầu mới nhất, bổ sung test hành vi có ý nghĩa.
3. Kiểm tra browser thật full width/resizing/ghim, click-doubleclick, autocomplete điền dữ liệu, sửa/lưu/undo, hai phiên đồng thời và xung đột.
4. Chạy test Purchase và phần liên quan, cập nhật tài liệu đúng kết quả. Graphify trước đó không có CLI; đừng nói đã chạy nếu chưa chạy được.
5. Commit chỉ file thuộc nhiệm vụ, push PR, kiểm tra CI, merge theo quyền đã có.
6. Chờ auto-deploy, kiểm tra trial trên website; thao tác chỉ sample riêng, xác nhận trang chính vẫn Sheets và dữ liệu chính không đổi. Lưu screenshot bằng chứng.
7. Báo URL dùng thử, các luồng đã đo thực tế và phần còn thiếu; không gọi hoàn thiện 90% nếu chưa đối chiếu đủ yêu cầu.
