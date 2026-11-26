$ErrorActionPreference = "Stop"
$projectDir = "D:\OneDrive\Desktop\工具库\肥仔\任务管理器"
Set-Location $projectDir

# Kill existing electron processes
Get-Process -Name "electron" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

# Start app with CDP
$app = Start-Process -FilePath "npx" -ArgumentList "electron . --remote-debugging-port=9222" -WorkingDirectory $projectDir -NoNewWindow -PassThru
Write-Host "Started electron PID: $($app.Id)"

# Wait for app to boot
Start-Sleep -Seconds 5

# Verify running
$proc = Get-Process -Name "electron" -ErrorAction SilentlyContinue
if ($proc) {
    Write-Host "App running: PID $($proc.Id)"
    exit 0
} else {
    Write-Host "ERROR: App not running"
    exit 1
}
