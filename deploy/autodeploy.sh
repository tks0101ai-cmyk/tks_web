#!/bin/bash
# Tu trien khai TOKOSI dashboard (chay tu cron moi phut, co flock).
# fetch -> co commit moi? -> chan neu co migration moi -> merge --ff-only -> npm ci (thu muc tam, doi ten) -> kiem tra config
# -> pm2 reload (web cluster 1 instance: khong gian doan) -> health check -> loi thi quay ve commit cu va reload lai.
# Commit loi khong bi thu lai cho den khi origin/main doi. FORCE=1 de bo qua chan migration / ghi nho loi.
set -u
export PATH=/opt/node24/bin:$PATH
export GIT_SSH_COMMAND="ssh -o BatchMode=yes"
REPO=${REPO:-/root/tokosi_dashboard}
ECO=${ECO:-/root/tokosi_deploy_dash/ecosystem.config.cjs}
BRANCH=${BRANCH:-main}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:3100/health}
FAILED_FILE=${FAILED_FILE:-/root/tokosi_deploy_dash/last-failed-sha}
FORCE=${FORCE:-0}
log() { echo "[$(date '+%F %T')] $*"; }

cd "$REPO" || exit 1
timeout 60 git fetch -q origin "$BRANCH" 2>/tmp/tokosi-autodeploy-fetch.log || { log "git fetch loi: $(tail -1 /tmp/tokosi-autodeploy-fetch.log)"; exit 1; }
old=$(git rev-parse HEAD); new=$(git rev-parse "origin/$BRANCH")
[ "$old" = "$new" ] && exit 0
[ "$FORCE" != 1 ] && [ "$new" = "$(cat "$FAILED_FILE" 2>/dev/null)" ] && exit 0

fail() { log "$1"; echo "$new" > "$FAILED_FILE"; exit 1; }
log "cap nhat ${old:0:8} -> ${new:0:8}"

# Migration chay tay vi DB Supabase dung chung: chi bao, khong tu ap.
mig=$(git diff --name-only "$old" "$new" -- server/db/migrations)
if [ -n "$mig" ] && [ "$FORCE" != 1 ]; then
  fail "DUNG: commit moi co migration, hay ap tay roi chay 'FORCE=1 $0': $(echo $mig | tr '\n' ' ')"
fi

git merge --ff-only -q "origin/$BRANCH" || fail "khong merge ff-only duoc (co thay doi cuc bo?)"
changed=$(git diff --name-only "$old" "$new" -- server)
if [ -z "$changed" ]; then log "chi doi ngoai server/ (tai lieu...), khong can reload"; rm -f "$FAILED_FILE"; exit 0; fi

rollback() {
  log "$1 -> quay ve ${old:0:8}"
  git reset -q --hard "$old"
  [ -d server/node_modules.old ] && { rm -rf server/node_modules; mv server/node_modules.old server/node_modules; }
  pm2 reload "$ECO" --update-env >/dev/null 2>&1
  echo "$new" > "$FAILED_FILE"; exit 1
}

# Cai dependency vao thu muc tam roi doi ten, de ban dang chay khong bi mat node_modules giua chung.
if git diff --name-only "$old" "$new" -- server/package.json server/package-lock.json | grep -q .; then
  stage=$(mktemp -d "$REPO/server/.nm-stage.XXXX")
  cp server/package.json server/package-lock.json "$stage/"
  (cd "$stage" && npm ci --omit=dev >/tmp/tokosi-autodeploy-npm.log 2>&1) || { rm -rf "$stage"; rollback "npm ci loi (xem /tmp/tokosi-autodeploy-npm.log)"; }
  rm -rf server/node_modules.old; mv server/node_modules server/node_modules.old; mv "$stage/node_modules" server/node_modules; rm -rf "$stage"
fi

# Bat loi cu phap / thieu bien moi truong bat buoc truoc khi dong vao ban dang chay.
(cd server && node --check index.js && node --check worker.js && NODE_ENV=production node --env-file=.env -e "require('./config')") >/tmp/tokosi-autodeploy-check.log 2>&1 \
  || rollback "kiem tra truoc reload loi: $(tail -1 /tmp/tokosi-autodeploy-check.log)"

pm2 reload "$ECO" --update-env >/dev/null 2>&1
for _ in $(seq 1 20); do
  sleep 2
  if curl -fsS -m 5 "$HEALTH_URL" >/dev/null 2>&1; then
    rm -rf server/node_modules.old "$FAILED_FILE"
    log "xong: khoe tai $(git rev-parse --short HEAD)"; exit 0
  fi
done
rollback "sau reload /health khong tra loi"
