@echo off
chcp 65001 >nul
title MyClaude GUI 服务
echo ==============================================
echo   MyClaude GUI  ·  http://127.0.0.1:7788
echo   关闭本窗口 = 停止服务（会自动保存会话）
echo ==============================================
cd /d "%~dp0"
"dist\myclaude.exe" --gui
pause
