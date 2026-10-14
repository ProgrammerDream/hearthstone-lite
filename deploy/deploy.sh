#!/usr/bin/env bash
# 在目标机（vps-tokyo）上部署 / 更新 hearthstone-lite 联机服务端。幂等；只操作 hearthstone-lite 这一个 systemd unit。
#
#   bash deploy/deploy.sh [git-ref]            默认 ref: feat/server-mvp
#   SKIP_GIT=1 bash deploy/deploy.sh           代码已经放到 APP_DIR（例如用补丁 / scp 送过去），跳过 git 拉取
#
# 环境变量：APP_DIR(/home/ubuntu/apps/hearthstone-lite) REPO(GitHub 地址) PORT(8787)
set -euo pipefail
APP_DIR="${APP_DIR:-/home/ubuntu/apps/hearthstone-lite}"
REPO="${REPO:-https://github.com/ProgrammerDream/hearthstone-lite.git}"
REF="${1:-feat/server-mvp}"
PORT="${PORT:-8787}"
UNIT=hearthstone-lite

echo "== 1. 端口检查 :${PORT}"
if ss -ltnp | grep -q ":${PORT} "; then
  if systemctl is-active --quiet "$UNIT"; then
    echo "   端口由本服务占用（将重启）"
  else
    echo "!! 端口 ${PORT} 被其它进程占用，停止部署，不碰别人的进程："; ss -ltnp | grep ":${PORT} "; exit 1
  fi
else
  echo "   空闲"
fi

echo "== 2. 代码"
if [ "${SKIP_GIT:-0}" != "1" ]; then
  if [ ! -d "$APP_DIR/.git" ]; then
    mkdir -p "$(dirname "$APP_DIR")"
    git clone --branch "$REF" "$REPO" "$APP_DIR"
  else
    git -C "$APP_DIR" fetch origin "$REF"
    git -C "$APP_DIR" checkout -q "$REF"
    git -C "$APP_DIR" reset -q --hard "origin/$REF"
  fi
fi
cd "$APP_DIR"
echo "   $(git rev-parse --short HEAD) $(git log -1 --format=%s)"

echo "== 3. 依赖（仅生产依赖：ws）"
npm ci --omit=dev --no-audit --no-fund

echo "== 4. 自测"
# Trust the process status, not reporter text (TAP/spec differ over SSH).
# With set -e, a failed test stops here before any service changes.
npm test

echo "== 5. systemd"
sudo install -m 644 deploy/hearthstone-lite.service "/etc/systemd/system/${UNIT}.service"
sudo systemctl daemon-reload
sudo systemctl enable "$UNIT" >/dev/null 2>&1 || true
sudo systemctl restart "$UNIT"

echo "== 6. 健康检查"
sleep 1.5
curl -fsS "http://127.0.0.1:${PORT}/healthz"; echo
systemctl --no-pager status "$UNIT" | sed -n '1,5p'
echo "OK: http://$(curl -s -m 3 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}'):${PORT}/"
