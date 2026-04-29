/**
 * TradingView → MEXC Futures webhook server
 *
 * Receives POST /webhook from TradingView alerts and places orders on MEXC Futures.
 *
 * Expected JSON body from TradingView:
 * {
 *   "secret":   "your_webhook_secret",   // optional WEBHOOK_SECRET guard
 *   "symbol":   "BTC_USDT",              // MEXC contract symbol
 *   "side":     "open_long",             // open_long | close_long | open_short | close_short
 *   "type":     "market",               // market | limit
 *   "leverage": 10,
 *   "usd_risk": 50,                      // USD amount to risk per trade
 *   "price":    65000,                   // required for limit orders (ignored for market)
 *   "tp":       67000,                   // take profit price (optional)
 *   "sl":       63000                    // stop loss price (required for position sizing)
 * }
 */

import express from 'express';
import cors from 'cors';
import { placeOrder, getBalance } from './mexc.js';
import { startScanner } from './scanner.js';
import { forwardRegimeToSAE } from './sae_regime_forwarder.js';

const app = express();
app.use(cors());
app.use(express.json());

const PORT          = process.env.PORT          || 3000;
const API_KEY       = process.env.MEXC_API_KEY;
const API_SECRET    = process.env.MEXC_SECRET;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET; // optional
const BALANCE_API_KEY = process.env.BALANCE_API_KEY; // required for GET /balance

if (!API_KEY || !API_SECRET) {
  console.error('ERROR: MEXC_API_KEY and MEXC_SECRET must be set in environment.');
  process.exit(1);
}

if (!BALANCE_API_KEY) {
  console.error('ERROR: BALANCE_API_KEY must be set in environment. Refuse to start with an open /balance endpoint.');
  process.exit(1);
}

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', service: 'mexc-webhook' }));

// Test Telegram connectivity
app.get('/test-telegram', async (req, res) => {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return res.status(500).json({ success: false, error: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set' });
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: '🧪 Test alert - scanner is alive', parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error(`[test-telegram] Telegram API error: ${errText.slice(0, 300)}`);
      return res.status(500).json({ success: false, error: errText.slice(0, 300) });
    }
    console.log('[test-telegram] Test message sent OK');
    return res.json({ success: true, message: 'Telegram test sent' });
  } catch (err) {
    console.error(`[test-telegram] fetch failed: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Wallet balance — gated by X-API-Key header (shared secret with the chrome extension)
app.get('/balance', async (req, res) => {
  if (req.get('X-API-Key') !== BALANCE_API_KEY) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }
  try {
    const { total } = await getBalance(API_KEY, API_SECRET);
    return res.json({ success: true, total });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Balance fetch failed: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Main webhook endpoint
app.post('/webhook', async (req, res) => {
  const body = req.body;

  // Optional secret guard
  if (WEBHOOK_SECRET && body.secret !== WEBHOOK_SECRET) {
    console.warn(`[${new Date().toISOString()}] Rejected: invalid secret`);
    return res.status(403).json({ success: false, error: 'Invalid webhook secret' });
  }

  const { symbol, side, type, leverage, usd_risk, price, tp, sl } = body;

  // Validate required fields
  const missing = [];
  if (!symbol)                missing.push('symbol');
  if (!side)                  missing.push('side');
  if (!type)                  missing.push('type');
  if (!leverage)              missing.push('leverage');
  if (!usd_risk)              missing.push('usd_risk');
  if (type === 'limit' && !price) missing.push('price (required for limit orders)');

  if (missing.length > 0) {
    return res.status(400).json({ success: false, error: `Missing fields: ${missing.join(', ')}` });
  }

  console.log(`[${new Date().toISOString()}] Webhook: ${side} ${symbol} | type=${type} leverage=${leverage}x risk=$${usd_risk}`);

  try {
    const result = await placeOrder({
      symbol,
      side,
      type,
      leverage: Number(leverage),
      usd_risk: Number(usd_risk),
      price:    price ? Number(price) : undefined,
      tp:       tp    ? Number(tp)    : undefined,
      sl:       sl ? Number(sl) : undefined,
      apiKey:   API_KEY,
      apiSecret: API_SECRET,
    });

    console.log(`[${new Date().toISOString()}] Order placed: ${JSON.stringify(result)}`);
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Order failed: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── Shared helpers ────────────────────────────────────────────────────────────

// Fetch ETH/BTC change for a given timeframe from Binance klines
async function fetchEthBtcForTf(tf) {
  if (tf === '1d') {
    const r = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=ETHBTC',
      { signal: AbortSignal.timeout(8_000) });
    const j = await r.json();
    return { value: parseFloat(j.lastPrice), change: parseFloat(j.priceChangePercent) };
  }
  const intervalMap = { '1h': '1h', '4h': '4h', '1w': '1w' };
  const interval = intervalMap[tf] || '1d';
  const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=ETHBTC&interval=${interval}&limit=2`,
    { signal: AbortSignal.timeout(8_000) });
  const j = await r.json();
  if (!Array.isArray(j) || j.length < 1) throw new Error('No ETHBTC kline');
  const bar    = j[j.length - 1];
  const open   = parseFloat(bar[1]);
  const close  = parseFloat(bar[4]);
  const change = open > 0 ? ((close - open) / open) * 100 : 0;
  return { value: close, change };
}

// Pick the right CoinPaprika % change field for a given TF
function cpChange(quotes, tf) {
  const usd = quotes?.USD ?? {};
  if (tf === '1h') return parseFloat(usd.percent_change_1h  ?? 0);
  if (tf === '4h') return parseFloat(usd.percent_change_6h  ?? 0); // 6h is the closest proxy
  if (tf === '1w') return parseFloat(usd.percent_change_7d  ?? 0);
  return parseFloat(usd.percent_change_24h ?? 0); // '1d' default
}

// ── Macro data proxy — Yahoo Finance ─────────────────────────────────────────
// Accepts ?tf=1h|4h|1d|1w (default: 1d)
app.get('/market-data', async (req, res) => {
  const tf = req.query.tf || '1d';

  // Map our TF to Yahoo interval + range params
  const yfParams = {
    '1h': { interval: '60m',  range: '1d'  },
    '4h': { interval: '60m',  range: '2d'  },  // aggregate last 4 bars client-side
    '1d': { interval: '1d',   range: '5d'  },
    '1w': { interval: '1wk',  range: '1mo' },
  }[tf] ?? { interval: '1d', range: '5d' };

  const YF_SYMBOLS = {
    DXY: 'DX-Y.NYB', OIL: 'CL=F', GOLD: 'GC=F',
    SPX: '%5EGSPC',  NDX: '%5EIXIC', US10Y: '%5ETNX', VIX: '%5EVIX',
  };

  const results = {};
  await Promise.all(Object.entries(YF_SYMBOLS).map(async ([name, yf]) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yf}?interval=${yfParams.interval}&range=${yfParams.range}`;
      const r   = await fetch(url, {
        signal: AbortSignal.timeout(8_000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; market-cockpit/1.0)' },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json   = await r.json();
      const meta   = json.chart?.result?.[0]?.meta;
      const quotes = json.chart?.result?.[0]?.indicators?.quote?.[0];
      const closes = (quotes?.close ?? []).filter(v => v != null);
      if (!meta || closes.length < 2) throw new Error('Insufficient data');
      const curr = meta.regularMarketPrice ?? closes.at(-1);

      let prev;
      if (tf === '4h') {
        // 4H: open of the bar that started ~4h ago; we have hourly closes, take closes[-5]
        const window = closes.slice(-5);
        prev = window[0];
      } else {
        prev = closes.at(-2);
      }
      const change = prev > 0 ? ((curr - prev) / prev) * 100 : 0;
      results[name] = { value: curr, change };
    } catch (err) {
      console.warn(`[market-data/${tf}] ${name}: ${err.message}`);
      results[name] = null;
    }
  }));
  return res.json({ success: true, data: results, ts: Date.now(), tf });
});

// ── Crypto data proxy — CoinPaprika + Binance ────────────────────────────────
// Accepts ?tf=1h|4h|1d|1w (default: 1d)
// CoinPaprika: free, no key, no server-side IP blocks

// Day 14.2 Patch 2 — in-memory cache to fit CoinPaprika free-tier quota
// (~25k calls/month). Per-tf cache; 60s TTL matches the regime poller
// cadence so the next poll ALWAYS hits cache except after a TTL flip.
const _cryptoDataCache = new Map();  // tf → {at: epoch_ms, payload: {...}}
const _CRYPTO_CACHE_TTL_MS = 60_000;

function _getCryptoCache(tf) {
  const e = _cryptoDataCache.get(tf);
  if (!e) return null;
  if (Date.now() - e.at > _CRYPTO_CACHE_TTL_MS) return null;
  return e.payload;
}

function _setCryptoCache(tf, payload) {
  _cryptoDataCache.set(tf, { at: Date.now(), payload });
}

app.get('/crypto-data', async (req, res) => {
  const tf = req.query.tf || '1d';

  // Patch 2 — cache hit short-circuits before any external fetch.
  const cached = _getCryptoCache(tf);
  if (cached) {
    return res.json({ ...cached, cache: 'HIT' });
  }

  // Patch 1 — fetch each source independently with per-source try/catch
  // so a single failure (e.g. CoinPaprika 429 from Railway IP rate-limit)
  // doesn't take out the others. Binance ethBtc is independent of
  // CoinPaprika so it can still produce data when CP is rate-limited.
  let globalRes = null;
  let tickersRes = null;
  let ethBtcData = null;

  await Promise.all([
    (async () => {
      try {
        const r = await fetch('https://api.coinpaprika.com/v1/global',
          { signal: AbortSignal.timeout(10_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        // Sanity: a real response has a positive market_cap_usd.
        // A 429 with JSON body might have an `error` field instead.
        if (typeof j.market_cap_usd !== 'number' || j.market_cap_usd <= 0) {
          throw new Error('missing or zero market_cap_usd in response');
        }
        globalRes = j;
      } catch (err) {
        console.warn(`[crypto-data/${tf}] coinpaprika.global: ${err.message}`);
      }
    })(),
    (async () => {
      try {
        const r = await fetch('https://api.coinpaprika.com/v1/tickers?limit=20',
          { signal: AbortSignal.timeout(10_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (!Array.isArray(j) || j.length === 0) {
          throw new Error('tickers not an array or empty');
        }
        tickersRes = j;
      } catch (err) {
        console.warn(`[crypto-data/${tf}] coinpaprika.tickers: ${err.message}`);
      }
    })(),
    (async () => {
      try {
        ethBtcData = await fetchEthBtcForTf(tf);
      } catch (err) {
        console.warn(`[crypto-data/${tf}] binance.ethBtc: ${err.message}`);
      }
    })(),
  ]);

  const globalOk  = globalRes !== null;
  const tickersOk = tickersRes !== null;
  const data = {};

  if (globalOk && tickersOk) {
    const totalMktCap = parseFloat(globalRes.market_cap_usd ?? 0);
    const tickers     = tickersRes;

    const bySymbol = {};
    for (const t of tickers) bySymbol[t.symbol] = t;

    const btc  = bySymbol['BTC'];
    const eth  = bySymbol['ETH'];
    const usdt = bySymbol['USDT'];

    const btcMktCap  = parseFloat(btc?.quotes?.USD?.market_cap  ?? 0);
    const ethMktCap  = parseFloat(eth?.quotes?.USD?.market_cap  ?? 0);
    const usdtMktCap = parseFloat(usdt?.quotes?.USD?.market_cap ?? 0);

    const btcChange  = cpChange(btc?.quotes,  tf);
    const ethChange  = cpChange(eth?.quotes,  tf);

    // Weighted-avg total change from top 20
    const top20Sum   = tickers.reduce((s, t) => s + parseFloat(t.quotes?.USD?.market_cap ?? 0), 0);
    let totalChange  = 0;
    for (const t of tickers) {
      const w = parseFloat(t.quotes?.USD?.market_cap ?? 0) / (top20Sum || 1);
      totalChange += w * cpChange(t.quotes, tf);
    }

    const totalPrev = totalMktCap / (1 + totalChange / 100);
    const btcPrev   = btcMktCap   / (1 + btcChange   / 100);
    const ethPrev   = ethMktCap   / (1 + ethChange   / 100);

    const btcDomCurrent  = totalMktCap ? (btcMktCap  / totalMktCap) * 100 : parseFloat(globalRes.bitcoin_dominance_percentage ?? 0);
    const btcDomPrev     = totalPrev   ? (btcPrev    / totalPrev)   * 100 : btcDomCurrent;
    const usdtDomCurrent = totalMktCap ? (usdtMktCap / totalMktCap) * 100 : 0;
    const usdtDomPrev    = totalPrev   ? (usdtMktCap / totalPrev)   * 100 : usdtDomCurrent;

    const total3Current = totalMktCap - btcMktCap - ethMktCap;
    const total3Prev    = totalPrev   - btcPrev   - ethPrev;
    const total3Change  = total3Prev > 0 ? ((total3Current - total3Prev) / total3Prev) * 100 : 0;

    const top10Sum     = tickers.slice(0, 10).reduce((s, t) => s + parseFloat(t.quotes?.USD?.market_cap ?? 0), 0);
    const top10SumPrev = tickers.slice(0, 10).reduce((s, t) => {
      return s + parseFloat(t.quotes?.USD?.market_cap ?? 0) / (1 + cpChange(t.quotes, tf) / 100);
    }, 0);
    const othersCurrent = Math.max(0, totalMktCap - top10Sum);
    const othersPrev    = Math.max(0, totalPrev   - top10SumPrev);
    const othersChange  = othersPrev > 0 ? ((othersCurrent - othersPrev) / othersPrev) * 100 : 0;

    // Patch 1 — only emit derived metrics when total_mkt_cap > 0. Otherwise
    // null them out so consumers can detect missing data instead of seeing
    // silent zeros.
    if (totalMktCap > 0) {
      data.btcD   = { value: btcDomCurrent,  change: btcDomCurrent  - btcDomPrev };
      data.usdtD  = { value: usdtDomCurrent, change: usdtDomCurrent - usdtDomPrev };
      data.total  = { value: totalMktCap,    change: totalChange };
      data.total3 = { value: total3Current,  change: total3Change };
      data.others = { value: othersCurrent,  change: othersChange };
    } else {
      data.btcD = data.usdtD = data.total = data.total3 = data.others = null;
    }
  } else {
    // Either CoinPaprika source failed; null out the 5 derived metrics.
    data.btcD = data.usdtD = data.total = data.total3 = data.others = null;
  }
  data.ethBtc = ethBtcData;

  const payload = {
    success: true,
    ts: Date.now(),
    tf,
    data,
    sources: {
      coinpaprika_global_ok: globalOk,
      coinpaprika_tickers_ok: tickersOk,
      binance_ethbtc_ok: ethBtcData !== null,
    },
  };

  // Patch 2 — only cache "good enough" responses (at least one source
  // succeeded). All-failed responses skip the cache so a transient blip
  // doesn't pin null data for 60s.
  if (globalOk || tickersOk || ethBtcData !== null) {
    _setCryptoCache(tf, payload);
  }

  return res.json({ ...payload, cache: 'MISS' });
});

// ── Cockpit regime proxy → EchoOo-SAE ─────────────────────────────────────────
// The browser-side cockpit POSTs its 60s regime snapshot here. We enrich it
// and forward to SAE /regime/external using the server-held SAE_INGEST_TOKEN.
// Gated by SAE_REGIME_PUSH_ENABLED on the server (flip env + redeploy to
// activate; cockpit code doesn't need to change).
//
// Fire-and-forget for the cockpit — we don't await the SAE forward before
// returning, so the cockpit's fetch stays fast regardless of SAE latency.
app.post('/cockpit/regime', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ success: false, error: 'body must be JSON object' });
  }
  const enriched = { ...body };
  if (!enriched.snapshot_at) enriched.snapshot_at = new Date().toISOString();
  if (!enriched.source)      enriched.source      = 'market_cockpit';
  // Non-blocking — SAE network call happens in the background.
  forwardRegimeToSAE(enriched).catch(err => {
    console.error(`[cockpit/regime] forward threw unexpectedly: ${err?.message || err}`);
  });
  return res.json({ success: true, queued: true });
});

app.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT}`);
  console.log(`POST http://localhost:${PORT}/webhook`);
  startScanner().catch(err => console.error('[scanner] startup error:', err.message));
});
