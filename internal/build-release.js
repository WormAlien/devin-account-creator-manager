/**
 * Сборщик релиза v5.0 — упаковывает всё в один .bat файл
 * Запуск: node build-release.js
 *
 * Подход: bat-файл содержит base64-данные в виде отдельных строк
 * с префиксом ::DATA:. PowerShell-скрипт извлекает эти строки
 * из bat-файла и декодирует.
 *
 * Автор: @qlevis (Telegram)
 * Спасибо за вдохновение: @abuz_ai (Telegram)
 */

const fs = require('fs');
const path = require('path');
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
const bundleVersion = packageJson.version;

const noop = () => {};
console.log = noop;
console.info = noop;
console.warn = noop;
console.error = noop;
console.debug = noop;

// Корневые файлы — из родительской директории, internal/ — из текущей
const files = {
    'package.json': fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'),
    'start.js': fs.readFileSync(path.join(__dirname, '..', 'start.js'), 'utf-8'),
    'config.js': fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf-8'),
    'README.md': fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf-8'),
    'internal/autoreger.js': fs.readFileSync(path.join(__dirname, 'autoreger.js'), 'utf-8'),
    'internal/bin-lookup.js': fs.readFileSync(path.join(__dirname, 'bin-lookup.js'), 'utf-8'),
};

// package-lock.json — опционально, для воспроизводимой установки
const lockfilePath = path.join(__dirname, '..', 'package-lock.json');
if (fs.existsSync(lockfilePath)) {
    files['package-lock.json'] = fs.readFileSync(lockfilePath, 'utf-8');
} else {
    console.warn('  [!] ВНИМАНИЕ: package-lock.json не найден — установка будет менее воспроизводимой');
}

for (const [name, content] of Object.entries(files)) {
    if (/tm_[a-f0-9]{20,}/i.test(content)) {
        console.error(`  [!] ОШИБКА: ${name} содержит API-ключ! Удалите перед сборкой.`);
        process.exit(1);
    }
    if (/5154620022|623358637/.test(content) && name !== 'config.js') {
        console.warn(`  [!] ВНИМАНИЕ: ${name} содержит конкретный BIN. Убедитесь что это не ваши данные.`);
    }
}

const dataLines = [];
for (const [name, content] of Object.entries(files)) {
    const b64 = Buffer.from(content).toString('base64');
    dataLines.push(`::DATA:START:${name}`);
    for (let i = 0; i < b64.length; i += 76) {
        dataLines.push(`::DATA:${b64.slice(i, i + 76)}`);
    }
    dataLines.push(`::DATA:END:${name}`);
}

const bat = `@echo off
setlocal
chcp 65001 >nul 2>&1

echo.
echo ============================================================
echo   DEVIN AI AUTOREGER v5.0
echo ============================================================
echo.
set "BUNDLE_VER=${bundleVersion}"

echo   Автоматическая регистрация Devin AI с подпиской Pro Trial
echo.
echo   Автор: @qlevis (Telegram)
echo   Спасибо за вдохновение: @abuz_ai (Telegram)
echo.
echo ============================================================
echo.
echo   КАК ПОЛЬЗОВАТЬСЯ:
echo   1. При первом запуске скачаются зависимости и Chromium
echo   2. В меню доступны: регистрация, BIN-генератор, doctor, dry-run
echo   3. Для BIN используйте credit-карты (не prepaid!)
echo   4. Результаты: output/Аккаунты/
echo   5. Dry-run архив: output/Архив/
echo.
echo   Если Node.js не установлен — скачайте: https://nodejs.org/
echo ============================================================
echo.

:: === Check Node.js ===
where node >nul 2>&1
if errorlevel 1 (
    echo [!] Node.js не установлен!
    echo.
    echo     Скачайте: https://nodejs.org/
    echo     Выберите LTS, установите, перезапустите этот файл.
    echo.
    start https://nodejs.org/
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
echo [OK] Node.js %NODE_VER%

:: === Work directory ===
set "APPDIR=%~dp0autoreger_data"
if not exist "%APPDIR%" mkdir "%APPDIR%"

:: === Extract embedded files ===
echo [*] Подготовка файлов...

set "FORCE_EXTRACT=0"
for %%a in (%*) do if "%%a"=="--force" set "FORCE_EXTRACT=1"

if not exist "%APPDIR%\\start.js" set "FORCE_EXTRACT=1"
if exist "%APPDIR%\\_bundle_version.txt" (
    set /p INSTALLED_BUNDLE_VER=<"%APPDIR%\\_bundle_version.txt"
) else (
    set "INSTALLED_BUNDLE_VER="
)
if not "%INSTALLED_BUNDLE_VER%"=="%BUNDLE_VER%" set "FORCE_EXTRACT=1"

if "%FORCE_EXTRACT%"=="1" (
  echo [*] Распаковка файлов...
  set "BATSELF=%~f0"
  set "APPDIR_ENV=%APPDIR%"
  powershell -ExecutionPolicy Bypass -NoProfile -Command ^
    "$bat = Get-Content -LiteralPath $env:BATSELF -Encoding UTF8;" ^
    "$d = $env:APPDIR_ENV;" ^
    "$curFile = $null; $buf = '';" ^
    "foreach ($line in $bat) {" ^
    "  if ($line -match '^::DATA:START:(.+)$') { $curFile = $Matches[1]; $buf = ''; continue }" ^
    "  if ($line -match '^::DATA:END:') {" ^
    "    $p = Join-Path $d $curFile;" ^
    "    $dir = Split-Path $p -Parent;" ^
    "    if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null };" ^
    "    Write-Host ('  Creating ' + $curFile + '...');" ^
    "    [IO.File]::WriteAllBytes($p, [Convert]::FromBase64String($buf));" ^
    "    $curFile = $null; $buf = ''; continue" ^
    "  }" ^
    "  if ($curFile -and $line -match '^::DATA:(.+)$') { $buf += $Matches[1] }" ^
    "}"
  if errorlevel 1 (
    echo [!] Ошибка распаковки файлов
    pause
    exit /b 1
  )
  > "%APPDIR%\\_bundle_version.txt" echo %BUNDLE_VER%
) else (
  echo [OK] Файлы уже распакованы и актуальны ^(версия %BUNDLE_VER%^)
)

:: === Install deps (version-aware) ===
set "DEPSCHK=%APPDIR%\\_deps_version.txt"
set "NEED_INSTALL=0"

if not exist "%APPDIR%\\node_modules" set "NEED_INSTALL=1"

if exist "%DEPSCHK%" (
    for /f "tokens=*" %%v in ('type "%DEPSCHK%"') do set "OLD_VER=%%v"
) else (
    set "OLD_VER="
)

for /f "tokens=*" %%v in ('cd /d "%APPDIR%" ^& node -p "require('./package.json').version" 2^>nul') do set "NEW_VER=%%v"

if not "%OLD_VER%"=="%NEW_VER%" set "NEED_INSTALL=1"

if "%NEED_INSTALL%"=="1" (
    echo.
    if exist "%APPDIR%\\package-lock.json" (
        echo [*] Установка зависимостей ^(npm ci — воспроизводимая^)...
        cd /d "%APPDIR%"
        call npm ci --omit=dev
    ) else (
        echo [*] Установка зависимостей ^(npm install^)...
        cd /d "%APPDIR%"
        call npm install --production
    )
    if errorlevel 1 (
        echo [!] npm install не удался. Проверьте интернет.
        pause
        exit /b 1
    )
    echo %NEW_VER%> "%DEPSCHK%"
    echo [OK] Зависимости установлены
) else (
    echo [OK] Зависимости актуальны
)

:: === Install Chromium (real check) ===
set "NEED_CHROMIUM=0"

node -e "try{const p=require('playwright');const e=p.chromium.executablePath();const f=require('fs');process.exit(f.existsSync(e)?0:1)}catch(e){process.exit(1)}" 2>nul
if errorlevel 1 set "NEED_CHROMIUM=1"

if "%NEED_CHROMIUM%"=="1" (
    echo.
    echo [*] Скачивание Chromium... ^(~100 МБ^)
    cd /d "%APPDIR%"
    call npx playwright install chromium
    if errorlevel 1 (
        echo [!] Ошибка установки Chromium.
        echo     Попробуйте вручную: cd autoreger_data ^&^& npx playwright install chromium
        pause
        exit /b 1
    )
    echo [OK] Chromium установлен
) else (
    echo [OK] Chromium актуален
)

:: === Run ===
:menu
echo.
echo ============================================================
echo   ЧТО ЗАПУСТИТЬ?
echo ============================================================
echo.
echo   1. Регистрация аккаунтов Devin AI ^(интерактивно^)
echo   2. BIN-генератор ^(подобрать/проверить BIN^)
echo   3. Doctor mode ^(диагностика всех компонентов^)
echo   4. Dry-run по config.js ^(до оплаты, без реального платежа^)
echo   5. Прямой запуск по config.js ^(без вопросов^)
echo   6. Открыть папку output/
echo   7. Открыть config.js в Блокноте
echo   8. Открыть README.md
echo   0. Выход
echo.
set /p CHOICE="  Ваш выбор [0-8]: "

if "%CHOICE%"=="1" goto :run_autoreger
if "%CHOICE%"=="2" goto :run_binlookup
if "%CHOICE%"=="3" goto :run_doctor
if "%CHOICE%"=="4" goto :run_dryrun
if "%CHOICE%"=="5" goto :run_direct
if "%CHOICE%"=="6" goto :open_output
if "%CHOICE%"=="7" goto :open_config
if "%CHOICE%"=="8" goto :open_readme
if "%CHOICE%"=="0" goto :done_exit
echo [!] Неверный выбор. Введите число от 0 до 8.
echo.
pause
goto :menu

:run_autoreger
echo.
echo ============================================================
echo   РЕГИСТРАЦИЯ АККАУНТОВ
echo ============================================================
echo.
cd /d "%APPDIR%"
node start.js
goto :done_mode

:run_binlookup
echo.
echo ============================================================
echo   BIN-ГЕНЕРАТОР
echo ============================================================
echo.
cd /d "%APPDIR%"
node internal/bin-lookup.js
goto :done_mode

:run_doctor
echo.
echo ============================================================
echo   DOCTOR MODE
echo ============================================================
echo.
cd /d "%APPDIR%"
node internal/autoreger.js --doctor
goto :done_mode

:run_dryrun
echo.
echo ============================================================
echo   DRY-RUN ПО CONFIG.JS
echo ============================================================
echo.
cd /d "%APPDIR%"
node internal/autoreger.js --dry-run
goto :done_mode

:run_direct
echo.
echo ============================================================
echo   ПРЯМОЙ ЗАПУСК ПО CONFIG.JS
echo ============================================================
echo.
cd /d "%APPDIR%"
node internal/autoreger.js
goto :done_mode

:open_output
if not exist "%APPDIR%\\output" mkdir "%APPDIR%\\output"
start "" "%APPDIR%\\output"
goto :menu

:open_config
notepad "%APPDIR%\\config.js"
goto :menu

:open_readme
if exist "%APPDIR%\\README.md" (
    start "" "%APPDIR%\\README.md"
) else (
    echo [!] README.md не найден в распакованной папке.
    pause
)
goto :menu

:done_mode
echo.
pause
:menu_return
goto :menu

:done_exit
exit /b 0

${dataLines.join('\r\n')}
`;

const outPath = path.join(__dirname, '..', 'Autoreger.bat');
fs.writeFileSync(outPath, bat.replace(/\r?\n/g, '\r\n'), 'utf-8');

const sizeKB = (fs.statSync(outPath).size / 1024).toFixed(0);
console.log(`\n  Done: ${outPath}`);
console.log(`  Size: ${sizeKB} KB`);
console.log(`  Contains: ${Object.keys(files).join(', ')}`);
console.log(`\n  Пользователь просто дважды кликает Autoreger.bat`);
console.log(`  Первый запуск: устанавливает npm + Chromium`);
console.log(`  Затем: меню режимов (регистрация, BIN, doctor, dry-run, direct run)\n`);
