@echo off
title Clipsmith
cd /d "%~dp0"

if not exist "node_modules" (
  echo  Installing, this takes a few minutes the first time...
  call npm install
)
echo.
echo  Starting Clipsmith. Your browser will open in a few seconds.
echo  Keep this window open while you use the app. Close it to stop.
echo.
start "" cmd /c "timeout /t 10 >nul & start http://localhost:4321/studio"
call npm run dev
pause
