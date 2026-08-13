@echo off
REM Replaces keepalive-proxy.js process on :20133 without blocking the caller.
REM Kills whatever listens on :20133, then spawns node fully detached with both
REM stdout and stderr redirected to files, so the launching console returns at once.
REM Logs: keepalive-proxy.err.log  (stderr contains proxy logs via log())
cd /d "%~dp0"

for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":20133 " ^| findstr LISTENING') do taskkill /F /PID %%P >nul 2>&1
timeout /t 1 /nobreak >nul

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList '\"%~dp0keepalive-proxy.js\"' -WorkingDirectory '%~dp0' -WindowStyle Hidden -RedirectStandardOutput '%~dp0keepalive-proxy.out.log' -RedirectStandardError '%~dp0keepalive-proxy.err.log'"