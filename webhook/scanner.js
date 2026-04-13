/**
 * WebSocket SFP Scanner — MEXC Perpetual Futures
 *
 * CTA General Setup (3 reasons in order):
 *   1. LOCATION  — price is at a key level (PWH/PWL/PMH/PML/Monday H-L/Daily-Weekly Open)
 *   2. STRUCTURE — W pattern (long) or M pattern (short) confirmed on 5m
 *   3. MOMENTUM  — divergence: OBV, RSI, MACD histogram
 *
 * Signal rank 1–16 (unique per confluence combination):
 *   rank = 1 + (hasLocation<<3 | hasOBV<<2 | hasRSI<<1 | hasMACD)
 *
 * Key levels refreshed every 1h via REST (no lookahead):
 *   PWH / PWL        = last COMPLETED week high / low
 *   PMH / PML        = last COMPLETED month high / low
 *   Monday High/Low  = last Monday daily bar
 *   Weekly Open      = current week open (forming weekly bar)
 *   Daily Open       = current day open  (forming daily bar)
 */

import WebSocket from 'ws';

// ── Constants ──────────────────────────────────────────────────────────────────
const WS_URL            = 'wss://contract.mexc.com/edge';
const REST_BASE         = 'https://contract.mexc.com';
const TELEGRAM_API      = 'https://api.telegram.org';

const PING_INTERVAL_MS  = 15_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS  = 60_000;
const VOLUME_REFRESH_MS = 60 * 60 * 1000;      // 1h
const LEVEL_REFRESH_MS  = 60 * 60 * 1000;      // 1h (staggered 30min after volume)
const ALERT_RESET_MS    = 4 * 60 * 60 * 1000;  // 4h dedup window

const TOP_N           = 250;
const MIN_VOLUME_USDT = 5_000_000;              // 5M USDT 24h

const BOOTSTRAP_5M  = 100;
const BOOTSTRAP_1H  = 500;   // ~20 days of 1H bars
const BOOTSTRAP_D1  = 14;    // 14 daily bars — enough to find last Monday
const BOOTSTRAP_W1  = 4;     // 3 completed weeks + forming
const BOOTSTRAP_MO  = 4;     // 3 completed months + forming
const BUFFER_MAX_5M = 150;
const BUFFER_MAX_1H = 550;

// ── State ──────────────────────────────────────────────────────────────────────
let ws             = null;
let pingTimer      = null;
let reconnectDelay = RECONNECT_BASE_MS;
let disconnectedAt = 0;
let shuttingDown   = false;

// Bar = { time, open, high, low, close, vol }
const klineBuffers = new Map();   // symbol → { m5: Bar[], h1: Bar[] }
const levelCache   = new Map();   // symbol → Levels object
const lastWsTs     = new Map();   // "SYMBOL:Min5" → epochSeconds
const pendingBar   = new Map();   // "SYMBOL:Min5" → forming bar data from WS
let   topSymbols   = [];
const alerted      = new Map();   // "SYMBOL:long" | "SYMBOL:short" → timestamp

let candleCloseCount = 0;

// ── Misc helpers ───────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function wasAlertedRecently(symbol, direction) {
  const ts = alerted.get(`${symbol}:${direction}`);
  return ts != null && Date.now() - ts < ALERT_RESET_MS;
}
function markAlerted(symbol, direction) {
  alerted.set(`${symbol}:${direction}`, Date.now());
}

// ── REST ───────────────────────────────────────────────────────────────────────
async function restGet(path) {
  const res = await fetch(`${REST_BASE}${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`REST ${path}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== 0 && json.code !== 200) {
    throw new Error(`REST ${path}: code ${json.code} — ${json.message || ''}`);
  }
  return json.data;
}

// ── Kline parser ───────────────────────────────────────────────────────────────
// excludeLast=true  → skip the forming (still-open) bar — use for history
// excludeLast=false → include it — use to get the forming bar's open price
function parseKlines(d, excludeLast = true) {
  if (!d || !Array.isArray(d.time) || !d.time.length) return [];
  const end = excludeLast ? d.time.length - 1 : d.time.length;
  return Array.from({ length: end }, (_, i) => ({
    time:  d.time[i],
    open:  parseFloat(d.open[i]),
    high:  parseFloat(d.high[i]),
    low:   parseFloat(d.low[i]),
    close: parseFloat(d.close[i]),
    vol:   parseFloat((d.vol || [])[i] || 0),
  }));
}

// ── Key level computation ─────────────────────────────────────────────────────
// Priority order for level matching (highest priority first)
const LEVEL_PRIORITY = ['PML', 'PMH', 'PWL', 'PWH', 'mondayLow', 'mondayHigh', 'weeklyOpen', 'dailyOpen'];

const LEVEL_DISPLAY = {
  PWH:        'PWH',
  PWL:        'PWL',
  PMH:        'PMH (Monthly)',
  PML:        'PML (Monthly)',
  mondayHigh: 'Monday High',
  mondayLow:  'Monday Low',
  weeklyOpen: 'Weekly Open',
  dailyOpen:  'Daily Open',
};

function computeLevels(d1Comp, d1Forming, w1Comp, w1Forming, moComp) {
  const lastWeek   = w1Comp.at(-1)  ?? null;   // last COMPLETED week bar
  const lastMonth  = moComp.at(-1)  ?? null;   // last COMPLETED month bar

  // Find the most recent Monday in completed daily bars
  const mondays    = d1Comp.filter(b => new Date(b.time * 1000).getUTCDay() === 1);
  const lastMonday = mondays.at(-1) ?? null;

  return {
    PWH:        lastWeek?.high   ?? null,
    PWL:        lastWeek?.low    ?? null,
    PMH:        lastMonth?.high  ?? null,
    PML:        lastMonth?.low   ?? null,
    mondayHigh: lastMonday?.high ?? null,
    mondayLow:  lastMonday?.low  ?? null,
    weeklyOpen: w1Forming?.open  ?? null,   // current (forming) week open
    dailyOpen:  d1Forming?.open  ?? null,   // current (forming) day open
  };
}

// ── Top-N selection ───────────────────────────────────────────────────────────
async function fetchTopSymbols() {
  console.log('[scanner] Selecting top symbols via REST...');
  const [detail, tickers] = await Promise.all([
    restGet('/api/v1/contract/detail'),
    restGet('/api/v1/contract/ticker'),
  ]);
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
  console.log(`[scanner] ${selected.length} symbols selected (≥${MIN_VOLUME_USDT / 1e6}M USDT)`);
  return selected;
}

// ── Bootstrap klines + levels ─────────────────────────────────────────────────
async function bootstrapKlines(symbols) {
  console.log(`[scanner] Bootstrapping klines + key levels for ${symbols.length} symbols...`);
  let ok = 0;
  for (const symbol of symbols) {
    try {
      const [raw5m, raw1h, rawD1, rawW1, rawMo] = await Promise.all([
        restGet(`/api/v1/contract/kline/${symbol}?interval=Min5&limit=${BOOTSTRAP_5M}`),
        restGet(`/api/v1/contract/kline/${symbol}?interval=Min60&limit=${BOOTSTRAP_1H}`),
        restGet(`/api/v1/contract/kline/${symbol}?interval=Day1&limit=${BOOTSTRAP_D1}`),
        restGet(`/api/v1/contract/kline/${symbol}?interval=Week1&limit=${BOOTSTRAP_W1}`),
        restGet(`/api/v1/contract/kline/${symbol}?interval=Month1&limit=${BOOTSTRAP_MO}`),
      ]);

      klineBuffers.set(symbol, {
        m5: parseKlines(raw5m),
        h1: parseKlines(raw1h),
      });

      // Completed bars (exclude forming) + the forming bar's open for daily/weekly open levels
      const d1Comp    = parseKlines(rawD1, true);
      const d1Forming = parseKlines(rawD1, false).at(-1) ?? null;
      const w1Comp    = parseKlines(rawW1, true);
      const w1Forming = parseKlines(rawW1, false).at(-1) ?? null;
      const moComp    = parseKlines(rawMo, true);

      levelCache.set(symbol, computeLevels(d1Comp, d1Forming, w1Comp, w1Forming, moComp));
      ok++;
    } catch (err) {
      console.error(`[scanner] Bootstrap ${symbol}: ${err.message}`);
      klineBuffers.set(symbol, { m5: [], h1: [] });
      levelCache.set(symbol, {});
    }
    await sleep(400);   // ~2.5 symbols/s — safely under MEXC 20 req/s limit
  }
  console.log(`[scanner] Bootstrap done: ${ok}/${symbols.length} symbols`);
}

// ── Level refresh (every 1h) ──────────────────────────────────────────────────
async function refreshLevels() {
  console.log('[scanner] Refreshing key levels...');
  let ok = 0;
  for (const symbol of topSymbols) {
    try {
      const [rawD1, rawW1, rawMo] = await Promise.all([
        restGet(`/api/v1/contract/kline/${symbol}?interval=Day1&limit=${BOOTSTRAP_D1}`),
        restGet(`/api/v1/contract/kline/${symbol}?interval=Week1&limit=${BOOTSTRAP_W1}`),
        restGet(`/api/v1/contract/kline/${symbol}?interval=Month1&limit=${BOOTSTRAP_MO}`),
      ]);
      const d1Comp    = parseKlines(rawD1, true);
      const d1Forming = parseKlines(rawD1, false).at(-1) ?? null;
      const w1Comp    = parseKlines(rawW1, true);
      const w1Forming = parseKlines(rawW1, false).at(-1) ?? null;
      const moComp    = parseKlines(rawMo, true);
      levelCache.set(symbol, computeLevels(d1Comp, d1Forming, w1Comp, w1Forming, moComp));
      ok++;
    } catch (err) {
      console.error(`[scanner] Level refresh ${symbol}: ${err.message}`);
    }
    await sleep(300);
  }
  console.log(`[scanner] Level refresh done: ${ok}/${topSymbols.length}`);
}

// ── Buffer update ─────────────────────────────────────────────────────────────
function pushBarToBuffer(symbol, interval, bar) {
  const buf = klineBuffers.get(symbol);
  if (!buf) return;
  const arr = interval === 'Min5' ? buf.m5 : buf.h1;
  const max = interval === 'Min5' ? BUFFER_MAX_5M : BUFFER_MAX_1H;
  arr.push(bar);
  if (arr.length > max) arr.shift();
}

// ── W / M structure detection ─────────────────────────────────────────────────
// W (long SFP): within the last 4 bars a candle wicked BELOW level,
//               current bar closes ABOVE level AND above that sweep bar's close.
// Minimum 3 candles: bars before sweep + sweep wick + current close above.
function detectWPattern(bars5m, level) {
  if (bars5m.length < 5) return false;
  const last = bars5m.at(-1);
  if (last.close <= level) return false;
  for (const sweepBar of bars5m.slice(-5, -1)) {
    if (sweepBar.low < level && last.close > sweepBar.close) return true;
  }
  return false;
}

// M (short SFP): within the last 4 bars a candle wicked ABOVE level,
//                current bar closes BELOW level AND below that sweep bar's close.
function detectMPattern(bars5m, level) {
  if (bars5m.length < 5) return false;
  const last = bars5m.at(-1);
  if (last.close >= level) return false;
  for (const sweepBar of bars5m.slice(-5, -1)) {
    if (sweepBar.high > level && last.close < sweepBar.close) return true;
  }
  return false;
}

// Returns highest-priority level that was swept, or null.
function findSweepLevel(bars5m, levels, direction) {
  for (const key of LEVEL_PRIORITY) {
    const price = levels[key];
    if (price == null || !isFinite(price) || price <= 0) continue;
    if (direction === 'long'  && detectWPattern(bars5m, price)) return { key, price };
    if (direction === 'short' && detectMPattern(bars5m, price)) return { key, price };
  }
  return null;
}

// ── RSI (Wilder smoothing, period 14) ────────────────────────────────────────
function calcRSI(closes, period = 14) {
  const rsi = new Array(period).fill(NaN);
  if (closes.length <= period) return rsi;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    gainSum += Math.max(0, d);
    lossSum += Math.max(0, -d);
  }
  let avgGain = gainSum / period, avgLoss = lossSum / period;
  rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, d))  / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
    rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return rsi;
}

// ── OBV ───────────────────────────────────────────────────────────────────────
function calcOBV(bars) {
  const obv = [0];
  for (let i = 1; i < bars.length; i++) {
    const prev = obv[i - 1];
    if      (bars[i].close > bars[i - 1].close) obv.push(prev + bars[i].vol);
    else if (bars[i].close < bars[i - 1].close) obv.push(prev - bars[i].vol);
    else                                          obv.push(prev);
  }
  return obv;
}

// ── MACD histogram (12/26/9) ──────────────────────────────────────────────────
function calcEMA(data, period) {
  if (!data.length) return [];
  const k = 2 / (period + 1);
  const ema = [data[0]];
  for (let i = 1; i < data.length; i++) ema.push(data[i] * k + ema[i - 1] * (1 - k));
  return ema;
}

function calcMACDHistogram(closes, fast = 12, slow = 26, signal = 9) {
  // Return NaN-filled array if not enough data so divergence check fails cleanly
  if (closes.length < slow + signal) return new Array(closes.length).fill(NaN);
  const emaFast    = calcEMA(closes, fast);
  const emaSlow    = calcEMA(closes, slow);
  const macdLine   = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = calcEMA(macdLine, signal);
  return macdLine.map((v, i) => v - signalLine[i]);
}

// ── Generic divergence (price pivots vs indicator values, lookback 5) ──────────
// Bull: price makes lower low, indicator makes higher low
// Bear: price makes higher high, indicator makes lower high
function checkDivergence(closes, indicatorValues, direction) {
  const lookback = 5;
  const highs = [], lows = [];
  for (let i = lookback; i < closes.length - lookback; i++) {
    let isH = true, isL = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (closes[j] >= closes[i]) isH = false;
      if (closes[j] <= closes[i]) isL = false;
    }
    if (isH) highs.push(i);
    if (isL)  lows.push(i);
  }

  if (direction === 'short') {
    const [i1, i2] = highs.slice(-2);
    if (i1 == null || i2 == null) return false;
    const v1 = indicatorValues[i1], v2 = indicatorValues[i2];
    if (!isFinite(v1) || !isFinite(v2)) return false;
    return closes[i2] > closes[i1] && v2 < v1;   // HH price, LH indicator = bearish div
  } else {
    const [i1, i2] = lows.slice(-2);
    if (i1 == null || i2 == null) return false;
    const v1 = indicatorValues[i1], v2 = indicatorValues[i2];
    if (!isFinite(v1) || !isFinite(v2)) return false;
    return closes[i2] < closes[i1] && v2 > v1;   // LL price, HL indicator = bullish div
  }
}

function checkRSIDivergence(bars5m, direction) {
  const closes = bars5m.map(b => b.close);
  return checkDivergence(closes, calcRSI(closes), direction);
}

function checkOBVDivergence(bars5m, direction) {
  return checkDivergence(bars5m.map(b => b.close), calcOBV(bars5m), direction);
}

function checkMACDDivergence(bars5m, direction) {
  const closes = bars5m.map(b => b.close);
  return checkDivergence(closes, calcMACDHistogram(closes), direction);
}

// ── GS Location — 1H fib zone check ──────────────────────────────────────────
function findBarPivots(bars, lookback = 5) {
  const highs = [], lows = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isHigh = false;
      if (bars[j].low  <= bars[i].low)  isLow  = false;
    }
    if (isHigh) highs.push({ index: i, price: bars[i].high });
    if (isLow)   lows.push({ index: i, price: bars[i].low  });
  }
  return { highs, lows };
}

function checkGSLocation(bars1h, direction, currentPrice) {
  const recent = bars1h.slice(-50);
  if (recent.length < 20) return null;
  const { highs, lows } = findBarPivots(recent, 5);
  if (!highs.length || !lows.length) return null;
  const swingHigh = highs.at(-1).price;
  const swingLow  = lows.at(-1).price;
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

// ── Scoring ───────────────────────────────────────────────────────────────────
// rank = 1 + (hasLocation<<3 | hasOBV<<2 | hasRSI<<1 | hasMACD)
// This produces the exact 16-entry table from the spec without a lookup table.
function calcRank(hasLocation, hasOBV, hasRSI, hasMACD) {
  return 1 + ((hasLocation ? 8 : 0) | (hasOBV ? 4 : 0) | (hasRSI ? 2 : 0) | (hasMACD ? 1 : 0));
}

function rankEmoji(rank) {
  if (rank <= 4)  return '⚡';
  if (rank <= 8)  return '🎯';
  if (rank <= 12) return '🔥';
  if (rank <= 15) return '💎';
  return '💎💎';
}

// ── Alert builder ─────────────────────────────────────────────────────────────
function buildAlert(symbol, direction, levelKey, rank, hasLocation, locZone, hasOBV, hasRSI, hasMACD) {
  const coin  = symbol.replace('_USDT', 'USDT');
  const dir   = direction === 'long' ? 'LONG' : 'SHORT';
  const emoji = rankEmoji(rank);
  const time  = new Date().toISOString().slice(11, 16) + ' UTC';
  const swept = direction === 'long' ? 'swept (W structure confirmed)' : 'swept (M structure confirmed)';
  const locStr = hasLocation ? `${locZone} ✅` : '❌';

  return [
    `${emoji} <b>${coin} ${dir} ${rank}/16</b>`,
    `Level: ${LEVEL_DISPLAY[levelKey] || levelKey} ${swept}`,
    `Location: ${locStr} | OBV: ${hasOBV ? '✅' : '❌'} | RSI: ${hasRSI ? '✅' : '❌'} | MACD: ${hasMACD ? '✅' : '❌'}`,
    `Time: ${time}`,
  ].join('\n');
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

// ── Signal detection (runs on each 5m candle close) ───────────────────────────
async function detectSFP(symbol) {
  try {
    const buf = klineBuffers.get(symbol);
    if (!buf) return;
    const { m5, h1 } = buf;
    if (m5.length < 30 || h1.length < 50) return;

    const levels = levelCache.get(symbol);
    if (!levels || !Object.values(levels).some(v => v != null)) return;

    for (const direction of ['long', 'short']) {
      if (wasAlertedRecently(symbol, direction)) continue;

      // Step 1: STRUCTURE — W or M pattern at a key level
      const match = findSweepLevel(m5, levels, direction);
      if (!match) continue;

      const { key: levelKey } = match;
      const currentPrice = m5.at(-1).close;

      // Step 2: LOCATION — 1H fib zone
      const locZone     = checkGSLocation(h1, direction, currentPrice);
      const hasLocation = locZone != null;

      // Step 3: MOMENTUM — divergence on 5m
      const hasOBV  = checkOBVDivergence(m5, direction);
      const hasRSI  = checkRSIDivergence(m5, direction);
      const hasMACD = checkMACDDivergence(m5, direction);

      const rank = calcRank(hasLocation, hasOBV, hasRSI, hasMACD);

      console.log(
        `[scanner] ★ ${symbol} ${direction.toUpperCase()} ${rank}/16 | ` +
        `level=${levelKey} | loc=${locZone || 'none'} | OBV=${hasOBV} RSI=${hasRSI} MACD=${hasMACD}`
      );

      await sendTelegram(buildAlert(symbol, direction, levelKey, rank, hasLocation, locZone, hasOBV, hasRSI, hasMACD));
      markAlerted(symbol, direction);
    }
  } catch (err) {
    console.error(`[scanner] detectSFP ${symbol}: ${err.message}`);
  }
}

// ── WebSocket helpers ─────────────────────────────────────────────────────────
function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function subscribeSymbols(symbols) {
  for (const symbol of symbols) {
    wsSend({ method: 'sub.kline', param: { symbol, interval: 'Min5'  } });
    wsSend({ method: 'sub.kline', param: { symbol, interval: 'Min60' } });
  }
  console.log(`[scanner] Subscribed klines for ${symbols.length} symbols (5m + 1H)`);
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
  try { msg = JSON.parse(raw); } catch { return; }

  const { channel, symbol, data } = msg;
  if (channel === 'pong') return;

  if (channel === 'push.kline') {
    if (!symbol || !data) return;
    const interval = data.interval;
    if (interval !== 'Min5' && interval !== 'Min60') return;

    const t    = data.t;
    const key  = `${symbol}:${interval}`;
    const lastT = lastWsTs.get(key);

    // New timestamp → previous candle is now closed
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
    reconnectDelay = RECONNECT_BASE_MS;
    clearInterval(pingTimer);
    pingTimer = setInterval(() => wsSend({ method: 'ping' }), PING_INTERVAL_MS);
    subscribeSymbols(topSymbols);
  });

  ws.on('message', (raw) => {
    try { handleMessage(raw.toString()); } catch (err) {
      console.error('[scanner] handleMessage error:', err.message);
    }
  });

  ws.on('close', (code) => {
    clearInterval(pingTimer);
    disconnectedAt = Date.now();
    if (!shuttingDown) {
      console.warn(`[scanner] WebSocket closed (${code}). Reconnecting in ${reconnectDelay / 1000}s...`);
      scheduleReconnect();
    }
  });

  ws.on('error', (err) => {
    console.error(`[scanner] WebSocket error: ${err.message}`);
  });
}

function scheduleReconnect() {
  if (shuttingDown) return;
  setTimeout(async () => {
    const downtime = Date.now() - disconnectedAt;
    if (downtime > 10 * 60 * 1000) {
      console.log(`[scanner] Disconnected ${Math.round(downtime / 60000)}min — re-bootstrapping klines`);
      try { await bootstrapKlines(topSymbols); } catch (err) {
        console.error(`[scanner] Re-bootstrap failed: ${err.message}`);
      }
    }
    connect();
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  }, reconnectDelay);
}

// ── Volume refresh (every 1h) ─────────────────────────────────────────────────
async function refreshTopSymbols() {
  try {
    const newTop  = await fetchTopSymbols();
    const added   = newTop.filter(s => !topSymbols.includes(s));
    const removed = topSymbols.filter(s => !newTop.includes(s));

    if (added.length || removed.length) {
      console.log(`[scanner] Top refresh: +${added.length} added, -${removed.length} removed`);
      if (removed.length) unsubscribeSymbols(removed);
      if (added.length) {
        await bootstrapKlines(added);
        subscribeSymbols(added);
      }
      topSymbols = newTop;
    } else {
      console.log('[scanner] Top refresh: no changes');
    }
  } catch (err) {
    console.error(`[scanner] refreshTopSymbols failed: ${err.message}`);
  }
}

// ── Export ────────────────────────────────────────────────────────────────────
export async function startScanner() {
  console.log('[scanner] ── CTA SFP Scanner starting ──');
  console.log('[scanner] Setup: Location (key levels) → Structure (W/M) → Momentum (OBV + RSI + MACD)');
  console.log('[scanner] Rank formula: 1 + (loc<<3 | obv<<2 | rsi<<1 | macd)  →  1/16 to 16/16');

  process.on('unhandledRejection', (reason) => console.error('[scanner] Unhandled rejection:', reason));
  process.on('uncaughtException',  (err)    => console.error('[scanner] Uncaught exception:',  err.message));

  // Step 1: Bootstrap via REST
  try {
    topSymbols = await fetchTopSymbols();
    await bootstrapKlines(topSymbols);
  } catch (err) {
    console.error('[scanner] Bootstrap failed — will retry on WS reconnect:', err.message);
    topSymbols = topSymbols.length ? topSymbols : [];
  }

  // Step 2: Open WebSocket
  connect();

  // Step 3: Hourly volume refresh
  setInterval(refreshTopSymbols, VOLUME_REFRESH_MS);

  // Step 4: Hourly level refresh — staggered 30min after volume refresh
  setTimeout(() => {
    setInterval(refreshLevels, LEVEL_REFRESH_MS);
  }, 30 * 60 * 1000);

  console.log('[scanner] Scanner armed — listening for W/M patterns via WebSocket');
}
