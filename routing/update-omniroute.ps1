#!/usr/bin/env pwsh
# routing/update-omniroute.ps1
# Обновляет OmniRoute-контейнер до latest image, сохраняя volume с БД и все env.

$ErrorActionPreference = "Stop"

$ContainerName = "omniroute"
$Image = "ghcr.io/diegosouzapw/omniroute:latest"
$Port = 20128
$BackupDir = "$PSScriptRoot\..\backups"
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"

function Stop-IfFailed {
    param($Message)
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: $Message" -ForegroundColor Red
        exit 1
    }
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " OmniRoute careful update" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# 1. Проверить, что контейнер существует
$container = docker inspect $ContainerName 2>$null | ConvertFrom-Json -ErrorAction SilentlyContinue
if (-not $container) {
    Write-Host "Container '$ContainerName' not found. Nothing to update." -ForegroundColor Yellow
    exit 1
}

# 2. Создать папку для бэкапов
New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null

# 3. Бэкап volume
$VolumeBackup = "$BackupDir\omniroute-data-$Timestamp.tar"
Write-Host "[1/6] Backing up volume omniroute-data -> $VolumeBackup" -ForegroundColor Cyan
$vol = docker run --rm `
    -v "omniroute-data:/data" `
    -v "$($BackupDir):/backup" `
    alpine tar -cf "/backup/omniroute-data-$Timestamp.tar" -C / data
Stop-IfFailed "volume backup failed"

# 4. Дополнительно бэкап SQLite-файла (если он есть)
Write-Host "[2/6] Copying live SQLite file to backup" -ForegroundColor Cyan
$sqliteBackup = "$BackupDir\storage.sqlite-$Timestamp"
docker run --rm -v "omniroute-data:/data" -v "$($BackupDir):/backup" alpine `
    sh -c "cp /data/storage.sqlite /backup/storage.sqlite-$Timestamp 2>/dev/null || echo 'no sqlite'"

# 5. Получить текущие env и параметры из работающего контейнера
Write-Host "[3/6] Reading current container config" -ForegroundColor Cyan
$envList = $container.Config.Env | ForEach-Object { "-e", $_ }

# 6. Остановить старый контейнер
Write-Host "[4/6] Stopping old container" -ForegroundColor Cyan
docker stop $ContainerName
Stop-IfFailed "docker stop failed"

# 7. Переименовать старый контейнер (на всякий случай)
$backupName = "omniroute-backup-$Timestamp"
Write-Host "[5/6] Renaming old container to $backupName" -ForegroundColor Cyan
docker rename $ContainerName $backupName
Stop-IfFailed "docker rename failed"

# 8. Скачать/обновить образ
Write-Host "[6/6] Pulling latest image and starting new container" -ForegroundColor Cyan
docker pull $Image
Stop-IfFailed "docker pull failed"

# 9. Запустить новый контейнер с тем же volume, портом и env
$runArgs = @(
    "run", "-d", "--name", $ContainerName,
    "-p", "$($Port):$($Port)",
    "-v", "omniroute-data:/app/data",
    "--restart", "unless-stopped"
) + $envList + @($Image)

& docker @runArgs
Stop-IfFailed "docker run failed"

# 10. Подождать и проверить здоровье
Write-Host "Waiting for OmniRoute to start..." -ForegroundColor Cyan
$healthy = $false
for ($i = 1; $i -le 30; $i++) {
    Start-Sleep -Seconds 2
    $state = (docker inspect $ContainerName -f '{{.State.Status}}' 2>$null)
    if ($state -ne 'running') {
        Write-Host "  Health check #$i : container not running ($state)" -ForegroundColor Yellow
        continue
    }
    try {
        $tcp = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
        Write-Host "  Health check #$i : port $Port listening" -ForegroundColor Green
        $healthy = $true
        break
    } catch {
        Write-Host "  Health check #$i : port not ready yet" -ForegroundColor Yellow
    }
}

if (-not $healthy) {
    Write-Host "WARNING: OmniRoute did not become healthy within 60 seconds." -ForegroundColor Yellow
    Write-Host "Old container is preserved as '$backupName'." -ForegroundColor Yellow
    Write-Host "To rollback: docker stop $ContainerName; docker rm $ContainerName; docker rename $backupName $ContainerName; docker start $ContainerName" -ForegroundColor Yellow
    exit 1
}

Write-Host "" 
Write-Host "========================================" -ForegroundColor Green
Write-Host " OmniRoute updated successfully" -ForegroundColor Green
Write-Host "  Container: $ContainerName" -ForegroundColor Green
Write-Host "  Image: $Image" -ForegroundColor Green
Write-Host "  Port: $Port" -ForegroundColor Green
Write-Host "  Backup: $VolumeBackup" -ForegroundColor Green
Write-Host "  Old container: $backupName" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green

# 11. Проверка API (количество провайдеров)
Write-Host "Checking API via known key from routing/.env..." -ForegroundColor Cyan
$envFile = "$PSScriptRoot\.env"
$apiKey = $null
if (Test-Path $envFile) {
    $match = Select-String -Path $envFile -Pattern '^OMNIROUTE_API_KEY=(.+)$' | Select-Object -First 1
    if ($match) { $apiKey = $match.Matches.Groups[1].Value.Trim() }
}
if ($apiKey) {
    try {
        $providers = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/providers" -Headers @{"Authorization"="Bearer $apiKey"} -TimeoutSec 10
        Write-Host "  Providers in DB: $($providers.Count)" -ForegroundColor Green
    } catch {
        Write-Host "  Could not read provider count: $_" -ForegroundColor Yellow
    }
} else {
    Write-Host "  OMNIROUTE_API_KEY not found in routing/.env, skipping provider count" -ForegroundColor Yellow
}

exit 0
