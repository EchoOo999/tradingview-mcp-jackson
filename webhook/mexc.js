/**
 * MEXC Futures API client
 * Docs: https://mexcdevelop.github.io/apidocs/contract_v1_en/
 */
import crypto from 'crypto';

const BASE_URL = 'https://contract.mexc.com';

// Fallback precision per base coin if contract detail fetch fails
const FALLBACK_DECIMALS = { BTC: 4, ETH: 3, SOL: 1 };
const DEFAULT_DECIMALS  = 4;

// Cache volumeDecimal per symbol (fetched once from MEXC contract detail)
const volumeDecimalCache = {};

async function getVolumeDecimals(symbol) {
  if (volumeDecimalCache[symbol] !== undefined) return volumeDecimalCache[symbol];

  // Temporary hardcode: BTC_USDT → 2dp (0.0139 → 0.01) to isolate vol precision issue
  if (symbol === 'BTC_USDT') {
    console.log(`[contract detail] BTC_USDT: hardcoded decimals=2 (test override)`);
    volumeDecimalCache[symbol] = 2;
    return 2;
  }

  try {
    const res  = await fetch(`${BASE_URL}/api/v1/contract/detail?symbol=${symbol}`);
    const data = await res.json();
    if ((data.code === 0 || data.code === 200) && data.data) {
      console.log(`[contract detail] ${symbol} ALL fields:`, JSON.stringify(data.data));
      // Try known field names in priority order
      const raw = data.data.volDecimalPlace ?? data.data.volumeDecimal ?? data.data.contractSize ?? data.data.minVol;
      if (raw !== undefined) {
        const num = Number(raw);
        // If value < 1 it's a minVol (e.g. 0.0001) — convert to decimal count
        const dec = num < 1 ? Math.round(-Math.log10(num)) : num;
        volumeDecimalCache[symbol] = dec;
        console.log(`[contract detail] ${symbol} raw=${num} → decimals=${dec}`);
        return dec;
      }
      console.warn(`[contract detail] No precision field found for ${symbol}`);
    } else {
      console.warn(`[contract detail] Unexpected response for ${symbol}:`, JSON.stringify(data).slice(0, 200));
    }
  } catch (e) {
    console.warn(`[contract detail] Fetch failed for ${symbol}: ${e.message}`);
  }

  const base = symbol.split('_')[0].toUpperCase();
  const dec  = FALLBACK_DECIMALS[base] ?? DEFAULT_DECIMALS;
  console.warn(`[contract detail] Using fallback decimals=${dec} for ${symbol}`);
  volumeDecimalCache[symbol] = dec;
  return dec;
}

// MEXC side codes
const SIDE = {
  open_long:   1,
  close_long:  2,
  open_short:  3,
  close_short: 4,
};

// MEXC order type codes
const ORDER_TYPE = {
  limit:  1,
  market: 5, // market order type in MEXC Futures is 5
};

function sign(apiSecret, apiKey, timestamp, body) {
  const message = apiKey + timestamp + body;
  return crypto.createHmac('sha256', apiSecret).update(message).digest('hex');
}

async function request(method, path, body, apiKey, apiSecret) {
  const timestamp = Date.now().toString();
  const bodyStr = body ? JSON.stringify(body) : '';
  const signature = sign(apiSecret, apiKey, timestamp, bodyStr);

  const url = `${BASE_URL}${path}`;
  const headers = {
    'ApiKey': apiKey,
    'Request-Time': timestamp,
    'Signature': signature,
    'Content-Type': 'application/json',
  };

  console.log(`[MEXC req] ${method} ${path} | ts=${timestamp} | sig=${signature.slice(0, 16)}... | body=${bodyStr.slice(0, 120)}`);

  const res = await fetch(url, {
    method,
    headers,
    body: bodyStr || undefined,
  });

  const text = await res.text();
  console.log(`[MEXC res ${res.status}] ${text.slice(0, 500)}`);

  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok || (data.code !== 0 && data.code !== 200)) {
    const msg = data.message || data.msg || JSON.stringify(data);
    throw new Error(`MEXC API error ${data.code || res.status}: ${msg}`);
  }
  return data.data;
}

/**
 * Fetch total USDT balance across Spot + Futures accounts.
 * - Spot:    GET https://api.mexc.com/api/v3/account  (HMAC-SHA256 on queryString)
 * - Futures: GET /api/v1/private/account/assets        (existing futures auth)
 * Returns { total } = spot USDT (free+locked) + futures USDT equity.
 */
export async function getBalance(apiKey, apiSecret) {
  // Run both calls in parallel
  const [spotData, futuresAssets] = await Promise.all([
    // ── Spot API ──────────────────────────────────────────────────────────────
    (async () => {
      const ts  = Date.now().toString();
      const qs  = `timestamp=${ts}`;
      const sig = crypto.createHmac('sha256', apiSecret).update(qs).digest('hex');
      const res = await fetch(`https://api.mexc.com/api/v3/account?${qs}&signature=${sig}`, {
        headers: { 'X-MEXC-APIKEY': apiKey },
      });
      const rawSpot = await res.text();
      console.log(`[Spot res ${res.status}] ${rawSpot.slice(0, 500)}`);
      let json;
      try { json = JSON.parse(rawSpot); }
      catch (_) { throw new Error(`Spot non-JSON (${res.status}): ${rawSpot.slice(0, 200)}`); }
      if (json.code) throw new Error(`Spot API: ${json.msg || json.message}`);
      return json;
    })(),
    // ── Futures API ───────────────────────────────────────────────────────────
    request('GET', '/api/v1/private/account/assets', null, apiKey, apiSecret),
  ]);

  // Spot USDT
  const spotUsdt  = (spotData.balances || []).find(b => b.asset === 'USDT');
  const spotTotal = spotUsdt
    ? parseFloat(spotUsdt.free || 0) + parseFloat(spotUsdt.locked || 0)
    : 0;

  // Futures USDT equity (includes unrealized PnL)
  const futUsdt    = (futuresAssets || []).find(a => a.currency === 'USDT');
  const futEquity  = futUsdt ? parseFloat(futUsdt.equity ?? 0) : 0;

  return { total: spotTotal + futEquity };
}

/**
 * Set leverage for a symbol + side.
 */
export async function setLeverage(symbol, leverage, openType, positionType, apiKey, apiSecret) {
  return request('POST', '/api/v1/private/position/change_leverage', {
    symbol,
    leverage,
    openType,
    positionType,
  }, apiKey, apiSecret);
}

/**
 * Fetch open positions and return the one matching symbol + positionType.
 * Retries up to maxRetries times with a 1s delay (market orders fill fast but
 * the position may take a moment to appear).
 * positionType: 1 = long, 2 = short
 */
async function getOpenPosition(symbol, positionType, apiKey, apiSecret, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 1000));
    const positions = await request('GET', '/api/v1/private/position/open_positions', null, apiKey, apiSecret);
    const match = (positions || []).find(p => p.symbol === symbol && p.positionType === positionType);
    if (match) return match;
  }
  return null;
}

/**
 * Set TP/SL on an open position via POST /api/v1/private/stoporder/place.
 * This shows in the MEXC UI "TP/SL Order" tab and auto-cancels when position closes.
 *
 * lossTrend / profitTrend: 1 = last price, 2 = fair price, 3 = index price
 */
async function setPositionTpSl({ symbol, positionId, vol, tp, sl, apiKey, apiSecret }) {
  const body = {
    symbol,
    positionId,
    vol,
    ...(tp ? { takeProfitPrice: tp, takeProfitOrderPrice: tp, profitTrend: 1 } : {}),
    ...(sl ? { stopLossPrice: sl, stopLossOrderPrice: sl, stopLossType: 1, lossTrend: 1 } : {}),
  };
  return request('POST', '/api/v1/private/stoporder/place', body, apiKey, apiSecret);
}

/**
 * Place an order on MEXC Futures.
 *
 * @param {object} params
 * @param {string}  params.symbol        e.g. "BTC_USDT"
 * @param {string}  params.side          "open_long" | "close_long" | "open_short" | "close_short"
 * @param {string}  params.type          "market" | "limit"
 * @param {number}  params.leverage
 * @param {number}  params.usd_risk      USD amount to risk
 * @param {number}  params.price         Required for limit orders
 * @param {number}  params.tp            Take profit price
 * @param {number}  params.sl            Stop loss price
 * @param {string}  params.apiKey
 * @param {string}  params.apiSecret
 */
export async function placeOrder(params) {
  const {
    symbol,
    side,
    type,
    leverage,
    usd_risk,
    price,
    tp,
    sl,
    apiKey,
    apiSecret,
  } = params;

  const mexcSide = SIDE[side];
  if (!mexcSide) throw new Error(`Invalid side: ${side}. Use: ${Object.keys(SIDE).join(', ')}`);

  const isLong = side === 'open_long' || side === 'close_long';
  const positionType = isLong ? 1 : 2;
  const openType = 1; // isolated

  // Set leverage first
  await setLeverage(symbol, leverage, openType, positionType, apiKey, apiSecret);

  // Get current price for position sizing
  let contractPrice = price;
  if (!contractPrice || type === 'market') {
    const tickerRes = await fetch(`${BASE_URL}/api/v1/contract/ticker?symbol=${symbol}`);
    const tickerData = await tickerRes.json();
    if (tickerData.code !== 0 && tickerData.code !== 200) throw new Error(`Ticker error: ${tickerData.message}`);
    contractPrice = parseFloat(tickerData.data.lastPrice || tickerData.data.indexPrice);
  }

  // usd_risk = full USDT quantity (position notional) — NOT margin, NOT max loss
  // volume (contracts) = usd_risk / current_price, rounded DOWN to MEXC volumeDecimal
  const decimals  = await getVolumeDecimals(symbol);
  const factor    = Math.pow(10, decimals);
  const rawVolume = usd_risk / contractPrice;
  const volume    = Math.floor(rawVolume * factor) / factor;
  console.log(`[${new Date().toISOString()}] Volume calc: ${usd_risk} / ${contractPrice} = ${rawVolume} → floor(${decimals}dp) = ${volume}`);
  if (volume <= 0) throw new Error(`Volume rounds to zero at ${decimals}dp. Min usd_risk ≈ $${(contractPrice / factor).toFixed(2)}.`);

  // Place the market/limit order
  // NOTE: price must be completely absent for market orders — explicit assignment only for limit
  const orderBody = {
    symbol,
    vol: volume,
    leverage,
    side: mexcSide,
    type: ORDER_TYPE[type] ?? ORDER_TYPE.market,
    openType,
  };
  if (type === 'limit' && price != null) {
    orderBody.price = price;
  }
  console.log(`[order] type=${type} | price field included: ${type === 'limit' && price != null}`);

  console.log(`[${new Date().toISOString()}] Submitting order: ${JSON.stringify(orderBody)}`);
  const orderId = await request('POST', '/api/v1/private/order/submit', orderBody, apiKey, apiSecret);

  // Attach TP/SL via stoporder/place (shows in "TP/SL Order" tab, auto-cancels with position)
  const isOpening = side === 'open_long' || side === 'open_short';
  let tpslResult = null;
  if (isOpening && (tp || sl)) {
    const position = await getOpenPosition(symbol, positionType, apiKey, apiSecret);
    if (position) {
      tpslResult = await setPositionTpSl({
        symbol,
        positionId: position.positionId,
        vol: position.vol ?? volume,
        tp,
        sl,
        apiKey,
        apiSecret,
      });
    } else {
      console.warn(`[WARN] Could not find open position for ${symbol} to attach TP/SL`);
    }
  }

  return {
    orderId,
    symbol,
    side,
    type,
    leverage,
    volume,
    entryPrice: contractPrice,
    positionUsd: Math.round(usd_risk * 100) / 100,
    tp: tp || null,
    sl: sl || null,
    tpslAttached: tpslResult !== null,
  };
}
