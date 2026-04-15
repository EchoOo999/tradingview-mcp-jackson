@echo off
REM ─────────────────────────────────────────────────────────────────────────────
REM  MEXC Scalp Panel — One-click desktop launcher
REM
REM  1. Kills any running inject_panel.mjs (releases port 9224)
REM  2. Kills TradingView and relaunches it with CDP on port 9222
REM  3. Starts inject_panel.mjs — it polls until TV is ready, then injects.
REM     It also reconnects automatically if TV restarts later.
REM ─────────────────────────────────────────────────────────────────────────────

echo.
echo  MEXC Scalp Panel ^| TradingView Desktop
echo  ─────────────────────────────────────────
echo.

REM ── Step 1: Release port 9224 (kill old injector if running) ─────────────────
echo [1/3] Releasing port 9224...
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":9224 "') do (
    taskkill /F /PID %%p >nul 2>&1
)

REM ── Step 2: Launch TradingView with CDP ──────────────────────────────────────
echo [2/3] Launching TradingView with CDP...
powershell -NoProfile -Command "Stop-Process -Name TradingView -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1; $pkg = Get-AppxPackage -Name 'TradingView.Desktop' | Select-Object -First 1; if (-not $pkg) { Write-Error 'TradingView Store app not found'; exit 1 }; $exe = Join-Path $pkg.InstallLocation 'TradingView.exe'; Start-Process $exe -ArgumentList '--remote-debugging-port=9222'; Write-Host 'TradingView launched.'"
if %errorlevel% neq 0 (
    echo.
    echo  ERROR: Could not launch TradingView.
    echo  Make sure it is installed from the Microsoft Store.
    pause
    exit /b 1
)

REM ── Step 3: Start injector minimized in background ──────────────────────────
echo [3/3] Starting panel injector (minimized)...
start /min "inject_panel" node "%~dp0inject_panel.mjs"
echo  Done. Injector running in background.
echo  To stop: taskkill /F /IM node.exe
