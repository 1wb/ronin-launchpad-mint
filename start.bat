@echo off
chcp 65001 >nul
title Ronin Launchpad Mint
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [!] 未检测到 Node.js,请先安装: https://nodejs.org/ 下载 LTS 版一路下一步
  pause
  exit /b 1
)

echo ============================================
echo   Ronin Launchpad 白名单 Mint 工具
echo ============================================
echo   [1] 试跑  —— 只读模拟,不发交易,验证配置
echo   [2] 实弹  --go,到点自动开火(花 gas)
echo ============================================
set /p mode=请输入 1 或 2 后回车: 

if exist "dist\mint.cjs" (
  if "%mode%"=="2" (
    node "dist\mint.cjs" --go
  ) else (
    node "dist\mint.cjs"
  )
) else (
  if not exist "node_modules" (
    echo [!] 缺少依赖:请先在本目录执行 npm install,或直接下载包含 dist 的完整仓库
    pause
    exit /b 1
  )
  if "%mode%"=="2" (
    node "mint.mjs" --go
  ) else (
    node "mint.mjs"
  )
)
pause
