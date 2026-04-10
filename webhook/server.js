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

// Wallet balance
app.get('/balance', async (req, res) => {
  try {
    const { available, equity, total_wallet } = await getBalance(API_KEY, API_SECRET);
    return res.json({ success: true, available, equity, total_wallet });
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

app.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT}`);
  console.log(`POST http://localhost:${PORT}/webhook`);
});
