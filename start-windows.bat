@echo off
title Clipsmith
cd /d "%~dp0"

if not exist "node_modules" (
  echo  Installing, this takes a few minutes the first time...
) else (
  echo  Checking for updates to what Clipsmith needs...
)
rem runs every time so a new version's extra parts get installed (takes seconds when nothing changed)
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo  Installing failed. Check your internet connection and run this file again.
  pause
  exit /b 1
)
echo.
echo  Starting Clipsmith. Your browser will open in a few seconds.
echo  Keep this window open while you use the app. Close it to stop.
echo.
start "" cmd /c "timeout /t 10 >nul & start http://localhost:4321/studio"
call npm run dev
pause
