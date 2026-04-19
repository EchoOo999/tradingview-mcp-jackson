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

const app = express();
app.use(cors());
app.use(express.json());

const PORT          = process.env.PORT          || 3000;
const API_KEY       = process.env.MEXC_API_KEY;
const API_SECRET    = process.env.MEXC_SECRET;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET; // optional

if (!API_KEY || !API_SECRET) {
  console.error('ERROR: MEXC_API_KEY and MEXC_SECRET must be set in environment.');
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

// Wallet balance
app.get('/balance', async (req, res) => {
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

// Macro data proxy — Yahoo Finance (bypasses CORS for browser extension clients)
app.get('/market-data', async (req, res) => {
  const YF_SYMBOLS = {
    DXY:   'DX-Y.NYB',
    OIL:   'CL=F',
    GOLD:  'GC=F',
    SPX:   '%5EGSPC',
    NDX:   '%5EIXIC',
    US10Y: '%5ETNX',
    VIX:   '%5EVIX',
  };
  const results = {};
  await Promise.all(Object.entries(YF_SYMBOLS).map(async ([name, yf]) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yf}?interval=1d&range=5d`;
      const r = await fetch(url, {
        signal: AbortSignal.timeout(8_000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; market-cockpit/1.0)' },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json  = await r.json();
      const meta   = json.chart?.result?.[0]?.meta;
      const quotes = json.chart?.result?.[0]?.indicators?.quote?.[0];
      const closes = (quotes?.close ?? []).filter(v => v != null);
      if (!meta || closes.length < 2) throw new Error('Insufficient data');
      const curr   = meta.regularMarketPrice ?? closes.at(-1);
      const prev   = closes.at(-2);
      const change = prev > 0 ? ((curr - prev) / prev) * 100 : 0;
      results[name] = { value: curr, change, prev };
    } catch (err) {
      console.warn(`[market-data] ${name}: ${err.message}`);
      results[name] = null;
    }
  }));
  return res.json({ success: true, data: results, ts: Date.now() });
});

// Crypto data proxy — CoinGecko + Binance (bypasses CORS for browser extension clients)
app.get('/crypto-data', async (req, res) => {
  try {
    const [globalRes, marketsRes, ethBtcRes] = await Promise.all([
      fetch('https://api.coingecko.com/api/v3/global', { signal: AbortSignal.timeout(10_000) }).then(r => r.json()),
      fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=10&page=1&sparkline=false&price_change_percentage=24h', { signal: AbortSignal.timeout(10_000) }).then(r => r.json()),
      fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=ETHBTC', { signal: AbortSignal.timeout(10_000) }).then(r => r.json()),
    ]);

    const gd           = globalRes.data;
    const totalMktCap  = gd.total_market_cap.usd;
    const totalChange  = gd.market_cap_change_percentage_24h_usd;
    const totalPrev    = totalMktCap / (1 + totalChange / 100);

    const btcCoin  = marketsRes.find(c => c.id === 'bitcoin')  ?? {};
    const ethCoin  = marketsRes.find(c => c.id === 'ethereum') ?? {};
    const btcMktCap = btcCoin.market_cap ?? (totalMktCap * gd.market_cap_percentage.btc / 100);
    const ethMktCap = ethCoin.market_cap ?? (totalMktCap * gd.market_cap_percentage.eth / 100);
    const btcChange = btcCoin.price_change_percentage_24h ?? 0;
    const ethChange = ethCoin.price_change_percentage_24h ?? 0;
    const btcPrev   = btcMktCap / (1 + btcChange / 100);
    const ethPrev   = ethMktCap / (1 + ethChange / 100);

    const btcDomCurrent  = gd.market_cap_percentage.btc;
    const btcDomPrev     = (btcPrev / totalPrev) * 100;
    const usdtMktCap     = totalMktCap * gd.market_cap_percentage.usdt / 100;
    const usdtDomCurrent = gd.market_cap_percentage.usdt;
    const usdtDomPrev    = (usdtMktCap / totalPrev) * 100;

    const total3Current  = totalMktCap - btcMktCap - ethMktCap;
    const total3Prev     = totalPrev   - btcPrev   - ethPrev;
    const total3Change   = total3Prev > 0 ? ((total3Current - total3Prev) / total3Prev) * 100 : 0;

    const top10Sum       = marketsRes.reduce((s, c) => s + (c.market_cap ?? 0), 0);
    const top10SumPrev   = marketsRes.reduce((s, c) => {
      const chg = c.price_change_percentage_24h ?? 0;
      return s + (c.market_cap ?? 0) / (1 + chg / 100);
    }, 0);
    const othersCurrent  = Math.max(0, totalMktCap - top10Sum);
    const othersPrev     = Math.max(0, totalPrev   - top10SumPrev);
    const othersChange   = othersPrev > 0 ? ((othersCurrent - othersPrev) / othersPrev) * 100 : 0;

    return res.json({
      success: true,
      ts: Date.now(),
      data: {
        btcD:   { value: btcDomCurrent,  change: btcDomCurrent  - btcDomPrev },
        usdtD:  { value: usdtDomCurrent, change: usdtDomCurrent - usdtDomPrev },
        ethBtc: { value: parseFloat(ethBtcRes.lastPrice), change: parseFloat(ethBtcRes.priceChangePercent) },
        total:  { value: totalMktCap,    change: totalChange },
        total3: { value: total3Current,  change: total3Change },
        others: { value: othersCurrent,  change: othersChange },
      },
    });
  } catch (err) {
    console.error(`[crypto-data] ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT}`);
  console.log(`POST http://localhost:${PORT}/webhook`);
  startScanner().catch(err => console.error('[scanner] startup error:', err.message));
});
