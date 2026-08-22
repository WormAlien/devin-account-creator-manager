@echo off
setlocal EnableDelayedExpansion
REM Restart ABUSE HUB dashboard on :8200.
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
REM `exit`, а не `exit /b`: второе завершает только скрипт, и если консоль запущена с
REM `cmd /k` (так делал дашборд), окно остаётся жить в промпте — по одному на каждый
REM клик «перезапустить». Здесь работу продолжает элевированная копия, эта консоль
REM больше не нужна вообще.
net session >nul 2>&1
if not "%errorlevel%"=="0" (
    echo Requesting Administrator rights ^(UAC^) ...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs -WorkingDirectory '%~dp0'"
    exit
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
REM Front-door :20100 — единый вход Claude Code. Убивать безопасно только потому,
REM что transparent-proxy.js спавнит его обратно на boot. Порты :20155-20157
REM (keepalive провайдеров) здесь НЕ перечислены намеренно: их разбирает сам дашборд
REM на boot — активный пересоздаёт (force), лежалых детей прошлого запуска снимает
REM (bootSweepStaleChildren), а поднимает их обратно активация провайдера. Так «весь
REM стек» перезапускается и из START.bat, и на mac, а не только из этого файла.
call :KILLPORT 20100 "front-door"
if "%FAILED%"=="1" goto FAILED

echo All ports released.

REM ---- Pointer to the repo root for the statusline shim ----------------------
REM settings.json points at %USERPROFILE%\.claude\autoreger-statusline.sh, and the
REM shim reads the real repo path from autoreger-root.txt. That way moving or
REM renaming the project folder does not break the status bar: just start the
REM dashboard from the new location and the pointer is rewritten.
for %%I in ("%~dp0..") do set "REPO_ROOT=%%~fI"
set "REPO_ROOT_U=%REPO_ROOT:\=/%"
if not exist "%USERPROFILE%\.claude" mkdir "%USERPROFILE%\.claude" >nul 2>&1
>"%USERPROFILE%\.claude\autoreger-root.txt" echo %REPO_ROOT_U%
if exist "%~dp0statusline-shim.sh" copy /Y "%~dp0statusline-shim.sh" "%USERPROFILE%\.claude\autoreger-statusline.sh" >nul 2>&1

REM Три служебных прокси стартуют СКРЫТО и ОТДЕЛЬНЫМ процессом (2026-08-22, вторая
REM правка). До неё перебрали два варианта, и оба плохи по-разному:
REM   * `start /B node ...` — окна нет, но процесс остаётся привязан к ЭТОЙ консоли,
REM     а консольное окно живёт, пока к нему привязан хоть один процесс: `exit 0`
REM     отрабатывал, cmd умирал, а окно висело вечно с «Window will close in 3 s».
REM   * `start "FM Rotator" /MIN node ...` — окно закрывается, но их становится
REM     ЧЕТЫРЕ в таскбаре вместо одного (владелец: «плодятся, было одно раньше»).
REM Start-Process не привязывает ребёнка к нашей консоли (значит окно закроется) и
REM `-WindowStyle Hidden` не создаёт ему своего окна. Логи не теряются: все три
REM прокси пишут через routing/proxy-logger.js батчем в сам дашборд, их видно на
REM вкладке «Server Logs» под префиксами [fm-rot], [fm-oa], [vyce] — то есть stdout
REM этих окон никому и не был нужен. Единственное окно, которое остаётся видимым, —
REM ABUSE HUB ниже: это дашборд, и его /MIN не трогаем.
echo Starting Freemodel Key Rotator on :20126 ...
call :STARTGUARD 20126 || goto FAILED
call :STARTHIDDEN freemodel-rotator.js
ping 127.0.0.1 -n 2 >nul

echo Starting FreeModel OpenAI Proxy on :20130 ...
call :STARTGUARD 20130 || goto FAILED
call :STARTHIDDEN freemodel-openai-proxy.js
ping 127.0.0.1 -n 2 >nul

echo Starting VyceAI OpenAI Proxy on :20131 ...
call :STARTGUARD 20131 || goto FAILED
call :STARTHIDDEN vyceai-openai-proxy.js
ping 127.0.0.1 -n 2 >nul

echo Starting transparent-proxy.js (switcher + dashboard) on :8200 ...
call :STARTGUARD 8200 || goto FAILED
start "ABUSE HUB" /MIN node transparent-proxy.js

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
REM Запустить node-скрипт %1 без своего окна и НЕ привязывая к нашей консоли.
REM `-WindowStyle Hidden` прячет консоль ребёнка, отдельный процесс даёт нашей
REM консоли право закрыться (см. блок комментариев у вызовов выше). Рабочий каталог
REM задаём явно: у Start-Process он НЕ наследуется от cmd, и без него node не найдёт
REM свой .js. Ошибки PowerShell не глотаем — порт всё равно проверит следующий
REM STARTGUARD, но текст в окне полезнее молчания.
:STARTHIDDEN
powershell -NoProfile -Command "Start-Process -FilePath 'node' -ArgumentList '%~1' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
exit /b 0

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