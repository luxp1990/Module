Add-Type -AssemblyName System.Windows.Forms
Start-Sleep -Milliseconds 200

# 发送 Ctrl+Shift+M
Write-Host "Sending Ctrl+Shift+M..."
[System.Windows.Forms.SendKeys]::SendWait("^+M")
Start-Sleep 1
Write-Host "Sent"
