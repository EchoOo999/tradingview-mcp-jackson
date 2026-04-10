/**
 * MEXC Futures API client
 * Docs: https://mexcdevelop.github.io/apidocs/contract_v1_en/
 */
import crypto from 'crypto';

const BASE_URL = 'https://contract.mexc.com';

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

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'ApiKey': apiKey,
      'Request-Time': timestamp,
      'Signature': signature,
      'Content-Type': 'application/json',
    },
    body: bodyStr || undefined,
  });

  const data = await res.json();
  if (!res.ok || (data.code !== 0 && data.code !== 200)) {
    const msg = data.message || data.msg || JSON.stringify(data);
    throw new Error(`MEXC API error ${data.code || res.status}: ${msg}`);
  }
  return data.data;
}

/**
 * Fetch USDT futures wallet balance.
 * Returns { available, total } in USDT.
 */
export async function getBalance(apiKey, apiSecret) {
  const assets = await request('GET', '/api/v1/private/account/assets', null, apiKey, apiSecret);
  // assets is an array; find USDT
  const usdt = (assets || []).find(a => a.currency === 'USDT');
  if (!usdt) throw new Error('USDT asset not found in account assets');
  return {
    available: parseFloat(usdt.availableBalance ?? usdt.available ?? 0),
    total:     parseFloat(usdt.equity ?? usdt.totalBalance ?? usdt.balance ?? 0),
  };
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

  // sl_distance_pct = |entry - sl| / entry
  // position_value_usd = usd_risk / sl_distance_pct
  // volume (contracts) = position_value_usd / entry_price * leverage
  const slDistance = Math.abs(contractPrice - sl) / contractPrice;
  if (slDistance <= 0) throw new Error('SL price must differ from entry price');

  const positionValueUsd = usd_risk / slDistance;
  const volume = Math.floor((positionValueUsd / contractPrice) * leverage);
  if (volume < 1) throw new Error(`Computed volume < 1 contract. Increase usd_risk or leverage.`);

  // Place the market/limit order
  const orderBody = {
    symbol,
    price: type === 'limit' ? price : 0,
    vol: volume,
    leverage,
    side: mexcSide,
    type: ORDER_TYPE[type] ?? ORDER_TYPE.market,
    openType,
  };

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
    tp: tp || null,
    sl: sl || null,
    positionValueUsd: Math.round(positionValueUsd * 100) / 100,
    tpslAttached: tpslResult !== null,
  };
}
