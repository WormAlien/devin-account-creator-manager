# whoami.ps1 — quick lookup: take an OmniRoute account id (full or first 8 chars),
# print name/email/status. Pass id as argument or paste a line containing one.
#
# Usage:
#   .\whoami.ps1 fd48f370
#   .\whoami.ps1 anthropic-compatible-e5441a70-...:fd48f370-...
#   .\whoami.ps1     # (no arg)  list all accounts grouped by status

param([string]$query = "")

$sqlite = "C:\Users\WormAlien\AppData\Local\Microsoft\WinGet\Links\sqlite3.exe"
$src    = "$env:USERPROFILE\.omniroute\storage.sqlite"
$tmp    = "$env:TEMP\omni_whoami.sqlite"

Copy-Item $src $tmp -Force
Copy-Item "$src-wal" "$tmp-wal" -Force -ErrorAction SilentlyContinue
Copy-Item "$src-shm" "$tmp-shm" -Force -ErrorAction SilentlyContinue

if (-not $query) {
    Write-Host "`n=== all accounts (active first) ===" -ForegroundColor Cyan
    & $sqlite $tmp "-header" "-column" @"
SELECT
  substr(id, 1, 8)         AS id8,
  CASE WHEN provider LIKE 'anthropic-compat%' THEN 'free' ELSE provider END AS prov,
  is_active                AS act,
  test_status              AS status,
  substr(coalesce(name,''), 1, 32) AS name,
  substr(coalesce(error_code,''), 1, 5) AS err
FROM provider_connections
ORDER BY is_active DESC, last_used_at DESC, created_at DESC;
"@
    exit 0
}

# Extract any UUID-like fragment. If colon present, take last part (account id).
$id = $query
if ($id -match ':') { $id = ($id -split ':')[-1] }
# Trim non-hex/dash chars
$id = ($id -replace '[^0-9a-fA-F-]', '')
# Take first 8 hex chars as prefix for matching
$prefix = if ($id.Length -ge 8) { $id.Substring(0, 8) } else { $id }

Write-Host "`n=== match: id LIKE '$prefix%' ===" -ForegroundColor Cyan
& $sqlite $tmp "-cmd" ".mode line" @"
SELECT
  id,
  provider,
  auth_type,
  name,
  email,
  is_active,
  test_status,
  error_code,
  last_error,
  rate_limited_until,
  last_used_at,
  created_at
FROM provider_connections
WHERE id LIKE '$prefix%';
"@
