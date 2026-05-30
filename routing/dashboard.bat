@echo off
chcp 65001 >nul
echo Starting dashboard server on http://localhost:8300
start "" /B node "%~dp0dashboard-server.js" > "%~dp0dashboard-server.log" 2>&1
timeout /t 2 /nobreak >nul
start "" "http://localhost:8300"
