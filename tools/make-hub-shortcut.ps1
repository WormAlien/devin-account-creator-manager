#Requires -Version 5
# make-hub-shortcut.ps1 - creates an "ABUSE HUB" shortcut on the current user's Desktop.
#
# ASCII ONLY on purpose (project rule): a .ps1 without BOM is read as ANSI by PowerShell
# 5.1, so Cyrillic inside would be mangled. Everything user-visible here is English.
#
# Target is HUB.bat - the documented double-click entry point: start, stop, restart,
# update and doctor all live in its menu. Elevation is NOT requested on purpose. HUB.bat
# says it plainly: self-elevating broke the launcher (taskkill from a normal console
# cannot kill an elevated node), and the hub asks for rights itself when it needs them.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-hub-shortcut.ps1

$ErrorActionPreference = 'Stop'

# Paths are derived, never hardcoded: the repo may live anywhere, and the Desktop is not
# always %USERPROFILE%\Desktop (OneDrive redirection).
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$bat  = Join-Path $repo 'HUB.bat'
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'ABUSE HUB.lnk'

if (-not (Test-Path -LiteralPath $bat)) { throw "HUB.bat not found next to tools\: $bat" }
if (-not (Test-Path -LiteralPath $desktop)) { throw "Desktop folder not found: $desktop" }

# Icon: node.exe if we can find it, otherwise leave the default .bat icon alone.
$icon = ''
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if ($node) { $icon = $node.Source + ',0' }

$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnk)
$s.TargetPath = $bat
$s.WorkingDirectory = $repo
$s.Description = 'ABUSE HUB - start, stop, restart, update, doctor'
$s.WindowStyle = 1
if ($icon) { $s.IconLocation = $icon }
$s.Save()

# Read the shortcut back: Save() is silent even when the target is nonsense.
$check = $sh.CreateShortcut($lnk)
Write-Output ('created : ' + $lnk)
Write-Output ('target  : ' + $check.TargetPath)
Write-Output ('workdir : ' + $check.WorkingDirectory)
Write-Output ('icon    : ' + $check.IconLocation)
if ($check.TargetPath -ne $bat) { throw 'shortcut points somewhere else - check the path above' }
