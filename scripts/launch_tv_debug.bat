@echo off
REM Launch TradingView Desktop (Windows Store / MSIX) with CDP enabled.
REM
REM For Store installs the exe lives in the protected WindowsApps directory.
REM shell:AppsFolder + env-var tricks do NOT pass --remote-debugging-port
REM through the MSIX activation sandbox.  The only approach that works is
REM launching the exe directly; we use Get-AppxPackage to resolve the path
REM without needing to browse the restricted WindowsApps folder.

set PORT=%1
if "%PORT%"=="" set PORT=9222

echo [1/3] Killing existing TradingView instances...
taskkill /F /IM TradingView.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo [2/3] Locating and launching TradingView with CDP port %PORT%...
powershell -NoProfile -Command ^
  "$pkg = Get-AppxPackage -Name 'TradingView.Desktop' | Select-Object -First 1; ^
  if (-not $pkg) { ^
    Write-Error 'TradingView Store app not found. Is it installed from the Microsoft Store?'; ^
    exit 1 ^
  }; ^
  $exe = Join-Path $pkg.InstallLocation 'TradingView.exe'; ^
  Write-Host ('Found: ' + $exe); ^
  Start-Process $exe -ArgumentList '--remote-debugging-port=%PORT%'; ^
  Write-Host 'Launched.'"

if %errorlevel% neq 0 (
    echo.
    echo ERROR: Could not locate or launch TradingView.
    echo If installed outside the Store, run manually:
    echo   TradingView.exe --remote-debugging-port=%PORT%
    exit /b 1
)

echo [3/3] Waiting for CDP on port %PORT%...
timeout /t 6 /nobreak >nul

:check
powershell -NoProfile -Command ^
  "try { Invoke-WebRequest -Uri 'http://localhost:%PORT%/json/version' -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel% neq 0 (
    echo   Still loading...
    timeout /t 3 /nobreak >nul
    goto check
)

echo.
echo CDP ready at http://localhost:%PORT%
powershell -NoProfile -Command "(Invoke-WebRequest -Uri 'http://localhost:%PORT%/json/version' -UseBasicParsing).Content"
echo.
