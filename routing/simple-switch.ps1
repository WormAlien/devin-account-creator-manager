# Простое переключение между Notion и OmniRoute
# Использование:
#   .\simple-switch.ps1 notion      - на notion-manager (8190)
#   .\simple-switch.ps1 omniroute   - на OmniRoute (20128)

param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('notion', 'omniroute')]
    [string]$Backend
)

$settingsPath = "$env:USERPROFILE\.claude\settings.json"

# Load key from routing/.env (gitignored)
$envFile = Join-Path $PSScriptRoot ".env"
$apiKey = $null
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*NOTION_API_KEY\s*=\s*(.+)\s*$') {
            $apiKey = $matches[1].Trim('"').Trim("'")
            break
        }
    }
}
if (-not $apiKey) {
    Write-Host "ERROR: NOTION_API_KEY not found in routing/.env" -ForegroundColor Red
    Write-Host "       Copy routing/.env.example to routing/.env and fill in the key." -ForegroundColor Yellow
    exit 1
}

if (-not (Test-Path $settingsPath)) {
    Write-Host "ERROR: $settingsPath not found" -ForegroundColor Red
    exit 1
}

# Backup current settings
$backupPath = "$settingsPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item $settingsPath $backupPath
Write-Host "Backup: $backupPath" -ForegroundColor Gray

$json = Get-Content $settingsPath -Raw | ConvertFrom-Json

switch ($Backend) {
    'notion' {
        # Автор-стиль: только BASE_URL + API_KEY, БЕЗ model
        $json.env = [pscustomobject]@{
            ANTHROPIC_BASE_URL = 'http://localhost:8190'
            ANTHROPIC_API_KEY  = $apiKey
        }
        # Удаляем top-level model если есть
        if ($json.PSObject.Properties.Name -contains 'model') {
            $json.PSObject.Properties.Remove('model')
        }
        Write-Host "`n✅ Switched to Notion (8190)" -ForegroundColor Green
        Write-Host "   URL: http://localhost:8190" -ForegroundColor Cyan
        Write-Host "   Config: author style (no model field)" -ForegroundColor Gray
    }
    'omniroute' {
        $json.env = [pscustomobject]@{
            ANTHROPIC_BASE_URL = 'http://localhost:20128/v1'
            ANTHROPIC_API_KEY  = $apiKey
        }
        # Добавляем model=ComboWombo
        if ($json.PSObject.Properties.Name -contains 'model') {
            $json.model = 'ComboWombo'
        } else {
            $json | Add-Member -NotePropertyName 'model' -NotePropertyValue 'ComboWombo'
        }
        Write-Host "`n✅ Switched to OmniRoute (20128)" -ForegroundColor Green
        Write-Host "   URL: http://localhost:20128/v1" -ForegroundColor Cyan
        Write-Host "   Model: ComboWombo" -ForegroundColor Gray
    }
}

# Сохраняем
$json | ConvertTo-Json -Depth 10 | Set-Content $settingsPath -Encoding UTF8

Write-Host "`n⚠️  Restart Claude Code to apply" -ForegroundColor Yellow
