# cleanup-reg-procs.ps1 — kill orphaned browser zombies left by autoregers / LK sessions.
#
# On Windows, when a reg script dies, its Chromium/Camoufox children get reparented
# to explorer.exe and keep eating RAM (~1.5GB after a few runs). This kills ONLY our
# browsers (playwright chromium, camoufox, github/agentrouter profiles) whose parent
# is gone. The user's real browser is untouched (different paths, no marker match).
#
# Safe default: skips browsers whose parent process is still alive (active session,
# e.g. an open GitHub LK window). -Force kills those too (explicit request).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File routing\cleanup-reg-procs.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File routing\cleanup-reg-procs.ps1 -Force

param([switch]$Force)

$markerRe = 'ms-playwright|github\\profiles|agentrouter\\sessions|camoufox\\Cache'

$procs = Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'camoufox.exe') -and
    $_.CommandLine -match $markerRe
}

$explorerPid = (Get-Process explorer -ErrorAction SilentlyContinue | Select-Object -First 1).Id
$killed = 0

foreach ($p in $procs) {
    $parentAlive = Get-Process -Id $p.ParentProcessId -ErrorAction SilentlyContinue
    $orphan = $Force -or (-not $parentAlive) -or ($p.ParentProcessId -eq $explorerPid)

    $cl = [string]$p.CommandLine
    if ($cl.Length -gt 100) { $cl = $cl.Substring(0, 100) + '...' }

    if ($orphan) {
        Write-Host ("kill  {0} pid={1} (orphan): {2}" -f $p.Name, $p.ProcessId, $cl)
        taskkill /F /T /PID $p.ProcessId 2>$null | Out-Null
        $killed++
    } else {
        Write-Host ("skip {0} pid={1} (live session): {2}" -f $p.Name, $p.ProcessId, $cl)
    }
}

if ($killed -eq 0) { Write-Host "No orphan browser zombies found. Clean slate." }