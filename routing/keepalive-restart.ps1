# Replaces keepalive-proxy.js on :20133 without blocking the caller.
# Uses WMI Win32_Process.Create -> fully detached (no inherited console handles),
# so the launching shell returns immediately. All output goes to keepalive-proxy.out.log.
$ErrorActionPreference = 'SilentlyContinue'

$dir = $PSScriptRoot
$node = 'C:\Program Files\nodejs\node.exe'
$script = Join-Path $dir 'keepalive-proxy.js'
$outLog = Join-Path $dir 'keepalive-proxy.out.log'
$logFile = Join-Path $dir 'keepalive-proxy.log'

# Kill whatever listens on :20133
$conns = Get-NetTCPConnection -LocalPort 20133 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) {
    try { Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop } catch {}
}
Start-Sleep -Milliseconds 800

$sets = @(
  'PORT=20133',
  'UPSTREAM=https://agentrouter.org',
  'IDLE_MS=5000',
  'MAX_RETRIES=3',
  'RETRY_DELAY_MS=1500',
  'COUNT_TOKENS_FALLBACK=1',
  'EARLY_SSE=1',
  'UPSTREAM_TIMEOUT_MS=600000',
  'HAIKU_REMAP=1',
  'HAIKU_TO_MODEL=gpt-5.6-sol',
  'HAIKU_GPT_PROXY=http://127.0.0.1:20132',
  'LOG_FILE=' + $logFile
)
$envVars = ($sets | ForEach-Object { 'set "' + $_ + '"' }) -join '&&'

$cmdLine = 'cmd.exe /c cd /d "' + $dir + '" && ' + $envVars + ' && "' + $node + '" "' + $script + '" >> "' + $outLog + '" 2>&1'

$wmi = [wmiclass]'\\.\root\cimv2:Win32_Process'
$r = $wmi.Create($cmdLine)
