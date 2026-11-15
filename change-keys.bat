@echo off
cd /d "%~dp0"
if exist ".env" del ".env"
echo Old keys removed. Starting setup again...
call start-windows.bat
