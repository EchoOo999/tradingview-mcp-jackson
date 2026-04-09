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
 * Set leverage for a symbol + side.
 * @param {string} symbol  e.g. "BTC_USDT"
 * @param {number} leverage
 * @param {number} openType  1=isolated, 2=cross
 * @param {number} positionType  1=long, 2=short
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
 * Get contract info for a symbol (used to determine contract unit/step).
 */
export async function getContractDetail(symbol) {
  const res = await fetch(`${BASE_URL}/api/v1/contract/detail?symbol=${symbol}`);
  const data = await res.json();
  if (data.code !== 0 && data.code !== 200) throw new Error(`Contract info error: ${data.message}`);
  return data.data;
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
  const openType = 1; // isolated (default; configurable later)

  // Set leverage first
  await setLeverage(symbol, leverage, openType, positionType, apiKey, apiSecret);

  // Calculate position size in contracts
  // sl_distance_pct = |entry - sl| / entry
  // position_value_usd = usd_risk / sl_distance_pct
  // volume (contracts) = position_value_usd / entry_price
  let contractPrice = price;
  if (!contractPrice || type === 'market') {
    // Get current mark price
    const tickerRes = await fetch(`${BASE_URL}/api/v1/contract/ticker?symbol=${symbol}`);
    const tickerData = await tickerRes.json();
    if (tickerData.code !== 0 && tickerData.code !== 200) throw new Error(`Ticker error: ${tickerData.message}`);
    contractPrice = parseFloat(tickerData.data.lastPrice || tickerData.data.indexPrice);
  }

  const slDistance = Math.abs(contractPrice - sl) / contractPrice;
  if (slDistance <= 0) throw new Error('SL price must differ from entry price');

  const positionValueUsd = usd_risk / slDistance;
  const volume = Math.floor((positionValueUsd / contractPrice) * leverage);
  if (volume < 1) throw new Error(`Computed volume < 1 contract. Increase usd_risk or leverage.`);

  const orderBody = {
    symbol,
    price: type === 'limit' ? price : 0,
    vol: volume,
    leverage,
    side: mexcSide,
    type: ORDER_TYPE[type] ?? ORDER_TYPE.market,
    openType,
    ...(tp ? { stopLossOrTakeProfitList: [] } : {}),
  };

  // Add TP/SL via stopLossOrTakeProfitList
  const tpslList = [];
  if (tp) {
    tpslList.push({
      stopLossOrTakeProfitType: 2, // 2 = TP
      triggerType: 1,              // 1 = last price
      triggerPrice: tp,
      executrionType: 2,           // 2 = market close
    });
  }
  if (sl) {
    tpslList.push({
      stopLossOrTakeProfitType: 1, // 1 = SL
      triggerType: 1,
      triggerPrice: sl,
      executrionType: 2,
    });
  }
  if (tpslList.length > 0) {
    orderBody.stopLossOrTakeProfitList = tpslList;
  }

  const result = await request('POST', '/api/v1/private/order/submit', orderBody, apiKey, apiSecret);

  return {
    orderId: result,
    symbol,
    side,
    type,
    leverage,
    volume,
    entryPrice: contractPrice,
    tp: tp || null,
    sl: sl || null,
    positionValueUsd: Math.round(positionValueUsd * 100) / 100,
  };
}
