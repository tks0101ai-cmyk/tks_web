# ==========================================
# TKS Dashboard — image cho VPS (Docker Compose)
#
# Build context la thu muc server/ (xem docker-compose.yml o thu muc goc).
# Khong co build step cho frontend: server/public/ la HTML/CSS/JS viet tay da
# commit san, chi can copy nguyen trang.
# ==========================================
FROM node:22-bookworm-slim

WORKDIR /app

# ==========================================
# QUAN TRONG — KHONG dat ENV NODE_ENV=production o day.
#
# server/auth/authRoutes.js:123 va server/branch/branchMiddleware.js:20 dat
# cookie voi `secure: process.env.NODE_ENV === 'production'`. Cookie co co
# Secure khong bao gio duoc trinh duyet gui qua HTTP, nen khi app con chay
# bang IP tran (chua co domain/HTTPS) thi dat NODE_ENV=production se lam
# dang nhap HONG HOAN TOAN: user login xong bi da ra ngay.
#
# Chi bat NODE_ENV=production SAU KHI da co domain + chung chi HTTPS.
#
# Khong dat NODE_ENV cung khien server/config.js:4-6 thu require('dotenv'),
# nhung dotenv nam trong devDependencies va da bi loai boi --omit=dev. Loi
# MODULE_NOT_FOUND do bi try/catch o dong 5 nuot lai, khong crash. Bien moi
# truong that su den tu `env_file:` cua Compose (bien that cua process), nen
# khong can dotenv.
# ==========================================

# Copy manifest truoc de tan dung layer cache: chi khi package*.json doi thi
# buoc npm ci moi chay lai.
COPY package.json package-lock.json ./

# npm ci --omit=dev: bo dotenv + jsdom (devDependencies).
# bcryptjs la pure JS nen khong can toolchain bien dich native.
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# server/data/ la TOAN BO state ben vung cua app (users.json, notifications.json,
# roleChangeRequests.json, telegram_conversations.json) — se duoc mount bang
# named volume tks-data. Tao san thu muc voi quyen cua user `node` ngay trong
# image de khi Docker khoi tao volume rong, volume ke thua dung uid/gid nay.
#
# Neu thu muc nay khong ghi duoc, notificationRepository.js:188 va
# roleChangeRequestRepository.js:166 se AM THAM fallback sang os.tmpdir():
# app trong nhu chay binh thuong nhung du lieu bi mat sau moi lan restart.
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 3000

# Kiem tra GET /health (server/routes.js:28-30). Dung node fetch san co tu
# Node 18+ nen khong phai cai them curl/wget vao image slim.
#
# Healthcheck la lop phat hien DUY NHAT khi app treo: server/index.js:9-15 bat
# uncaughtException/unhandledRejection nhung chi log chu KHONG process.exit(),
# nen process van song trong trang thai hong va `restart:` cua Docker se khong
# bao gio kich hoat.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# --max-old-space-size=1536: nang tu 512 trong server/package.json:8. Gia tri
# 512 do duoc tinh cho instance nho cua Render; VPS nay con ~5.4 GB trong.
CMD ["node", "--max-old-space-size=1536", "index.js"]
