@echo off
REM Restart Backend Switcher dashboard on :8200.
REM Kills any existing instance, starts fresh, opens UI in default browser.
REM
REM Usage: double-click, or call from cmd.

cd /d "%~dp0"

REM Гасим всё разом, потом даём ОС отпустить сокеты.
REM Раньше пауза была ping -n 2 (~1с) — taskkill отрабатывает асинхронно,
REM порт ещё в TIME_WAIT, и старт падал с EADDRINUSE. Теперь 4с.
call :KILLPORT 8200  "switcher"
call :KILLPORT 8300  "legacy"
call :KILLPORT 20126 "FM rotator"
call :KILLPORT 20130 "FM OpenAI proxy"
call :KILLPORT 20131 "VyceAI proxy"
call :KILLPORT 20132 "agentrouter proxy"

echo Waiting for ports to be released ...
ping 127.0.0.1 -n 5 >nul

echo Starting Freemodel Key Rotator on :20126 ...
start "FM Rotator" /B node freemodel-rotator.js
ping 127.0.0.1 -n 2 >nul

echo Starting FreeModel OpenAI Proxy on :20130 ...
start "FM OpenAI Proxy" /B node freemodel-openai-proxy.js
ping 127.0.0.1 -n 2 >nul

echo Starting VyceAI OpenAI Proxy on :20131 ...
start "Vyce OpenAI Proxy" /B node vyceai-openai-proxy.js
ping 127.0.0.1 -n 2 >nul

echo Starting transparent-proxy.js (switcher + dashboard) on :8200 ...
start "Backend Switcher" /MIN node transparent-proxy.js

REM Wait for the server to come up (poll status endpoint up to 6s)
set RETRY=0
:WAIT
ping 127.0.0.1 -n 2 >nul
curl -s --max-time 1 http://localhost:8200/__switch/api/status >nul 2>&1
if not errorlevel 1 goto READY
set /a RETRY+=1
if %RETRY% LSS 6 goto WAIT

:READY
echo Opening dashboard ...
start "" http://localhost:8200/__switch

echo.
echo  Switcher / Accounts dashboard:  http://localhost:8200/__switch
echo  Status API:                     http://localhost:8200/__switch/api/status
echo.
echo Window will close in 3 seconds...
ping 127.0.0.1 -n 4 >nul
exit /b 0

REM ── Убить всех слушателей порта %1 (%2 — человекочитаемое имя) ──────────
REM netstat отдаёт по строке на каждый сокет, поэтому один PID может
REM встретиться дважды — второй taskkill просто ничего не находит, это норма.
:KILLPORT
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%~1 " ^| findstr LISTENING') do (
    echo Stopping PID %%P on :%~1 ^(%~2^) ...
    taskkill /F /PID %%P >nul 2>&1
)
exit /b 0
