# Recreates the keepalive-proxy.js process on the given port (default :20133).
#   powershell -NoProfile -ExecutionPolicy Bypass -File keepalive-restart.ps1 -Port 20155
# Instances: 20133 = AgentRouter, 20155 = Tabi, 20156 = GoRouter, 20157 = XPeach,
#            20158 = JustWoker, 20159 = SeekAi, 20160 = TrueSOTA, 20161 = KKtoken.
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
# HEDGE_MS / MAX_ATTEMPTS / MAX_HEDGES / PRE_COMMIT_MS deliberately NOT set here:
# these four are the dashboard knobs, their source of truth is
# keepalive-config-<PORT>.json (highest priority) and the const cfg defaults in
# keepalive-proxy.js. Duplicating them in this script rotted twice already - a
# manual restart silently reset a tab to whatever numbers were frozen here.
$common = @{
  IDLE_MS = '5000'; RETRY_DELAY_MS = '1500';
  COUNT_TOKENS_FALLBACK = '1'; UPSTREAM_TIMEOUT_MS = '600000';
}
$perPort = @{
  20133 = @{ UPSTREAM = 'https://agentrouter.org'; KEY_FILE = "$profileDir\.claude\ar-active-key.txt";
             MODELMAP_FILE = (Join-Path $dir 'ar-modelmap.json');
             HAIKU_REMAP = '1'; HAIKU_TO_MODEL = 'gpt-5.6-sol'; HAIKU_GPT_PROXY = 'http://127.0.0.1:20132' }
  20155 = @{ UPSTREAM = 'https://tabitoken.com'; KEY_FILE = "$profileDir\.claude\tabi-active-key.txt";
             MODELMAP_FILE = (Join-Path $dir 'tabi-modelmap.json') }
  20156 = @{ UPSTREAM = 'https://gorouter.app'; KEY_FILE = "$profileDir\.claude\gorouter-active-key.txt";
             MODELMAP_FILE = (Join-Path $dir 'gorouter-modelmap.json') }
  20157 = @{ UPSTREAM = 'https://xpeach.codes'; KEY_FILE = "$profileDir\.claude\xpeach-active-key.txt";
             MODELMAP_FILE = (Join-Path $dir 'xpeach-modelmap.json') }
  # JustWoker: UPSTREAM is the bare root - keepalive appends /v1/messages itself.
  # The /v1 base URL (JW_BASE_URL in transparent-proxy.js) is for model listing only;
  # putting it here would send /v1/v1/messages and the gateway answers 404.
  20158 = @{ UPSTREAM = 'https://api.justwoker.icu'; KEY_FILE = "$profileDir\.claude\justwoker-active-key.txt";
             MODELMAP_FILE = (Join-Path $dir 'justwoker-modelmap.json') }
  # SeekAi: same trap - bare root, /v1 is for model listing only.
  20159 = @{ UPSTREAM = 'https://seekai.cc'; KEY_FILE = "$profileDir\.claude\seekai-active-key.txt";
             MODELMAP_FILE = (Join-Path $dir 'seekai-modelmap.json') }
  # TrueSOTA (sub2api): bare root as well. Only claude-opus-5 / -thinking honour our
  # system prompt on this gateway, so truesota-modelmap.json is opus-only in all tiers.
  20160 = @{ UPSTREAM = 'https://true-sota.com'; KEY_FILE = "$profileDir\.claude\truesota-active-key.txt";
             MODELMAP_FILE = (Join-Path $dir 'truesota-modelmap.json') }
  # KKtoken (New API): bare root here too. KK_BASE_URL in transparent-proxy.js keeps the
  # /v1 suffix for model listing only - putting it here would send /v1/v1/messages and
  # the gateway answers 404 on every request.
  20161 = @{ UPSTREAM = 'https://kktoken.cc'; KEY_FILE = "$profileDir\.claude\kktoken-active-key.txt";
             MODELMAP_FILE = (Join-Path $dir 'kktoken-modelmap.json') }
}
if (-not $perPort.ContainsKey($Port)) {
  Write-Error "Unknown port $Port (known: 20133 / 20155 / 20156 / 20157 / 20158 / 20159 / 20160 / 20161)"; exit 1
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
