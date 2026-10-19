#!/usr/bin/env bash
# deploy.sh — 安装与启动 Manus 桌面助手 (Ubuntu 24, GNOME)
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HTML="$APP_DIR/assistant-wallpaper.html"
DAEMON="$APP_DIR/assistant_daemon.py"
SCRATCH="$HOME/.hermes/cache/scratch"
LOG="$SCRATCH/manus_agent.log"

mkdir -p "$SCRATCH"

echo "[1/4] 检查依赖…"
command -v python3 >/dev/null || { echo "缺少 python3"; exit 1; }

echo "[2/4] 写壁纸 SVG（静态兜底）…"
cat > "$APP_DIR/wallpaper.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
  <rect width="1920" height="1080" fill="#05060a"/>
  <radialGradient id="g" cx="50%" cy="35%" r="70%"><stop offset="0%" stop-color="#6366f1" stop-opacity=".12"/><stop offset="100%" stop-color="#05060a" stop-opacity="0"/></radialGradient>
  <circle cx="960" cy="380" r="700" fill="url(#g)"/>
  <text x="960" y="560" font-family="sans-serif" font-size="64" fill="#6366f1" text-anchor="middle" opacity=".85">◆</text>
  <text x="960" y="640" font-family="sans-serif" font-size="24" fill="#9ca3af" text-anchor="middle">Manus Agent 桌面助手 · 1920×1080</text>
</svg>
SVG
echo "  -> $APP_DIR/wallpaper.svg"

echo "[3/4] 设置 GNOME 壁纸（如果可用）…"
if command -v gsettings >/dev/null 2>&1; then
  gsettings set org.gnome.desktop.background picture-uri "file://$HTML" 2>/dev/null || true
  gsettings set org.gnome.desktop.background picture-uri-dark "file://$HTML" 2>/dev/null || true
  gsettings set org.gnome.desktop.screensaver picture-uri "file://$APP_DIR/wallpaper.svg" 2>/dev/null || true
  echo "  壁纸已设为 HTML（GNOME 可能不直接渲染 HTML 壁纸，建议在浏览器全屏打开：$HTML）"
else
  echo "  无 gsettings，跳过；请手动在浏览器全屏打开 $HTML"
fi

echo "[4/4] 启动后端守护进程 (端口 8765)…"
if pgrep -f "assistant_daemon.py" >/dev/null; then
  echo "  守护进程已在运行"
else
  nohup python3 "$DAEMON" >> "$LOG" 2>&1 &
  echo $! > "$SCRATCH/manus_daemon.pid"
  sleep 1
  if curl -s http://127.0.0.1:8765/stats >/dev/null 2>&1; then
    echo "  守护进程已启动 (PID $(cat $SCRATCH/manus_daemon.pid))"
  else
    echo "  启动失败，查看日志: $LOG"
  fi
fi

echo ""
echo "=== 使用说明 ==="
echo "1. 交互壁纸：在浏览器打开 $HTML 并按 F11 全屏（建议设为开机自启）"
echo "2. 开机自启示例：echo '@reboot $HOME/.config/autostart/manus.desktop' 至 crontab"
echo "3. 登录屏幕 CSS：将 wallpaper.svg 复制到 /usr/share/gnome-shell/theme/ (需 root)"
echo "4. 停止守护进程：kill \$(cat $SCRATCH/manus_daemon.pid)"
echo "5. 日志：$LOG"
