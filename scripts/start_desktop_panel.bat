@echo off
setlocal

echo ============================================
echo  MEXC Scalp Panel ^— TradingView Desktop
echo ============================================
echo.

:: Step 1 — Launch TradingView with CDP enabled
echo [1/3] Launching TradingView Desktop with CDP...
cscript //nologo "%~dp0launch_tv_debug.vbs"

:: Step 2 — Wait for TradingView to fully load
echo [2/3] Waiting for TradingView to load (10s)...
timeout /t 10 /nokey >nul

:: Step 3 — Inject panel
echo [3/3] Injecting MEXC Scalp Panel...
echo.
echo  Panel:  floating trading panel (top-right corner)
echo  Search: Ctrl+F to search MEXC perpetuals
echo  Bridge: http://localhost:9224
echo.
echo Press Ctrl+C to stop the panel.
echo.

node "%~dp0inject_panel.mjs"

endlocal
