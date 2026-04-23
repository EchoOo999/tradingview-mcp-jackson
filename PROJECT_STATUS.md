# TV → MEXC Trading System — Project Status

## Version: v1.0 — Full Production

## System Components

### 1. MEXC Scalp Panel (chrome-extension/content.js)
- Floating trading panel injected via CDP into TV Desktop UWP
- Position: bottom-right (persisted to chrome.storage.local)
- Features:
  * LONG/SHORT/PUSH with live market price
  * Cross/Isolated, Market/Limit toggles
  * Manual $ or % of Balance
  * R/R Preview (Position Size, Margin, PnL, Liq Price)
  * Total Balance refresh every 10s
  * 📋 From Drawing: reads Entry/TP/SL from TV Long/Short Position tool
  * Auto-detects LONG/SHORT from drawing type
  * Re-reads fresh on every click (no stale data)
  * Market mode = live price, Limit mode = drawing entry
  * Ctrl+F coin search overlay

### 2. Market Cockpit Panel (chrome-extension/market-cockpit.js)
- Floating regime dashboard, stacked above MEXC Scalp Panel
- Position: bottom-right above MEXC Scalp (persisted)
- 3 tabs: CRYPTO / MACRO / MASTER
- TF selector: 1H / 4H / Daily / Weekly (default Daily) — verified live via CDP 2026-04-20
- Refresh interval configurable (30s/60s/2min/5min)
- 8-scenario Master regime matrix (3×3 tier grid):
  * 🚀 FULL RISK-ON
  * ⚡ CRYPTO-ONLY RALLY
  * 🟢 CRYPTO LEADING
  * 🟡 MACRO TAILWIND
  * ➡️ MIXED
  * ⚠️ MACRO HEADWIND
  * ⚠️ CRYPTO DECOUPLING
  * 💀 FULL RISK-OFF
- Color-coded regime boxes (7 severity levels)
- Crypto-trader focused action lines
- Top drivers: 3 biggest movers across all metrics
- Tooltip explains divergence logic
- Minimize → MC icon stacks above MS icon bottom-right

### 3. Railway Webhook (webhook/)
URL: https://mexc-webhook-production.up.railway.app
Endpoints:
- POST /webhook — execute MEXC orders
- GET  /balance — fetch total balance
- GET  /market-data — Yahoo Finance proxy (DXY, OIL, GOLD, SPX, NDX, US10Y, VIX)
- GET  /crypto-data — CoinPaprika + Binance proxy (BTC.D, USDT.D, ETH/BTC, TOTAL, TOTAL3, OTHERS)
  * NOTE: Started on CoinGecko (IP-blocked on Railway), migrated to CoinCap
    (DNS sunset), now on CoinPaprika. Supports ?tf=1h|4h|1d|1w via
    percent_change_1h/6h/24h/7d fields (6h used as 4H proxy).

### 4. Signal Scanner (webhook/scanner.js)
STATUS: MUTED (ALERTS_ENABLED = false at top of file)
Detection logic active, Telegram sends disabled.
Logs "[MUTED] Would have sent: [alert text]" instead.
To resume: set ALERTS_ENABLED = true, redeploy.

#### 4a. SAE Forwarder (webhook/sae_forwarder.js) — NEW
Second signal path: scanner detections also POST to EchoOo-SAE /ta-events as
crypto-intel input for Polymarket bot. Independent of Telegram ALERTS_ENABLED.

- Endpoint:   SAE_ENDPOINT (default https://botbridge-production.up.railway.app/ta-events)
- Auth:       header X-SAE-Token = SAE_INGEST_TOKEN
- Toggle:     SAE_FORWARDING_ENABLED=true|false (default false — safety)
- Behaviour:  5s timeout, 1x retry on 5xx/network, soft 10/min rate-limit (queues excess),
              fire-and-forget so detection path never blocks, errors logged not thrown.

Wired into all 3 detection emit points:
  * SFP (5m close) → pattern_type SFP_long | SFP_short
  * LJ stage 1 (1H close) → LJ_{long|short}_stage1
  * LJ stage 2 (1H retest) → LJ_{long|short}_stage2

To enable in production:
  1. Railway dashboard → mexc-webhook → Variables
  2. Set SAE_INGEST_TOKEN to the value provisioned in EchoOo-SAE
  3. Set SAE_FORWARDING_ENABLED=true
  4. Redeploy (Railway auto-restarts on env change)
  5. Confirm in logs: `[sae] forwarded SYMBOL pattern_type → 200`

Active detection logic:
- W Breakout 1/2 + 2/2 (4H/Daily/Weekly)
- LJ Setup CORRECT logic:
  * LONG: descending resistance TL with 3 rejections → clean break →
    W above broken TL → neckline break = alert 1/2 → retest = 2/2
  * SHORT: ascending support TL with 3 rejections → clean break →
    M below broken TL → neckline break = alert 1/2 → retest = 2/2
- 7-day staleness guard
- Full debug trace logging
- SFU alerts REMOVED completely

### 5. Pine Scripts (in "Pine Scripts" layout ONLY)
- "Crypto Key Levels - by EchoOo" — 6 crypto dominance metrics, -6 to +6 score
- "Macro Key Levels - by EchoOo" — 7 TradFi metrics, -7 to +7 score
- "All Key Levels - by EchoOo" — combined 13-metric master table
- "SFP Screener 1-6 - Claude" — 6 Pine scripts for MEXC perp scanning

## Critical Technical Knowledge

### TV Desktop UWP API (confirmed working)
- widget = window.TradingViewApi._activeChartWidgetWV.value()
- widget IS the chart (no .activeChart() wrapper on UWP)
- widget.getAllShapes() → list drawings
- widget.getShapeById(id).getPoints() → [{price, time}, ...]
- widget.getShapeById(id).getProperties() → profitLevel, stopLevel
- widget.removeEntity(id) → delete drawing

### Shape Name Regex (broadened)
Matches: long_position | short_position | LineToolRiskReward(Long|Short) | (Long|Short)Trade

### MEXC Order Flow
- Promise.all: leverage + ticker + getContractDetail (~2s saved)
- priceUnit rounding prevents error 2015
- Live entry re-fetch before payload build
- getOpenPosition retry: 5×500ms
- Timestamp logging every step

### CDP Injection Pipeline (scripts/inject_panel.mjs)
Injects into every TV tab in this order:
1. styles.css (panel CSS)
2. content.js (MEXC Scalp Panel)
3. market-cockpit.js (Market Cockpit)
4. coin-search-overlay.js (Ctrl+F search)

Hot-reload procedure (no TV restart needed):
1. Kill injector process on port 9224 (taskkill //F //PID <pid>)
2. Restart: node scripts/inject_panel.mjs (background, confirm :9224 LISTENING)
3. Reload TV tab via CDP (ui_evaluate: location.reload())
4. Wait ~8s for re-inject, verify DOM via ui_evaluate
5. IIFE guards prevent double-injection

Known injection-context limits:
- chrome.storage.local.* silently fails in CDP-injected context (try/catch swallows
  the error). Panel position + TF persistence across reloads does NOT work as coded.
  Non-critical: default position logic kicks in on each load.
- Cockpit default position anchors to MEXC panel via 600ms setTimeout. If MEXC is
  still expanding at that moment, Cockpit lands against an incomplete size and can
  overlap once MEXC finishes rendering. Manual reposition fixes it per session.

Full restart procedure:
1. taskkill /F /IM TradingView.exe /T
2. Sleep 2s
3. Run scripts/start_desktop_panel.bat
4. Sleep 8s
5. Verify via CDP: both panel elements in DOM

## Hard Rules (DO NOT VIOLATE)
- NEVER modify Main Layout or Daily Plan in TV
- ONLY edit Pine Scripts ending in "- Claude" or "- by EchoOo"
- Execute autonomously, no step-by-step confirmation
- Use /clear between major task groups
- Kill + relaunch TV via start_desktop_panel.bat after extension changes

## Parked Future Improvements
1. Resume LJ alerts after logic review + backtest validation
2. Auto-draw confirmed position on TV Desktop after fill
   (horizontal lines safer than full Position tool)
3. TV Position Tool → auto-capture on drawing creation
   (eliminate manual "From Drawing" click)
4. Live trade performance logging to sheet/db
5. Master Regime historical tracking + backtest
6. Additional setup scanners (when requested)
7. Mobile companion panel access

## Repo
github.com/EchoOo999/tradingview-mcp-jackson

## Resume Protocol for Next Session
1. Read this PROJECT_STATUS.md first
2. Check git log for recent commits since this doc
3. Verify:
   - TV Desktop + Railway webhook still live
   - Both panels visible on TV
   - Pine Scripts still in Pine Scripts layout
4. Pick from parked improvements or take new user request
