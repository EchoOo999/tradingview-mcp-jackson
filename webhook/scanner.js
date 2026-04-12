/**
 * SFP + GS Location Scanner for MEXC Perpetual Futures
 *
 * Runs every 5 minutes. Scans all USDT perpetuals for:
 *   - SFP (Swing Failure Pattern) on 5m candles vs 20-day high/low reference
 *   - GS Location (fib retracement zone) on 1H candles
 *   - RSI divergence on 5m
 *
 * Read-only — no trading, no auth required. Public MEXC endpoints only.
 */

const MEXC_BASE        = 'https://contract.mexc.com';
const TELEGRAM_API     = 'https://api.telegram.org';
const SCAN_INTERVAL_MS = 5 * 60 * 1000;      // 5 minutes
const ALERT_RESET_MS   = 4 * 60 * 60 * 1000; // 4 hours dedup window
const BATCH_SIZE       = 8;                   // concurrent symbols per batch
const BATCH_DELAY_MS   = 350;                 // ms between batches (rate-limit guard)
const RSI_PERIOD       = 14;
const KLINES_5M        = 100;
const KLINES_1H        = 500;                 // ~20 days

// ── Dedup tracker ─────────────────────────────────────────────────────────────
// key: "SYMBOL:long" | "SYMBOL:short"  →  timestamp of last alert
const alerted = new Map();

function wasAlertedRecently(symbol, direction) {
  const ts = alerted.get(`${symbol}:${direction}`);
  return ts != null && Date.now() - ts < ALERT_RESET_MS;
}
function markAlerted(symbol, direction) {
  alerted.set(`${symbol}:${direction}`, Date.now());
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
async function fetchJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── MEXC public data ──────────────────────────────────────────────────────────
async function fetchAllSymbols() {
  const data = await fetchJSON(`${MEXC_BASE}/api/v1/contract/detail`);
  if (data.code !== 200 && data.code !== 0) throw new Error(`contract/detail: ${data.message}`);
  return (data.data || [])
    .filter(c => c.symbol && c.symbol.endsWith('_USDT'))
    .map(c => c.symbol);
}

/**
 * Returns array of { time, open, high, low, close, vol }
 * interval: 'Min5' | 'Min60'
 */
async function fetchKlines(symbol, interval, limit) {
  const url = `${MEXC_BASE}/api/v1/contract/kline/${symbol}?interval=${interval}&limit=${limit}`;
  const data = await fetchJSON(url);
  if (data.code !== 200 && data.code !== 0) throw new Error(`kline ${interval}: ${data.message}`);
  const d = data.data;
  if (!d || !Array.isArray(d.time) || !d.time.length) return [];
  return d.time.map((t, i) => ({
    time:  t,
    open:  parseFloat(d.open[i]),
    high:  parseFloat(d.high[i]),
    low:   parseFloat(d.low[i]),
    close: parseFloat(d.close[i]),
    vol:   parseFloat((d.vol || [])[i] || 0),
  }));
}

// ── RSI ───────────────────────────────────────────────────────────────────────
/**
 * Returns an array of RSI values (same length as closes).
 * Positions < RSI_PERIOD are null (not enough history).
 */
function calcRSI(closes, period = RSI_PERIOD) {
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
/**
 * Returns { highs, lows } — arrays of { index, price }
 * A pivot high: highest bar within ±lookback neighbours.
 */
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

// ── RSI Divergence (simplified) ───────────────────────────────────────────────
/**
 * direction 'long'  → bull div: lower low in price, higher low in RSI
 * direction 'short' → bear div: higher high in price, lower high in RSI
 */
function checkDivergence(bars5m, direction) {
  const closes = bars5m.map(b => b.close);
  const rsiArr = calcRSI(closes);
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
/**
 * Finds last swing high + low on 1H (last 50 bars).
 * Measures retracement of current price between those levels.
 *
 * direction 'long':
 *   retrace = (swingHigh - price) / range
 *   0.618–0.786 → RLZ   (deep retracement long)
 *   0.382–0.500 → PCZ   (shallow / trend continuation long)
 *
 * direction 'short':
 *   retrace = (price - swingLow) / range
 *   0.618–0.786 → SRZ   (deep retracement short)
 *   0.382–0.500 → DCZ   (shallow / trend continuation short)
 */
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
    const retrace = (swingHigh - currentPrice) / range;
    if (retrace >= 0.618 && retrace <= 0.786) return 'RLZ (0.618–0.786)';
    if (retrace >= 0.382 && retrace <= 0.500) return 'PCZ (0.382–0.500)';
  } else {
    const retrace = (currentPrice - swingLow) / range;
    if (retrace >= 0.618 && retrace <= 0.786) return 'SRZ (0.618–0.786)';
    if (retrace >= 0.382 && retrace <= 0.500) return 'DCZ (0.382–0.500)';
  }
  return null;
}

// ── Telegram sender ───────────────────────────────────────────────────────────
async function sendTelegram(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('[scanner] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — alert skipped');
    return;
  }
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`[scanner] Telegram error: ${err.slice(0, 200)}`);
    }
  } catch (err) {
    console.error(`[scanner] Telegram send failed: ${err.message}`);
  }
}

// ── Alert message builder ─────────────────────────────────────────────────────
function buildAlertMessage(symbol, direction, location, hasDivergence) {
  const coin    = symbol.replace('_', '');
  const time    = new Date().toISOString().slice(11, 16) + ' UTC';
  const dir     = direction === 'long' ? 'LONG' : 'SHORT';
  const level   = direction === 'long' ? 'PWL swept' : 'PWH swept';
  const divLine = hasDivergence ? 'Divergence: RSI' : null;

  const lines = location
    ? [
        `🎯 <b>SFP + GS LOCATION</b>`,
        `Coin: ${coin}`,
        `Direction: ${dir}`,
        `Level: ${level}`,
        `Location: ${location}`,
        divLine,
        `Time: ${time}`,
      ]
    : [
        `⚡ <b>SFP ONLY</b>`,
        `Coin: ${coin}`,
        `Direction: ${dir}`,
        `Level: ${level}`,
        divLine,
        `Time: ${time}`,
      ];

  return lines.filter(Boolean).join('\n');
}

// ── Per-symbol analysis ───────────────────────────────────────────────────────
async function scanSymbol(symbol) {
  try {
    // Fetch both timeframes in parallel
    const [bars5m, bars1h] = await Promise.all([
      fetchKlines(symbol, 'Min5',  KLINES_5M),
      fetchKlines(symbol, 'Min60', KLINES_1H),
    ]);

    if (bars5m.length < 30 || bars1h.length < 50) return;

    // ── Reference levels: highest high + lowest low of last 20 days on 1H ──
    const refBars = bars1h.slice(-480); // 480h = 20 days
    const PWH = Math.max(...refBars.map(b => b.high));
    const PWL = Math.min(...refBars.map(b => b.low));

    // Use the second-to-last 5m bar (last fully closed candle)
    const sfpBar      = bars5m[bars5m.length - 2];
    const currentPrice = bars5m[bars5m.length - 1].close;
    if (!sfpBar) return;

    const isLongSFP  = sfpBar.low  < PWL && sfpBar.close > PWL;
    const isShortSFP = sfpBar.high > PWH && sfpBar.close < PWH;
    if (!isLongSFP && !isShortSFP) return;

    // ── Check each triggered direction ──────────────────────────────────────
    for (const direction of ['long', 'short']) {
      if (direction === 'long'  && !isLongSFP)  continue;
      if (direction === 'short' && !isShortSFP) continue;
      if (wasAlertedRecently(symbol, direction)) continue;

      const hasDivergence = checkDivergence(bars5m, direction);
      const location      = checkGSLocation(bars1h, direction, currentPrice);

      console.log(
        `[scanner] SIGNAL ${symbol} ${direction.toUpperCase()} | ` +
        `location=${location || 'none'} div=${hasDivergence} ` +
        `PWH=${PWH} PWL=${PWL} sfpBar.high=${sfpBar.high} sfpBar.low=${sfpBar.low}`
      );

      const msg = buildAlertMessage(symbol, direction, location, hasDivergence);
      await sendTelegram(msg);
      markAlerted(symbol, direction);
    }
  } catch (err) {
    // Suppress 404s for thin/delisted symbols; log other errors briefly
    if (!String(err.message).includes('HTTP 4')) {
      console.error(`[scanner] ${symbol}: ${err.message}`);
    }
  }
}

// ── Full scan ─────────────────────────────────────────────────────────────────
async function scanAll() {
  const startTime = Date.now();
  console.log(`[scanner] ── Scan started ${new Date(startTime).toISOString()} ──`);

  let symbols;
  try {
    symbols = await fetchAllSymbols();
    console.log(`[scanner] ${symbols.length} USDT perpetuals found`);
  } catch (err) {
    console.error(`[scanner] fetchAllSymbols failed: ${err.message}`);
    return;
  }

  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(s => scanSymbol(s)));
    // Throttle between batches to stay within rate limits
    if (i + BATCH_SIZE < symbols.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[scanner] ── Scan complete in ${elapsed}s ──`);
}

// ── Export ────────────────────────────────────────────────────────────────────
export function startScanner() {
  console.log('[scanner] SFP scanner armed — interval=5m, dedup=4h');
  // First run immediately, then every 5 minutes
  scanAll().catch(err => console.error('[scanner] initial scan error:', err.message));
  setInterval(
    () => scanAll().catch(err => console.error('[scanner] scan error:', err.message)),
    SCAN_INTERVAL_MS
  );
}
