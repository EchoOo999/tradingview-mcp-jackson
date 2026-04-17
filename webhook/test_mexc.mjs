import crypto from 'crypto';

const KEY    = process.env.MEXC_API_KEY;
const SECRET = process.env.MEXC_SECRET;
const BASE   = 'https://contract.mexc.com';

if (!KEY || !SECRET) {
  console.error('ERROR: MEXC_API_KEY and MEXC_SECRET must be set');
  process.exit(1);
}

// 1. Contract detail — no auth needed
console.log('=== CONTRACT DETAIL (BTC_USDT) ===');
const detailRes  = await fetch(`${BASE}/api/v1/contract/detail?symbol=BTC_USDT`);
const detailData = await detailRes.json();
console.log(JSON.stringify(detailData, null, 2));

// Highlight the fields we care about
const d = detailData.data ?? {};
console.log('\n--- KEY FIELDS ---');
console.log('contractSize:    ', d.contractSize);
console.log('minVol:          ', d.minVol);
console.log('volDecimalPlace: ', d.volDecimalPlace);
console.log('volumeDecimal:   ', d.volumeDecimal);
console.log('------------------\n');

// 2. Test market order: vol=1, side=3 (open_short), type=5 (market), leverage=10, openType=1 (isolated)
console.log('=== TEST ORDER (vol=1, market, open_short) ===');
const ts   = Date.now().toString();
const body = JSON.stringify({ symbol: 'BTC_USDT', vol: 1, leverage: 10, side: 3, type: 5, openType: 1 });
const sig  = crypto.createHmac('sha256', SECRET).update(KEY + ts + body).digest('hex');

const orderRes  = await fetch(`${BASE}/api/v1/private/order/submit`, {
  method: 'POST',
  headers: {
    'ApiKey':        KEY,
    'Request-Time':  ts,
    'Signature':     sig,
    'Content-Type':  'application/json',
  },
  body,
});
const orderData = await orderRes.json();
console.log(JSON.stringify(orderData, null, 2));
