#!/bin/bash
# PPT InteractiveWebPage — 本地开发快速启动
# 用法: bash start.sh

set -e

PORT=${1:-3000}
WORKER_PORT=${2:-8787}

echo "╔══════════════════════════════════════════════╗"
echo "║  PPT InteractiveWebPage — 本地开发环境       ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# 检查 Python
if ! command -v python3 &> /dev/null; then
  echo "❌ 需要 Python 3 请先安装"
  exit 1
fi

# 启动前端服务器
echo "🌐 启动前端服务器 (端口 $PORT)..."
cd "$(dirname "$0")/frontend/public"
python3 -m http.server $PORT &
FRONTEND_PID=$!
sleep 0.5

echo ""
echo "✅ 前端已启动:"
echo "   Portal:  http://localhost:$PORT/index.html"
echo "   工具页:  http://localhost:$PORT/app.html"
echo "   3D演示:  http://localhost:$PORT/demo.html"
echo ""

# 尝试启动 Worker
if command -v wrangler &> /dev/null; then
  echo "⚡ 启动 Worker 本地开发 (端口 $WORKER_PORT)..."
  cd "$(dirname "$0")/worker"
  wrangler dev --port $WORKER_PORT &
  WORKER_PID=$!
  sleep 1
  echo "   Worker:  http://localhost:$WORKER_PORT"
  echo ""
fi

echo "按 Ctrl+C 停止所有服务"
echo ""

# 等待中断
trap "echo ''; echo '正在停止...'; kill $FRONTEND_PID 2>/dev/null; kill $WORKER_PID 2>/dev/null; echo '✅ 已停止'; exit 0" INT TERM
wait
