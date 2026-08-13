@echo off
REM Backend Switcher — starts transparent-proxy.js (UI on :8200/__switch)
REM This is NOT a request proxy — it only edits ~/.claude/settings.json
REM and tells you to restart Claude Code.

cd /d "%~dp0"

REM Kill orphaned browser zombies left by autoregers / LK sessions (real user browser untouched)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0cleanup-reg-procs.ps1"

REM Kill any existing instance on :8200 so we don't get EADDRINUSE
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8200 " ^| findstr LISTENING') do (
    echo Stopping existing listener on :8200 (PID %%P)
    taskkill /F /PID %%P >nul 2>&1
)

echo Starting Freemodel Key Rotator on :20126 ...
start "FM Rotator" /B node freemodel-rotator.js
timeout /t 1 /nobreak >nul

REM Kill + start FreeModel OpenAI proxy (:20130) — Anthropic->OpenAI for gpt models
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":20130 " ^| findstr LISTENING') do (
    taskkill /F /PID %%P >nul 2>&1
)
echo Starting FreeModel OpenAI Proxy on :20130 ...
start "FM OpenAI Proxy" /B node freemodel-openai-proxy.js
timeout /t 1 /nobreak >nul

REM Kill + start VyceAI OpenAI proxy (:20131) — Anthropic->OpenAI for vyceai.com
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":20131 " ^| findstr LISTENING') do (
    taskkill /F /PID %%P >nul 2>&1
)
echo Starting VyceAI OpenAI Proxy on :20131 ...
start "Vyce OpenAI Proxy" /B node vyceai-openai-proxy.js
timeout /t 1 /nobreak >nul

REM Kill agentrouter proxy (:20132) ? ??????????? boot-spawn'?? transparent-proxy.js
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":20132 " ^| findstr LISTENING') do (
    taskkill /F /PID %%P >nul 2>&1
)

REM Kill keepalive proxy (:20133) — тоже boot-spawn'ится transparent-proxy.js
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":20133 " ^| findstr LISTENING') do (
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
taskkill /FI "WINDOWTITLE eq FM Rotator*" /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq FM OpenAI Proxy*" /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Vyce OpenAI Proxy*" /F >nul 2>&1
