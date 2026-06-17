@echo off
REM Restart Backend Switcher dashboard on :8200.
REM Kills any existing instance, starts fresh, opens UI in default browser.
REM
REM Usage: double-click, or call from cmd.

cd /d "%~dp0"

REM Kill listener on :8200
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8200 " ^| findstr LISTENING') do (
    echo Stopping PID %%P on :8200 ...
    taskkill /F /PID %%P >nul 2>&1
)
REM Also kill the legacy :8300 zombie if it ever comes back
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8300 " ^| findstr LISTENING') do (
    echo Stopping legacy PID %%P on :8300 ...
    taskkill /F /PID %%P >nul 2>&1
)

REM Brief wait so the OS releases the port
ping 127.0.0.1 -n 2 >nul

echo Starting Freemodel Key Rotator on :20126 ...
start "FM Rotator" /B node freemodel-rotator.js
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
