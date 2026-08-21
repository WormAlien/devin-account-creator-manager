# ─────────────────────────────────────────────────────────────────────────────
#  Bootstrap-установщик для ГОЛОЙ Windows (запуск из PowerShell, без git/node)
#
#  Одной строкой в PowerShell:
#    irm https://raw.githubusercontent.com/WormAlien/hub-cc/master/install.ps1 | iex
#
#  Что делает: ставит Git + Node.js через winget → клонирует репо → запускает
#  интерактивный install.sh в git-bash. Дальше всё спрашивает install.sh.
# ─────────────────────────────────────────────────────────────────────────────
$ErrorActionPreference = 'Stop'

function Info($m) { Write-Host "  $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  OK $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  ! $m"  -ForegroundColor Yellow }
function Die($m)  { Write-Host "  X $m"  -ForegroundColor Red; exit 1 }

function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

Write-Host ""
Write-Host "════════════════════════════════════════════════════════" -ForegroundColor White
Write-Host "  ABUSE HUB — bootstrap" -ForegroundColor White
Write-Host "════════════════════════════════════════════════════════" -ForegroundColor White

# ── winget есть? ─────────────────────────────────────────────────────────────
if (-not (Have winget)) {
  Die "winget не найден. Обнови 'App Installer' из Microsoft Store, потом запусти снова."
}

# ── Execution Policy ─────────────────────────────────────────────────────────
# Дефолтная политика Restricted блокирует npm.ps1/npx.ps1 → npm в PowerShell
# падает с PSSecurityException. RemoteSigned для CurrentUser достаточно и
# не требует прав администратора.
try {
  $pol = Get-ExecutionPolicy -Scope CurrentUser
  if ($pol -eq 'Undefined' -or $pol -eq 'Restricted' -or $pol -eq 'AllSigned') {
    Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
    Ok "ExecutionPolicy CurrentUser -> RemoteSigned (иначе npm в PowerShell не работает)"
  } else {
    Ok "ExecutionPolicy: $pol"
  }
} catch { Warn "не смог поменять ExecutionPolicy: $_" }

# ── Git ──────────────────────────────────────────────────────────────────────
if (Have git) {
  Ok "git уже есть"
} else {
  Info "Ставлю Git for Windows ..."
  winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
  # обновляем PATH в текущей сессии, чтоб git/bash стали видны без перезапуска
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
              [System.Environment]::GetEnvironmentVariable('Path','User')
}

# ── Node.js LTS ──────────────────────────────────────────────────────────────
if (Have node) {
  Ok "node уже есть"
} else {
  Info "Ставлю Node.js LTS ..."
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
              [System.Environment]::GetEnvironmentVariable('Path','User')
}

# ── находим bash (git-bash) ──────────────────────────────────────────────────
$bash = $null
foreach ($p in @(
  "$env:ProgramFiles\Git\bin\bash.exe",
  "${env:ProgramFiles(x86)}\Git\bin\bash.exe",
  "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe"
)) { if (Test-Path $p) { $bash = $p; break } }
if (-not $bash -and (Have bash)) { $bash = (Get-Command bash).Source }
if (-not $bash) {
  Warn "git-bash не найден в PATH этой сессии."
  Die  "Закрой это окно PowerShell, открой НОВОЕ и запусти команду ещё раз (PATH обновится)."
}

# ── клон репо (если ещё нет) ──────────────────────────────────────────────────
$repo = 'https://github.com/WormAlien/hub-cc.git'
$repoName = 'hub-cc'
# Имя папки клона сменилось на hub-cc (2026-08-21). Старые установки лежат в
# папке с прежним именем — их тоже считаем «уже внутри репо», иначе установщик
# склонирует hub-cc внутрь них и получится двойная вложенность.
$repoNamesLegacy = @('hub-cc', 'vibe-code-account-creator-manager')
$cwd = (Get-Location).Path

if ($repoNamesLegacy -contains (Split-Path $cwd -Leaf) -and (Test-Path (Join-Path $cwd '.git'))) {
  $dir = $cwd
  Ok "уже внутри репо → $dir"
} else {
  $dir = Join-Path $cwd $repoName
  $nested = Join-Path $dir $repoName
  if (Test-Path (Join-Path $nested '.git')) {
    Die "найдена двойная вложенность: $nested. Перейди в нормальную папку или удали внешний дубль до установки venv."
  }
  if (Test-Path (Join-Path $dir '.git')) {
    Ok "репо уже склонировано → $dir"
  } else {
    Info "Клонирую репозиторий ..."
    git clone $repo $dir
  }
}

# ── запуск install.sh в git-bash ─────────────────────────────────────────────
Info "Запускаю интерактивный install.sh ..."
Write-Host ""
& $bash -lc "cd '$($dir -replace '\\','/')' && bash install.sh"
