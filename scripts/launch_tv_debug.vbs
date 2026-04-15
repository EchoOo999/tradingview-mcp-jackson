Set oShell = CreateObject("WScript.Shell")

' For Windows Store (MSIX) installs the exe lives under WindowsApps and must
' be launched directly with --remote-debugging-port — env-var tricks do NOT
' propagate through the COM/MSIX activation sandbox.
'
' We use PowerShell Get-AppxPackage to resolve the exact install path without
' needing elevated access to the protected WindowsApps directory.

Dim psCmd
psCmd = "powershell -NoProfile -Command """ & _
  "taskkill /F /IM TradingView.exe | Out-Null; " & _
  "Start-Sleep 2; " & _
  "$pkg = Get-AppxPackage -Name 'TradingView.Desktop' | Select-Object -First 1; " & _
  "if (-not $pkg) { Write-Error 'TradingView Store app not found'; exit 1 }; " & _
  "$exe = Join-Path $pkg.InstallLocation 'TradingView.exe'; " & _
  "Write-Host ('Launching: ' + $exe); " & _
  "Start-Process $exe -ArgumentList '--remote-debugging-port=9222'; " & _
  "Write-Host 'Launched — CDP on port 9222';" & _
  """"

oShell.Run psCmd, 1, True
WScript.Echo "Done."
