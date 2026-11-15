@echo off
title Clipsmith
cd /d "%~dp0"

if exist ".env" goto start

echo.
echo  ============================================
echo   CLIPSMITH - FIRST TIME SETUP
echo  ============================================
echo.
echo  You need two keys. To paste in this window:
echo  RIGHT-CLICK inside the window, then press Enter.
echo.
:askopenai
set "OKEY="
set /p OKEY=  1) Paste your OpenAI key (starts with sk-) and press Enter: 
if "%OKEY%"=="" goto askopenai
echo.
:askanthropic
set "AKEY="
set /p AKEY=  2) Paste your Anthropic key (starts with sk-ant-) and press Enter: 
if "%AKEY%"=="" goto askanthropic

> ".env" echo OPENAI_API_KEY=%OKEY%
>> ".env" echo ANTHROPIC_API_KEY=%AKEY%
>> ".env" echo APP_ACCESS_CODE=
echo.
echo  Keys saved. To change them later, double-click change-keys.bat
echo.

:start
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
