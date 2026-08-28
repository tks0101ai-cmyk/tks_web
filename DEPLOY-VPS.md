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

## 5. Di trú dữ liệu từ Render ⚠️

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

Nếu bắt đầu hoàn toàn mới: đăng nhập `admin` / `Admin@123` rồi **đổi mật khẩu ngay**.

## 6. Firewall — không cần làm gì

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

```bash
curl -i -s -X POST http://localhost/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"Admin@123"}' | grep -i set-cookie
```

Kết quả phải có `Set-Cookie: tks_auth=...` và **không chứa chữ `Secure`**.
Nếu thấy `Secure` → `NODE_ENV=production` đã lọt vào env, quay lại mục 3 gỡ ra.

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

**Backup dữ liệu (nên đặt cron hằng ngày):**

```bash
docker run --rm -v tks_web_tks-data:/data -v /root/backups:/backup alpine tar czf /backup/tks-data-$(date +%F).tar.gz -C /data .
```

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
