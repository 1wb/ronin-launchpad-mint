#!/usr/bin/env bash
# Ronin Launchpad Mint - macOS / Linux 启动器
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "[!] 未检测到 Node.js,请先安装: https://nodejs.org/"
  exit 1
fi

echo "============================================"
echo "  Ronin Launchpad 白名单 Mint 工具"
echo "============================================"
echo "  [1] 试跑  —— 只读模拟,不发交易,验证配置"
echo "  [2] 实弹  --go,到点自动开火(花 gas)"
echo "============================================"
printf "请输入 1 或 2 后回车: "
read -r mode

if [ -f "dist/mint.cjs" ]; then
  if [ "$mode" = "2" ]; then
    node dist/mint.cjs --go
  else
    node dist/mint.cjs
  fi
else
  if [ ! -d "node_modules" ]; then
    echo "[!] 缺少依赖:请先在本目录执行 npm install,或下载包含 dist 的完整仓库"
    exit 1
  fi
  if [ "$mode" = "2" ]; then
    node mint.mjs --go
  else
    node mint.mjs
  fi
fi
