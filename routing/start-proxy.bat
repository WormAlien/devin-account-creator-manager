@echo off
echo Starting Transparent Proxy Router...
cd /d "%~dp0"
start "Transparent Proxy" node transparent-proxy.js
timeout /t 2 /nobreak >nul
echo Opening dashboard...
start http://localhost:8200/dashboard/
echo.
echo Proxy running on http://localhost:8200
echo Notion dashboard: http://localhost:8200/dashboard/
echo Switch panel:     http://localhost:8200/__switch
echo.
echo Press any key to stop...
pause >nul
taskkill /FI "WINDOWTITLE eq Transparent Proxy*" /F >nul 2>&1
