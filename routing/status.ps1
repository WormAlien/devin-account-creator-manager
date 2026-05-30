# Показать текущее состояние

Write-Host ""
Write-Host "=== PORTS ===" -ForegroundColor Cyan
foreach ($port in 8190, 8200, 20128) {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) {
        $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
        Write-Host ("  {0}: OK {1} (PID {2})" -f $port, $p.ProcessName, $c.OwningProcess) -ForegroundColor Green
    } else {
        Write-Host ("  {0}: free" -f $port) -ForegroundColor Gray
    }
}

Write-Host ""
Write-Host "=== CLAUDE CODE CONFIG ===" -ForegroundColor Cyan
$j = Get-Content "$env:USERPROFILE\.claude\settings.json" -Raw | ConvertFrom-Json
Write-Host "  ANTHROPIC_BASE_URL = $($j.env.ANTHROPIC_BASE_URL)"
Write-Host "  ANTHROPIC_MODEL    = $($j.env.ANTHROPIC_MODEL)"
Write-Host "  FAST_MODEL         = $($j.env.ANTHROPIC_SMALL_FAST_MODEL)"
Write-Host "  top-level model    = $($j.model)   <-- Claude Code uses this"

if ($j.env.ANTHROPIC_BASE_URL -match '20128') {
    Write-Host "  -> Claude Code uses OmniRoute" -ForegroundColor Yellow
} elseif ($j.env.ANTHROPIC_BASE_URL -match '8200') {
    Write-Host "  -> Claude Code uses Smart router (main=notion, fast=omniroute)" -ForegroundColor Yellow
} elseif ($j.env.ANTHROPIC_BASE_URL -match '8190') {
    Write-Host "  -> Claude Code uses notion-manager" -ForegroundColor Yellow
}
Write-Host ""
