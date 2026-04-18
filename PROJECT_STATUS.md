# TV → MEXC Scalp Panel — Project Status

## Status: ✅ PRODUCTION — Full System Live

## Architecture
- Chrome extension injected via CDP into TV Desktop UWP (port 9222)
- Launcher: `scripts/start_desktop_panel.bat`
- Webhook: `mexc-webhook-production.up.railway.app` (Railway)
- Repo: `github.com/EchoOo999/tradingview-mcp-jackson`

## Critical TV Desktop UWP API Knowledge
- `widget = window.TradingViewApi._activeChartWidgetWV.value()`
- `widget` IS the chart (no `.activeChart()` wrapper on UWP)
- `widget.getAllShapes()` — lists all drawings
- `widget.getShapeById(id).getPoints()` — returns `[{price, time}, ...]`
- `widget.getShapeById(id).getProperties()` — profitLevel, stopLevel
- `widget.removeEntity(id)` — deletes drawing

## Shape Name Detection (broadened regex)
Matches: `long_position`, `short_position`, `LineToolRiskRewardLong/Short`,
`LongTrade/ShortTrade` variants

## MEXC Order Flow
- `Promise.all`: leverage + ticker + getContractDetail (~2s saved)
- `getContractDetail` returns `priceUnit`, `minVol`, `volScale` per symbol
- `roundPrice(p) = Math.round(p / priceUnit) * priceUnit` (fixes error 2015)
- Live entry re-fetch right before payload build
- `getOpenPosition` retry: 5×500ms
- Timestamp logging at every step

## Features Live

### Scalp Panel (`chrome-extension/content.js`)
- LONG / SHORT / PUSH with live market price
- Cross / Isolated, Market / Limit toggles
- Manual $ or % of Balance
- R/R Preview (Position Size, Margin, PnL, Liq Price)
- Total Balance refresh every 10s
- 📋 From Drawing — reads Entry/TP/SL from TV Long/Short Position tool
- Auto-detects LONG/SHORT from drawing type
- Re-reads fresh on every click (no stale data)
- Market mode = live price / Limit mode = drawing entry
- Ctrl+F coin search overlay

### Signal Scanner (`webhook/scanner.js`)
- W Breakout 1/2 + 2/2 (4H/Daily/Weekly)
- LJ Setup — correct logic:
  - **LONG**: descending resistance TL with 3 rejections → clean break above → W forms above broken TL → neckline break = alert 1/2
  - **SHORT**: ascending support TL with 3 rejections → clean break below → M forms below broken TL → neckline break = alert 1/2
- Alert 2/2 on neckline retest + bounce
- Staleness guard: skip breaks >7 days old
- Full debug trace: touch timestamps, break bar, W/M lows/highs, neckline, alert bar
- SFP scanner retained (5m, W/M on key level + confluence rank)

### Pine Script — "Claude - Market Bias Table"
- 6 metrics: BTC.D, USDT.D, ETH/BTC, TOTAL, TOTAL3, OTHERS
- Direction: open→close delta on current chart TF (configurable flat threshold)
- Color coding from ALT-bullish perspective per row
- Score system: −6 to +6
- 5 regimes: FULL ALT SEASON / RISK-ON / NEUTRAL / BTC DEFENSIVE / RISK-OFF
- 3 special cases: BTC PUMP, ETH ROTATION, SMALL CAP SEASON
- Auto $T/$B formatting for market cap values
- Inputs: position, text size, signal row toggle, flat threshold, bold colors

## Hard Rules (DO NOT VIOLATE)
- Never modify **Main Layout** or **Daily Plan** in TV
- Only edit Pine Scripts ending in `- Claude`
- Execute autonomously, no step-by-step confirmation needed
- Use `/clear` between major task groups
- Always kill + relaunch TV via `start_desktop_panel.bat` after extension changes

## Parked Future Improvements
1. Auto-draw confirmed position on TV Desktop after fill (horizontal lines safer than full Position tool)
2. TV Position Tool → MEXC auto-capture on drawing creation (eliminate manual "From Drawing" click)
3. Live trade performance logging to sheet/db
4. Additional Pine Scripts for setup scanning
5. USDT.D audit on Daily Plan (partially addressed via Market Bias Table)

## Resume Protocol
Next session, Claude Code should:
1. Read this `PROJECT_STATUS.md` first
2. Check `git log` for recent commits
3. Confirm TV Desktop + Railway webhook still live
4. Pick from parked improvements or take new user request
