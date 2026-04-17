/**
 * MEXC Futures API client
 * Docs: https://mexcdevelop.github.io/apidocs/contract_v1_en/
 */
import crypto from 'crypto';

const BASE_URL = 'https://contract.mexc.com';

// Cache contract detail per symbol (fetched once from MEXC)
const contractDetailCache = {};

async function getContractDetail(symbol) {
  if (contractDetailCache[symbol]) return contractDetailCache[symbol];

  try {
    const res  = await fetch(`${BASE_URL}/api/v1/contract/detail?symbol=${symbol}`);
    const data = await res.json();
    if ((data.code === 0 || data.code === 200) && data.data) {
      const d = data.data;
      // priceUnit may be explicit or derived from priceScale (decimal places for price)
      const priceScale = Number(d.priceScale ?? 1);
      const priceUnit  = d.priceUnit ? Number(d.priceUnit) : Math.pow(10, -priceScale);
      const detail = {
        contractSize: Number(d.contractSize || 1),
        priceUnit,
        priceScale,
        minVol:   Number(d.minVol   || 1),
        volScale: Number(d.volScale || 0),
      };
      contractDetailCache[symbol] = detail;
      console.log(`[contract detail] ${symbol}:`, JSON.stringify(detail));
      return detail;
    }
    console.warn(`[contract detail] No data for ${symbol}:`, JSON.stringify(data).slice(0, 200));
  } catch (e) {
    console.warn(`[contract detail] Fetch failed for ${symbol}: ${e.message}`);
  }

  // Fallbacks per known base coins
  const FALLBACK = {
    BTC: { contractSize: 0.0001, priceUnit: 0.1,   priceScale: 1, minVol: 1, volScale: 0 },
    ETH: { contractSize: 0.01,   priceUnit: 0.01,  priceScale: 2, minVol: 1, volScale: 0 },
    SOL: { contractSize: 0.1,    priceUnit: 0.01,  priceScale: 2, minVol: 1, volScale: 0 },
  };
  const base   = symbol.split('_')[0].toUpperCase();
  const detail = FALLBACK[base] ?? { contractSize: 1, priceUnit: 0.01, priceScale: 2, minVol: 1, volScale: 0 };
  console.warn(`[contract detail] Using fallback for ${symbol}:`, JSON.stringify(detail));
  contractDetailCache[symbol] = detail;
  return detail;
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
async function getOpenPosition(symbol, positionType, apiKey, apiSecret, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 500));
    const t = Date.now();
    const positions = await request('GET', '/api/v1/private/position/open_positions', null, apiKey, apiSecret);
    console.log(`[timing] getOpenPosition attempt ${i + 1}/${maxRetries}: ${Date.now() - t}ms, found ${(positions||[]).length} positions`);
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

  const t0 = Date.now();
  const mexcSide = SIDE[side];
  if (!mexcSide) throw new Error(`Invalid side: ${side}. Use: ${Object.keys(SIDE).join(', ')}`);

  const isLong       = side === 'open_long'  || side === 'close_long';
  const positionType = isLong ? 1 : 2;
  const openType     = 1; // isolated

  // Parallelize: setLeverage + ticker fetch + contract detail (saves ~2s vs sequential)
  const needTicker = !price || type === 'market';
  const [, tickerData, detail] = await Promise.all([
    setLeverage(symbol, leverage, openType, positionType, apiKey, apiSecret),
    needTicker
      ? fetch(`${BASE_URL}/api/v1/contract/ticker?symbol=${symbol}`).then(r => r.json())
      : Promise.resolve(null),
    getContractDetail(symbol),
  ]);
  console.log(`[timing] leverage+ticker+detail parallel: ${Date.now() - t0}ms`);

  // Resolve live price for market orders (or as fallback for limit)
  let contractPrice = price;
  if (needTicker) {
    if (!tickerData || (tickerData.code !== 0 && tickerData.code !== 200))
      throw new Error(`Ticker error: ${tickerData?.message ?? 'no data'}`);
    contractPrice = parseFloat(tickerData.data.lastPrice || tickerData.data.indexPrice);
  }

  // Price rounding helper — rounds to nearest priceUnit (fixes MEXC error 2015)
  const { contractSize, priceUnit, minVol } = detail;
  const roundPrice = (p) => p ? Math.round(p / priceUnit) * priceUnit : p;

  // Vol: integer contracts, minimum minVol
  const rawVol = Math.floor(usd_risk / (contractPrice * contractSize));
  const volume = Math.max(minVol, rawVol);
  console.log(`[${new Date().toISOString()}] Vol: floor(${usd_risk}/(${contractPrice}×${contractSize}))=${rawVol} → clamped to ${volume} (minVol=${minVol})`);
  if (volume < 1) throw new Error(`Volume rounds to 0 contracts. Min usd_risk ≈ $${(contractPrice * contractSize).toFixed(2)}.`);

  // Build order — price must be absent for market orders
  const orderBody = {
    symbol,
    vol: volume,
    leverage,
    side: mexcSide,
    type: ORDER_TYPE[type] ?? ORDER_TYPE.market,
    openType,
  };
  if (type === 'limit' && price != null) {
    orderBody.price = roundPrice(price);
  }
  console.log(`[${new Date().toISOString()}] Submitting order: ${JSON.stringify(orderBody)}`);

  const t1 = Date.now();
  const orderId = await request('POST', '/api/v1/private/order/submit', orderBody, apiKey, apiSecret);
  console.log(`[timing] order submit: ${Date.now() - t1}ms`);

  // Attach TP/SL (rounded to priceUnit to avoid error 2015)
  const isOpening = side === 'open_long' || side === 'open_short';
  let tpslResult = null;
  if (isOpening && (tp || sl)) {
    const t2 = Date.now();
    const position = await getOpenPosition(symbol, positionType, apiKey, apiSecret);
    console.log(`[timing] getOpenPosition: ${Date.now() - t2}ms`);
    if (position) {
      const t3 = Date.now();
      tpslResult = await setPositionTpSl({
        symbol,
        positionId: position.positionId,
        vol: position.vol ?? volume,
        tp: roundPrice(tp),
        sl: roundPrice(sl),
        apiKey,
        apiSecret,
      });
      console.log(`[timing] setPositionTpSl: ${Date.now() - t3}ms`);
    } else {
      console.warn(`[WARN] No open position for ${symbol} after retries — TP/SL not attached`);
    }
  }

  console.log(`[timing] total placeOrder: ${Date.now() - t0}ms`);

  return {
    orderId,
    symbol,
    side,
    type,
    leverage,
    volume,
    entryPrice: contractPrice,
    positionUsd: Math.round(usd_risk * 100) / 100,
    tp: roundPrice(tp) || null,
    sl: roundPrice(sl) || null,
    tpslAttached: tpslResult !== null,
  };
}
