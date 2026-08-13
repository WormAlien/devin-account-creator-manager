@echo off
setlocal EnableDelayedExpansion
REM Restart Backend Switcher dashboard on :8200.
REM Kills any existing instance, starts fresh, opens UI in default browser.
REM
REM Hardened 2026-08-13:
REM   - self-elevates to Administrator: taskkill can NOT kill elevated node
REM     instances from a normal console (silent "Access denied" before).
REM   - taskkill errors are NOT swallowed; each port is verified with netstat
REM     until it is actually free (up to 8s) before anything is started.
REM   - refuses to start on a busy port and exits with code 1 instead of
REM     crashing with EADDRINUSE.
REM
REM Usage: double-click, or call from cmd.

cd /d "%~dp0"

REM ---- Self-elevation: run as Administrator so taskkill works on all old PIDs ----
net session >nul 2>&1
if not "%errorlevel%"=="0" (
    echo Requesting Administrator rights ^(UAC^) ...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs -WorkingDirectory '%~dp0'"
    exit /b
)

REM Гасим всё разом, потом даём ОС отпустить сокеты (не фиксированной паузой,
REM а блоками netstat-проверки, пока порт не освободился реально).
call :KILLPORT 8200  "switcher"
call :KILLPORT 8300  "legacy"
call :KILLPORT 20126 "FM rotator"
call :KILLPORT 20130 "FM OpenAI proxy"
call :KILLPORT 20131 "VyceAI proxy"
call :KILLPORT 20132 "agentrouter proxy"
call :KILLPORT 20133 "keepalive proxy"
if "%FAILED%"=="1" goto FAILED

echo All ports released.

echo Starting Freemodel Key Rotator on :20126 ...
call :STARTGUARD 20126 || goto FAILED
start "FM Rotator" /B node freemodel-rotator.js
ping 127.0.0.1 -n 2 >nul

echo Starting FreeModel OpenAI Proxy on :20130 ...
call :STARTGUARD 20130 || goto FAILED
start "FM OpenAI Proxy" /B node freemodel-openai-proxy.js
ping 127.0.0.1 -n 2 >nul

echo Starting VyceAI OpenAI Proxy on :20131 ...
call :STARTGUARD 20131 || goto FAILED
start "Vyce OpenAI Proxy" /B node vyceai-openai-proxy.js
ping 127.0.0.1 -n 2 >nul

echo Starting transparent-proxy.js (switcher + dashboard) on :8200 ...
call :STARTGUARD 8200 || goto FAILED
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
choice /c Fn /n /t 3 /d n /m "Window will close in 3 s... press F to keep it open. "
if errorlevel 2 exit 0
echo.
echo  Keeping window open. Press any key to close.
pause >nul
exit 0

:FAILED
echo.
echo  *** RESTART FAILED - ports could not be freed, see messages above. ***
choice /c Fn /n /t 5 /d n /m "Window will close in 5 s... press F to keep it open. "
if errorlevel 2 exit 1
echo  Keeping window open. Press any key to close.
pause >nul
exit 1

REM ----------------------------------------------------------------------------
REM Kill all LISTENING PIDs on port %1 ("%2" = friendly name).
REM After killing, poll netstat for up to ~8s until the port is really free.
REM The verification loop is the source of truth (taskkill "not found" on a
REM duplicate IPv4/IPv6 socket row is harmless noise, not an error).
:KILLPORT
set "KP_PORT=%~1"
set "KP_NAME=%~2"
set "KP_ANY=0"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%KP_PORT% " ^| findstr LISTENING') do (
    set "KP_ANY=1"
    echo   Stopping PID %%P on :%KP_PORT% ^(%KP_NAME%^)...
    taskkill /F /PID %%P
)
if not "%KP_ANY%"=="1" exit /b 0
set /a KP_WAIT=0
:KP_WAITFREE
set "KP_STILL="
for /f "tokens=5" %%Q in ('netstat -ano ^| findstr ":%KP_PORT% " ^| findstr LISTENING') do set "KP_STILL=%%Q"
if defined KP_STILL (
    set /a KP_WAIT+=1
    if !KP_WAIT! GEQ 8 (
        echo   !!! ERROR: port :%KP_PORT% still held by PID !KP_STILL! ^(%KP_NAME%^)
        set "FAILED=1"
        exit /b 0
    )
    ping 127.0.0.1 -n 2 >nul
    goto KP_WAITFREE
)
echo   Port :%KP_PORT% free.
exit /b 0

REM ----------------------------------------------------------------------------
REM Refuse to start on a busy port. Exit code 1 -> caller goes to :FAILED.
:STARTGUARD
set "SG_PORT=%~1"
netstat -ano | findstr ":%SG_PORT% " | findstr LISTENING >nul
if not errorlevel 1 (
    echo   !!! ABORT: port :%SG_PORT% is still busy, not starting %~2
    set "FAILED=1"
    exit /b 1
)
exit /b 0