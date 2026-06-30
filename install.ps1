# ─────────────────────────────────────────────────────────────────────────────
#  Bootstrap-установщик для ГОЛОЙ Windows (запуск из PowerShell, без git/node)
#
#  Одной строкой в PowerShell:
#    irm https://raw.githubusercontent.com/WormAlien/vibe-code-account-creator-manager/master/install.ps1 | iex
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
Write-Host "  Vibe-Code Account Creator Manager — bootstrap" -ForegroundColor White
Write-Host "════════════════════════════════════════════════════════" -ForegroundColor White

# ── winget есть? ─────────────────────────────────────────────────────────────
if (-not (Have winget)) {
  Die "winget не найден. Обнови 'App Installer' из Microsoft Store, потом запусти снова."
}

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
$repo = 'https://github.com/WormAlien/vibe-code-account-creator-manager.git'
$dir  = Join-Path (Get-Location) 'vibe-code-account-creator-manager'
if (Test-Path (Join-Path $dir '.git')) {
  Ok "репо уже склонировано → $dir"
} else {
  Info "Клонирую репозиторий ..."
  git clone $repo $dir
}

# ── запуск install.sh в git-bash ─────────────────────────────────────────────
Info "Запускаю интерактивный install.sh ..."
Write-Host ""
& $bash -lc "cd '$($dir -replace '\\','/')' && bash install.sh"
