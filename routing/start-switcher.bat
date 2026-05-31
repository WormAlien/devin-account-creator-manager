@echo off
REM Backend Switcher — starts transparent-proxy.js (UI on :8200/__switch)
REM This is NOT a request proxy — it only edits ~/.claude/settings.json
REM and tells you to restart Claude Code.

cd /d "%~dp0"

REM Kill any existing instance on :8200 so we don't get EADDRINUSE
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8200 " ^| findstr LISTENING') do (
    echo Stopping existing listener on :8200 (PID %%P)
    taskkill /F /PID %%P >nul 2>&1
)

echo Starting Backend Switcher on :8200 ...
start "Backend Switcher" node transparent-proxy.js
timeout /t 2 /nobreak >nul

echo Opening switch panel...
start http://localhost:8200/__switch

echo.
echo Switch panel:  http://localhost:8200/__switch
echo Status API:    http://localhost:8200/__switch/api/status
echo.
echo Window will stay open. Close it (or press a key) to stop the switcher.
pause >nul
taskkill /FI "WINDOWTITLE eq Backend Switcher*" /F >nul 2>&1
