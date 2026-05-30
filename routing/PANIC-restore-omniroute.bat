@echo off
chcp 65001 >nul

echo.
echo ============================================
echo  PANIC: Restoring OmniRoute working state
echo ============================================
echo.

REM 1. Восстановить settings.json из бэкапа
copy /Y "%USERPROFILE%\.claude\settings.omniroute-backup.json" "%USERPROFILE%\.claude\settings.json" >nul
if %ERRORLEVEL%==0 (
    echo [1/4] settings.json restored from backup
) else (
    echo [1/4] ERROR: backup not found
)

REM 2. Прибить smart-router (8200) и debug-proxy (8191)
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8200,8191 -State Listen -EA SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -EA SilentlyContinue }"
echo [2/4] smart-router and debug-proxy stopped

REM 3. Прибить notion-manager
taskkill /F /IM notion-manager.exe >nul 2>&1
if %ERRORLEVEL%==0 (
    echo [3/4] notion-manager.exe stopped
) else (
    echo [3/4] notion-manager.exe was not running
)

REM 4. Проверить OmniRoute
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 20128 -State Listen -ErrorAction SilentlyContinue; if ($c) { Write-Host '[4/4] OK: OmniRoute is alive on 20128' -Fore Green } else { Write-Host '[4/4] WARNING: OmniRoute NOT running - start it manually' -Fore Yellow }"

echo.
echo Restart Claude Code to apply settings
echo.
pause
