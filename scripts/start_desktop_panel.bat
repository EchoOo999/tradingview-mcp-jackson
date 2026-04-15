@echo off
REM ── Self-hiding: relaunch this script hidden, then exit immediately ───────────
if not "%1"=="hidden" (
  powershell -NoProfile -WindowStyle Hidden -Command "Start-Process cmd -ArgumentList '/c \"%~f0\" hidden' -WindowStyle Hidden"
  exit /b
)

REM ── Step 1: Release port 9224 ─────────────────────────────────────────────────
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":9224 "') do (
    taskkill /F /PID %%p >nul 2>&1
)

REM ── Step 2: Launch TradingView with CDP (no window) ───────────────────────────
powershell -NoProfile -WindowStyle Hidden -Command "Stop-Process -Name TradingView -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1; $pkg = Get-AppxPackage -Name 'TradingView.Desktop' | Select-Object -First 1; if (-not $pkg) { exit 1 }; $exe = Join-Path $pkg.InstallLocation 'TradingView.exe'; Start-Process $exe -ArgumentList '--remote-debugging-port=9222'"

REM ── Step 3: Start injector — completely hidden, detached ──────────────────────
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath node -ArgumentList '\"%~dp0inject_panel.mjs\"' -WorkingDirectory '%~dp0..' -WindowStyle Hidden"
