# TV → MEXC Scalp Panel — Project Status

## Status: ✅ PRODUCTION — Live Trading

## Architecture

```
TradingView Desktop UWP
  └── CDP port 9222
        └── Chrome Extension (chrome-extension/)
              └── POST /webhook → Railway (mexc-webhook-production.up.railway.app)
                    └── MEXC Futures API (contract.mexc.com)
```

- **Launcher:** `scripts/start_desktop_panel.bat`
- **Webhook:** `https://mexc-webhook-production.up.railway.app` (Railway, always-on)
- **Repo:** `github.com/EchoOo999/tradingview-mcp-jackson`

---

## Key TV Desktop UWP API (Confirmed Working)

```javascript
// Widget access — widget IS the chart (no .activeChart() wrapper on UWP)
const widget = window.TradingViewApi._activeChartWidgetWV.value();

widget.getAllShapes()                      // [{id, name}, ...]
widget.getShapeById(id).getPoints()        // [{price, time}, ...]  — entry point(s)
widget.getShapeById(id).getProperties()    // profitLevel, stopLevel (tick offsets from entry)
widget.createShape({time, price}, {shape}) // 'long_position', 'short_position', etc.
widget.removeEntity(id)                    // delete drawing by id

// Symbol info (for tick size)
widget._chartWidget._modelWV._value.m_model._mainSeries._symbolInfo._value
  // → { minmov, pricescale }  →  tickSize = minmov / pricescale
```

### Shape Name Detection

`getAllShapes()` returns name strings. Broadened match catches all variants:

```javascript
/riskreward/i || name === 'long_position' || name === 'short_position'
  || name === 'linetoollongtrade' || name === 'linetoolshorttrade'
```

### RiskReward Price Formula

```javascript
// getPoints() returns only the entry price for RiskReward tools
entry = getPoints()[0].price

// profitLevel / stopLevel are INTEGER TICK OFFSETS from entry
tickSize = minmov / pricescale   // e.g. 1/10 = 0.1 for BTC
tp = entry + profitLevel * tickSize   // LONG
sl = entry - stopLevel  * tickSize   // LONG
tp = entry - profitLevel * tickSize  // SHORT
sl = entry + stopLevel  * tickSize   // SHORT
```

---

## MEXC Precision Handling (Fixes Error 2015)

`webhook/mexc.js` — `getContractDetail(symbol)` fetches per-symbol:

| Field | Source | Use |
|-------|--------|-----|
| `contractSize` | `data.contractSize` | vol = floor(usd_risk / (price × contractSize)) |
| `priceUnit` | `data.priceUnit` or `10^(-priceScale)` | round all prices before API calls |
| `minVol` | `data.minVol` | minimum contract volume (clamp vol) |

```javascript
const roundPrice = (p) => Math.round(p / priceUnit) * priceUnit;
// Applied to: limit price, TP price, SL price
```

---

## Order Flow (Optimized)

```
PUSH click
  ├── getCurrentPrice() re-fetch (freshest entry for Market mode)
  └── POST /webhook
        └── placeOrder()
              ├── Promise.all([setLeverage, ticker, getContractDetail])  ← parallel (~2s saved)
              ├── roundPrice() applied to all prices
              ├── order/submit
              └── getOpenPosition (5×500ms retries)
                    └── stoporder/place (TP/SL attached to position)
```

Timestamp logging at each step: `[timing] leverage+ticker+detail`, `[timing] order submit`,
`[timing] getOpenPosition`, `[timing] setPositionTpSl`, `[timing] total placeOrder`.

---

## Features Live

| Feature | Status |
|---------|--------|
| LONG / SHORT / PUSH | ✅ |
| Market / Limit order types | ✅ |
| Cross / Isolated margin | ✅ |
| Manual $ or % of Balance risk | ✅ |
| R/R Preview (Size, Margin, PnL, Liq) | ✅ |
| Total Balance auto-refresh (10s) | ✅ |
| 📋 From Drawing | ✅ |
| Auto LONG/SHORT from drawing type | ✅ |
| Fully re-reads on every click | ✅ |
| Market mode → live entry price | ✅ |
| Limit mode → drawing's entry price | ✅ |
| Ctrl+F coin search overlay | ✅ |
| Draggable panel | ✅ |
| Collapse / MS reopen button | ✅ |

---

## Signal Scanner (`webhook/scanner.js`)

Runs alongside the webhook server. Active alerts sent via Telegram:

| Scanner | Timeframes | Alerts |
|---------|-----------|--------|
| W Breakout | 4H / Daily / Weekly | `W Breakout 1/2`, `W Breakout 2/2` |
| LJ Setup | HTF trendline + 1H W/M | `LJ Long 1/2`, `LJ Long 2/2`, `LJ Short 1/2`, `LJ Short 2/2` |

SFU alerts removed. Symbols: top MEXC perp pairs by volume.

---

## Hard Rules (NEVER VIOLATE)

1. Never modify `Main Layout` or `Daily Plan` in TradingView
2. Only edit Pine Scripts with names ending in `- Claude`
3. Execute autonomously — no step-by-step confirmation required
4. Use `/clear` between major task groups

---

## Known Future Improvements (Parked)

1. **Auto-draw confirmed fill on TV** — horizontal lines for Entry/TP/SL after order fills
2. **Auto-capture on drawing creation** — detect new Long/Short Position tool without manual button click
3. **Audit USDT.D indicators** on Daily Plan layout
4. **Reposition "Time - by EchoOo"** indicator
5. **"Claude - Market Bias Table" Pine Script** — BTC.D, USDT.D, ETHBTC with color-coded directional bias

---

## File Structure

```
chrome-extension/
  content.js          # Panel UI, From Drawing capture, order dispatch
  styles.css          # Panel styling
  manifest.json       # Chrome extension manifest (CDP injection)

webhook/
  server.js           # Express server: /webhook, /balance endpoints
  mexc.js             # MEXC Futures API client (orders, TP/SL, balance)
  scanner.js          # W Breakout + LJ Setup signal scanner

scripts/
  start_desktop_panel.bat   # Launch TV Desktop with CDP + MCP server
  launch_tv_debug.bat       # Alternative launcher
  inject_panel.mjs          # One-shot panel injector
  coin-search-overlay.js    # Ctrl+F coin search overlay
  pine_push.js / pine_pull.js

src/                  # MCP server core (TradingView tool implementations)
skills/               # Claude Code skill definitions
```

---

## How to Resume (Next Session)

1. Read this `PROJECT_STATUS.md` first
2. Run `git log --oneline -10` to see recent commits
3. Confirm TV Desktop is running: `scripts/start_desktop_panel.bat`
4. Confirm Railway webhook alive: `GET https://mexc-webhook-production.up.railway.app/`
5. Pick from **Known Future Improvements** above or take new user request
