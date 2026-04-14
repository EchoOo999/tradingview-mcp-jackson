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

// ── Debug ──────────────────────────────────────────────────────────────────────
// Temporary verbose logging for one coin. Remove when done debugging.
const DEBUG_SYMBOL = 'BTC_USDT';

// ── Constants ──────────────────────────────────────────────────────────────────
const WS_URL            = 'wss://contract.mexc.com/edge';
const REST_BASE         = 'https://contract.mexc.com';
const TELEGRAM_API      = 'https://api.telegram.org';

const PING_INTERVAL_MS  = 15_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS  = 60_000;
const VOLUME_REFRESH_MS = 60 * 60 * 1000;      // 1h
const LEVEL_REFRESH_MS  = 60 * 60 * 1000;      // 1h (staggered 30min after volume)
const ALERT_RESET_MS     = 4 * 60 * 60 * 1000;  // 4h dedup window (SFP)
const ALERT_RESET_SFU_MS = 8 * 60 * 60 * 1000;  // 8h dedup window (SFU)

const TOP_N           = 250;
const MIN_VOLUME_USDT = 5_000_000;              // 5M USDT 24h

const BOOTSTRAP_5M  = 100;
const BOOTSTRAP_1H  = 500;   // ~20 days of 1H bars
const BOOTSTRAP_4H  = 100;   // ~16 days of 4H bars
const BOOTSTRAP_D1  = 100;   // 100 daily bars — key levels + SFU level detection
const BOOTSTRAP_W1  = 4;     // 3 completed weeks + forming
const BOOTSTRAP_MO  = 4;     // 3 completed months + forming
const BUFFER_MAX_5M = 150;
const BUFFER_MAX_1H = 550;
const BUFFER_MAX_4H = 110;
const BUFFER_MAX_1D = 110;

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
const alertedSFU   = new Map();   // "SYMBOL:long" | "SYMBOL:short" → timestamp (SFU dedup)

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
function wasAlertedSFURecently(symbol, direction) {
  const ts = alertedSFU.get(`${symbol}:${direction}`);
  return ts != null && Date.now() - ts < ALERT_RESET_SFU_MS;
}
function markAlertedSFU(symbol, direction) {
  alertedSFU.set(`${symbol}:${direction}`, Date.now());
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
// W pattern (LONG)  only fires at support levels (below price).
// M pattern (SHORT) only fires at resistance levels (above price).
// Session levels are computed live from the H1 buffer — not stored in levelCache.
const LONG_LEVELS  = ['PML', 'PWL', 'mondayLow',  'weeklyOpen', 'londonLow',  'asiaLow'];
const SHORT_LEVELS = ['PMH', 'PWH', 'mondayHigh', 'weeklyOpen', 'londonHigh', 'asiaHigh'];

const LEVEL_DISPLAY = {
  PWH:        'PWH',
  PWL:        'PWL',
  PMH:        'PMH (Monthly)',
  PML:        'PML (Monthly)',
  mondayHigh: 'Monday High',
  mondayLow:  'Monday Low',
  weeklyOpen: 'Weekly Open',
  asiaHigh:   'Asia High',
  asiaLow:    'Asia Low',
  londonHigh: 'London High',
  londonLow:  'London Low',
};

function computeLevels(d1Comp, w1Comp, w1Forming, moComp) {
  const lastWeek   = w1Comp.at(-1) ?? null;   // last COMPLETED week bar
  const lastMonth  = moComp.at(-1) ?? null;   // last COMPLETED month bar

  // Monday bar valid only when its full 24h window has passed.
  const nowSec     = Date.now() / 1000;
  const mondays    = d1Comp.filter(b =>
    new Date(b.time * 1000).getUTCDay() === 1 &&
    (b.time + 86400) < nowSec
  );
  const lastMonday = mondays.at(-1) ?? null;

  return {
    PWH:        lastWeek?.high   ?? null,
    PWL:        lastWeek?.low    ?? null,
    PMH:        lastMonth?.high  ?? null,
    PML:        lastMonth?.low   ?? null,
    mondayHigh: lastMonday?.high ?? null,
    mondayLow:  lastMonday?.low  ?? null,
    weeklyOpen: (new Date().getUTCDay() !== 1 ? w1Forming?.open : null) ?? null,
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
      const [raw5m, raw1h, raw4h, rawD1, rawW1, rawMo] = await Promise.all([
        restGet(`/api/v1/contract/kline/${symbol}?interval=Min5&limit=${BOOTSTRAP_5M}`),
        restGet(`/api/v1/contract/kline/${symbol}?interval=Min60&limit=${BOOTSTRAP_1H}`),
        restGet(`/api/v1/contract/kline/${symbol}?interval=Hour4&limit=${BOOTSTRAP_4H}`),
        restGet(`/api/v1/contract/kline/${symbol}?interval=Day1&limit=${BOOTSTRAP_D1}`),
        restGet(`/api/v1/contract/kline/${symbol}?interval=Week1&limit=${BOOTSTRAP_W1}`),
        restGet(`/api/v1/contract/kline/${symbol}?interval=Month1&limit=${BOOTSTRAP_MO}`),
      ]);

      const d1Comp    = parseKlines(rawD1, true);
      klineBuffers.set(symbol, {
        m5: parseKlines(raw5m),
        h1: parseKlines(raw1h),
        h4: parseKlines(raw4h),
        d1: d1Comp,
      });
      const w1Comp    = parseKlines(rawW1, true);
      const w1Forming = parseKlines(rawW1, false).at(-1) ?? null;
      const moComp    = parseKlines(rawMo, true);

      levelCache.set(symbol, computeLevels(d1Comp, w1Comp, w1Forming, moComp));
      ok++;
    } catch (err) {
      console.error(`[scanner] Bootstrap ${symbol}: ${err.message}`);
      klineBuffers.set(symbol, { m5: [], h1: [], h4: [], d1: [] });
      levelCache.set(symbol, {});
    }
    await sleep(800);   // ~1.25 symbols/s — back off to avoid MEXC rate limit (code 510)
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
      const w1Comp    = parseKlines(rawW1, true);
      const w1Forming = parseKlines(rawW1, false).at(-1) ?? null;
      const moComp    = parseKlines(rawMo, true);
      levelCache.set(symbol, computeLevels(d1Comp, w1Comp, w1Forming, moComp));
      // Also refresh d1 klineBuffer (used for SFU level detection)
      const buf = klineBuffers.get(symbol);
      if (buf) buf.d1 = d1Comp;
      // TEMPORARY: log sig pivot count per coin (WING=8 on 1H)
      const h1Buf = buf?.h1 ?? [];
      const { nHighs, nLows } = countSigPivots1H(h1Buf);
      if (nHighs < 2 || nLows < 2) {
        console.log(`[DEBUG-PIVOTS] ${symbol}: 1H sig pivots: ${nHighs} highs, ${nLows} lows — GS Location DISABLED (need ≥2 each)`);
      } else if (symbol === DEBUG_SYMBOL) {
        console.log(`[DEBUG-PIVOTS] ${symbol}: 1H sig pivots: ${nHighs} highs, ${nLows} lows ✓`);
      }
      ok++;
    } catch (err) {
      console.error(`[scanner] Level refresh ${symbol}: ${err.message}`);
    }
    await sleep(600);
  }
  console.log(`[scanner] Level refresh done: ${ok}/${topSymbols.length}`);
}

// ── Buffer update ─────────────────────────────────────────────────────────────
function pushBarToBuffer(symbol, interval, bar) {
  const buf = klineBuffers.get(symbol);
  if (!buf) return;
  let arr, max;
  if      (interval === 'Min5')   { arr = buf.m5; max = BUFFER_MAX_5M; }
  else if (interval === 'Min60')  { arr = buf.h1; max = BUFFER_MAX_1H; }
  else if (interval === 'Hour4')  { arr = buf.h4; max = BUFFER_MAX_4H; }
  else if (interval === 'Day1')   { arr = buf.d1; max = BUFFER_MAX_1D; }
  else return;
  if (!arr) return;
  arr.push(bar);
  if (arr.length > max) arr.shift();
}

// ── Debug helpers (TEMPORARY) ─────────────────────────────────────────────────

// Returns a human-readable reason why the W pattern failed for a given level.
function debugWhyWFailed(bars5m, level) {
  if (bars5m.length < 5) return `not enough bars (${bars5m.length})`;
  const last = bars5m.at(-1);
  if (last.close <= level) return `close(${last.close.toPrecision(6)}) <= level(${level.toPrecision(6)}) — price not above level`;
  const searchBars = bars5m.slice(-5, -1);
  for (let i = 0; i < searchBars.length; i++) {
    const sweepBar = searchBars[i];
    if (sweepBar.low >= level) continue;
    if (last.close <= sweepBar.close) {
      return `sweep@i=${i} low=${sweepBar.low.toPrecision(6)}<level BUT close(${last.close.toPrecision(6)}) <= sweepClose(${sweepBar.close.toPrecision(6)}) — right leg too weak`;
    }
    const between = searchBars.slice(i + 1);
    if (between.length === 0) return `PASS — adjacent sweep, no neckline needed`;
    const neckline = Math.max(...between.map(b => b.high));
    if (last.close > neckline) return `PASS — close(${last.close.toPrecision(6)}) > neckline(${neckline.toPrecision(6)})`;
    return `sweep@i=${i} OK BUT close(${last.close.toPrecision(6)}) <= neckline(${neckline.toPrecision(6)}) — neckline break FAILED`;
  }
  return `no sweep bar with low < level(${level.toPrecision(6)}) in last 4 bars`;
}

// Returns a human-readable reason why the M pattern failed for a given level.
function debugWhyMFailed(bars5m, level) {
  if (bars5m.length < 5) return `not enough bars (${bars5m.length})`;
  const last = bars5m.at(-1);
  if (last.close >= level) return `close(${last.close.toPrecision(6)}) >= level(${level.toPrecision(6)}) — price not below level`;
  const searchBars = bars5m.slice(-5, -1);
  for (let i = 0; i < searchBars.length; i++) {
    const sweepBar = searchBars[i];
    if (sweepBar.high <= level) continue;
    if (last.close >= sweepBar.close) {
      return `sweep@i=${i} high=${sweepBar.high.toPrecision(6)}>level BUT close(${last.close.toPrecision(6)}) >= sweepClose(${sweepBar.close.toPrecision(6)}) — right leg too weak`;
    }
    const between = searchBars.slice(i + 1);
    if (between.length === 0) return `PASS — adjacent sweep, no neckline needed`;
    const neckline = Math.min(...between.map(b => b.low));
    if (last.close < neckline) return `PASS — close(${last.close.toPrecision(6)}) < neckline(${neckline.toPrecision(6)})`;
    return `sweep@i=${i} OK BUT close(${last.close.toPrecision(6)}) >= neckline(${neckline.toPrecision(6)}) — neckline break FAILED`;
  }
  return `no sweep bar with high > level(${level.toPrecision(6)}) in last 4 bars`;
}

// Returns a human-readable explanation of divergence check for a given indicator.
// Duplicates checkDivergence logic — debug only, does not affect production path.
function debugDivergenceDetail(closes, indicatorName, indicatorValues, direction, minDiffRatio = 0) {
  const WING = 5, MIN_AGO = 20, MAX_AGO = 60;
  const n = closes.length;
  const searchStart = Math.max(WING, n - MAX_AGO);
  const searchEnd   = n - MIN_AGO;
  if (searchEnd <= searchStart) return `${indicatorName}: insufficient window (n=${n}, need>${MIN_AGO + WING})`;

  const highs = [], lows = [];
  for (let i = searchStart; i < searchEnd; i++) {
    let isH = true, isL = true;
    for (let j = i - WING; j <= i + WING; j++) {
      if (j < 0 || j >= n || j === i) continue;
      if (closes[j] >= closes[i]) isH = false;
      if (closes[j] <= closes[i]) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) highs.push(i);
    if (isL)  lows.push(i);
  }

  const currentInd = indicatorValues.at(-1);
  if (!isFinite(currentInd)) return `${indicatorName}: currentInd=${currentInd} (NaN/Inf — not enough data?)`;

  if (direction === 'long') {
    if (lows.length < 2) return `${indicatorName}: only ${lows.length} swing low(s) in window [${searchStart}..${searchEnd}) — need 2`;
    const [i1, i2] = lows.slice(-2);
    const v1 = indicatorValues[i1], v2 = indicatorValues[i2];
    if (!isFinite(v1) || !isFinite(v2)) return `${indicatorName}: pivot indic values not finite (v1=${v1} v2=${v2})`;
    const priceDiv = closes[i2] < closes[i1];
    const indDiv   = v2 > v1;
    if (!priceDiv || !indDiv) {
      return `${indicatorName}: no div — price[i1]=${closes[i1].toPrecision(6)} price[i2]=${closes[i2].toPrecision(6)} (LL=${priceDiv}) | ind[i1]=${v1.toPrecision(4)} ind[i2]=${v2.toPrecision(4)} (HL=${indDiv})`;
    }
    if (minDiffRatio > 0) {
      const diff = Math.abs(v2 - v1) / Math.max(Math.abs(v1), Math.abs(v2), 1);
      if (diff < minDiffRatio) return `${indicatorName}: div found but diff too small (${(diff * 100).toFixed(2)}% < ${(minDiffRatio * 100).toFixed(2)}%)`;
    }
    const between  = indicatorValues.slice(i1, i2 + 1).filter(isFinite);
    const neckline = Math.max(...between);
    const pass = currentInd > neckline;
    return `${indicatorName}: div confirmed structurally ✓ | neckline=${neckline.toPrecision(4)} currentInd=${currentInd.toPrecision(4)} → neckline break ${pass ? 'PASS ✅' : 'FAIL ❌ (current must exceed neckline)'}`;
  } else {
    if (highs.length < 2) return `${indicatorName}: only ${highs.length} swing high(s) in window [${searchStart}..${searchEnd}) — need 2`;
    const [i1, i2] = highs.slice(-2);
    const v1 = indicatorValues[i1], v2 = indicatorValues[i2];
    if (!isFinite(v1) || !isFinite(v2)) return `${indicatorName}: pivot indic values not finite (v1=${v1} v2=${v2})`;
    const priceDiv = closes[i2] > closes[i1];
    const indDiv   = v2 < v1;
    if (!priceDiv || !indDiv) {
      return `${indicatorName}: no div — price[i1]=${closes[i1].toPrecision(6)} price[i2]=${closes[i2].toPrecision(6)} (HH=${priceDiv}) | ind[i1]=${v1.toPrecision(4)} ind[i2]=${v2.toPrecision(4)} (LH=${indDiv})`;
    }
    if (minDiffRatio > 0) {
      const diff = Math.abs(v2 - v1) / Math.max(Math.abs(v1), Math.abs(v2), 1);
      if (diff < minDiffRatio) return `${indicatorName}: div found but diff too small (${(diff * 100).toFixed(2)}% < ${(minDiffRatio * 100).toFixed(2)}%)`;
    }
    const between  = indicatorValues.slice(i1, i2 + 1).filter(isFinite);
    const neckline = Math.min(...between);
    const pass = currentInd < neckline;
    return `${indicatorName}: div confirmed structurally ✓ | neckline=${neckline.toPrecision(4)} currentInd=${currentInd.toPrecision(4)} → neckline break ${pass ? 'PASS ✅' : 'FAIL ❌ (current must be below neckline)'}`;
  }
}

// Count significant pivots (8-bar wing) in a 1H buffer.
// Used in refreshLevels to verify enough structure exists.
function countSigPivots1H(bars1h) {
  const WING = 8;
  let nHighs = 0, nLows = 0;
  for (let i = WING; i < bars1h.length - WING; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - WING; j <= i + WING; j++) {
      if (j === i) continue;
      if (bars1h[j].high >= bars1h[i].high) isHigh = false;
      if (bars1h[j].low  <= bars1h[i].low)  isLow  = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) nHighs++;
    if (isLow)  nLows++;
  }
  return { nHighs, nLows };
}

// ── W / M structure detection ─────────────────────────────────────────────────
// W (long SFP):
//   1. A bar in the last 4 wicked BELOW level (the sweep)
//   2. Current bar closes ABOVE level AND above sweep bar's close
//   3. Current bar closes ABOVE the price neckline = highest high of bars
//      between the sweep bar and current (confirms W break, not just recovery)
//   When sweep bar is directly before current (no bars in between), step 3
//   is satisfied by condition 2 alone.
function detectWPattern(bars5m, level) {
  if (bars5m.length < 5) return false;
  const last       = bars5m.at(-1);
  if (last.close <= level) return false;
  const searchBars = bars5m.slice(-5, -1);
  for (let i = 0; i < searchBars.length; i++) {
    const sweepBar = searchBars[i];
    if (sweepBar.low  >= level)           continue;  // not a sweep
    if (last.close    <= sweepBar.close)  continue;  // right leg not higher than sweep close
    const between  = searchBars.slice(i + 1);
    if (between.length === 0)             return true;  // adjacent — close>sweep.close is sufficient
    const neckline = Math.max(...between.map(b => b.high));
    if (last.close > neckline)            return true;  // price broke above W neckline
  }
  return false;
}

// M (short SFP):
//   1. A bar in the last 4 wicked ABOVE level (the sweep)
//   2. Current bar closes BELOW level AND below sweep bar's close
//   3. Current bar closes BELOW the price neckline = lowest low of bars
//      between the sweep bar and current (confirms M break)
function detectMPattern(bars5m, level) {
  if (bars5m.length < 5) return false;
  const last       = bars5m.at(-1);
  if (last.close >= level) return false;
  const searchBars = bars5m.slice(-5, -1);
  for (let i = 0; i < searchBars.length; i++) {
    const sweepBar = searchBars[i];
    if (sweepBar.high  <= level)          continue;  // not a sweep
    if (last.close     >= sweepBar.close) continue;  // right leg not lower than sweep close
    const between  = searchBars.slice(i + 1);
    if (between.length === 0)             return true;
    const neckline = Math.min(...between.map(b => b.low));
    if (last.close < neckline)            return true;  // price broke below M neckline
  }
  return false;
}

// Returns highest-priority level that was swept, or null.
function findSweepLevel(bars5m, levels, direction) {
  const keys = direction === 'long' ? LONG_LEVELS : SHORT_LEVELS;
  for (const key of keys) {
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

// ── Generic divergence with neckline confirmation ─────────────────────────────
//
// Bull (long):
//   1. Find 2 price swing lows: low2 < low1 (lower low)
//   2. Indicator at low2 > indicator at low1 (higher low = potential div)
//   3. Neckline = highest indicator value between low1 and low2
//   4. CONFIRMED only when current indicator > neckline (neckline break)
//
// Bear (short):
//   1. Find 2 price swing highs: high2 > high1 (higher high)
//   2. Indicator at high2 < indicator at high1 (lower high = potential div)
//   3. Neckline = lowest indicator value between high1 and high2
//   4. CONFIRMED only when current indicator < neckline (neckline break)
//
// Pivot search window: 20–60 bars ago (100 min – 5 h on 5m) to avoid
//   micro-pivots that are too recent AND stale pivots that no longer matter.
// Pivot confirmation wing: 5 bars on each side must be a local extreme.
// minDiffRatio: minimum relative indicator difference (pass 0.005 for OBV).
function checkDivergence(closes, indicatorValues, direction, minDiffRatio = 0) {
  const WING        = 5;   // bars on each side to confirm pivot is a local extreme
  const MIN_AGO     = 20;  // pivot must be ≥ 20 bars ago (100 min) — no micro-pivots
  const MAX_AGO     = 60;  // pivot must be ≤ 60 bars ago (5 h)   — no stale pivots

  const n           = closes.length;
  const searchStart = Math.max(WING, n - MAX_AGO);
  const searchEnd   = n - MIN_AGO;  // exclusive; ensures pivot is ≥ MIN_AGO bars back

  if (searchEnd <= searchStart) return false;

  const highs = [], lows = [];
  for (let i = searchStart; i < searchEnd; i++) {
    let isH = true, isL = true;
    for (let j = i - WING; j <= i + WING; j++) {
      if (j < 0 || j >= n || j === i) continue;
      if (closes[j] >= closes[i]) isH = false;
      if (closes[j] <= closes[i]) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) highs.push(i);
    if (isL)  lows.push(i);
  }

  const currentInd = indicatorValues.at(-1);
  if (!isFinite(currentInd)) return false;

  if (direction === 'short') {
    const [i1, i2] = highs.slice(-2);
    if (i1 == null || i2 == null) return false;
    const v1 = indicatorValues[i1], v2 = indicatorValues[i2];
    if (!isFinite(v1) || !isFinite(v2)) return false;
    if (!(closes[i2] > closes[i1] && v2 < v1)) return false;   // HH price, LH indicator
    // Minimum meaningful difference between pivot values
    if (minDiffRatio > 0 && Math.abs(v2 - v1) / Math.max(Math.abs(v1), Math.abs(v2), 1) < minDiffRatio) return false;
    // Neckline = lowest indicator value between the two swing highs
    const between = indicatorValues.slice(i1, i2 + 1).filter(isFinite);
    if (!between.length) return false;
    const neckline = Math.min(...between);
    return currentInd < neckline;   // confirmed: current breaks below neckline
  } else {
    const [i1, i2] = lows.slice(-2);
    if (i1 == null || i2 == null) return false;
    const v1 = indicatorValues[i1], v2 = indicatorValues[i2];
    if (!isFinite(v1) || !isFinite(v2)) return false;
    if (!(closes[i2] < closes[i1] && v2 > v1)) return false;   // LL price, HL indicator
    // Minimum meaningful difference between pivot values
    if (minDiffRatio > 0 && Math.abs(v2 - v1) / Math.max(Math.abs(v1), Math.abs(v2), 1) < minDiffRatio) return false;
    // Neckline = highest indicator value between the two swing lows
    const between = indicatorValues.slice(i1, i2 + 1).filter(isFinite);
    if (!between.length) return false;
    const neckline = Math.max(...between);
    return currentInd > neckline;   // confirmed: current breaks above neckline
  }
}

function checkRSIDivergence(bars5m, direction) {
  const closes = bars5m.map(b => b.close);
  return checkDivergence(closes, calcRSI(closes), direction);
}

function checkOBVDivergence(bars5m, direction) {
  // 0.5% minimum difference: OBV trending in same direction as price ≠ divergence
  return checkDivergence(bars5m.map(b => b.close), calcOBV(bars5m), direction, 0.005);
}

function checkMACDDivergence(bars5m, direction) {
  const closes = bars5m.map(b => b.close);
  return checkDivergence(closes, calcMACDHistogram(closes), direction);
}

// ── GS Location — 1H significant pivot fib zone check ────────────────────────
//
// Significant Pivot High: 1H bar whose high is strictly above ALL 8 bars on
//   each side — this is the M-top / swing high where sellers took over.
// Significant Pivot Low:  1H bar whose low is strictly below ALL 8 bars on
//   each side — this is the W-bottom / swing low where buyers took over.
//
// Market state determined from last 2 sig pivot highs + last 2 sig pivot lows:
//   RANGE     = both highs roughly equal AND both lows roughly equal (≤2% diff)
//   UPTREND   = higher highs + higher lows
//   DOWNTREND = lower highs + lower lows
//   (mixed / unclear → return null, no location forced)
//
// Fib zones (fib always drawn between most recent sig high and sig low):
//   Range  LONG  — L.RLZ  0.618–0.786 retracement from high toward low
//   Range  SHORT — S.RLZ  0.618–0.786 retracement from low toward high
//   Uptrend LONG    — P.CZ  0.382–0.500 pullback from swing high
//   Downtrend SHORT — D.CZ  0.382–0.500 bounce from swing low
function checkGSLocation(bars1h, direction, currentPrice) {
  const WING      = 8;      // bars required on each side of a significant pivot
  const RANGE_TOL = 0.02;   // 2%  — "roughly equal" threshold for market state
  const EXACT_TOL = 0.01;   // ±1% ratio window for MM (0.618) / SHARK (0.786) labels

  if (bars1h.length < WING * 2 + 5) return null;

  // Scan for significant pivots (stop early when both flags go false)
  const sigHighs = [];
  const sigLows  = [];

  for (let i = WING; i < bars1h.length - WING; i++) {
    const pivH = bars1h[i].high;
    const pivL = bars1h[i].low;
    let isHigh = true, isLow = true;

    for (let j = i - WING; j <= i + WING; j++) {
      if (j === i) continue;
      if (bars1h[j].high >= pivH) isHigh = false;
      if (bars1h[j].low  <= pivL) isLow  = false;
      if (!isHigh && !isLow) break;
    }

    if (isHigh) sigHighs.push({ index: i, price: pivH });
    if (isLow)   sigLows.push({ index: i, price: pivL });
  }

  if (sigHighs.length < 2 || sigLows.length < 2) return null;

  // Market state: compare the two most recent pivots of each type
  const [h1, h2] = sigHighs.slice(-2);   // h1 = older, h2 = more recent
  const [l1, l2] = sigLows.slice(-2);    // l1 = older, l2 = more recent

  const highsEqual  = Math.abs(h2.price - h1.price) / h1.price <= RANGE_TOL;
  const lowsEqual   = Math.abs(l2.price - l1.price) / l1.price <= RANGE_TOL;
  const higherHighs = !highsEqual && h2.price > h1.price;
  const higherLows  = !lowsEqual  && l2.price > l1.price;
  const lowerHighs  = !highsEqual && h2.price < h1.price;
  const lowerLows   = !lowsEqual  && l2.price < l1.price;

  let marketState;
  if      (highsEqual  && lowsEqual)  marketState = 'range';
  else if (higherHighs && higherLows) marketState = 'uptrend';
  else if (lowerHighs  && lowerLows)  marketState = 'downtrend';
  else return null;   // mixed structure — do not force a location

  const lastHigh = sigHighs.at(-1).price;
  const lastLow  = sigLows.at(-1).price;
  const range    = lastHigh - lastLow;
  if (range <= 0) return null;

  if (marketState === 'range') {
    if (direction === 'long') {
      const ratio = (lastHigh - currentPrice) / range;
      if (ratio < 0.618 || ratio > 0.786) return null;
      if (Math.abs(ratio - 0.618) <= EXACT_TOL) return 'L.RLZ-MM (0.618)';
      if (Math.abs(ratio - 0.786) <= EXACT_TOL) return 'L.RLZ-SHARK (0.786)';
      return 'L.RLZ (0.618-0.786)';
    } else {
      const ratio = (currentPrice - lastLow) / range;
      if (ratio < 0.618 || ratio > 0.786) return null;
      if (Math.abs(ratio - 0.618) <= EXACT_TOL) return 'S.RLZ-MM (0.618)';
      if (Math.abs(ratio - 0.786) <= EXACT_TOL) return 'S.RLZ-SHARK (0.786)';
      return 'S.RLZ (0.618-0.786)';
    }
  }

  if (marketState === 'uptrend' && direction === 'long') {
    const ratio = (lastHigh - currentPrice) / range;
    if (ratio >= 0.382 && ratio <= 0.500) return 'P.CZ (0.382-0.500)';
  }

  if (marketState === 'downtrend' && direction === 'short') {
    const ratio = (currentPrice - lastLow) / range;
    if (ratio >= 0.382 && ratio <= 0.500) return 'D.CZ (0.382-0.500)';
  }

  return null;
}

// ── Scoring ───────────────────────────────────────────────────────────────────
// rank = 1 + (hasLocation<<3 | hasOBV<<2 | hasRSI<<1 | hasMACD)
// This produces the exact 16-entry table from the spec without a lookup table.
function calcRank(hasLocation, hasOBV, hasRSI, hasMACD) {
  return 1 + ((hasLocation ? 8 : 0) | (hasOBV ? 4 : 0) | (hasRSI ? 2 : 0) | (hasMACD ? 1 : 0));
}

// ── Alert builder ─────────────────────────────────────────────────────────────
function buildAlert(symbol, direction, levelKey, rank, hasLocation, locZone, hasOBV, hasRSI, hasMACD) {
  const coin     = symbol.replace('_USDT', 'USDT');
  const dir      = direction === 'long' ? 'LONG' : 'SHORT';
  const dirEmoji = direction === 'long' ? '🟢' : '🔴';
  const time     = new Date().toISOString().slice(11, 16) + ' UTC';
  const swept    = direction === 'long' ? 'swept (W structure confirmed)' : 'swept (M structure confirmed)';
  const locStr   = hasLocation ? `${locZone} ✅` : '❌';

  return [
    `${dirEmoji} <b>${coin} ${dir} ${rank}/16</b>`,
    `Level: ${LEVEL_DISPLAY[levelKey] || levelKey} ${swept}`,
    `Location: ${locStr} | OBV ${hasOBV ? '✅' : '❌'} | RSI ${hasRSI ? '✅' : '❌'} | MACD ${hasMACD ? '✅' : '❌'}`,
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

// ── Session level computation (derived live from H1 buffer) ──────────────────
// H1 buffer holds 550 bars (~23 days) — always enough to cover today's sessions.
// Asia   session: 00:00–08:00 UTC — valid as a level only AFTER 08:00 UTC
// London session: 08:00–16:00 UTC — valid as a level only AFTER 16:00 UTC
function computeSessionLevels(h1Bars) {
  const now  = new Date();
  const nowH = now.getUTCHours();
  const todayMidnight = Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()
  ) / 1000;

  const asiaStart   = todayMidnight;
  const asiaEnd     = todayMidnight + 8  * 3600;
  const londonStart = asiaEnd;
  const londonEnd   = todayMidnight + 16 * 3600;

  const asiaBars   = h1Bars.filter(b => b.time >= asiaStart   && b.time < asiaEnd);
  const londonBars = h1Bars.filter(b => b.time >= londonStart && b.time < londonEnd);

  return {
    asiaHigh:   (nowH >= 8  && asiaBars.length   > 0) ? Math.max(...asiaBars.map(b => b.high))   : null,
    asiaLow:    (nowH >= 8  && asiaBars.length   > 0) ? Math.min(...asiaBars.map(b => b.low))    : null,
    londonHigh: (nowH >= 16 && londonBars.length > 0) ? Math.max(...londonBars.map(b => b.high)) : null,
    londonLow:  (nowH >= 16 && londonBars.length > 0) ? Math.min(...londonBars.map(b => b.low))  : null,
  };
}

// ── SFU level computation ─────────────────────────────────────────────────────
// SFU (Swing Failure Unit): two consecutive 5m closes — bar N closes through a
// 1H/4H/1D extreme, bar N+1 closes back. The extreme is the highest visible
// high / lowest visible low across all three timeframes — retail stop cluster.
// Returns the most significant level AND which TF it came from.
function computeSFULevels(bars1h, bars4h, bars1d) {
  const h1High = bars1h.length ? Math.max(...bars1h.slice(-100).map(b => b.high).filter(isFinite)) : -Infinity;
  const h4High = bars4h.length ? Math.max(...bars4h.slice(-100).map(b => b.high).filter(isFinite)) : -Infinity;
  const d1High = bars1d.length ? Math.max(...bars1d.slice(-100).map(b => b.high).filter(isFinite)) : -Infinity;

  const h1Low  = bars1h.length ? Math.min(...bars1h.slice(-100).map(b => b.low).filter(isFinite)) : Infinity;
  const h4Low  = bars4h.length ? Math.min(...bars4h.slice(-100).map(b => b.low).filter(isFinite)) : Infinity;
  const d1Low  = bars1d.length ? Math.min(...bars1d.slice(-100).map(b => b.low).filter(isFinite)) : Infinity;

  const sfuHigh   = Math.max(h1High, h4High, d1High);
  const sfuHighTF = sfuHigh === d1High ? '1D' : sfuHigh === h4High ? '4H' : '1H';

  const sfuLow    = Math.min(h1Low, h4Low, d1Low);
  const sfuLowTF  = sfuLow === d1Low  ? '1D' : sfuLow  === h4Low  ? '4H' : '1H';

  return {
    sfuHigh:   isFinite(sfuHigh) ? sfuHigh   : null,
    sfuHighTF: isFinite(sfuHigh) ? sfuHighTF : null,
    sfuLow:    isFinite(sfuLow)  ? sfuLow    : null,
    sfuLowTF:  isFinite(sfuLow)  ? sfuLowTF  : null,
  };
}

// Returns { level, tf } when a 2-bar SFU sequence is detected on the last two
// closed 5m bars. Bar N closes through the level, bar N+1 closes back.
function detectSFU(bars5m, sfuHigh, sfuHighTF, sfuLow, sfuLowTF, direction) {
  if (bars5m.length < 2) return null;
  const prev = bars5m.at(-2);
  const curr = bars5m.at(-1);

  if (direction === 'long' && sfuLow != null) {
    if (prev.close < sfuLow && curr.close > sfuLow) {
      return { level: sfuLow, tf: sfuLowTF };
    }
  }
  if (direction === 'short' && sfuHigh != null) {
    if (prev.close > sfuHigh && curr.close < sfuHigh) {
      return { level: sfuHigh, tf: sfuHighTF };
    }
  }
  return null;
}

// ── SFU alert builders ────────────────────────────────────────────────────────
// sfuResult = { level, tf }  (tf = "1H" | "4H" | "1D")
// Case A: SFU detected, no SFP
function buildSFUAlert(symbol, direction, sfuResult, hasLocation, locZone, hasOBV, hasRSI, hasMACD) {
  const coin     = symbol.replace('_USDT', 'USDT');
  const dir      = direction === 'long' ? 'LONG' : 'SHORT';
  const dirEmoji = direction === 'long' ? '🟢' : '🔴';
  const side     = direction === 'long' ? 'Low' : 'High';
  const time     = new Date().toISOString().slice(11, 16) + ' UTC';
  const locStr   = hasLocation ? `${locZone} ✅` : '❌';

  return [
    `${dirEmoji} <b>${coin} ${dir} 🚀SFU</b>`,
    `Level: ${sfuResult.tf} ${side} swept`,
    `Location: ${locStr} | OBV ${hasOBV ? '✅' : '❌'} | RSI ${hasRSI ? '✅' : '❌'} | MACD ${hasMACD ? '✅' : '❌'}`,
    `Time: ${time}`,
  ].join('\n');
}

// Case B: SFU + SFP both confirmed — merged alert
function buildMergedAlert(symbol, direction, levelKey, rank, hasLocation, locZone, hasOBV, hasRSI, hasMACD, sfuResult) {
  const coin     = symbol.replace('_USDT', 'USDT');
  const dir      = direction === 'long' ? 'LONG' : 'SHORT';
  const dirEmoji = direction === 'long' ? '🟢' : '🔴';
  const sfpStr   = direction === 'long' ? 'swept (W structure confirmed)' : 'swept (M structure confirmed)';
  const side     = direction === 'long' ? 'Low' : 'High';
  const time     = new Date().toISOString().slice(11, 16) + ' UTC';
  const locStr   = hasLocation ? `${locZone} ✅` : '❌';

  return [
    `${dirEmoji} <b>${coin} ${dir} ${rank}/16 🚀SFU</b>`,
    `Level: ${LEVEL_DISPLAY[levelKey] || levelKey} ${sfpStr}`,
    `SFU: ${sfuResult.tf} ${side} swept ✅`,
    `Location: ${locStr} | OBV ${hasOBV ? '✅' : '❌'} | RSI ${hasRSI ? '✅' : '❌'} | MACD ${hasMACD ? '✅' : '❌'}`,
    `Time: ${time}`,
  ].join('\n');
}

// ── Signal detection (runs on each 5m candle close) ───────────────────────────
// Three cases per direction:
//   Case B — SFP + SFU both confirmed → merged alert (highest priority)
//   Case C — SFP only, rank ≥ 2       → normal SFP alert
//   Case A — SFU only, no SFP         → SFU-only alert
async function detectSFP(symbol) {
  console.log(`[SCAN] ${symbol} tick`);
  try {
    const buf = klineBuffers.get(symbol);
    if (!buf) { console.log(`[SCAN] ${symbol} EXIT: no buffer`); return; }
    const { m5, h1, h4, d1 } = buf;
    if (m5.length < 30 || h1.length < 50) { console.log(`[SCAN] ${symbol} EXIT: insufficient bars m5=${m5.length} h1=${h1.length}`); return; }

    const cached = levelCache.get(symbol);
    if (!cached || !Object.values(cached).some(v => v != null)) { console.log(`[SCAN] ${symbol} EXIT: no levels cached`); return; }
    const levels = { ...cached, ...computeSessionLevels(h1) };

    // Compute SFU levels once per symbol tick (1H + 4H + 1D)
    const { sfuHigh, sfuHighTF, sfuLow, sfuLowTF } = computeSFULevels(h1, h4 ?? [], d1 ?? []);

    // ── TEMPORARY verbose debug for BTC ──────────────────────────────────────
    if (symbol === DEBUG_SYMBOL) {
      const currentPrice = m5.at(-1)?.close;
      console.log(`[DEBUG-BTC] ── detectSFP tick @ price=${currentPrice} ──`);
      console.log(`[DEBUG-BTC] Buffers: m5=${m5.length} h1=${h1.length} h4=${h4?.length ?? 0} d1=${d1?.length ?? 0}`);
      console.log(`[DEBUG-BTC] SFU levels: high=${sfuHigh?.toPrecision(6)} (${sfuHighTF}), low=${sfuLow?.toPrecision(6)} (${sfuLowTF})`);
      // Separate level values for readability
      const nonNullLevels = Object.entries(levels).filter(([, v]) => v != null);
      if (nonNullLevels.length === 0) {
        console.log(`[DEBUG-BTC] Levels: NONE (all null — levelCache empty?)`);
      } else {
        console.log(`[DEBUG-BTC] Levels (${nonNullLevels.length}): ` +
          nonNullLevels.map(([k, v]) => `${k}=${v.toPrecision(6)}`).join(' | '));
      }
      // Check W pattern (LONG) for each long level
      console.log(`[DEBUG-BTC] W pattern (LONG) check:`);
      for (const key of LONG_LEVELS) {
        const price = levels[key];
        if (price == null) { console.log(`  ${key}: null — skipped`); continue; }
        console.log(`  ${key}=${price.toPrecision(6)}: ${debugWhyWFailed(m5, price)}`);
      }
      // Check M pattern (SHORT) for each short level
      console.log(`[DEBUG-BTC] M pattern (SHORT) check:`);
      for (const key of SHORT_LEVELS) {
        const price = levels[key];
        if (price == null) { console.log(`  ${key}: null — skipped`); continue; }
        console.log(`  ${key}=${price.toPrecision(6)}: ${debugWhyMFailed(m5, price)}`);
      }
      // Divergence detail for both directions
      const closes = m5.map(b => b.close);
      const rsiVals  = calcRSI(closes);
      const obvVals  = calcOBV(m5);
      const macdVals = calcMACDHistogram(closes);
      for (const dir of ['long', 'short']) {
        console.log(`[DEBUG-BTC] ${dir.toUpperCase()} divergence:`);
        console.log(`  ${debugDivergenceDetail(closes, 'RSI',  rsiVals,  dir)}`);
        console.log(`  ${debugDivergenceDetail(closes, 'OBV',  obvVals,  dir, 0.005)}`);
        console.log(`  ${debugDivergenceDetail(closes, 'MACD', macdVals, dir)}`);
      }
      // SFU 2-bar check
      const sfuLong  = detectSFU(m5, sfuHigh, sfuHighTF, sfuLow, sfuLowTF, 'long');
      const sfuShort = detectSFU(m5, sfuHigh, sfuHighTF, sfuLow, sfuLowTF, 'short');
      const prev = m5.at(-2), curr = m5.at(-1);
      console.log(`[DEBUG-BTC] SFU check: prev.close=${prev?.close?.toPrecision(6)} curr.close=${curr?.close?.toPrecision(6)}`);
      console.log(`[DEBUG-BTC]   LONG  SFU (prev<sfuLow && curr>sfuLow): ${sfuLong  ? `PASS level=${sfuLong.level}` : `FAIL (sfuLow=${sfuLow?.toPrecision(6)})`}`);
      console.log(`[DEBUG-BTC]   SHORT SFU (prev>sfuHigh && curr<sfuHigh): ${sfuShort ? `PASS level=${sfuShort.level}` : `FAIL (sfuHigh=${sfuHigh?.toPrecision(6)})`}`);
      // Dedup status
      console.log(`[DEBUG-BTC] Dedup: sfp_long=${wasAlertedRecently(symbol,'long')} sfp_short=${wasAlertedRecently(symbol,'short')} sfu_long=${wasAlertedSFURecently(symbol,'long')} sfu_short=${wasAlertedSFURecently(symbol,'short')}`);
    }
    // ─────────────────────────────────────────────────────────────────────────

    for (const direction of ['long', 'short']) {
      const sfpAlerted = wasAlertedRecently(symbol, direction);
      const sfuAlerted = wasAlertedSFURecently(symbol, direction);

      // Detect SFU regardless of SFP dedup (SFU has its own dedup key)
      const sfuResult = (!sfuAlerted)
        ? detectSFU(m5, sfuHigh, sfuHighTF, sfuLow, sfuLowTF, direction)
        : null;

      // Detect SFP (structure) only if not recently alerted for SFP
      let sfpMatch = null;
      if (!sfpAlerted) {
        sfpMatch = findSweepLevel(m5, levels, direction);
      }

      const currentPrice = m5.at(-1).close;

      // Compute location + momentum once (shared by all cases that need it)
      let locZone = null, hasLocation = false;
      let hasOBV = false, hasRSI = false, hasMACD = false;
      let rank = 0;

      const needsConfluence = sfpMatch != null || sfuResult != null;
      if (needsConfluence) {
        locZone     = checkGSLocation(h1, direction, currentPrice);
        hasLocation = locZone != null;
        hasOBV      = checkOBVDivergence(m5, direction);
        hasRSI      = checkRSIDivergence(m5, direction);
        hasMACD     = checkMACDDivergence(m5, direction);
        rank        = calcRank(hasLocation, hasOBV, hasRSI, hasMACD);
      }

      // ── Case B: SFP + SFU merged ──────────────────────────────────────────
      if (sfpMatch && sfuResult) {
        const { key: levelKey } = sfpMatch;
        console.log(
          `[scanner] ★ ${symbol} ${direction.toUpperCase()} ${rank}/16 + SFU | ` +
          `level=${levelKey} sfuLevel=${sfuResult.level.toPrecision(6)} (${sfuResult.tf}) | ` +
          `loc=${locZone || 'none'} | OBV=${hasOBV} RSI=${hasRSI} MACD=${hasMACD}`
        );
        await sendTelegram(
          buildMergedAlert(symbol, direction, levelKey, rank, hasLocation, locZone, hasOBV, hasRSI, hasMACD, sfuResult)
        );
        markAlerted(symbol, direction);
        markAlertedSFU(symbol, direction);
        continue;
      }

      // ── Case C: SFP only ──────────────────────────────────────────────────
      if (sfpMatch && !sfuResult) {
        if (rank < 2) {
          console.log(`[scanner] skip ${symbol} ${direction.toUpperCase()} — rank 1/16, no confluence`);
          continue;
        }
        const { key: levelKey } = sfpMatch;
        console.log(
          `[scanner] ★ ${symbol} ${direction.toUpperCase()} ${rank}/16 | ` +
          `level=${levelKey} | loc=${locZone || 'none'} | OBV=${hasOBV} RSI=${hasRSI} MACD=${hasMACD}`
        );
        await sendTelegram(
          buildAlert(symbol, direction, levelKey, rank, hasLocation, locZone, hasOBV, hasRSI, hasMACD)
        );
        markAlerted(symbol, direction);
        continue;
      }

      // ── Case A: SFU only (no SFP match) ──────────────────────────────────
      if (sfuResult && !sfpMatch) {
        console.log(
          `[scanner] ☆ ${symbol} ${direction.toUpperCase()} SFU | ` +
          `sfuLevel=${sfuResult.level.toPrecision(6)} (${sfuResult.tf}) | ` +
          `loc=${locZone || 'none'} | OBV=${hasOBV} RSI=${hasRSI} MACD=${hasMACD}`
        );
        await sendTelegram(
          buildSFUAlert(symbol, direction, sfuResult, hasLocation, locZone, hasOBV, hasRSI, hasMACD)
        );
        markAlertedSFU(symbol, direction);
      }
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
    wsSend({ method: 'sub.kline', param: { symbol, interval: 'Min5'   } });
    wsSend({ method: 'sub.kline', param: { symbol, interval: 'Min60'  } });
    wsSend({ method: 'sub.kline', param: { symbol, interval: 'Hour4'  } });
    // Day1 intentionally omitted — MEXC WS does not reliably support Day1 kline
    // subscriptions; d1 buffer is refreshed via hourly REST in refreshLevels.
  }
  console.log(`[scanner] Subscribed klines for ${symbols.length} symbols (5m + 1H + 4H)`);
}

function unsubscribeSymbols(symbols) {
  for (const symbol of symbols) {
    wsSend({ method: 'unsub.kline', param: { symbol, interval: 'Min5'   } });
    wsSend({ method: 'unsub.kline', param: { symbol, interval: 'Min60'  } });
    wsSend({ method: 'unsub.kline', param: { symbol, interval: 'Hour4'  } });
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
    if (interval !== 'Min5' && interval !== 'Min60' && interval !== 'Hour4') return;

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
            if (symbol === DEBUG_SYMBOL) {
              console.log(`[DEBUG-BTC] 5m close: ${closedBar.close} | h=${closedBar.high} l=${closedBar.low} v=${closedBar.vol.toFixed(0)} @ ${new Date(closedBar.time * 1000).toISOString()}`);
            }
            candleCloseCount++;
            if (candleCloseCount % 50 === 0) {
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
