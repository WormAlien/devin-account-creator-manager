# fix-paths-after-move.ps1 -- run ONCE after moving/renaming the repo folder.
#
# The repo itself is path-independent (all scripts resolve paths from their own
# location). What does NOT move with it are references kept OUTSIDE the repo by
# Claude Code:
#   1. ~/.claude/projects/<path-slug>/  -- session history AND the agent memory
#      dir; the slug is derived from the project path, so a moved folder looks
#      like a brand new project and the old memory is invisible.
#   2. ~/.claude.json -- project entry key + githubRepoPaths mapping.
#   3. ~/.claude/settings.json -- statusLine.command with an absolute path to
#      routing/statusline-autoreger.sh (the dashboard also self-heals this on
#      start; done here too, in case you fix things before launching it).
#   4. tgbot/.env -- DEFAULT_CWD (code falls back to repo root, but keep it tidy).
#   5. tools/tg-venv -- a venv remembers where it was created; python.exe keeps
#      working, pip/activate do not.
#
# Usage (from the NEW location):
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\fix-paths-after-move.ps1
#   ... -OldPath 'C:\Users\WormAlien\Desktop\Autoreger_Clean'    # if autodetect is ambiguous
#   ... -DryRun                                                  # show, change nothing
#
# ASCII only on purpose: PowerShell 5.1 reads .ps1 as ANSI and mangles UTF-8.
param([string]$OldPath = '', [switch]$DryRun)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path.TrimEnd('\')
$claudeDir = Join-Path $env:USERPROFILE '.claude'
$projectsDir = Join-Path $claudeDir 'projects'
$settingsFile = Join-Path $claudeDir 'settings.json'
$claudeJson = Join-Path $env:USERPROFILE '.claude.json'
$act = @()   # what was done, for the final summary

function Get-CcSlug([string]$p) { return (($p.TrimEnd('\', '/')) -replace '[^A-Za-z0-9]', '-') }
function Say([string]$m) { Write-Host $m }

$newSlug = Get-CcSlug $repo
Say "repo now at : $repo"
Say "project slug: $newSlug"
if ($DryRun) { Say '--- DRY RUN, nothing will be written ---' }

# ---- 1. Claude Code project dir: sessions + agent memory --------------------
# Autodetect: a project whose path is recorded in ~/.claude.json but no longer
# exists on disk is exactly a folder that was moved. Every other project dir
# (other repos, the wiki vault) still exists, so it never matches.
$oldSlug = ''
if ($OldPath) {
    $oldSlug = Get-CcSlug $OldPath
} elseif ((Test-Path $claudeJson) -and (Test-Path $projectsDir)) {
    $gone = @()
    try {
        $j0 = Get-Content $claudeJson -Raw | ConvertFrom-Json
        foreach ($n in $j0.projects.PSObject.Properties.Name) {
            if ($n -eq $repo -or (Test-Path $n)) { continue }
            if (Test-Path (Join-Path $projectsDir (Get-CcSlug $n))) { $gone += $n }
        }
    } catch { Say "could not read $claudeJson : $($_.Exception.Message)" }
    if ($gone.Count -eq 1) { $OldPath = $gone[0]; $oldSlug = Get-CcSlug $OldPath }
    elseif ($gone.Count -gt 1) {
        Say 'Several moved-away projects, pass the old path explicitly:'
        $gone | ForEach-Object { Say ("  " + $_) }
        Say "  -OldPath '<one of the above>'"
        exit 1
    }
}
if ($oldSlug -and $oldSlug -ne $newSlug) {
    $src = Join-Path $projectsDir $oldSlug
    $dst = Join-Path $projectsDir $newSlug
    if (Test-Path $src) {
        if (-not (Test-Path $dst)) {
            Say "project dir: $oldSlug -> $newSlug (rename)"
            if (-not $DryRun) { Move-Item $src $dst }
            $act += 'project dir renamed (sessions + memory kept)'
        } else {
            # Claude Code already created a fresh dir here -- merge instead of clobber.
            Say "project dir: merging $oldSlug into existing $newSlug"
            if (-not $DryRun) {
                robocopy $src $dst /E /XC /XN /XO /NFL /NDL /NJH /NJS /NP | Out-Null
                Remove-Item $src -Recurse -Force
            }
            $act += 'project dir merged into the existing one'
        }
    }
} else {
    Say 'project dir: nothing to move (no old dir found)'
}

# ---- 2. Patch the json configs with the old path ----------------------------
if ($OldPath) { Say "old path    : $OldPath" } else { Say 'old path    : unknown, json configs left alone' }

# PS 5.1 "-Encoding UTF8" writes a BOM, and a BOM breaks JSON.parse in Node (both
# Claude Code and the dashboard read these files) and shows up as part of the first
# key in .env. Always write UTF-8 without BOM.
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-TextNoBom([string]$file, [string]$text) {
    [System.IO.File]::WriteAllText($file, $text, $Utf8NoBom)
}

function Patch-File([string]$file, [string]$old, [string]$new, [string]$label) {
    if (-not $old -or -not (Test-Path $file)) { return $false }
    $raw = Get-Content $file -Raw
    $oldFwd = $old.Replace('\', '/').TrimEnd('/')
    $oldBack = $old.Replace('/', '\').TrimEnd('\')
    $newFwd = $new.Replace('\', '/').TrimEnd('/')
    $newBack = $new.Replace('/', '\').TrimEnd('\')
    $patched = $raw.Replace($oldBack.Replace('\', '\\'), $newBack.Replace('\', '\\')).Replace($oldFwd, $newFwd).Replace($oldBack, $newBack)
    if ($patched -eq $raw) { Say "$label : no old path inside"; return $false }
    Say "$label : patched"
    if (-not $DryRun) {
        Copy-Item $file "$file.bak-move" -Force
        Write-TextNoBom $file $patched
    }
    return $true
}

if (Patch-File $claudeJson $OldPath $repo '.claude.json  ') { $act += '.claude.json updated (project key + githubRepoPaths)' }
if (Patch-File $settingsFile $OldPath $repo 'settings.json ') { $act += 'settings.json updated (statusline path)' }

# tgbot/.env: empty DEFAULT_CWD means "repo root", which survives any future move.
$tgEnv = Join-Path $repo 'tgbot\.env'
if (Test-Path $tgEnv) {
    $raw = Get-Content $tgEnv -Raw
    $patched = $raw -replace '(?m)^DEFAULT_CWD=.*$', 'DEFAULT_CWD='
    if ($patched -ne $raw) {
        Say 'tgbot/.env    : DEFAULT_CWD cleared (falls back to repo root)'
        if (-not $DryRun) { Write-TextNoBom $tgEnv $patched }
        $act += 'tgbot/.env DEFAULT_CWD cleared'
    }
}


# ---- 3. tools/tg-venv: python.exe survives a move, pip/activate do not ------
$venv = Join-Path $repo 'tools\tg-venv'
$venvPy = Join-Path $venv 'Scripts\python.exe'
$req = Join-Path $repo 'tools\tg-venv-requirements.txt'
if (Test-Path $venvPy) {
    $ok = $false
    try { & $venvPy -c 'import opentele, telethon' 2>$null; $ok = ($LASTEXITCODE -eq 0) } catch { $ok = $false }
    if ($ok) {
        Say 'tg-venv       : works (imports fine), left as is'
    } elseif (Test-Path $req) {
        Say 'tg-venv       : broken after move -> recreating'
        if (-not $DryRun) {
            $base = 'python'
            $cfg = Join-Path $venv 'pyvenv.cfg'
            if (Test-Path $cfg) {
                $exe = (Get-Content $cfg | Where-Object { $_ -match '^executable\s*=' }) -replace '^executable\s*=\s*', ''
                if ($exe -and (Test-Path $exe)) { $base = $exe }
            }
            Remove-Item $venv -Recurse -Force
            & $base -m venv $venv
            & $venvPy -m pip install -q -r $req
        }
        $act += 'tg-venv recreated'
    } else {
        Say "tg-venv       : broken and no $req -- run install-deps.sh"
    }
} else {
    Say 'tg-venv       : not installed (fine unless you use TG session opening)'
}

# ---- summary ----------------------------------------------------------------
Say ''
if ($act.Count) { Say 'Done:'; $act | ForEach-Object { Say ("  - " + $_) } }
else { Say 'Nothing needed changing.' }
Say ''
Say 'Next: start the dashboard from the new location -> routing\restart-dashboard.bat'
Say '      (it also rewrites the statusline path in settings.json on every start)'
if ($DryRun) { Say 'This was a dry run.' }
