#!/bin/sh
# ============================================================================
# Backup volume du lieu song cua tks-web (users.json, notifications.json,
# roleChangeRequests.json, telegram_conversations.json).
#
# Chay tay:  /root/tks_web/scripts/backup-tks-data.sh
# Chay cron: xem DEPLOY-VPS.md muc "Backup tu dong".
#
# KHONG can dung container. Ca 4 store deu ghi kieu temp-file + rename()
# (localUserStore.js:199, notificationRepository.js:53, conversationStore.js:63,
# roleChangeRequestRepository.js:58). rename() la atomic tren cung filesystem,
# nen tar luon doc duoc ban cu HOAC ban moi tron ven — khong bao gio doc phai
# file dang ghi do dang.
#
# NGUOC LAI, RESTORE thi BAT BUOC phai dung container truoc — xem cuoi file.
# ============================================================================
set -eu

# cron chay voi PATH toi thieu va KHONG doc ~/.profile. Dat tuong minh de
# `docker` chac chan tim thay — day la nguyen nhan pho bien nhat khien cron job
# im lang khong chay trong khi go tay thi ngon.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

VOLUME="${TKS_BACKUP_VOLUME:-tks_web_tks-data}"
DEST="${TKS_BACKUP_DEST:-/root/backups}"
KEEP_DAYS="${TKS_BACKUP_KEEP_DAYS:-14}"

STAMP=$(date +%F-%H%M)
ARCHIVE="tks-data-${STAMP}.tar.gz"

mkdir -p "$DEST"
# 700: archive chua users.json — hash mat khau, email, ten that cua nhan vien.
chmod 700 "$DEST"

# :ro — script chi doc, khong the lo tay ghi vao volume that.
docker run --rm \
  -v "${VOLUME}:/data:ro" \
  -v "${DEST}:/backup" \
  alpine tar czf "/backup/${ARCHIVE}" -C /data .

chmod 600 "${DEST}/${ARCHIVE}"

# ---------------------------------------------------------------------------
# Kiem tra bat buoc: go SAI ten volume thi Docker TU TAO MOT VOLUME RONG thay vi
# bao loi. tar van exit 0, van de ra file .tar.gz ~100 byte, cron van ghi "OK".
# Backup kieu do chi lo ra vao dung luc can restore. Bat buoc doi chieu
# users.json co that trong archive.
# ---------------------------------------------------------------------------
if ! tar tzf "${DEST}/${ARCHIVE}" | grep -q '^\./users\.json$'; then
  rm -f "${DEST}/${ARCHIVE}"
  echo "$(date +%F' '%T) LOI: archive khong chua users.json — kiem tra ten volume '${VOLUME}' (docker volume ls)" >&2
  exit 1
fi

# Xoay vong. Chi khop dung tien to tks-data-*.tar.gz nen backup.log va cac file
# khac trong thu muc khong bi dung toi.
find "$DEST" -maxdepth 1 -type f -name 'tks-data-*.tar.gz' -mtime "+${KEEP_DAYS}" -delete

SIZE=$(stat -c%s "${DEST}/${ARCHIVE}")
COUNT=$(find "$DEST" -maxdepth 1 -type f -name 'tks-data-*.tar.gz' | wc -l)
echo "$(date +%F' '%T) OK ${ARCHIVE} — ${SIZE} byte, giu ${COUNT} ban (${KEEP_DAYS} ngay)"

# ============================================================================
# RESTORE — doc ky truoc khi dung
#
#   cd /root/tks_web
#   docker compose stop tks-web                 # BAT BUOC. conversationStore.js:20
#                                               # cache trong RAM; do file moi xuong
#                                               # duoi chan container dang song se bi
#                                               # persist() ke tiep ghi de lai.
#   docker run --rm -v tks_web_tks-data:/data -v /root/backups:/backup alpine \
#     sh -c 'rm -rf /data/* && tar xzf /backup/tks-data-<STAMP>.tar.gz -C /data'
#   docker compose start tks-web
#   docker compose exec tks-web ls -la /app/data   # phai thuoc so huu `node`
#
# Sau khi restore, kiem tra lai 2 tai khoan hardcode (DEPLOY-VPS.md muc 5):
# ensureHardcodedAdmins() se tao lai chung kem mat khau MAC DINH neu ban backup
# khong co.
# ============================================================================
