# Переключатель Claude Code между OmniRoute (20128) и notion-manager (8190)
# Использование:
#   .\switch-backend.ps1 notion      - на notion-manager (как у автора репо: только BASE_URL + API_KEY)
#   .\switch-backend.ps1 omniroute   - на OmniRoute
#   .\switch-backend.ps1 smart       - через smart-router (legacy)

param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('notion', 'omniroute', 'smart')]
    [string]$Backend
)

$settingsPath = "$env:USERPROFILE\.claude\settings.json"
$apiKey       = if ($env:ROUTER_API_KEY) { $env:ROUTER_API_KEY } else { "sk-local-dev-key" }

if (-not (Test-Path $settingsPath)) {
    Write-Host "ERROR: $settingsPath not found" -ForegroundColor Red
    exit 1
}

$json = Get-Content $settingsPath -Raw | ConvertFrom-Json

# Helper: set/replace env on $json (Add-Member if missing, otherwise overwrite)
function Set-Env($obj, $envObj) {
    if ($obj.PSObject.Properties.Name -contains 'env') {
        $obj.env = $envObj
    } else {
        $obj | Add-Member -NotePropertyName 'env' -NotePropertyValue $envObj
    }
}

switch ($Backend) {
    'notion' {
        # АВТОР-СТИЛЬ: только BASE_URL + API_KEY.
        # НИКАКИХ ANTHROPIC_MODEL / ANTHROPIC_SMALL_FAST_MODEL / top-level "model" -
        # они ломают tool-bypass в notion-manager.
        $newEnv = [pscustomobject]@{
            ANTHROPIC_BASE_URL = 'http://localhost:8190'
            ANTHROPIC_API_KEY  = $apiKey
        }
        Set-Env $json $newEnv
        if ($json.PSObject.Properties.Name -contains 'model') {
            $json.PSObject.Properties.Remove('model')
        }
        $url   = 'http://localhost:8190'
        $label = 'notion-manager (8190) - author config'
    }
    'omniroute' {
        $newEnv = [pscustomobject]@{
            ANTHROPIC_BASE_URL = 'http://localhost:20128/v1'
            ANTHROPIC_API_KEY  = $apiKey
        }
        Set-Env $json $newEnv
        if ($json.PSObject.Properties.Name -contains 'model') {
            $json.model = 'ComboWombo'
        } else {
            $json | Add-Member -NotePropertyName 'model' -NotePropertyValue 'ComboWombo'
        }
        $url   = 'http://localhost:20128/v1'
        $label = 'OmniRoute (20128) model=ComboWombo'
    }
    'smart' {
        $newEnv = [pscustomobject]@{
            ANTHROPIC_BASE_URL = 'http://localhost:8200'
            ANTHROPIC_API_KEY  = $apiKey
        }
        Set-Env $json $newEnv
        if ($json.PSObject.Properties.Name -contains 'model') {
            $json.model = 'opus-4.8'
        } else {
            $json | Add-Member -NotePropertyName 'model' -NotePropertyValue 'opus-4.8'
        }
        $url   = 'http://localhost:8200'
        $label = 'Smart router (8200) - legacy, may break notion bypass'
    }
}

$json | ConvertTo-Json -Depth 20 | Set-Content $settingsPath -Encoding UTF8

Write-Host ""
Write-Host "OK: Switched to $label" -ForegroundColor Green
Write-Host "   URL: $url"
if ($Backend -eq 'notion') {
    Write-Host "   env: only BASE_URL + API_KEY (no MODEL fields)"
    Write-Host "   top-level model: REMOVED"
} else {
    Write-Host "   model: $($json.model)"
}
Write-Host ""
Write-Host "Restart Claude Code to apply" -ForegroundColor Yellow
Write-Host ""

