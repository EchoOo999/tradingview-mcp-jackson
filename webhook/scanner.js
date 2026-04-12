/**
 * SFP + GS Location Scanner for MEXC Perpetual Futures
 *
 * RATE LIMIT DESIGN (confirmed from MEXC docs):
 *   /contract/kline  → 20 req / 2s (= 10 req/s max). We target ~0.7 req/s (7% of max).
 *   /contract/detail → 1 req / 5s. Called once per scan cycle only.
 *   Error code 510   → "Excessive frequency of requests"
 *
 * SAFETY MODEL:
 *   - Fully sequential: one HTTP request at a time, no batching, no Promise.all
 *   - 500ms pause between the 5m and 1H request for the same coin
 *   - 1500ms pause after each coin (= ~2s per coin total = ~0.5 req/s average)
 *   - On any 510 / HTTP 429 response: exponential backoff (10s → 20s → 40s)
 *   - If still failing after 3 retries: pause the entire scanner for 10 minutes
 *   - Only one scan cycle runs at a time (overlap guard)
 *   - Logs requests/minute every 60 seconds
 *
 * Read-only — no trading, no MEXC auth. Public endpoints only.
 */

const MEXC_BASE        = 'https://contract.mexc.com';
const TELEGRAM_API     = 'https://api.telegram.org';

// ── Timing constants ──────────────────────────────────────────────────────────
const DELAY_BETWEEN_REQUESTS_MS = 500;   // between 5m and 1H fetch for same coin
const DELAY_BETWEEN_COINS_MS    = 1500;  // after finishing a coin before the next
const SCAN_COOLDOWN_MS          = 5 * 60 * 1000;   // min gap between scan starts
const RATE_LIMIT_PAUSE_MS       = 10 * 60 * 1000;  // full scanner pause on rate limit
const BACKOFF_BASE_MS           = 10_000;           // first backoff: 10s
const MAX_RETRIES               = 3;

// ── Dedup: { "SYMBOL:long" | "SYMBOL:short" → timestamp } ────────────────────
const ALERT_RESET_MS = 4 * 60 * 60 * 1000; // 4 hours
const alerted        = new Map();

function wasAlertedRecently(symbol, direction) {
  const ts = alerted.get(`${symbol}:${direction}`);
  return ts != null && Date.now() - ts < ALERT_RESET_MS;
}
function markAlerted(symbol, direction) {
  alerted.set(`${symbol}:${direction}`, Date.now());
}

// ── Requests-per-minute tracker ───────────────────────────────────────────────
let reqCount   = 0;   // total requests in current 1-minute window
let reqWindowStart = Date.now();

function trackRequest() {
  reqCount++;
}
function logRPM() {
  const elapsed = (Date.now() - reqWindowStart) / 1000;
  const rpm     = (reqCount / elapsed * 60).toFixed(1);
  console.log(`[scanner:rpm] ${reqCount} requests in last ${elapsed.toFixed(0)}s → ~${rpm} req/min (limit ~600/min)`);
  reqCount       = 0;
  reqWindowStart = Date.now();
}

// ── Scanner state ─────────────────────────────────────────────────────────────
let isScanning       = false;
let rateLimitedUntil = 0;   // epoch ms — scanner paused until this time

// ── Sleep helper ──────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── HTTP fetch with retry + exponential backoff ───────────────────────────────
/**
 * Fetches a URL and returns parsed JSON.
 * On MEXC error code 510 or HTTP 429/418, backs off exponentially.
 * If all retries exhausted, sets rateLimitedUntil and throws.
 */
async function fetchJSON(url) {
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    trackRequest();
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      // Network/timeout error — not a rate limit, just rethrow
      throw err;
    }

    // ── Rate limit detection ─────────────────────────────────────────────────
    if (res.status === 429 || res.status === 418) {
      const backoff = BACKOFF_BASE_MS * Math.pow(2, attempt);
      console.warn(`[scanner] HTTP ${res.status} rate limit on ${url} — backoff ${backoff / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(backoff);
      attempt++;
      continue;
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();

    // ── MEXC error code 510 ──────────────────────────────────────────────────
    if (data.code === 510) {
      const backoff = BACKOFF_BASE_MS * Math.pow(2, attempt);
      console.warn(`[scanner] MEXC 510 (rate limit) on ${url} — backoff ${backoff / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(backoff);
      attempt++;
      continue;
    }

    return data;
  }

  // All retries exhausted — pause the entire scanner for 10 minutes
  const pauseUntil = new Date(Date.now() + RATE_LIMIT_PAUSE_MS).toISOString();
  console.error(`[scanner] !! Rate limit retries exhausted. Pausing scanner until ${pauseUntil}`);
  rateLimitedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
  throw new Error('RATE_LIMIT_EXHAUSTED');
}

// ── MEXC public data ──────────────────────────────────────────────────────────
const MIN_VOLUME_USDT = 50_000_000; // 50M USDT 24h minimum

/**
 * Fetches all symbols from /contract/detail, then filters by:
 *   - ends with _USDT
 *   - does NOT contain "STOCK"
 *   - 24h USDT volume (amount24) > 50M  (from /contract/ticker)
 *
 * Returns filtered symbol list and logs counts.
 * Note: /contract/detail is rate-limited to 1 req/5s — caller must sleep after.
 */
async function fetchAllSymbols() {
  // Step 1: all _USDT symbols (no STOCK)
  const detailData = await fetchJSON(`${MEXC_BASE}/api/v1/contract/detail`);
  if (detailData.code !== 200 && detailData.code !== 0) throw new Error(`contract/detail error: ${detailData.message}`);

  const base = (detailData.data || [])
    .filter(c => c.symbol && c.symbol.endsWith('_USDT') && !c.symbol.includes('STOCK'))
    .map(c => c.symbol);

  // Step 2: 24h ticker for volume filter (single request, all symbols)
  // /contract/ticker has same 20req/2s limit — one call, no issue
  await sleep(5000); // respect /contract/detail 1req/5s before next call
  const tickerData = await fetchJSON(`${MEXC_BASE}/api/v1/contract/ticker`);
  if (tickerData.code !== 200 && tickerData.code !== 0) throw new Error(`contract/ticker error: ${tickerData.message}`);

  // Build volume map: symbol → amount24 (USDT turnover)
  const volumeMap = new Map();
  for (const t of (tickerData.data || [])) {
    if (t.symbol) volumeMap.set(t.symbol, parseFloat(t.amount24 || 0));
  }

  // Step 3: apply volume filter
  const filtered = base.filter(sym => (volumeMap.get(sym) ?? 0) >= MIN_VOLUME_USDT);

  console.log(
    `[scanner] Symbol filter: ${base.length} _USDT (no STOCK) → ` +
    `${filtered.length} pass 50M volume | dropped ${base.length - filtered.length}`
  );

  return filtered;
}

/**
 * Fetch klines for one symbol/interval.
 * Returns array of { time, open, high, low, close, vol } or null on soft failure.
 */
async function fetchKlines(symbol, interval, limit) {
  const url  = `${MEXC_BASE}/api/v1/contract/kline/${symbol}?interval=${interval}&limit=${limit}`;
  const data = await fetchJSON(url);

  if (data.code !== 200 && data.code !== 0) {
    throw new Error(`kline ${interval} for ${symbol}: ${data.message}`);
  }

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

// ── RSI Divergence ────────────────────────────────────────────────────────────
function checkDivergence(bars5m, direction) {
  const rsiArr      = calcRSI(bars5m.map(b => b.close));
  const { highs, lows } = findPivots(bars5m, 3);

  if (direction === 'short') {
    const last2 = highs.slice(-2);
    if (last2.length < 2) return false;
    const [h1, h2] = last2;
    const r1 = rsiArr[h1.index], r2 = rsiArr[h2.index];
    if (r1 == null || r2 == null) return false;
    return h2.price > h1.price && r2 < r1;
  } else {
    const last2 = lows.slice(-2);
    if (last2.length < 2) return false;
    const [l1, l2] = last2;
    const r1 = rsiArr[l1.index], r2 = rsiArr[l2.index];
    if (r1 == null || r2 == null) return false;
    return l2.price < l1.price && r2 > r1;
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

// ── Telegram ──────────────────────────────────────────────────────────────────
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

function buildAlertMessage(symbol, direction, location, hasDivergence) {
  const coin  = symbol.replace('_', '');
  const time  = new Date().toISOString().slice(11, 16) + ' UTC';
  const dir   = direction === 'long' ? 'LONG' : 'SHORT';
  const level = direction === 'long' ? 'PWL swept' : 'PWH swept';
  const div   = hasDivergence ? '\nDivergence: RSI' : '';

  return location
    ? `🎯 <b>SFP + GS LOCATION</b>\nCoin: ${coin}\nDirection: ${dir}\nLevel: ${level}\nLocation: ${location}${div}\nTime: ${time}`
    : `⚡ <b>SFP ONLY</b>\nCoin: ${coin}\nDirection: ${dir}\nLevel: ${level}${div}\nTime: ${time}`;
}

// ── Per-symbol analysis ───────────────────────────────────────────────────────
/**
 * Fetches klines sequentially (5m, pause, 1H) then runs SFP + GS checks.
 * Returns true if it ran cleanly, throws if rate-limited.
 */
async function scanSymbol(symbol) {
  // ── 5m klines ──────────────────────────────────────────────────────────────
  let bars5m;
  try {
    bars5m = await fetchKlines(symbol, 'Min5', 100);
  } catch (err) {
    if (err.message === 'RATE_LIMIT_EXHAUSTED') throw err; // bubble up
    if (!err.message.includes('HTTP 4')) {
      console.error(`[scanner] ${symbol} 5m fetch: ${err.message}`);
    }
    return;
  }

  await sleep(DELAY_BETWEEN_REQUESTS_MS); // 500ms between the two requests

  // ── 1H klines ──────────────────────────────────────────────────────────────
  let bars1h;
  try {
    bars1h = await fetchKlines(symbol, 'Min60', 500);
  } catch (err) {
    if (err.message === 'RATE_LIMIT_EXHAUSTED') throw err;
    if (!err.message.includes('HTTP 4')) {
      console.error(`[scanner] ${symbol} 1H fetch: ${err.message}`);
    }
    return;
  }

  // ── Analysis ────────────────────────────────────────────────────────────────
  if (bars5m.length < 30 || bars1h.length < 50) return;

  try {
    // PWH/PWL = highest high + lowest low of last 20 days on 1H (480 bars)
    const refBars = bars1h.slice(-480);
    const PWH     = Math.max(...refBars.map(b => b.high));
    const PWL     = Math.min(...refBars.map(b => b.low));

    if (!isFinite(PWH) || !isFinite(PWL)) return; // bad kline data — skip

    // Second-to-last 5m bar = last fully closed candle
    const sfpBar       = bars5m[bars5m.length - 2];
    const currentPrice = bars5m[bars5m.length - 1].close;
    if (!sfpBar) return;

    const isLongSFP  = sfpBar.low  < PWL && sfpBar.close > PWL;
    const isShortSFP = sfpBar.high > PWH && sfpBar.close < PWH;
    if (!isLongSFP && !isShortSFP) return;

    for (const direction of ['long', 'short']) {
      if (direction === 'long'  && !isLongSFP)  continue;
      if (direction === 'short' && !isShortSFP) continue;
      if (wasAlertedRecently(symbol, direction)) continue;

      const hasDivergence = checkDivergence(bars5m, direction);
      const location      = checkGSLocation(bars1h, direction, currentPrice);

      console.log(
        `[scanner] ★ SIGNAL ${symbol} ${direction.toUpperCase()} | ` +
        `location=${location || 'none'} | div=${hasDivergence} | ` +
        `PWH=${PWH.toFixed(4)} PWL=${PWL.toFixed(4)} | ` +
        `sfp.high=${sfpBar.high} sfp.low=${sfpBar.low} sfp.close=${sfpBar.close}`
      );

      await sendTelegram(buildAlertMessage(symbol, direction, location, hasDivergence));
      markAlerted(symbol, direction);
    }
  } catch (err) {
    console.error(`[scanner] ${symbol} analysis error: ${err.message}`);
  }
}

// ── Full scan cycle ───────────────────────────────────────────────────────────
async function scanAll() {
  if (isScanning) {
    console.log('[scanner] Previous scan still running — skipping this tick');
    return;
  }

  if (Date.now() < rateLimitedUntil) {
    const resumeIn = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
    console.log(`[scanner] Rate-limit pause active — resuming in ${resumeIn}s`);
    return;
  }

  isScanning = true;
  const startTime = Date.now();
  console.log(`[scanner] ── Scan started ${new Date(startTime).toISOString()} ──`);

  // Reset req/min tracker at scan start
  reqCount       = 0;
  reqWindowStart = Date.now();
  const rpmTimer = setInterval(logRPM, 60_000);

  let symbols;
  try {
    symbols = await fetchAllSymbols(); // includes 5s sleep + volume filter internally
    console.log(`[scanner] ${symbols.length} coins queued | ETA: ~${Math.ceil(symbols.length * 2 / 60)}min`);
  } catch (err) {
    console.error(`[scanner] fetchAllSymbols failed: ${err.message}`);
    clearInterval(rpmTimer);
    isScanning = false;
    return;
  }

  let processed = 0;
  let errCount  = 0;

  for (const symbol of symbols) {
    // Re-check rate limit pause inside the loop in case it was set mid-scan
    if (Date.now() < rateLimitedUntil) {
      const resumeIn = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
      console.warn(`[scanner] Rate limit triggered mid-scan — stopping scan, resuming in ${resumeIn}s`);
      break;
    }

    try {
      await scanSymbol(symbol);
      processed++;
    } catch (err) {
      if (err.message === 'RATE_LIMIT_EXHAUSTED') {
        console.error('[scanner] Rate limit exhausted — aborting scan');
        break;
      }
      errCount++;
      console.error(`[scanner] ${symbol}: ${err.message}`);
    }

    // 1500ms pause between coins (+ 500ms already spent between requests = ~2s per coin)
    await sleep(DELAY_BETWEEN_COINS_MS);
  }

  clearInterval(rpmTimer);
  logRPM(); // final rpm log

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[scanner] ── Scan complete: ${processed}/${symbols.length} coins in ${elapsed}s | errors: ${errCount} ──`);

  isScanning = false;
}

// ── Export ────────────────────────────────────────────────────────────────────
export function startScanner() {
  console.log('[scanner] SFP scanner armed');
  console.log('[scanner] Rate limit design: sequential | ~0.7 req/s | 50% of 10 req/s max');
  console.log('[scanner] Dedup window: 4h | Rate limit pause: 10min | Scan cooldown: 5min');

  // Catch unhandled rejections at process level — prevents Node from crashing
  // on any unexpected async error that escapes our per-function try-catch blocks.
  process.on('unhandledRejection', (reason) => {
    console.error('[scanner] Unhandled rejection (caught at process level):', reason);
    // Do NOT exit — log and continue. Railway keeps the process alive.
  });
  process.on('uncaughtException', (err) => {
    console.error('[scanner] Uncaught exception (caught at process level):', err.message);
    // Do NOT exit — log and continue.
  });

  // Use setTimeout chain so scans NEVER overlap regardless of how long they take.
  // .catch() on scheduleNext() prevents an unhandled rejection from crashing Node.
  async function scheduleNext() {
    try {
      await scanAll();
    } catch (err) {
      // scanAll() has comprehensive try-catch internally, but this is the final safety net.
      console.error('[scanner] Unexpected error in scanAll (caught in scheduleNext):', err.message);
      isScanning = false; // ensure we don't get stuck
    }
    setTimeout(scheduleNext, SCAN_COOLDOWN_MS);
  }

  scheduleNext().catch(err => {
    console.error('[scanner] scheduleNext() rejected unexpectedly:', err.message);
  });
}
