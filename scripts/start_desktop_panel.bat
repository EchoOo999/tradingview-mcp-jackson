@echo off
REM ─────────────────────────────────────────────────────────────────────────────
REM  MEXC Scalp Panel — One-click desktop launcher (all windows hidden)
REM
REM  Run this via start_desktop_panel.vbs for a completely silent launch.
REM ─────────────────────────────────────────────────────────────────────────────

REM ── Step 1: Release port 9224 (kill old injector if running) ─────────────────
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":9224 "') do (
    taskkill /F /PID %%p >nul 2>&1
)

REM ── Step 2: Launch TradingView with CDP (hidden PowerShell window) ────────────
powershell -NoProfile -WindowStyle Hidden -Command "Stop-Process -Name TradingView -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1; $pkg = Get-AppxPackage -Name 'TradingView.Desktop' | Select-Object -First 1; if (-not $pkg) { exit 1 }; $exe = Join-Path $pkg.InstallLocation 'TradingView.exe'; Start-Process $exe -ArgumentList '--remote-debugging-port=9222'"

REM ── Step 3: Start injector silently — no window ───────────────────────────────
start /b node "%~dp0inject_panel.mjs" >nul 2>&1
