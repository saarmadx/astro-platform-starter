@echo off
title Clipsmith - optional paid keys
cd /d "%~dp0"
echo.
echo  OPTIONAL. Clipsmith works for free without any keys.
echo  Keys only unlock the paid options (OpenAI captions, Claude API clip picking).
echo  To paste in this window: RIGHT-CLICK, then press Enter. Press Enter alone to skip one.
echo.
set "OKEY="
set "AKEY="
set /p OKEY=  OpenAI key (starts with sk-): 
set /p AKEY=  Anthropic key (starts with sk-ant-): 
> ".env" echo OPENAI_API_KEY=%OKEY%
>> ".env" echo ANTHROPIC_API_KEY=%AKEY%
>> ".env" echo APP_ACCESS_CODE=
echo.
echo  Saved. Close Clipsmith and start it again for the keys to take effect.
pause
