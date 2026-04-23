/**
 * WebSocket Scanner — MEXC Perpetual Futures
 *
 * CTA SFP (5m): Location → Structure (W/M on key level) → Momentum
 * LJ Setup (1H): HTF TL (3+ rejections) → clean break → W/M on opposite side → neckline alert
 *   LONG: descending resistance TL broken upward → W above broken TL → neckline break = 1/2
 *   SHORT: ascending support TL broken downward → M below broken TL → neckline break = 1/2
 *
 * Rank formula (SFP): 1 + (loc<<3 | obv<<2 | rsi<<1 | macd) → 1/16–16/16
 */

import WebSocket from 'ws';
import { forwardSignalToSAE } from './sae_forwarder.js';

// ── Constants ──────────────────────────────────────────────────────────────────
const WS_URL            = 'wss://contract.mexc.com/edge';
const REST_BASE         = 'https://contract.mexc.com';
const TELEGRAM_API      = 'https://api.telegram.org';

const PING_INTERVAL_MS  = 15_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS  = 60_000;
const VOLUME_REFRESH_MS = 60 * 60 * 1000;
const LEVEL_REFRESH_MS  = 60 * 60 * 1000;
const ALERT_RESET_SESSION_MS = 4 * 60 * 60 * 1000;
const ALERT_RESET_STRUCT_MS  = 8 * 60 * 60 * 1000;
const ALERT_RESET_LJ_MS      = 24 * 60 * 60 * 1000;

const TOP_N           = 20;
const MIN_VOLUME_USDT = 5_000_000;

// ── Alert Master Toggle ────────────────────────────────────────────────────────
// To resume Telegram sends: set ALERTS_ENABLED = true and redeploy.
// While false, every detection still runs and logs "[MUTED] Would have sent: ..."
// so you can verify signal quality without spamming Telegram.
const ALERTS_ENABLED = false;

const BOOTSTRAP_5M  = 100;
const BOOTSTRAP_1H  = 500;
const BOOTSTRAP_4H  = 100;
const BOOTSTRAP_D1  = 100;
const BOOTSTRAP_W1  = 60;
const BOOTSTRAP_MO  = 4;
const BUFFER_MAX_5M = 150;
const BUFFER_MAX_1H = 550;
const BUFFER_MAX_4H = 110;
const BUFFER_MAX_1D = 110;
const BUFFER_MAX_W1 = 65;

// ── State ──────────────────────────────────────────────────────────────────────
let ws             = null;
let pingTimer      = null;
let reconnectDelay = RECONNECT_BASE_MS;
let disconnectedAt = 0;
let shuttingDown   = false;

const klineBuffers = new Map();   // symbol → { m5, h1, h4, d1, w1 }
const levelCache   = new Map();   // symbol → Levels object
const lastWsTs     = new Map();   // "SYMBOL:interval" → epochSeconds
const pendingBar   = new Map();   // "SYMBOL:interval" → forming bar data
let   topSymbols   = [];
const alerted      = new Map();   // "SYMBOL:direction:levelKey" → timestamp
const alertedLJ    = new Map();   // "SYMBOL:TF:direction:neckKey:stage" → timestamp
const ljStage1     = new Map();   // "SYMBOL:TF:direction" → { neckline, nk }

let candleCloseCount = 0;

// ── Misc helpers ───────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function wasAlertedRecently(symbol, direction, levelKey) {
  const ts      = alerted.get(`${symbol}:${direction}:${levelKey}`);
  const timeout = SESSION_LEVELS.has(levelKey) ? ALERT_RESET_SESSION_MS : ALERT_RESET_STRUCT_MS;
  return ts != null && Date.now() - ts < timeout;
}
function markAlerted(symbol, direction, levelKey) {
  alerted.set(`${symbol}:${direction}:${levelKey}`, Date.now());
}
function wasAlertedLJRecently(symbol, tf, direction, dedupKey) {
  const ts = alertedLJ.get(`${symbol}:${tf}:${direction}:${dedupKey}`);
  return ts != null && Date.now() - ts < ALERT_RESET_LJ_MS;
}
function markAlertedLJ(symbol, tf, direction, dedupKey) {
  alertedLJ.set(`${symbol}:${tf}:${direction}:${dedupKey}`, Date.now());
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
const LONG_LEVELS    = ['PML', 'PWL', 'mondayLow',  'weeklyOpen', 'londonLow',  'asiaLow'];
const SHORT_LEVELS   = ['PMH', 'PWH', 'mondayHigh', 'weeklyOpen', 'londonHigh', 'asiaHigh'];
const SESSION_LEVELS = new Set(['asiaHigh', 'asiaLow', 'londonHigh', 'londonLow']);

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
  const lastWeek   = w1Comp.at(-1) ?? null;
  const lastMonth  = moComp.at(-1) ?? null;
  const nowSec     = Date.now() / 1000;
  const mondays    = d1Comp.filter(b =>
    new Date(b.time * 1000).getUTCDay() === 1 &&
    (b.time + 86400) < nowSec
  );
  const lastMonday = (new Date().getUTCDay() !== 1) ? (mondays.at(-1) ?? null) : null;
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
      const w1Comp    = parseKlines(rawW1, true);
      const w1Forming = parseKlines(rawW1, false).at(-1) ?? null;
      const moComp    = parseKlines(rawMo, true);
      klineBuffers.set(symbol, {
        m5: parseKlines(raw5m),
        h1: parseKlines(raw1h),
        h4: parseKlines(raw4h),
        d1: d1Comp,
        w1: w1Comp,
      });
      levelCache.set(symbol, computeLevels(d1Comp, w1Comp, w1Forming, moComp));
      ok++;
    } catch (err) {
      console.error(`[scanner] Bootstrap ${symbol}: ${err.message}`);
      klineBuffers.set(symbol, { m5: [], h1: [], h4: [], d1: [], w1: [] });
      levelCache.set(symbol, {});
    }
    await sleep(800);
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
      const buf = klineBuffers.get(symbol);
      if (buf) { buf.d1 = d1Comp; buf.w1 = w1Comp; }
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

// ── W / M structure detection (SFP) ──────────────────────────────────────────
function detectWPattern(bars5m, level) {
  if (bars5m.length < 6) return false;
  const last = bars5m.at(-1);
  if (last.close <= level) return false;
  const n       = bars5m.length;
  const MIN_GAP = 3;
  for (let ri = n - 2; ri >= Math.max(n - 5, 1); ri--) {
    const rightBar = bars5m[ri];
    if (rightBar.low >= level) continue;
    const approachBars = bars5m.slice(Math.max(0, ri - 5), ri);
    if (approachBars.filter(b => b.close > level).length < 3) continue;
    let bestNeckline = -Infinity;
    for (let li = ri - MIN_GAP; li >= Math.max(0, ri - 20); li--) {
      if (bars5m[li].low > level) continue;
      if (rightBar.close <= bars5m[li].close) continue;
      const midBars = bars5m.slice(li + 1, ri);
      if (midBars.length === 0) continue;
      const neckline = Math.max(...midBars.map(b => b.high));
      if (neckline > bestNeckline) bestNeckline = neckline;
    }
    if (bestNeckline === -Infinity) continue;
    if (last.close > bestNeckline) return true;
  }
  return false;
}

function detectMPattern(bars5m, level) {
  if (bars5m.length < 6) return false;
  const last = bars5m.at(-1);
  if (last.close >= level) return false;
  const n       = bars5m.length;
  const MIN_GAP = 3;
  for (let ri = n - 2; ri >= Math.max(n - 5, 1); ri--) {
    const rightBar = bars5m[ri];
    if (rightBar.high <= level) continue;
    const approachBars = bars5m.slice(Math.max(0, ri - 5), ri);
    if (approachBars.filter(b => b.close < level).length < 3) continue;
    let bestNeckline = Infinity;
    for (let li = ri - MIN_GAP; li >= Math.max(0, ri - 20); li--) {
      if (bars5m[li].high < level) continue;
      if (rightBar.close >= bars5m[li].close) continue;
      const midBars = bars5m.slice(li + 1, ri);
      if (midBars.length === 0) continue;
      const neckline = Math.min(...midBars.map(b => b.low));
      if (neckline < bestNeckline) bestNeckline = neckline;
    }
    if (bestNeckline === Infinity) continue;
    if (last.close < bestNeckline) return true;
  }
  return false;
}

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

// ── RSI (Wilder smoothing, period 14) ─────────────────────────────────────────
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
  if (closes.length < slow + signal) return new Array(closes.length).fill(NaN);
  const emaFast    = calcEMA(closes, fast);
  const emaSlow    = calcEMA(closes, slow);
  const macdLine   = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = calcEMA(macdLine, signal);
  return macdLine.map((v, i) => v - signalLine[i]);
}

// ── Generic divergence with neckline confirmation ─────────────────────────────
function checkDivergence(bars, indicatorValues, direction, minDiffRatio = 0) {
  const WING        = 5;
  const MIN_AGO     = 20;
  const MAX_AGO     = 60;
  const n           = bars.length;
  const searchStart = Math.max(WING, n - MAX_AGO);
  const searchEnd   = n - MIN_AGO;
  if (searchEnd <= searchStart) return false;
  const highs = [], lows = [];
  for (let i = searchStart; i < searchEnd; i++) {
    let isH = true, isL = true;
    for (let j = i - WING; j <= i + WING; j++) {
      if (j < 0 || j >= n || j === i) continue;
      if (bars[j].high >= bars[i].high) isH = false;
      if (bars[j].low  <= bars[i].low)  isL = false;
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
    if (!(bars[i2].close > bars[i1].close && v2 < v1)) return false;
    if (minDiffRatio > 0 && Math.abs(v2 - v1) / Math.max(Math.abs(v1), Math.abs(v2), 1) < minDiffRatio) return false;
    const between = indicatorValues.slice(i1, i2 + 1).filter(isFinite);
    if (!between.length) return false;
    return currentInd < Math.min(...between);
  } else {
    const [i1, i2] = lows.slice(-2);
    if (i1 == null || i2 == null) return false;
    const v1 = indicatorValues[i1], v2 = indicatorValues[i2];
    if (!isFinite(v1) || !isFinite(v2)) return false;
    if (!(bars[i2].close < bars[i1].close && v2 > v1)) return false;
    if (minDiffRatio > 0 && Math.abs(v2 - v1) / Math.max(Math.abs(v1), Math.abs(v2), 1) < minDiffRatio) return false;
    const between = indicatorValues.slice(i1, i2 + 1).filter(isFinite);
    if (!between.length) return false;
    return currentInd > Math.max(...between);
  }
}

function checkRSIDivergence(bars, direction) {
  return checkDivergence(bars, calcRSI(bars.map(b => b.close)), direction);
}
function checkOBVDivergence(bars, direction) {
  return checkDivergence(bars, calcOBV(bars), direction, 0.005);
}
function checkMACDDivergence(bars, direction) {
  return checkDivergence(bars, calcMACDHistogram(bars.map(b => b.close)), direction);
}

// ── GS Location (1H fib zone) ─────────────────────────────────────────────────
function checkGSLocation(bars1h, direction, currentPrice) {
  const WING      = 8;
  const RANGE_TOL = 0.02;
  const EXACT_TOL = 0.01;
  if (bars1h.length < WING * 2 + 5) return null;
  const sigHighs = [], sigLows = [];
  for (let i = WING; i < bars1h.length - WING; i++) {
    const pivH = bars1h[i].high, pivL = bars1h[i].low;
    let isHigh = true, isLow = true;
    for (let j = i - WING; j <= i + WING; j++) {
      if (j === i) continue;
      if (bars1h[j].high >= pivH) isHigh = false;
      if (bars1h[j].low  <= pivL) isLow  = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) sigHighs.push({ price: pivH });
    if (isLow)   sigLows.push({ price: pivL });
  }
  if (sigHighs.length < 2 || sigLows.length < 2) return null;
  const [h1, h2] = sigHighs.slice(-2);
  const [l1, l2] = sigLows.slice(-2);
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
  else return null;
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
function calcRank(hasLocation, hasOBV, hasRSI, hasMACD) {
  return 1 + ((hasLocation ? 8 : 0) | (hasOBV ? 4 : 0) | (hasRSI ? 2 : 0) | (hasMACD ? 1 : 0));
}

// ── Symbol display names ──────────────────────────────────────────────────────
const SYMBOL_DISPLAY_NAMES = {
  'TRUMPOFFICIAL_USDT': 'TRUMP',
  'BIANRENSHENG_USDT':  '币安人生',
};

// ── SFP Alert builder ─────────────────────────────────────────────────────────
function buildAlert(symbol, direction, levelKey, levelPrice, rank, hasLocation, locZone, hasOBV, hasRSI, hasMACD) {
  const coin     = SYMBOL_DISPLAY_NAMES[symbol] || symbol.replace('_USDT', '');
  const dir      = direction === 'long' ? 'LONG' : 'SHORT';
  const dirEmoji = direction === 'long' ? '🟢' : '🔴';
  const time     = new Date().toISOString().slice(11, 16) + ' UTC';
  const swept    = direction === 'long' ? 'swept (W structure confirmed)' : 'swept (M structure confirmed)';
  const locStr   = hasLocation ? `${locZone} ✅` : '❌';
  return [
    `${dirEmoji} <b>${coin} ${dir} ${rank}/16</b>`,
    `Level: ${LEVEL_DISPLAY[levelKey] || levelKey} (${levelPrice.toPrecision(6)}) ${swept}`,
    `Location: ${locStr} | OBV ${hasOBV ? '✅' : '❌'} | RSI ${hasRSI ? '✅' : '❌'} | MACD ${hasMACD ? '✅' : '❌'}`,
    `Time: ${time}`,
  ].join('\n');
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) { console.warn('[scanner] TELEGRAM env vars not set — alert skipped'); return; }
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) console.error(`[scanner] Telegram error: ${(await res.text()).slice(0, 200)}`);
  } catch (err) {
    console.error(`[scanner] Telegram failed: ${err.message}`);
  }
}

// ── Session level computation ─────────────────────────────────────────────────
function computeSessionLevels(h1Bars) {
  const now  = new Date();
  const nowH = now.getUTCHours();
  const todayMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;
  const asiaStart = todayMidnight, asiaEnd = todayMidnight + 8 * 3600;
  const londonStart = asiaEnd,    londonEnd = todayMidnight + 16 * 3600;
  const asiaBars   = h1Bars.filter(b => b.time >= asiaStart   && b.time < asiaEnd);
  const londonBars = h1Bars.filter(b => b.time >= londonStart && b.time < londonEnd);
  const asiaValid   = nowH >= 8  && nowH < 10 && asiaBars.length   > 0;
  const londonValid = nowH >= 16 && nowH < 18 && londonBars.length > 0;
  return {
    asiaHigh:   asiaValid   ? Math.max(...asiaBars.map(b => b.high))   : null,
    asiaLow:    asiaValid   ? Math.min(...asiaBars.map(b => b.low))    : null,
    londonHigh: londonValid ? Math.max(...londonBars.map(b => b.high)) : null,
    londonLow:  londonValid ? Math.min(...londonBars.map(b => b.low))  : null,
  };
}

// ── SAE payload mapping ───────────────────────────────────────────────────────
// Maps scanner-internal field names to the EchoOo-SAE /ta-events shape.
// Forwarding itself is gated by SAE_FORWARDING_ENABLED in sae_forwarder.js,
// so these helpers always run but are no-ops when the env flag is off.
const SAE_LEVEL_MAP = {
  PWH:        'pwh',
  PWL:        'pwl',
  PMH:        null,           // monthly — not in SAE schema
  PML:        null,
  mondayHigh: 'monday_high',
  mondayLow:  'monday_low',
  weeklyOpen: 'weekly_open',
  asiaHigh:   'asia_high',
  asiaLow:    'asia_low',
  londonHigh: 'london_high',
  londonLow:  'london_low',
};

const SAE_HTF_MAP = { '4H': '4h', 'D1': '1d', 'W1': '1w' };

function mapFibZone(locZone, direction) {
  if (!locZone) return null;
  if (locZone.includes('SHARK')) return direction === 'long' ? 'L.RLZ-SHARK' : 'S.RLZ-SHARK';
  if (locZone.includes('P.CZ'))  return 'P.CZ';
  if (locZone.includes('D.CZ'))  return 'D.CZ';
  // Plain "L.RLZ" / "S.RLZ" / "L.RLZ-MM" / "S.RLZ-MM" all collapse to MM (the more common case)
  if (locZone.startsWith('L.RLZ')) return 'L.RLZ-MM';
  if (locZone.startsWith('S.RLZ')) return 'S.RLZ-MM';
  return null;
}

function pctDistance(a, b) {
  if (!isFinite(a) || !isFinite(b) || b === 0) return null;
  return Math.round((Math.abs(a - b) / b) * 100 * 100) / 100; // 2dp
}

export function buildSFPSAEPayload({ symbol, direction, levelKey, levelPrice, currentPrice, locZone, rank }) {
  return {
    market_id:               null,
    symbol,
    timeframe:               '5m',
    pattern_type:            direction === 'long' ? 'SFP_long' : 'SFP_short',
    rank,
    fib_zone:                mapFibZone(locZone, direction),
    nearest_session_level:   SAE_LEVEL_MAP[levelKey] ?? null,
    distance_to_level_pct:   pctDistance(currentPrice, levelPrice),
    neckline_price:          null,            // not exposed by detectWPattern/detectMPattern
    htf_timeframe:           '1h',            // SFP location uses 1H bars
    signal_reliability:      0.60,
    detected_at:             new Date().toISOString(),
    source:                  'mexc_scanner',
  };
}

export function buildLJSAEPayload({ symbol, direction, stage, htfTf, neckline, entry }) {
  const dir = direction === 'long' ? 'long' : 'short';
  return {
    market_id:               null,
    symbol,
    timeframe:               '1h',           // LJ trigger fires on 1H close
    pattern_type:            `LJ_${dir}_stage${stage}`,
    rank:                    null,
    fib_zone:                null,
    nearest_session_level:   null,
    distance_to_level_pct:   pctDistance(entry, neckline),
    neckline_price:          isFinite(neckline) ? neckline : null,
    htf_timeframe:           SAE_HTF_MAP[htfTf] ?? null,
    signal_reliability:      0.60,
    detected_at:             new Date().toISOString(),
    source:                  'mexc_scanner',
  };
}

// ── SFP detection (5m candle close) ──────────────────────────────────────────
async function detectSFP(symbol) {
  try {
    const buf = klineBuffers.get(symbol);
    if (!buf) return;
    const { m5, h1 } = buf;
    if (m5.length < 30 || h1.length < 50) return;
    const cached = levelCache.get(symbol);
    if (!cached || !Object.values(cached).some(v => v != null)) return;
    const levels = { ...cached, ...computeSessionLevels(h1) };
    for (const direction of ['long', 'short']) {
      let sfpMatch = findSweepLevel(m5, levels, direction);
      if (sfpMatch && wasAlertedRecently(symbol, direction, sfpMatch.key)) sfpMatch = null;
      if (!sfpMatch) continue;
      const currentPrice = m5.at(-1).close;
      const locZone     = checkGSLocation(h1, direction, currentPrice);
      const hasLocation = locZone != null;
      const hasOBV      = checkOBVDivergence(m5, direction);
      const hasRSI      = checkRSIDivergence(m5, direction);
      const hasMACD     = checkMACDDivergence(m5, direction);
      const rank        = calcRank(hasLocation, hasOBV, hasRSI, hasMACD);
      if (rank < 2) continue;
      const { key: levelKey, price: levelPrice } = sfpMatch;
      console.log(
        `[scanner] ★ ${symbol} ${direction.toUpperCase()} ${rank}/16 | ` +
        `level=${levelKey} | loc=${locZone || 'none'} | OBV=${hasOBV} RSI=${hasRSI} MACD=${hasMACD}`
      );
      const alertText = buildAlert(symbol, direction, levelKey, levelPrice, rank, hasLocation, locZone, hasOBV, hasRSI, hasMACD);
      if (ALERTS_ENABLED) {
        await sendTelegram(alertText);
      } else {
        console.log(`[MUTED] Would have sent: ${alertText.replace(/<[^>]+>/g, '')}`);
      }
      // SAE forwarding — independent of ALERTS_ENABLED, gated by SAE_FORWARDING_ENABLED env.
      // Fire-and-forget so detection path never waits on the network.
      forwardSignalToSAE(buildSFPSAEPayload({
        symbol, direction, levelKey, levelPrice, currentPrice, locZone, rank,
      })).catch(() => {});
      markAlerted(symbol, direction, levelKey);
    }
  } catch (err) {
    console.error(`[scanner] detectSFP ${symbol}: ${err.message}`);
  }
}

// ── LJ Setup — HTF Trendline Break + W/M on Opposite Side ─────────────────────
//
// LONG: Descending resistance TL (3+ lower highs, each rejecting from below — close below TL)
//   4th+ interaction: candle CLOSES ABOVE the TL (break — no wicks, close only)
//   After break: W forms on 1H with BOTH lows ABOVE the broken TL
//   W neckline breakout (1H close above) → Alert "LJ Long 1/2"
//   Neckline retest + bounce back above → Alert "LJ Long 2/2"
//
// SHORT: Ascending support TL (3+ higher lows, each rejecting from above — close above TL)
//   4th+ interaction: candle CLOSES BELOW the TL (break)
//   After break: M forms on 1H with BOTH highs BELOW the broken TL
//   M neckline breakdown (1H close below) → Alert "LJ Short 1/2"
//   Neckline retest + rejection back below → Alert "LJ Short 2/2"

const LJ_MIN_TOUCHES    = 3;
const LJ_MIN_GAP_BARS   = 3;                        // min bars between rejection touches
const LJ_TOUCH_TOL      = 0.015;                    // ±1.5% wick must reach TL to count
const LJ_BREAK_STALE_MS = 7 * 24 * 60 * 60 * 1000; // discard breaks older than 7 days

function trendlineAt(tl, time) {
  return tl.slope * time + tl.intercept;
}

// Descending resistance TL: lower pivot highs, each closing BELOW the TL (rejection).
// Returns { tl, touchCount, breakBar, _dbg } or null.
// breakBar = first candle after 3rd+ rejection where close > TL.
function detectDescendingTLBreak(bars, wing = 2) {
  const pivots = [];
  for (let i = wing; i < bars.length - wing; i++) {
    let ok = true;
    for (let j = i - wing; j <= i + wing; j++) {
      if (j !== i && bars[j].high >= bars[i].high) { ok = false; break; }
    }
    if (ok) pivots.push({ idx: i, time: bars[i].time, price: bars[i].high });
  }
  if (pivots.length < LJ_MIN_TOUCHES) return null;

  // Try each possible rightmost pivot as end of a descending chain
  for (let end = pivots.length - 1; end >= LJ_MIN_TOUCHES - 1; end--) {
    // Build chain going left: each older pivot must be higher (= descending TL going right)
    const group = [end];
    for (let k = end - 1; k >= 0 && group.length < 12; k--) {
      const tail = group[group.length - 1];
      if (pivots[tail].idx - pivots[k].idx < LJ_MIN_GAP_BARS) continue;
      if (pivots[k].price > pivots[tail].price) group.push(k);
    }
    if (group.length < LJ_MIN_TOUCHES) continue;
    group.reverse(); // oldest → newest

    // Verify strict descent after reversal
    let ok = true;
    for (let k = 1; k < group.length; k++) {
      if (pivots[group[k]].price >= pivots[group[k - 1]].price) { ok = false; break; }
    }
    if (!ok) continue;

    // TL defined by oldest and newest pivot in group
    const p1 = pivots[group[0]], p2 = pivots[group[group.length - 1]];
    const slope     = (p2.price - p1.price) / (p2.time - p1.time);
    const intercept = p1.price - slope * p1.time;
    const tl        = { slope, intercept };

    // Validate each touch: wick reached TL (±1.5%) AND close was BELOW (rejection)
    let validTouches = 0;
    let lastTouchIdx = -1;
    const touchLog   = [];
    for (const gi of group) {
      const piv  = pivots[gi];
      const tlPx = trendlineAt(tl, piv.time);
      if (Math.abs(piv.price - tlPx) / tlPx <= LJ_TOUCH_TOL && bars[piv.idx].close < tlPx) {
        validTouches++;
        lastTouchIdx = piv.idx;
        touchLog.push({ time: new Date(piv.time * 1000).toISOString(), price: piv.price.toPrecision(6) });
      }
    }
    if (validTouches < LJ_MIN_TOUCHES || lastTouchIdx < 0) continue;

    // Find break bar: first candle after last touch with close ABOVE TL
    for (let j = lastTouchIdx + 1; j < bars.length; j++) {
      const tlPx = trendlineAt(tl, bars[j].time);
      if (bars[j].close > tlPx) {
        return {
          tl, touchCount: validTouches, breakBar: bars[j],
          _dbg: { touches: touchLog, breakTime: new Date(bars[j].time * 1000).toISOString() },
        };
      }
    }
  }
  return null;
}

// Ascending support TL: higher pivot lows, each closing ABOVE the TL (rejection).
// Returns { tl, touchCount, breakBar, _dbg } or null.
// breakBar = first candle after 3rd+ rejection where close < TL.
function detectAscendingTLBreak(bars, wing = 2) {
  const pivots = [];
  for (let i = wing; i < bars.length - wing; i++) {
    let ok = true;
    for (let j = i - wing; j <= i + wing; j++) {
      if (j !== i && bars[j].low <= bars[i].low) { ok = false; break; }
    }
    if (ok) pivots.push({ idx: i, time: bars[i].time, price: bars[i].low });
  }
  if (pivots.length < LJ_MIN_TOUCHES) return null;

  for (let end = pivots.length - 1; end >= LJ_MIN_TOUCHES - 1; end--) {
    const group = [end];
    for (let k = end - 1; k >= 0 && group.length < 12; k--) {
      const tail = group[group.length - 1];
      if (pivots[tail].idx - pivots[k].idx < LJ_MIN_GAP_BARS) continue;
      if (pivots[k].price < pivots[tail].price) group.push(k);
    }
    if (group.length < LJ_MIN_TOUCHES) continue;
    group.reverse();

    let ok = true;
    for (let k = 1; k < group.length; k++) {
      if (pivots[group[k]].price <= pivots[group[k - 1]].price) { ok = false; break; }
    }
    if (!ok) continue;

    const p1 = pivots[group[0]], p2 = pivots[group[group.length - 1]];
    const slope     = (p2.price - p1.price) / (p2.time - p1.time);
    const intercept = p1.price - slope * p1.time;
    const tl        = { slope, intercept };

    let validTouches = 0;
    let lastTouchIdx = -1;
    const touchLog   = [];
    for (const gi of group) {
      const piv  = pivots[gi];
      const tlPx = trendlineAt(tl, piv.time);
      if (Math.abs(piv.price - tlPx) / tlPx <= LJ_TOUCH_TOL && bars[piv.idx].close > tlPx) {
        validTouches++;
        lastTouchIdx = piv.idx;
        touchLog.push({ time: new Date(piv.time * 1000).toISOString(), price: piv.price.toPrecision(6) });
      }
    }
    if (validTouches < LJ_MIN_TOUCHES || lastTouchIdx < 0) continue;

    for (let j = lastTouchIdx + 1; j < bars.length; j++) {
      const tlPx = trendlineAt(tl, bars[j].time);
      if (bars[j].close < tlPx) {
        return {
          tl, touchCount: validTouches, breakBar: bars[j],
          _dbg: { touches: touchLog, breakTime: new Date(bars[j].time * 1000).toISOString() },
        };
      }
    }
  }
  return null;
}

// Detect W (LONG) or M (SHORT) on 1H bars that formed AFTER the break,
// on the OPPOSITE side of the broken TL.
// LONG W: two local lows BOTH ABOVE the broken descending TL → neckline = highest high between them.
// SHORT M: two local highs BOTH BELOW the broken ascending TL → neckline = lowest low between them.
// Returns { neckline, _dbg } or null.
function detectLJPattern(bars1h, direction, tl, breakTime) {
  // Only consider 1H bars that opened after the break candle
  const startIdx = bars1h.findIndex(b => b.time >= breakTime);
  if (startIdx < 0 || bars1h.length - startIdx < 5) return null;

  const postBreak = bars1h.slice(startIdx);
  const last      = postBreak.at(-1);
  const n         = postBreak.length;
  const MIN_GAP   = 2;

  if (direction === 'long') {
    for (let ri = n - 2; ri >= 1; ri--) {
      const tlRi = trendlineAt(tl, postBreak[ri].time);
      if (postBreak[ri].low <= tlRi) continue; // right low must be ABOVE broken TL
      for (let li = ri - MIN_GAP; li >= 0; li--) {
        const tlLi = trendlineAt(tl, postBreak[li].time);
        if (postBreak[li].low <= tlLi) continue; // left low must also be ABOVE broken TL
        const midBars = postBreak.slice(li + 1, ri);
        if (!midBars.length) continue;
        const neckline = Math.max(...midBars.map(b => b.high));
        if (last.close > neckline) {
          return {
            neckline,
            _dbg: {
              wLeft:    { time: new Date(postBreak[li].time * 1000).toISOString(), low: postBreak[li].low.toPrecision(6) },
              wRight:   { time: new Date(postBreak[ri].time * 1000).toISOString(), low: postBreak[ri].low.toPrecision(6) },
              neckline: neckline.toPrecision(6),
              alertBar: new Date(last.time * 1000).toISOString(),
            },
          };
        }
      }
    }
  } else {
    for (let ri = n - 2; ri >= 1; ri--) {
      const tlRi = trendlineAt(tl, postBreak[ri].time);
      if (postBreak[ri].high >= tlRi) continue; // right high must be BELOW broken TL
      for (let li = ri - MIN_GAP; li >= 0; li--) {
        const tlLi = trendlineAt(tl, postBreak[li].time);
        if (postBreak[li].high >= tlLi) continue; // left high must also be BELOW broken TL
        const midBars = postBreak.slice(li + 1, ri);
        if (!midBars.length) continue;
        const neckline = Math.min(...midBars.map(b => b.low));
        if (last.close < neckline) {
          return {
            neckline,
            _dbg: {
              mLeft:    { time: new Date(postBreak[li].time * 1000).toISOString(), high: postBreak[li].high.toPrecision(6) },
              mRight:   { time: new Date(postBreak[ri].time * 1000).toISOString(), high: postBreak[ri].high.toPrecision(6) },
              neckline: neckline.toPrecision(6),
              alertBar: new Date(last.time * 1000).toISOString(),
            },
          };
        }
      }
    }
  }
  return null;
}

function getLJConfluence(bars1h, direction) {
  const closes  = bars1h.map(b => b.close);
  const hist    = calcMACDHistogram(closes);
  const histNow = hist.at(-1), histPrv = hist.at(-2);
  const hasRSI  = checkDivergence(bars1h, calcRSI(closes), direction);
  const hasOBV  = checkDivergence(bars1h, calcOBV(bars1h), direction, 0.005);
  const hasMACD = direction === 'long'
    ? isFinite(histNow) && histNow > 0 && isFinite(histPrv) && histNow > histPrv
    : isFinite(histNow) && histNow < 0 && isFinite(histPrv) && histNow < histPrv;
  return { hasRSI, hasOBV, hasMACD };
}

function buildLJAlert(symbol, tf, direction, stage, neckline, entry, hasRSI, hasMACD, hasOBV) {
  const coin    = SYMBOL_DISPLAY_NAMES[symbol] || symbol.replace('_USDT', '');
  const dir     = direction === 'long' ? 'LONG' : 'SHORT';
  const pat     = direction === 'long' ? 'W' : 'M';
  const score   = (hasRSI ? 1 : 0) + (hasMACD ? 1 : 0) + (hasOBV ? 1 : 0);
  const confStr = `${score}/3`;
  const time    = new Date().toISOString().slice(11, 16) + ' UTC';
  if (stage === 1) {
    return [
      `📐 <b>LJ ${dir} 1/2 — ${coin} | ${tf} TL break + 1H ${pat} neckline breakout</b>`,
      `Neckline: $${neckline.toPrecision(6)} | Entry: $${entry.toPrecision(6)}`,
      `RSI div: ${hasRSI ? '✅' : '❌'} | MACD: ${hasMACD ? '✅' : '❌'} | OBV: ${hasOBV ? '✅' : '❌'} | Confluence: ${confStr}`,
      `Time: ${time}`,
    ].join('\n');
  }
  return [
    `📐 <b>LJ ${dir} 2/2 — ${coin} | ${tf} neckline retest confirmed</b>`,
    `Neckline: $${neckline.toPrecision(6)}`,
    `RSI div: ${hasRSI ? '✅' : '❌'} | MACD: ${hasMACD ? '✅' : '❌'} | OBV: ${hasOBV ? '✅' : '❌'} | Confluence: ${confStr}`,
    `Time: ${time}`,
  ].join('\n');
}

async function detectLJSetup(symbol, timeframes) {
  try {
    const buf = klineBuffers.get(symbol);
    if (!buf) return;
    const { h1, h4, d1, w1 } = buf;
    if (!h1 || h1.length < 20) return;
    const tfBars = { '4H': h4, 'D1': d1, 'W1': w1 };
    const lastH1 = h1.at(-1);

    for (const tf of timeframes) {
      const htfBars = tfBars[tf];
      if (!htfBars || htfBars.length < 10) continue;

      for (const direction of ['long', 'short']) {
        const stageKey = `${symbol}:${tf}:${direction}`;

        // LONG: descending resistance TL broken upward → W forms above
        // SHORT: ascending support TL broken downward → M forms below
        const tlBreak = direction === 'long'
          ? detectDescendingTLBreak(htfBars)
          : detectAscendingTLBreak(htfBars);
        if (!tlBreak) continue;

        const { tl, touchCount, breakBar, _dbg } = tlBreak;

        // Discard breaks older than 7 days — setup has expired
        if ((lastH1.time - breakBar.time) * 1000 > LJ_BREAK_STALE_MS) continue;

        // Price must still be on the break side of the TL
        const tlNow  = trendlineAt(tl, lastH1.time);
        const sideOk = direction === 'long'
          ? lastH1.close > tlNow
          : lastH1.close < tlNow;
        if (!sideOk) continue;

        // ── Stage 2: neckline retest ─────────────────────────────────────────
        const s1Data = ljStage1.get(stageKey);
        if (s1Data) {
          const { neckline, nk } = s1Data;
          const retested  = direction === 'long'
            ? lastH1.low  <= neckline * 1.005 && lastH1.low  >= neckline * 0.995
            : lastH1.high >= neckline * 0.995 && lastH1.high <= neckline * 1.005;
          const confirmed = direction === 'long'
            ? lastH1.close > neckline
            : lastH1.close < neckline;
          if (retested && confirmed && !wasAlertedLJRecently(symbol, tf, direction, nk + ':2')) {
            const { hasRSI, hasMACD, hasOBV } = getLJConfluence(h1, direction);
            console.log(`[lj] ★★ ${symbol} LJ ${direction.toUpperCase()} 2/2 | ${tf} | neckline=${neckline.toPrecision(6)}`);
            const ljText2 = buildLJAlert(symbol, tf, direction, 2, neckline, lastH1.close, hasRSI, hasMACD, hasOBV);
            if (ALERTS_ENABLED) {
              await sendTelegram(ljText2);
            } else {
              console.log(`[MUTED] Would have sent: ${ljText2.replace(/<[^>]+>/g, '')}`);
            }
            forwardSignalToSAE(buildLJSAEPayload({
              symbol, direction, stage: 2, htfTf: tf, neckline, entry: lastH1.close,
            })).catch(() => {});
            markAlertedLJ(symbol, tf, direction, nk + ':2');
            ljStage1.delete(stageKey);
            continue;
          }
        }

        // ── Stage 1: W/M neckline breakout ──────────────────────────────────
        const pattern = detectLJPattern(h1, direction, tl, breakBar.time);
        if (!pattern) continue;
        const { neckline, _dbg: patDbg } = pattern;
        const nk = neckline.toPrecision(5);
        if (wasAlertedLJRecently(symbol, tf, direction, nk + ':1')) continue;

        // Debug trace
        console.log(
          `[lj] ★ ${symbol} LJ ${direction.toUpperCase()} 1/2 | ${tf}` +
          `\n  touches(${touchCount}): ${_dbg.touches.map(t => `${t.time}@${t.price}`).join(' | ')}` +
          `\n  break: ${_dbg.breakTime}` +
          `\n  ${direction === 'long' ? 'W' : 'M'} neckline: ${nk} | ${JSON.stringify(patDbg)}` +
          `\n  entry: ${lastH1.close.toPrecision(6)}`
        );

        const { hasRSI, hasMACD, hasOBV } = getLJConfluence(h1, direction);
        const ljText1 = buildLJAlert(symbol, tf, direction, 1, neckline, lastH1.close, hasRSI, hasMACD, hasOBV);
        if (ALERTS_ENABLED) {
          await sendTelegram(ljText1);
        } else {
          console.log(`[MUTED] Would have sent: ${ljText1.replace(/<[^>]+>/g, '')}`);
        }
        forwardSignalToSAE(buildLJSAEPayload({
          symbol, direction, stage: 1, htfTf: tf, neckline, entry: lastH1.close,
        })).catch(() => {});
        markAlertedLJ(symbol, tf, direction, nk + ':1');
        ljStage1.set(stageKey, { neckline, nk });
      }
    }
  } catch (err) {
    console.error(`[lj] detectLJSetup ${symbol}: ${err.message}`);
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
    wsSend({ method: 'sub.kline', param: { symbol, interval: 'Hour4' } });
  }
  console.log(`[scanner] Subscribed klines for ${symbols.length} symbols (5m + 1H + 4H)`);
}

function unsubscribeSymbols(symbols) {
  for (const symbol of symbols) {
    wsSend({ method: 'unsub.kline', param: { symbol, interval: 'Min5'  } });
    wsSend({ method: 'unsub.kline', param: { symbol, interval: 'Min60' } });
    wsSend({ method: 'unsub.kline', param: { symbol, interval: 'Hour4' } });
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
            if (candleCloseCount % 50 === 0) {
              console.log(`[scanner] ✓ ${candleCloseCount} candle closes processed (latest: ${symbol})`);
            }
            detectSFP(symbol).catch(err =>
              console.error(`[scanner] detectSFP ${symbol}: ${err.message}`)
            );
          }
          if (interval === 'Min60') {
            detectLJSetup(symbol, ['4H', 'D1', 'W1']).catch(err =>
              console.error(`[lj] detectLJSetup ${symbol}: ${err.message}`)
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
  ws.on('error', (err) => { console.error(`[scanner] WebSocket error: ${err.message}`); });
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
      if (added.length) { await bootstrapKlines(added); subscribeSymbols(added); }
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
  console.log('[scanner] ── CTA SFP + LJ Setup Scanner starting ──');
  console.log('[scanner] SFP: Location → Structure (W/M on key level) → Momentum | 5m candle close');
  console.log('[scanner] LJ:  HTF TL (3+ rejections) → clean break → 1H W/M on opposite side → neckline break alert | 1H close');

  process.on('unhandledRejection', (reason) => console.error('[scanner] Unhandled rejection:', reason));
  process.on('uncaughtException',  (err)    => console.error('[scanner] Uncaught exception:',  err.message));

  try {
    topSymbols = await fetchTopSymbols();
    await bootstrapKlines(topSymbols);
  } catch (err) {
    console.error('[scanner] Bootstrap failed — will retry on WS reconnect:', err.message);
    topSymbols = topSymbols.length ? topSymbols : [];
  }

  connect();
  setInterval(refreshTopSymbols, VOLUME_REFRESH_MS);
  setTimeout(() => { setInterval(refreshLevels, LEVEL_REFRESH_MS); }, 30 * 60 * 1000);

  console.log('[scanner] Scanner armed — SFP (5m WS) + LJ Setup (1H WS)');
}
