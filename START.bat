@echo off
chcp 65001 >nul
title Vibe-Code Dashboard
cd /d "%~dp0"

echo ============================================================
echo   Vibe-Code Account Creator Manager — запуск дашборда
echo ============================================================
echo.

REM --- проверка node ---
where node >nul 2>&1
if errorlevel 1 (
  echo [X] Node.js не найден. Установи Node.js LTS и запусти снова.
  echo     winget install OpenJS.NodeJS.LTS
  echo.
  pause
  exit /b 1
)

REM --- освобождаем порты (убиваем старые экземпляры) ---
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8200 " ^| findstr LISTENING') do taskkill /F /PID %%P >nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":20126 " ^| findstr LISTENING') do taskkill /F /PID %%P >nul 2>&1

REM --- ротатор FreeModel на :20126 (фоном, своё окно) ---
echo Запускаю FreeModel rotator на :20126 ...
start "FM Rotator" /MIN node "%~dp0routing\freemodel-rotator.js"

ping 127.0.0.1 -n 2 >nul

REM --- дашборд на :8200 ( В ЭТОМ ЖЕ ОКНЕ — ошибки будут видны) ---
echo Запускаю дашборд на :8200 ...
echo.
echo Открой в браузере:  http://localhost:8200/__switch
echo (это окно НЕ закрывай — пока оно открыто, дашборд работает)
echo Чтобы остановить — закрой окно или нажми Ctrl+C.
echo ------------------------------------------------------------
echo.

REM открываем браузер с небольшой задержкой
start "" cmd /c "ping 127.0.0.1 -n 4 >nul & start http://localhost:8200/__switch"

REM запускаем прокси на переднем плане — если упадёт, текст ошибки останется
node "%~dp0routing\transparent-proxy.js"

REM сюда попадаем только если прокси завершился/упал
echo.
echo ------------------------------------------------------------
echo [!] Дашборд остановился. Если выше есть КРАСНЫЙ текст ошибки —
echo     сделай скриншот этого окна и пришли.
echo.
pause
