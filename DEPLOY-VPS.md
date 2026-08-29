# Deploy TKS Dashboard lên VPS bằng Docker Compose

Tài liệu này thay thế phần "Deploying on Render" trong `server/README.md:147-176` khi chạy trên VPS tự quản.

**Cấu hình hiện tại:** chạy bằng **IP thuần, HTTP** (chưa có domain). Telegram bot **chưa bật**.
Xem mục [Khi có domain](#khi-có-domain) để nâng cấp lên HTTPS.

---

## ⚠️ Ba điều bắt buộc phải nhớ

### 1. KHÔNG được đặt `NODE_ENV=production` khi còn chạy HTTP

`server/auth/authRoutes.js:123` và `server/branch/branchMiddleware.js:20` đặt cookie với
`secure: process.env.NODE_ENV === 'production'`. Cookie có cờ `Secure` **không bao giờ được
trình duyệt gửi qua HTTP** → user đăng nhập thành công nhưng bị đá ra ngay lập tức, và log
server không báo lỗi gì cả (rất khó chẩn đoán).

Chỉ bật `NODE_ENV=production` **sau khi** đã có domain + chứng chỉ HTTPS.

### 2. Chỉ được chạy đúng 1 instance

Không dùng `docker compose up --scale`, không chạy song song với bản Render dùng chung
Telegram token. Lý do chi tiết trong comment của `docker-compose.yml`.

### 3. `server/data/` là toàn bộ dữ liệu sống

Bốn file JSON trong đó — đặc biệt `users.json` chứa **tài khoản người dùng thật** — không nằm
trong Google Sheets và không nằm trong git. Mất volume `tks-data` là mất sạch.

---

## 1. Chuẩn bị trên VPS

Đã kiểm tra trên VPS đích (2026-08-28) — mọi thứ sẵn sàng, mục này chỉ để tham chiếu khi
dựng lại trên máy khác:

| Hạng mục | Trạng thái |
|---|---|
| Docker | ✅ v29.7.2 |
| Docker Compose plugin | ✅ v5.5.0 |
| Node/npm trên host | ❌ chưa cài — **không cần**, đây chính là lý do chọn Docker |
| nginx/caddy/apache/certbot | ❌ chưa có — chưa cần khi chạy IP |
| Port 80/443 | ✅ trống (chỉ có sshd `:22`) |
| Disk | ✅ 213 GB trống |
| RAM | ✅ 5.4 GB available |

Kiểm tra lại nếu cần:

```bash
docker compose version && ss -tulpn | grep -E ':(80|443)' || echo "Port 80/443 trong - OK"
```

**Lưu ý về các service đang chạy trên VPS này:** 4 bot (`kiotviet-bot`, `kiotviet2-bot`,
`kiotviet-test`, `qa-bot`) chạy bằng **systemd + venv**, 1 bot (`invoice-telegram-bot`) chạy
bằng **Docker Compose** ở `/opt/invoice-telegram-bot/`. App này dùng Docker Compose và không
đụng gì tới các service kia — tên container `tks-web`, network riêng `tks_web_default`.

## 2. Clone đúng nhánh

```bash
cd /root && git clone -b deploy/vps-docker https://github.com/tks0101ai-cmyk/tks_web.git
```

Cờ `-b deploy/vps-docker` là **bắt buộc** — nhánh `main` không có Dockerfile.

Repo private → dùng Personal Access Token (Settings → Developer settings → Personal access
tokens, scope `repo`):

```bash
git clone -b deploy/vps-docker https://<TOKEN>@github.com/tks0101ai-cmyk/tks_web.git
```

## 3. Tạo file `server/.env`

Dùng SFTP của MobaXterm kéo `.env` từ máy local vào `/root/tks_web/server/.env`, rồi:

```bash
chmod 600 /root/tks_web/server/.env
```

**Kiểm tra line-ending ngay** — MobaXterm có thể tự chuyển LF sang CRLF khi truyền. Nếu dính,
mọi giá trị sẽ có ký tự `\r` thừa ở cuối và gây lỗi cực khó chẩn đoán (Google Sheets trả 404
vì `SPREADSHEET_ID` thừa `\r`, JWT không verify được, `GOOGLE_SERVICE_ACCOUNT_JSON` parse fail):

```bash
grep -c $'\r' /root/tks_web/server/.env
```

Kết quả phải là `0`. Nếu ra số khác 0, sửa bằng:

```bash
sed -i 's/\r$//' /root/tks_web/server/.env
```

**Kiểm tra lại quan trọng:** file `.env` gốc ở máy local có `PORT=` trỏ tới cổng khác 3000 thì
không sao — `docker-compose.yml` đã ghi đè `PORT: "3000"` để khớp với `EXPOSE`/`HEALTHCHECK`.

**Sửa lại file cho môi trường VPS** — bỏ hẳn 3 biến sau:

```bash
sed -i -E '/^(NODE_ENV|GOOGLE_CLIENT_ID|TELEGRAM_BOT_ENABLED)=/d' /root/tks_web/server/.env
```

Xác nhận đã sạch (phải không in ra gì):

```bash
grep -E '^(NODE_ENV|GOOGLE_CLIENT_ID|TELEGRAM_BOT_ENABLED)=' /root/tks_web/server/.env
```

Lý do bỏ từng biến:

| Biến | Vì sao phải bỏ khi chạy bằng IP |
|---|---|
| `NODE_ENV` | Xem cảnh báo #1 ở trên — đặt `production` là hỏng đăng nhập |
| `GOOGLE_CLIENT_ID` | Google Identity Services bắt buộc HTTPS và không nhận IP thuần làm Authorized JavaScript origin. Bỏ biến này thì `/api/auth/google-config` trả `clientId: null` và trang login **tự ẩn nút Google** (`server/public/login/index.html:504-505`) — giao diện sạch thay vì nút bấm vào báo lỗi |
| `TELEGRAM_BOT_ENABLED` | Chưa bật bot. `server/telegram/hrTelegramBot.js:31-36` mặc định tắt khi thiếu biến này |

Ba biến **bắt buộc phải có**, thiếu là container crash ngay lúc khởi động
(`server/config.js:8-12` throw khi load module):

- `SPREADSHEET_ID`
- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `JWT_SECRET`

## 4. Khởi chạy

```bash
cd /root/tks_web && docker compose up -d --build
```

## 5. Việc BẮT BUỘC làm ngay sau lần khởi động đầu ⚠️

Khi `server/data/users.json` chưa tồn tại, `server/auth/localUserStore.js:78-113` tự tạo
**hai** tài khoản Quản lý với mật khẩu **nằm sẵn trong mã nguồn**:

| Username | Mật khẩu mặc định | Nguồn |
|---|---|---|
| `admin` | `Admin@123` | `localUserStore.js:79` |
| `thangnnv2003@gmail.com` | `Thang@2026` | `localUserStore.js:80` |

Cả hai đều có vai trò `QUAN_LY`, phụ trách `Cả hai` cơ sở, trạng thái hoạt động.

**Hai tài khoản này không xoá được.** `HARDCODED_ADMINS` (`localUserStore.js:29-35`) chứa
`admin`, `admin@tokosi.vn`, `thangnnv2003@gmail.com` và các biến thể; `ensureHardcodedAdmins()`
chạy mỗi lần đọc file (`localUserStore.js:178`) sẽ tạo lại tài khoản nếu bị xoá và **ép ngược**
vai trò về Quản lý, trạng thái về hoạt động, cơ sở về Cả hai — kể cả khi bạn đã sửa tay.

May mắn là hàm đó **không đụng tới `passwordHash`** của tài khoản đã tồn tại, nên **đổi mật khẩu
là biện pháp duy nhất có tác dụng lâu dài, và nó có tác dụng thật.**

→ Đăng nhập lần lượt bằng cả hai tài khoản và đổi mật khẩu **ngay**, trước khi cho bất kỳ ai truy cập.

Luồng đổi: trang **`/account/#profile`** → thẻ "Bảo mật & Đổi mật khẩu"
(`server/public/account/index.html:379-421`) → `POST /api/auth/change-password`
(`server/auth/authRoutes.js:745`). Bắt buộc nhập đúng mật khẩu hiện tại; mật khẩu mới 8–128 ký tự.

**Đăng xuất rồi đăng nhập lại bằng mật khẩu mới** để xác minh — API chỉ trả `{ok:true}` chứ
không tự kiểm chứng.

Kiểm tra bằng máy (không cần tiết lộ mật khẩu mới — lệnh chỉ hỏi "hai mật khẩu *mặc định* còn
dùng được không"):

```bash
cd /root/tks_web && docker compose exec -T tks-web node -e 'const b=require("bcryptjs"),u=require("/app/data/users.json");[["admin","Admin@123"],["thangnnv2003@gmail.com","Thang@2026"]].forEach(function(p){var x=u.find(function(y){return y.username===p[0]});if(x===undefined){console.log(p[0],"KHONG TIM THAY");return}console.log(p[0], b.compareSync(p[1],x.passwordHash)?"VAN CON MAT KHAU MAC DINH":"da doi - OK")})'
```

Cả hai dòng phải ra `da doi - OK`.

> Lệnh trên cố ý dùng `x===undefined` thay vì `!x`, và nháy đơn bọc ngoài đoạn `node -e`. Bash
> tương tác coi `!` là history expansion **kể cả trong nháy kép** — viết gọn lại thành `!x` mà
> vẫn để nháy kép sẽ báo `event not found` chứ không chạy.

⚠️ **Đổi mật khẩu KHÔNG đá phiên nào ra.** `authRoutes.js:745-779` không ký lại token cũng
không xoá cookie — mọi `tks_auth` đã phát ra vẫn sống đủ 12h. Nếu có token nào từng bị lộ
(in ra terminal, dán vào chat, lọt vào log), phải đổi `JWT_SECRET` — xem
[Đổi JWT_SECRET](#đổi-jwt_secret-huỷ-toàn-bộ-phiên-đăng-nhập) ở mục Vận hành.

### 🔴 Rủi ro của việc chạy HTTP thuần

Vì chưa có domain nên toàn bộ traffic là HTTP không mã hoá, trên IP công khai
`152.53.183.240`. Nghĩa là **mật khẩu đăng nhập đi qua Internet dưới dạng chữ thường**, ai
đứng trên đường truyền (Wi-Fi công cộng, ISP, hạ tầng trung gian) cũng đọc được, và cookie
phiên `tks_auth` cũng vậy.

Chấp nhận được khi đang thử nghiệm nội bộ. **Không nên dùng với dữ liệu nhân sự/doanh thu thật
trong thời gian dài.** Nếu chưa mua được domain, cách nhanh và miễn phí là đăng ký một
subdomain DuckDNS trỏ về `152.53.183.240` rồi chạy Let's Encrypt — xem mục
[Khi có domain](#khi-có-domain).

## 6. Di trú dữ liệu từ Render (bỏ qua nếu dựng mới) ⚠️

> **Lần deploy này là dựng mới hoàn toàn — bỏ qua mục 6, đi thẳng tới mục 7.**
> Mục này giữ lại phòng khi sau này cần khôi phục dữ liệu từ backup.

**Làm trước khi cho người dùng vào.** Nếu bỏ qua, `server/auth/localUserStore.js` sẽ tự tạo
`users.json` mới với admin mặc định và **toàn bộ tài khoản cũ biến mất**.

Tải 4 file từ disk Render xuống máy local, SFTP lên VPS, rồi copy vào container:

```bash
docker cp users.json tks-web:/app/data/ && docker cp notifications.json tks-web:/app/data/ && docker cp roleChangeRequests.json tks-web:/app/data/ && docker cp telegram_conversations.json tks-web:/app/data/
```

Sửa quyền rồi restart:

```bash
docker compose exec -u root tks-web chown -R node:node /app/data && docker compose restart tks-web
```

Sau khi khôi phục xong, vẫn phải kiểm tra hai tài khoản hardcode ở [mục 5](#5-việc-bắt-buộc-làm-ngay-sau-lần-khởi-động-đầu-️) —
`ensureHardcodedAdmins()` sẽ tạo lại chúng kèm mật khẩu mặc định nếu file backup không có.

## 7. Firewall — không cần làm gì

Đã kiểm tra trên VPS này (2026-08-28): **ufw không được cài**, và `nft list ruleset` chỉ chứa
các chain do Docker tự sinh (`DOCKER`, `DOCKER-FORWARD`, nat cho `docker0` và
`br-d6f388fa73f4`) — **không có rule nào chặn inbound**.

Docker tự chèn rule nftables khi publish port, nên `ports: "80:3000"` sẽ hoạt động ngay,
không cần `ufw allow`.

Xác nhận lại sau khi container chạy:

```bash
ss -tulpn | grep ':80'
```

> Nếu về sau có cài ufw, nhớ rằng **ufw không chặn được port do Docker publish** (Docker chèn
> rule vào chain `DOCKER` nằm trước chain của ufw). Muốn giới hạn thật thì đổi `ports:` thành
> `"127.0.0.1:3000:3000"` rồi cho nginx đứng trước.

---

## Kiểm tra sau khi deploy

**1. Container khoẻ**

```bash
docker compose ps
```

Cột STATUS phải là `Up (healthy)`. Nếu `unhealthy` hoặc restart liên tục → xem log.

**2. Log không có lỗi env**

```bash
docker compose logs --tail=50 tks-web
```

Không được xuất hiện `Missing required env var`.

**3. Service account JSON parse được**

```bash
docker compose exec tks-web node -e "const o=JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON); console.log('OK:', o.client_email)"
```

In ra email service account là đạt. Nếu `SyntaxError` → file `.env` bị mangle lúc SFTP
(thường do đổi line-ending CRLF/LF).

**4. Health endpoint**

```bash
curl -i http://localhost/health
```

**5. Cookie KHÔNG có cờ Secure** ← quan trọng nhất

Cần một lần đăng nhập thành công. **Đừng gõ thẳng mật khẩu vào dòng lệnh** — nó sẽ nằm lại
trong `~/.bash_history`. Dùng `read -rs` để nhập kín:

```bash
read -rsp 'Mat khau admin: ' PW && echo && curl -i -s -X POST http://localhost/api/auth/login -H 'Content-Type: application/json' -d "{\"username\":\"admin\",\"password\":\"$PW\"}" | grep -i set-cookie; unset PW
```

Kết quả phải có `Set-Cookie: tks_auth=...` và **không chứa chữ `Secure`**.
Nếu thấy `Secure` → `NODE_ENV=production` đã lọt vào env, quay lại mục 3 gỡ ra.

> Cách không cần dòng lệnh: đăng nhập trên trình duyệt rồi xem DevTools → Application →
> Cookies → `tks_auth`, cột **Secure phải trống**.

> Mật khẩu ở đây là mật khẩu **đã đổi** ở [mục 5](#5-việc-bắt-buộc-làm-ngay-sau-lần-khởi-động-đầu-️).
> Nếu bạn còn đang chạy phép thử này bằng `Admin@123` thì nghĩa là mục 5 chưa làm — làm trước đã.

**6. Volume gắn đúng**

```bash
docker compose exec tks-web ls -la /app/data
```

Phải thấy các file JSON thuộc sở hữu `node`. Nếu thư mục trống mà app vẫn chạy được nghĩa là
đang dính fallback `os.tmpdir()` → dữ liệu sẽ mất khi restart.

**7. Trên trình duyệt** — mở **http://152.53.183.240**

VPS là dual-stack: IPv4 `152.53.183.240` (eth0), IPv6 `2a0a:4cc0:c0:e4e3:687c:60ff:feef:4b90`.
Dùng IPv4 cho tiện. Lưu ý `curl ifconfig.me` không tham số sẽ trả về IPv6 — không phải lỗi.

- Đăng nhập bằng user/mật khẩu → vào được dashboard, F5 vẫn giữ phiên
- Nút "Đăng nhập bằng Google" **không hiển thị** (đúng thiết kế khi chạy IP)
- Đổi cơ sở Hà Nội ↔ Sài Gòn trên thanh nav → số liệu đổi theo
- Trang HR: mở 2 tab, tạo đơn nghỉ phép ở tab 1 → tab 2 cập nhật realtime (kiểm tra SSE)

**8. Dữ liệu sống sót qua restart**

```bash
docker compose restart tks-web
```

Đăng nhập lại bằng tài khoản vừa tạo — nếu mất là volume chưa gắn đúng.

---

## Vận hành

**Cập nhật code:**

```bash
cd /root/tks_web && git pull origin deploy/vps-docker && docker compose up -d --build
```

`server/.env` và volume `tks-data` nằm ngoài git nên `git pull` không đụng tới.

### Đổi JWT_SECRET (huỷ toàn bộ phiên đăng nhập)

Làm khi có token bị lộ, hoặc khi cần đá tất cả mọi người ra. **Đây là cách duy nhất huỷ token
đang lưu hành:** hệ thống không có blacklist/revoke — `server/auth/authMiddleware.js:20-31` chỉ
gọi `verifyToken` rồi tin kết quả, không đối chiếu danh sách nào. Đổi mật khẩu *không* có tác dụng
này.

Không làm hỏng thứ gì khác: OTP là `Map` in-memory với mã 6 số ngẫu nhiên
(`server/auth/otpService.js:13,112`), luồng quên mật khẩu không có link ký sẵn nào
(`authRoutes.js:396-482` là OTP thuần), đăng nhập Google xác thực bằng khoá công khai của Google
(`googleAuthService.js:27-30`), mã liên kết Telegram lưu trong HR spreadsheet.

Backup trước:

```bash
cp /root/tks_web/server/.env /root/.env.bak.$(date +%F-%H%M) && chmod 600 /root/.env.bak.*
```

Sinh và thay (giá trị không hiện lên màn hình; history chỉ lưu `${NEW}` chưa expand):

```bash
NEW=$(openssl rand -hex 48) && sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${NEW}|" /root/tks_web/server/.env && unset NEW
```

Kiểm tra định dạng và line-ending — phải in ra `1` rồi `0`:

```bash
grep -c '^JWT_SECRET=[0-9a-f]\{96\}$' /root/tks_web/server/.env; grep -c $'\r' /root/tks_web/server/.env
```

**Nạp vào — chỗ dễ sai nhất:**

```bash
cd /root/tks_web && docker compose up -d --force-recreate tks-web
```

> ⚠️ `docker compose restart` **không** nạp lại `env_file`. Container cũ giữ nguyên biến môi
> trường cũ và secret cũ vẫn verify được — trông như đã đổi nhưng thực chất chưa. Bắt buộc
> `up -d --force-recreate`.

Xác minh token cũ đã chết (dán token cũ vào chỗ `<TOKEN_CU>`) — phải ra **`401`**:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost/api/auth/me -H 'Cookie: tks_auth=<TOKEN_CU>'
```

Ra `200` nghĩa là container chưa recreate thật. Xong xuôi thì xoá backup chứa secret cũ:

```bash
rm -f /root/.env.bak.*
```

**Tác dụng phụ** (đến từ việc restart, không từ secret): mọi người phải đăng nhập lại · OTP đang
chờ bị xoá sạch, ai đang giữa chừng quên mật khẩu phải xin mã mới · job kiểm tra đứt hàng đang
chạy bị mất · bộ đếm khoá đăng nhập sai 5 lần (`authRoutes.js:34`) reset · SSE đứt và trình duyệt
tự nối lại.

### Backup tự động

Volume `tks_web_tks-data` là **bản duy nhất** của `users.json` (tài khoản người dùng thật),
`notifications.json`, `roleChangeRequests.json`, `telegram_conversations.json`. Không có bản sao
nào ở Google Sheets, không có trong git.

Script `scripts/backup-tks-data.sh` (có trong repo) lo phần tarball + xoay vòng + tự kiểm tra.
**Không cần dừng container:** cả 4 store ghi kiểu temp-file + `rename()`
(`localUserStore.js:199`, `notificationRepository.js:53`, `conversationStore.js:63`,
`roleChangeRequestRepository.js:58`), mà `rename()` là atomic — `tar` luôn đọc được bản cũ hoặc
bản mới trọn vẹn, không bao giờ vớ phải file ghi dở.

Cài đặt một lần:

```bash
cd /root/tks_web && git pull origin deploy/vps-docker && chmod +x scripts/backup-tks-data.sh && docker pull alpine
```

`docker pull alpine` làm sẵn để cron không phụ thuộc vào mạng lúc 3 giờ sáng.

Chạy thử tay trước khi tin vào cron:

```bash
/root/tks_web/scripts/backup-tks-data.sh
```

Phải in ra dòng `OK tks-data-... — <số> byte`. Kích thước vài KB là đúng; **nếu chỉ ~100 byte thì
sai** — nhưng script đã tự bắt lỗi đó rồi (xem bên dưới).

Đặt cron 3h15 sáng:

```bash
( crontab -l 2>/dev/null; echo '15 3 * * * /root/tks_web/scripts/backup-tks-data.sh >> /root/backups/backup.log 2>&1' ) | crontab -
```

Xác nhận đã vào:

```bash
crontab -l
```

> ⚠️ **Ngày tháng cố ý nằm trong script, không nằm trong dòng crontab.** Trong crontab, `%` là ký
> tự đặc biệt (nghĩa là xuống dòng) — viết `date +%F` thẳng vào crontab sẽ khiến cron cắt cụt
> lệnh và job **im lặng không chạy**. Nếu sau này sửa dòng cron, đừng kéo `date` ra ngoài.

> ⚠️ **Gõ sai tên volume không báo lỗi.** `docker run -v ten_sai:/data` khiến Docker *tự tạo một
> volume rỗng*, `tar` vẫn exit 0 và vẫn đẻ ra file `.tar.gz` hợp lệ nhưng rỗng ruột — chỉ lộ ra
> vào đúng lúc cần restore. Vì vậy script bắt buộc đối chiếu `users.json` có thật trong archive,
> không có thì xoá file và exit 1.

Kiểm tra sau vài ngày:

```bash
ls -la /root/backups/ && tail -5 /root/backups/backup.log
```

**Giữ 14 bản, xoay vòng tự động.** Đổi bằng biến môi trường nếu cần:
`TKS_BACKUP_KEEP_DAYS=30`, `TKS_BACKUP_DEST=/mnt/...`, `TKS_BACKUP_VOLUME=...`.

🔴 **`/root/backups` nằm cùng ổ đĩa với volume.** Nó cứu được lỗi app, xoá nhầm, restore hỏng —
**không** cứu được mất VPS. Định kỳ kéo tarball mới nhất về máy bằng SFTP của MobaXterm.

### Restore từ backup

```bash
cd /root/tks_web && docker compose stop tks-web
```

**Bắt buộc dừng trước.** `conversationStore.js:20,43` giữ dữ liệu trong `cache` RAM; đổ file mới
xuống dưới chân container đang sống sẽ bị `persist()` kế tiếp ghi đè lại.

```bash
docker run --rm -v tks_web_tks-data:/data -v /root/backups:/backup alpine sh -c 'rm -rf /data/* && tar xzf /backup/tks-data-<STAMP>.tar.gz -C /data'
```

```bash
cd /root/tks_web && docker compose start tks-web && docker compose exec tks-web ls -la /app/data
```

Các file phải thuộc sở hữu `node`. Sau đó kiểm tra lại hai tài khoản hardcode ở
[mục 5](#5-việc-bắt-buộc-làm-ngay-sau-lần-khởi-động-đầu-️) — `ensureHardcodedAdmins()` sẽ tạo lại
chúng kèm **mật khẩu mặc định** nếu bản backup không chứa.

**Rollback về commit cũ:**

```bash
cd /root/tks_web && git checkout <commit-hash> && docker compose up -d --build
```

**Xem log realtime:**

```bash
docker compose logs -f tks-web
```

> Chạy unit test (434 test) phải làm ở máy local bằng `cd server && npm test` — image
> production đã loại `*.test.js` và devDependencies.

---

## Khi có domain

1. Trỏ bản ghi A về IP VPS, đợi DNS lan truyền
2. Đổi `ports:` trong `docker-compose.yml` thành `"127.0.0.1:3000:3000"`
3. Cài nginx làm reverse proxy. **Bắt buộc** có trong server block:
   - `proxy_buffering off;` và `proxy_read_timeout 300s;` cho route SSE
     `/api/hr/leave-requests/stream` (heartbeat 25s tại `server/hr/hrLeaveRoutes.js:93-99`)
   - `client_max_body_size 10m;` khớp `express.json({limit:'10mb'})` tại `server/index.js:22-23`
4. `certbot --nginx -d <domain>` lấy chứng chỉ Let's Encrypt
5. **Chỉ khi HTTPS đã chạy** mới thêm `NODE_ENV=production` vào `server/.env` để bật lại cookie `Secure`
6. Thêm `app.set('trust proxy', 1)` vào `server/index.js` (hiện chưa có, cần khi đứng sau nginx)
7. Thêm lại `GOOGLE_CLIENT_ID` vào `.env`, đồng thời thêm `https://<domain>` vào
   **Authorized JavaScript origins** của OAuth Client ID trên Google Cloud Console
8. Bật Telegram bot: thêm `TELEGRAM_BOT_ENABLED=true` — **phải tắt bản Render trước**,
   hai poller cùng token sẽ gây lỗi Telegram `409 Conflict`
9. Cron cho `docker compose exec tks-web npm run sync:customer-report`
   (`server/jobs/syncCustomerReport.js` là CLI chạy một lần, `index.js` không tự gọi)
