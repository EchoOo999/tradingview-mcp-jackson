/**
 * WebSocket-based SFP + GS Location Scanner — MEXC Perpetual Futures
 *
 * One persistent WebSocket connection to wss://contract.mexc.com/edge
 *
 * REST is used ONLY for:
 *   - Bootstrap: top-50 selection + initial kline history (once at startup)
 *   - Volume refresh: re-select top-50 every 6h and update subscriptions
 *
 * WebSocket handles everything else:
 *   - sub.kline (Min5 + Min60) for each top-50 coin
 *   - Candle close detection: when WS sends a new timestamp for a symbol+interval,
 *     the previous candle is finalized and SFP+GS detection runs immediately
 *
 * Read-only — no trading, no MEXC auth. Public endpoints only.
 */

import WebSocket from 'ws';

// ── Constants ─────────────────────────────────────────────────────────────────
const WS_URL            = 'wss://contract.mexc.com/edge';
const REST_BASE         = 'https://contract.mexc.com';
const TELEGRAM_API      = 'https://api.telegram.org';

const PING_INTERVAL_MS  = 15_000;              // server drops conn after 60s no-ping
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS  = 60_000;
const VOLUME_REFRESH_MS = 60 * 60 * 1000;      // 1h between top-coin refreshes
const ALERT_RESET_MS    = 4 * 60 * 60 * 1000; // 4h dedup window

const TOP_N             = 250;                 // raised — 5M filter is the real gate
const MIN_VOLUME_USDT   = 5_000_000;           // 5M USDT 24h (~206 coins currently)

const BOOTSTRAP_5M      = 100;
const BOOTSTRAP_1H      = 500;                 // ~20 days
const BUFFER_MAX_5M     = 150;                 // rolling buffer cap
const BUFFER_MAX_1H     = 550;

// ── State ─────────────────────────────────────────────────────────────────────
let ws             = null;
let pingTimer      = null;
let reconnectDelay = RECONNECT_BASE_MS;
let disconnectedAt = 0;
let shuttingDown   = false;

// Kline history: symbol → { m5: Bar[], h1: Bar[] }
// Bar = { time:number, open:number, high:number, low:number, close:number, vol:number }
const klineBuffers = new Map();

// Last seen candle-open timestamp from WS: "SYMBOL:Min5" → epochSeconds
const lastWsTs     = new Map();

// Last received WS data for the forming candle: "SYMBOL:Min5" → raw data obj
const pendingBar   = new Map();

// Current top-N symbols (updated every 6h)
let topSymbols     = [];

// Alert dedup: "SYMBOL:long" | "SYMBOL:short" → timestamp
const alerted      = new Map();

// Activity counters
let candleCloseCount = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function wasAlertedRecently(symbol, direction) {
  const ts = alerted.get(`${symbol}:${direction}`);
  return ts != null && Date.now() - ts < ALERT_RESET_MS;
}
function markAlerted(symbol, direction) {
  alerted.set(`${symbol}:${direction}`, Date.now());
}

// ── REST (bootstrap only) ─────────────────────────────────────────────────────
async function restGet(path) {
  const res = await fetch(`${REST_BASE}${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`REST ${path}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== 0 && json.code !== 200) {
    throw new Error(`REST ${path}: code ${json.code} — ${json.message || ''}`);
  }
  return json.data;
}

// ── Top-50 selection ──────────────────────────────────────────────────────────
async function fetchTopSymbols() {
  console.log('[scanner] Selecting top symbols via REST...');

  // Fetch detail + tickers in parallel (both are public, no auth needed)
  const [detail, tickers] = await Promise.all([
    restGet('/api/v1/contract/detail'),
    restGet('/api/v1/contract/ticker'),
  ]);

  // amount24 = 24h USDT turnover (confirmed from docs)
  const volMap = new Map();
  for (const t of (tickers || [])) {
    if (t.symbol) volMap.set(t.symbol, parseFloat(t.amount24 || 0));
  }

  const selected = (detail || [])
    .filter(c => c.symbol && c.symbol.endsWith('_USDT') && !c.symbol.includes('STOCK'))
    .map(c => ({ symbol: c.symbol, vol: volMap.get(c.symbol) ?? 0 }))
    .filter(c => c.vol >= MIN_VOLUME_USDT)
    .sort((a, b) => b.vol - a.vol)
    .slice(0, TOP_N)
    .map(c => c.symbol);

  console.log(`[scanner] ${selected.length} coins selected (≥${MIN_VOLUME_USDT / 1e6}M USDT volume)`);
  return selected;
}

// ── Bootstrap kline history ───────────────────────────────────────────────────
async function bootstrapKlines(symbols) {
  console.log(`[scanner] Bootstrapping klines for ${symbols.length} coins...`);
  let ok = 0;

  for (const symbol of symbols) {
    try {
      const [raw5m, raw1h] = await Promise.all([
        restGet(`/api/v1/contract/kline/${symbol}?interval=Min5&limit=${BOOTSTRAP_5M}`),
        restGet(`/api/v1/contract/kline/${symbol}?interval=Min60&limit=${BOOTSTRAP_1H}`),
      ]);

      // Exclude the last bar — it may be the currently-forming candle
      const parse = d => {
        if (!d || !Array.isArray(d.time) || !d.time.length) return [];
        const end = d.time.length - 1; // skip last
        return Array.from({ length: end }, (_, i) => ({
          time:  d.time[i],
          open:  parseFloat(d.open[i]),
          high:  parseFloat(d.high[i]),
          low:   parseFloat(d.low[i]),
          close: parseFloat(d.close[i]),
          vol:   parseFloat((d.vol || [])[i] || 0),
        }));
      };

      klineBuffers.set(symbol, { m5: parse(raw5m), h1: parse(raw1h) });
      ok++;
    } catch (err) {
      console.error(`[scanner] Bootstrap ${symbol}: ${err.message}`);
      klineBuffers.set(symbol, { m5: [], h1: [] });
    }

    await sleep(400); // ~5 req/s during bootstrap — safely under 10/s MEXC limit
  }

  console.log(`[scanner] Bootstrap done: ${ok}/${symbols.length} symbols`);
}

// ── Kline buffer update ───────────────────────────────────────────────────────
function pushBarToBuffer(symbol, interval, bar) {
  const buf = klineBuffers.get(symbol);
  if (!buf) return;

  const arr = interval === 'Min5' ? buf.m5 : buf.h1;
  const max = interval === 'Min5' ? BUFFER_MAX_5M : BUFFER_MAX_1H;

  arr.push(bar);
  if (arr.length > max) arr.shift();
}

// ── RSI (Wilder smoothed, period 14) ─────────────────────────────────────────
function calcRSI(closes, period = 14) {
  const rsi = new Array(period).fill(null);
  if (closes.length <= period) return rsi;

  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    gainSum += Math.max(0, d);
    lossSum += Math.max(0, -d);
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, d))  / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
    rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return rsi;
}

// ── Pivot detection ───────────────────────────────────────────────────────────
function findPivots(bars, lookback = 5) {
  const highs = [], lows = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isHigh = false;
      if (bars[j].low  <= bars[i].low)  isLow  = false;
    }
    if (isHigh) highs.push({ index: i, price: bars[i].high });
    if (isLow)  lows.push ({ index: i, price: bars[i].low  });
  }
  return { highs, lows };
}

// ── RSI divergence ────────────────────────────────────────────────────────────
function checkDivergence(bars5m, direction) {
  const rsiArr = calcRSI(bars5m.map(b => b.close));
  const { highs, lows } = findPivots(bars5m, 3);

  if (direction === 'short') {
    const last2 = highs.slice(-2);
    if (last2.length < 2) return false;
    const [h1, h2] = last2;
    const r1 = rsiArr[h1.index], r2 = rsiArr[h2.index];
    if (r1 == null || r2 == null) return false;
    return h2.price > h1.price && r2 < r1; // higher high, lower RSI = bear div
  } else {
    const last2 = lows.slice(-2);
    if (last2.length < 2) return false;
    const [l1, l2] = last2;
    const r1 = rsiArr[l1.index], r2 = rsiArr[l2.index];
    if (r1 == null || r2 == null) return false;
    return l2.price < l1.price && r2 > r1; // lower low, higher RSI = bull div
  }
}

// ── GS Location check ─────────────────────────────────────────────────────────
function checkGSLocation(bars1h, direction, currentPrice) {
  const recent = bars1h.slice(-50);
  if (recent.length < 20) return null;

  const { highs, lows } = findPivots(recent, 5);
  if (!highs.length || !lows.length) return null;

  const swingHigh = highs[highs.length - 1].price;
  const swingLow  = lows[lows.length  - 1].price;
  const range     = swingHigh - swingLow;
  if (range <= 0) return null;

  if (direction === 'long') {
    const r = (swingHigh - currentPrice) / range;
    if (r >= 0.618 && r <= 0.786) return 'RLZ (0.618–0.786)';
    if (r >= 0.382 && r <= 0.500) return 'PCZ (0.382–0.500)';
  } else {
    const r = (currentPrice - swingLow) / range;
    if (r >= 0.618 && r <= 0.786) return 'SRZ (0.618–0.786)';
    if (r >= 0.382 && r <= 0.500) return 'DCZ (0.382–0.500)';
  }
  return null;
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('[scanner] TELEGRAM env vars not set — alert skipped');
    return;
  }
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`[scanner] Telegram error: ${err.slice(0, 200)}`);
    }
  } catch (err) {
    console.error(`[scanner] Telegram failed: ${err.message}`);
  }
}

function buildAlert(symbol, direction, location, hasDivergence) {
  const coin  = symbol.replace('_', '');
  const time  = new Date().toISOString().slice(11, 16) + ' UTC';
  const dir   = direction === 'long' ? 'LONG' : 'SHORT';
  const level = direction === 'long' ? 'PWL swept' : 'PWH swept';
  const div   = hasDivergence ? '\nDivergence: RSI' : '';

  return location
    ? `🎯 <b>SFP + GS LOCATION</b>\nCoin: ${coin}\nDirection: ${dir}\nLevel: ${level}\nLocation: ${location}${div}\nTime: ${time}`
    : `⚡ <b>SFP ONLY</b>\nCoin: ${coin}\nDirection: ${dir}\nLevel: ${level}${div}\nTime: ${time}`;
}

// ── SFP detection (runs on each 5m candle close) ──────────────────────────────
async function detectSFP(symbol) {
  try {
    const buf = klineBuffers.get(symbol);
    if (!buf) return;

    const { m5, h1 } = buf;
    if (m5.length < 30 || h1.length < 50) return;

    // PWH/PWL = highest high + lowest low of last 20 days on 1H (480 bars)
    const refBars = h1.slice(-480);
    const PWH     = Math.max(...refBars.map(b => b.high));
    const PWL     = Math.min(...refBars.map(b => b.low));
    if (!isFinite(PWH) || !isFinite(PWL)) return;

    // Most recent closed 5m bar = last bar in buffer
    const sfpBar = m5[m5.length - 1];
    if (!sfpBar) return;
    const currentPrice = sfpBar.close;

    const isLongSFP  = sfpBar.low  < PWL && sfpBar.close > PWL;
    const isShortSFP = sfpBar.high > PWH && sfpBar.close < PWH;
    if (!isLongSFP && !isShortSFP) return;

    for (const direction of ['long', 'short']) {
      if (direction === 'long'  && !isLongSFP)  continue;
      if (direction === 'short' && !isShortSFP) continue;
      if (wasAlertedRecently(symbol, direction)) continue;

      const hasDivergence = checkDivergence(m5, direction);
      const location      = checkGSLocation(h1, direction, currentPrice);

      console.log(
        `[scanner] ★ SIGNAL ${symbol} ${direction.toUpperCase()} | ` +
        `location=${location || 'none'} | div=${hasDivergence} | ` +
        `PWH=${PWH.toFixed(4)} PWL=${PWL.toFixed(4)} | ` +
        `bar: H=${sfpBar.high} L=${sfpBar.low} C=${sfpBar.close}`
      );

      await sendTelegram(buildAlert(symbol, direction, location, hasDivergence));
      markAlerted(symbol, direction);
    }
  } catch (err) {
    console.error(`[scanner] detectSFP ${symbol}: ${err.message}`);
  }
}

// ── WebSocket send helper ─────────────────────────────────────────────────────
function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ── Subscribe / unsubscribe klines ────────────────────────────────────────────
function subscribeSymbols(symbols) {
  for (const symbol of symbols) {
    wsSend({ method: 'sub.kline', param: { symbol, interval: 'Min5'  } });
    wsSend({ method: 'sub.kline', param: { symbol, interval: 'Min60' } });
  }
  console.log(`[scanner] Subscribed klines for ${symbols.length} coins (5m + 1H)`);
}

function unsubscribeSymbols(symbols) {
  for (const symbol of symbols) {
    wsSend({ method: 'unsub.kline', param: { symbol, interval: 'Min5'  } });
    wsSend({ method: 'unsub.kline', param: { symbol, interval: 'Min60' } });
  }
}

// ── Incoming WS message handler ───────────────────────────────────────────────
function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  const { channel, symbol, data } = msg;

  if (channel === 'pong') return; // heartbeat ACK

  if (channel === 'push.kline') {
    if (!symbol || !data) return;

    const interval = data.interval;
    if (interval !== 'Min5' && interval !== 'Min60') return;

    const t   = data.t;   // candle open timestamp (seconds)
    const key = `${symbol}:${interval}`;
    const lastT = lastWsTs.get(key);

    // ── Candle close detected: timestamp changed ──────────────────────────────
    // When a NEW candle opens (t !== lastT), the PREVIOUS candle is finalized.
    // We use the last WS data received for that previous candle timestamp.
    if (lastT !== undefined && t !== lastT) {
      const prev = pendingBar.get(key);
      if (prev) {
        const closedBar = {
          time:  lastT,
          open:  parseFloat(prev.o),
          high:  parseFloat(prev.h),
          low:   parseFloat(prev.l),
          close: parseFloat(prev.c),
          vol:   parseFloat(prev.v || 0),
        };

        if (isFinite(closedBar.close) && closedBar.close > 0) {
          pushBarToBuffer(symbol, interval, closedBar);

          if (interval === 'Min5') {
            candleCloseCount++;
            if (candleCloseCount % 100 === 0) {
              console.log(`[scanner] ✓ ${candleCloseCount} candle closes processed (latest: ${symbol})`);
            }
            detectSFP(symbol).catch(err =>
              console.error(`[scanner] detectSFP ${symbol}: ${err.message}`)
            );
          }
        }
      }
    }

    // Store forming candle data and current timestamp
    pendingBar.set(key, data);
    lastWsTs.set(key, t);
  }
}

// ── WebSocket connection ──────────────────────────────────────────────────────
function connect() {
  if (shuttingDown) return;
  console.log(`[scanner] Connecting WebSocket → ${WS_URL}`);

  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('[scanner] WebSocket connected');
    reconnectDelay = RECONNECT_BASE_MS; // reset backoff on successful connect

    // Start ping timer
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      wsSend({ method: 'ping' });
    }, PING_INTERVAL_MS);

    // Re-subscribe to all current top symbols
    subscribeSymbols(topSymbols);
  });

  ws.on('message', (raw) => {
    try {
      handleMessage(raw.toString());
    } catch (err) {
      console.error('[scanner] handleMessage error:', err.message);
    }
  });

  ws.on('close', (code, reason) => {
    clearInterval(pingTimer);
    disconnectedAt = Date.now();
    if (!shuttingDown) {
      console.warn(`[scanner] WebSocket closed (${code}). Reconnecting in ${reconnectDelay / 1000}s...`);
      scheduleReconnect();
    }
  });

  ws.on('error', (err) => {
    console.error(`[scanner] WebSocket error: ${err.message}`);
    // 'close' event fires after 'error', so reconnect is handled there
  });
}

function scheduleReconnect() {
  if (shuttingDown) return;
  setTimeout(async () => {
    const downtime = Date.now() - disconnectedAt;

    // If disconnected > 10 min, re-bootstrap kline history to fill the gap
    if (downtime > 10 * 60 * 1000) {
      console.log(`[scanner] Disconnected for ${Math.round(downtime / 60000)}min — re-bootstrapping klines`);
      try {
        await bootstrapKlines(topSymbols);
      } catch (err) {
        console.error(`[scanner] Re-bootstrap failed: ${err.message}`);
      }
    }

    connect();

    // Increase backoff for next failure (exponential, capped at max)
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  }, reconnectDelay);
}

// ── Top-50 volume refresh (every 6h) ─────────────────────────────────────────
async function refreshTopSymbols() {
  try {
    const newTop = await fetchTopSymbols();

    const added   = newTop.filter(s => !topSymbols.includes(s));
    const removed = topSymbols.filter(s => !newTop.includes(s));

    if (added.length || removed.length) {
      console.log(`[scanner] Top-50 refresh: +${added.length} added, -${removed.length} removed`);

      // Unsubscribe dropped coins
      if (removed.length) unsubscribeSymbols(removed);

      // Bootstrap + subscribe new coins
      if (added.length) {
        await bootstrapKlines(added);
        subscribeSymbols(added);
      }

      topSymbols = newTop;
    } else {
      console.log('[scanner] Top-50 refresh: no changes');
    }
  } catch (err) {
    console.error(`[scanner] refreshTopSymbols failed: ${err.message}`);
  }
}

// ── Export ────────────────────────────────────────────────────────────────────
export async function startScanner() {
  console.log('[scanner] ── WebSocket SFP Scanner starting ──');
  console.log('[scanner] Architecture: 1 WS connection | REST for bootstrap only | 0 REST polling');

  // Safety net for any unexpected async errors
  process.on('unhandledRejection', (reason) => {
    console.error('[scanner] Unhandled rejection:', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[scanner] Uncaught exception:', err.message);
  });

  // ── Step 1: Bootstrap via REST ────────────────────────────────────────────
  try {
    topSymbols = await fetchTopSymbols();
    await bootstrapKlines(topSymbols);
  } catch (err) {
    console.error('[scanner] Bootstrap failed — scanner will retry on WS reconnect:', err.message);
    topSymbols = topSymbols.length ? topSymbols : []; // keep whatever we had
  }

  // ── Step 2: Open WebSocket connection ─────────────────────────────────────
  connect();

  // ── Step 3: Schedule 6h top-50 refresh ────────────────────────────────────
  setInterval(refreshTopSymbols, VOLUME_REFRESH_MS);

  console.log('[scanner] Scanner armed — listening for candle closes via WebSocket');
}
