# Recreates the keepalive-proxy.js process on the given port (default :20133).
#   powershell -NoProfile -ExecutionPolicy Bypass -File keepalive-restart.ps1 -Port 20155
# Instances: 20133 = AgentRouter, 20155 = Tabi, 20156 = GoRouter.
#
# Normal path is the dashboard button (Health tab -> POST /__switch/api/keepalive/restart).
# This script is the fallback for when the dashboard itself is down.
#
# Was WMI Win32_Process.Create: it silently failed to start node (port stayed
# empty) and $ErrorActionPreference='SilentlyContinue' hid the reason. Now it is
# Start-Process plus a check that the port actually answers.
# ASCII only on purpose: PowerShell 5.1 reads .ps1 as ANSI and mangles UTF-8.
param([int]$Port = 20133)

$dir = $PSScriptRoot
$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) { Write-Error 'node.exe not found'; exit 1 }
$script = Join-Path $dir 'keepalive-proxy.js'
$profileDir = $env:USERPROFILE

# Same env transparent-proxy.js passes when it spawns these instances.
$common = @{
  IDLE_MS = '5000'; MAX_ATTEMPTS = '2'; HEDGE_MS = '20000'; RETRY_DELAY_MS = '1500';
  COUNT_TOKENS_FALLBACK = '1'; PRE_COMMIT_MS = '10000'; UPSTREAM_TIMEOUT_MS = '600000';
}
$perPort = @{
  20133 = @{ UPSTREAM = 'https://agentrouter.org'; KEY_FILE = "$profileDir\.claude\ar-active-key.txt";
             MODELMAP_FILE = (Join-Path $dir 'ar-modelmap.json');
             HAIKU_REMAP = '1'; HAIKU_TO_MODEL = 'gpt-5.6-sol'; HAIKU_GPT_PROXY = 'http://127.0.0.1:20132' }
  20155 = @{ UPSTREAM = 'https://tabitoken.com'; KEY_FILE = "$profileDir\.claude\tabi-active-key.txt";
             MODELMAP_FILE = (Join-Path $dir 'tabi-modelmap.json') }
  20156 = @{ UPSTREAM = 'https://gorouter.app'; KEY_FILE = "$profileDir\.claude\gorouter-active-key.txt";
             MODELMAP_FILE = (Join-Path $dir 'gorouter-modelmap.json') }
}
if (-not $perPort.ContainsKey($Port)) {
  Write-Error "Unknown port $Port (known: 20133 / 20155 / 20156)"; exit 1
}

# Kill the current listener
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction Stop } catch {} }
Start-Sleep -Milliseconds 800

foreach ($kv in $common.GetEnumerator())         { Set-Item "env:$($kv.Key)" $kv.Value }
foreach ($kv in $perPort[$Port].GetEnumerator()) { Set-Item "env:$($kv.Key)" $kv.Value }
$env:PORT = "$Port"
$env:LOG_FILE = Join-Path $dir "keepalive-$Port.log"

Start-Process -FilePath $node -ArgumentList "`"$script`"" -WorkingDirectory $dir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dir "keepalive-$Port.out.log") -RedirectStandardError (Join-Path $dir "keepalive-$Port.err.log")

# Verify the instance is really up (10s max)
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/__keepalive/api/status" -TimeoutSec 1 -ErrorAction Stop
    if ($r.ok) { Write-Host "keepalive :$Port is up (upstream $($r.upstream))"; exit 0 }
  } catch {}
}
Write-Error "keepalive :$Port did not answer in 10s - see keepalive-$Port.err.log"
exit 1
