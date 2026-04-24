/**
 * Tests for sae_forwarder.js + scanner.js SAE payload mappers.
 *
 * Run:  node --test webhook/sae_forwarder.test.js
 *
 * These tests stub global.fetch — no real network calls.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  forwardSignalToSAE,
  _resetForwarderForTests,
  _inspectForwarderState,
} from './sae_forwarder.js';
import { buildSFPSAEPayload, buildLJSAEPayload, findNearestSessionLevel } from './scanner.js';

// ── Test helpers ──────────────────────────────────────────────────────────────
function installFetchMock(handler) {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  return {
    calls,
    restore: () => { global.fetch = originalFetch; },
  };
}

function setEnv(values) {
  const previous = {};
  for (const [k, v] of Object.entries(values)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else                 process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else                 process.env[k] = v;
    }
  };
}

function jsonResponse(status, body = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const SAMPLE_PAYLOAD = {
  market_id:             null,
  symbol:                'BTC_USDT',
  timeframe:             '5m',
  pattern_type:          'SFP_long',
  rank:                  14,
  fib_zone:              'L.RLZ-MM',
  nearest_session_level: 'monday_low',
  distance_to_level_pct: 0.3,
  neckline_price:        null,
  htf_timeframe:         '1h',
  signal_reliability:    0.60,
  detected_at:           '2026-04-23T20:15:00Z',
  source:                'mexc_scanner',
};

// ── forwarder behaviour ───────────────────────────────────────────────────────

test('forwarder is no-op when SAE_FORWARDING_ENABLED is unset', async () => {
  _resetForwarderForTests();
  const restoreEnv = setEnv({ SAE_FORWARDING_ENABLED: undefined, SAE_INGEST_TOKEN: 'tok' });
  const fetchMock = installFetchMock(() => jsonResponse(200));
  try {
    const r = await forwardSignalToSAE(SAMPLE_PAYLOAD);
    assert.equal(r.success, false);
    assert.equal(r.error, 'disabled');
    assert.equal(fetchMock.calls.length, 0);
  } finally { fetchMock.restore(); restoreEnv(); }
});

test('forwarder skips when token is empty', async () => {
  _resetForwarderForTests();
  const restoreEnv = setEnv({ SAE_FORWARDING_ENABLED: 'true', SAE_INGEST_TOKEN: '' });
  const fetchMock = installFetchMock(() => jsonResponse(200));
  try {
    const r = await forwardSignalToSAE(SAMPLE_PAYLOAD);
    assert.equal(r.success, false);
    assert.equal(r.error, 'missing_token');
    assert.equal(fetchMock.calls.length, 0);
  } finally { fetchMock.restore(); restoreEnv(); }
});

test('forwarder rejects malformed payload', async () => {
  _resetForwarderForTests();
  const restoreEnv = setEnv({ SAE_FORWARDING_ENABLED: 'true', SAE_INGEST_TOKEN: 'tok' });
  const fetchMock = installFetchMock(() => jsonResponse(200));
  try {
    const r1 = await forwardSignalToSAE(null);
    assert.equal(r1.error, 'invalid_payload');
    const r2 = await forwardSignalToSAE({ symbol: 'BTC_USDT' }); // missing pattern_type
    assert.equal(r2.error, 'invalid_payload');
    assert.equal(fetchMock.calls.length, 0);
  } finally { fetchMock.restore(); restoreEnv(); }
});

test('forwarder POSTs with correct URL, headers, and JSON body', async () => {
  _resetForwarderForTests();
  const restoreEnv = setEnv({
    SAE_FORWARDING_ENABLED: 'true',
    SAE_INGEST_TOKEN:       'secret-token-123',
    SAE_ENDPOINT:           'https://example.test/ta-events',
  });
  const fetchMock = installFetchMock(() => jsonResponse(200, { ok: true }));
  try {
    const r = await forwardSignalToSAE(SAMPLE_PAYLOAD);
    assert.equal(r.success, true);
    assert.equal(r.status, 200);
    assert.equal(fetchMock.calls.length, 1);
    const { url, init } = fetchMock.calls[0];
    assert.equal(url, 'https://example.test/ta-events');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.equal(init.headers['X-SAE-Token'], 'secret-token-123');
    const sentBody = JSON.parse(init.body);
    assert.deepEqual(sentBody, SAMPLE_PAYLOAD);
  } finally { fetchMock.restore(); restoreEnv(); }
});

test('forwarder retries once on 500 and succeeds on 2nd attempt', async () => {
  _resetForwarderForTests();
  const restoreEnv = setEnv({
    SAE_FORWARDING_ENABLED: 'true',
    SAE_INGEST_TOKEN:       'tok',
    SAE_ENDPOINT:           'https://example.test/ta-events',
  });
  const fetchMock = installFetchMock((url, init, n) =>
    n === 1 ? jsonResponse(500, { error: 'transient' }) : jsonResponse(200, { ok: true })
  );
  try {
    const r = await forwardSignalToSAE(SAMPLE_PAYLOAD);
    assert.equal(r.success, true);
    assert.equal(r.status, 200);
    assert.equal(fetchMock.calls.length, 2);
  } finally { fetchMock.restore(); restoreEnv(); }
});

test('forwarder does NOT retry on 4xx (returns failure)', async () => {
  _resetForwarderForTests();
  const restoreEnv = setEnv({
    SAE_FORWARDING_ENABLED: 'true',
    SAE_INGEST_TOKEN:       'tok',
    SAE_ENDPOINT:           'https://example.test/ta-events',
  });
  const fetchMock = installFetchMock(() => jsonResponse(401, { error: 'bad token' }));
  try {
    const r = await forwardSignalToSAE(SAMPLE_PAYLOAD);
    assert.equal(r.success, false);
    assert.equal(r.status, 401);
    assert.equal(fetchMock.calls.length, 1);
  } finally { fetchMock.restore(); restoreEnv(); }
});

test('forwarder retries on network error then gives up gracefully', async () => {
  _resetForwarderForTests();
  const restoreEnv = setEnv({
    SAE_FORWARDING_ENABLED: 'true',
    SAE_INGEST_TOKEN:       'tok',
    SAE_ENDPOINT:           'https://unreachable.test/ta-events',
  });
  const fetchMock = installFetchMock(() => { throw new Error('ECONNREFUSED'); });
  try {
    const r = await forwardSignalToSAE(SAMPLE_PAYLOAD);
    assert.equal(r.success, false);
    assert.match(r.error, /ECONNREFUSED/);
    assert.equal(fetchMock.calls.length, 2);  // 1 try + 1 retry
  } finally { fetchMock.restore(); restoreEnv(); }
});

test('forwarder swallows fetch crash — never throws to caller', async () => {
  _resetForwarderForTests();
  const restoreEnv = setEnv({
    SAE_FORWARDING_ENABLED: 'true',
    SAE_INGEST_TOKEN:       'tok',
  });
  const fetchMock = installFetchMock(() => { throw new TypeError('synthetic boom'); });
  try {
    let threw = false;
    let result;
    try { result = await forwardSignalToSAE(SAMPLE_PAYLOAD); }
    catch { threw = true; }
    assert.equal(threw, false, 'forwardSignalToSAE must never throw');
    assert.equal(result.success, false);
  } finally { fetchMock.restore(); restoreEnv(); }
});

test('forwarder rate-limits: 11th send is queued, not posted immediately', async () => {
  _resetForwarderForTests();
  const restoreEnv = setEnv({
    SAE_FORWARDING_ENABLED: 'true',
    SAE_INGEST_TOKEN:       'tok',
    SAE_ENDPOINT:           'https://example.test/ta-events',
  });
  const fetchMock = installFetchMock(() => jsonResponse(200));
  try {
    const results = [];
    for (let i = 0; i < 11; i++) {
      results.push(await forwardSignalToSAE({ ...SAMPLE_PAYLOAD, rank: i }));
    }
    // First 10 hit the network; 11th should be queued (success:true, queued:true).
    assert.equal(fetchMock.calls.length, 10);
    assert.equal(results[10].queued, true);
    const state = _inspectForwarderState();
    assert.equal(state.queueLen, 1);
  } finally { fetchMock.restore(); restoreEnv(); _resetForwarderForTests(); }
});

// ── Scanner mapping (integration shape) ───────────────────────────────────────

test('buildSFPSAEPayload — long, monday_low + L.RLZ-MM', () => {
  const p = buildSFPSAEPayload({
    symbol:       'BTC_USDT',
    direction:    'long',
    levelKey:     'mondayLow',
    levelPrice:   100000,
    currentPrice: 100300,
    locZone:      'L.RLZ-MM (0.618)',
    rank:         14,
  });
  assert.equal(p.market_id, null);
  assert.equal(p.symbol, 'BTC_USDT');
  assert.equal(p.timeframe, '5m');
  assert.equal(p.pattern_type, 'SFP_long');
  assert.equal(p.rank, 14);
  assert.equal(p.fib_zone, 'L.RLZ-MM');
  assert.equal(p.nearest_session_level, 'monday_low');
  assert.equal(p.distance_to_level_pct, 0.3);
  assert.equal(p.htf_timeframe, '1h');
  assert.equal(p.signal_reliability, 0.60);
  assert.equal(p.source, 'mexc_scanner');
  assert.equal(p.neckline_price, null);
  assert.match(p.detected_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('buildSFPSAEPayload — short, asia_high + S.RLZ-SHARK', () => {
  const p = buildSFPSAEPayload({
    symbol:       'ETH_USDT',
    direction:    'short',
    levelKey:     'asiaHigh',
    levelPrice:   3500,
    currentPrice: 3493,
    locZone:      'S.RLZ-SHARK (0.786)',
    rank:         9,
  });
  assert.equal(p.pattern_type, 'SFP_short');
  assert.equal(p.fib_zone, 'S.RLZ-SHARK');
  assert.equal(p.nearest_session_level, 'asia_high');
  assert.equal(p.distance_to_level_pct, 0.2);
});

test('buildSFPSAEPayload — PML/PMH (monthly) returns null session level', () => {
  const p = buildSFPSAEPayload({
    symbol: 'SOL_USDT', direction: 'long', levelKey: 'PML',
    levelPrice: 150, currentPrice: 150.5, locZone: null, rank: 8,
  });
  assert.equal(p.nearest_session_level, null);
  assert.equal(p.fib_zone, null);
});

test('buildSFPSAEPayload — P.CZ trend continuation maps correctly', () => {
  const p = buildSFPSAEPayload({
    symbol: 'BTC_USDT', direction: 'long', levelKey: 'PWL',
    levelPrice: 100000, currentPrice: 100050, locZone: 'P.CZ (0.382-0.500)', rank: 12,
  });
  assert.equal(p.fib_zone, 'P.CZ');
  assert.equal(p.nearest_session_level, 'pwl');
});

test('buildLJSAEPayload — long stage1 on 4H (bare call, no confluence)', () => {
  const p = buildLJSAEPayload({
    symbol: 'BTC_USDT', direction: 'long', stage: 1, htfTf: '4H',
    neckline: 79400.5, entry: 79480,
  });
  assert.equal(p.pattern_type, 'LJ_long_stage1');
  assert.equal(p.htf_timeframe, '4h');
  assert.equal(p.timeframe, '1h');
  assert.equal(p.neckline_price, 79400.5);
  // Defaults: no locZone + all confluence bits off → rank=1, fib_zone=null, level=null
  assert.equal(p.fib_zone, null);
  assert.equal(p.nearest_session_level, null);
  assert.equal(p.rank, 1);
  // distance falls back to neckline when no session level provided
  assert.equal(p.distance_to_level_pct, 0.1);
});

test('buildLJSAEPayload — short stage2 on D1', () => {
  const p = buildLJSAEPayload({
    symbol: 'ETH_USDT', direction: 'short', stage: 2, htfTf: 'D1',
    neckline: 3500, entry: 3490,
  });
  assert.equal(p.pattern_type, 'LJ_short_stage2');
  assert.equal(p.htf_timeframe, '1d');
});

test('buildLJSAEPayload — W1 maps to 1w', () => {
  const p = buildLJSAEPayload({
    symbol: 'XRP_USDT', direction: 'long', stage: 1, htfTf: 'W1',
    neckline: 0.5, entry: 0.51,
  });
  assert.equal(p.htf_timeframe, '1w');
});

// ── New LJ coverage: confluence + fib + session-level enrichment ───────────────

test('buildLJSAEPayload — full confluence (loc + OBV + RSI + MACD) → rank 16', () => {
  const p = buildLJSAEPayload({
    symbol: 'BTC_USDT', direction: 'long', stage: 1, htfTf: '4H',
    neckline: 79400, entry: 79500,
    locZone: 'L.RLZ-MM (0.618)',
    hasOBV: true, hasRSI: true, hasMACD: true,
  });
  assert.equal(p.rank, 16);                 // 1 + (8|4|2|1)
  assert.equal(p.fib_zone, 'L.RLZ-MM');
});

test('buildLJSAEPayload — loc only → rank 9', () => {
  const p = buildLJSAEPayload({
    symbol: 'ETH_USDT', direction: 'short', stage: 1, htfTf: 'D1',
    neckline: 3500, entry: 3490,
    locZone: 'S.RLZ (0.618-0.786)',
    hasOBV: false, hasRSI: false, hasMACD: false,
  });
  assert.equal(p.rank, 9);                  // 1 + (8|0|0|0)
  assert.equal(p.fib_zone, 'S.RLZ-MM');     // mapFibZone collapses bare S.RLZ to MM
});

test('buildLJSAEPayload — no loc, RSI+MACD only → rank 4', () => {
  const p = buildLJSAEPayload({
    symbol: 'SOL_USDT', direction: 'long', stage: 2, htfTf: '4H',
    neckline: 150, entry: 152,
    hasOBV: false, hasRSI: true, hasMACD: true,
  });
  assert.equal(p.rank, 4);                  // 1 + (0|0|2|1)
  assert.equal(p.fib_zone, null);
});

test('buildLJSAEPayload — nearest session level populated + distance uses level (not neckline)', () => {
  const p = buildLJSAEPayload({
    symbol: 'BTC_USDT', direction: 'long', stage: 1, htfTf: '4H',
    neckline: 79400, entry: 79500,
    levelKey: 'mondayLow', levelPrice: 79600,
    hasOBV: true, hasRSI: false, hasMACD: false,
  });
  assert.equal(p.nearest_session_level, 'monday_low');
  // distance should come from |79500 - 79600| / 79600 ≈ 0.1256% → 0.13
  assert.equal(p.distance_to_level_pct, 0.13);
  // sanity: not the neckline distance (|79500-79400|/79400 ≈ 0.1259 → 0.13 would coincide).
  // Use a sharper neckline to differentiate.
  const p2 = buildLJSAEPayload({
    symbol: 'BTC_USDT', direction: 'long', stage: 1, htfTf: '4H',
    neckline: 78000, entry: 79500,
    levelKey: 'mondayLow', levelPrice: 79600,
  });
  // With session level present, should use 79500-79600 not 79500-78000.
  assert.ok(p2.distance_to_level_pct < 1.0, 'session-level distance preferred over neckline');
  assert.equal(p2.nearest_session_level, 'monday_low');
});

test('buildLJSAEPayload — unmapped level key drops through to neckline distance', () => {
  const p = buildLJSAEPayload({
    symbol: 'BTC_USDT', direction: 'short', stage: 2, htfTf: 'D1',
    neckline: 80000, entry: 79920,
    levelKey: 'PMH', levelPrice: 81000,         // PMH → null in SAE_LEVEL_MAP (monthly)
  });
  assert.equal(p.nearest_session_level, null);
  // distance falls back to neckline: |79920-80000|/80000 = 0.001 → 0.1
  assert.equal(p.distance_to_level_pct, 0.1);
});

test('buildLJSAEPayload — htf mapping stable across stages and directions', () => {
  for (const [direction, stage, tf, expected] of [
    ['long',  1, '4H', '4h'],
    ['long',  2, '4H', '4h'],
    ['short', 1, 'D1', '1d'],
    ['short', 2, 'D1', '1d'],
    ['long',  1, 'W1', '1w'],
  ]) {
    const p = buildLJSAEPayload({
      symbol: 'BTC_USDT', direction, stage, htfTf: tf, neckline: 100, entry: 101,
    });
    assert.equal(p.htf_timeframe, expected);
    assert.equal(p.pattern_type, `LJ_${direction}_stage${stage}`);
  }
});

// ── findNearestSessionLevel — pure-function coverage ───────────────────────────

test('findNearestSessionLevel — picks closest mapped level within tolerance', () => {
  const levels = { mondayHigh: 110, mondayLow: 95, weeklyOpen: 99, PWH: 120, PWL: 90 };
  const r = findNearestSessionLevel(levels, 100, 0.05);
  assert.equal(r.key, 'weeklyOpen');
  assert.equal(r.price, 99);
});

test('findNearestSessionLevel — returns null when nothing is within tolerance', () => {
  const levels = { mondayHigh: 200, mondayLow: 50, weeklyOpen: 300 };
  const r = findNearestSessionLevel(levels, 100, 0.02);   // 2% = 98-102
  assert.equal(r, null);
});

test('findNearestSessionLevel — ignores unmapped keys (PMH/PML monthly)', () => {
  const levels = { PMH: 100.5, PML: 99.5 };               // both in 1% band, but unmapped
  const r = findNearestSessionLevel(levels, 100, 0.02);
  assert.equal(r, null);
});

test('findNearestSessionLevel — handles null/NaN level values', () => {
  const levels = { mondayHigh: null, mondayLow: NaN, weeklyOpen: 100, PWH: undefined };
  const r = findNearestSessionLevel(levels, 100);
  assert.equal(r.key, 'weeklyOpen');
});

test('findNearestSessionLevel — defensive: empty levels + invalid price', () => {
  assert.equal(findNearestSessionLevel({}, 100), null);
  assert.equal(findNearestSessionLevel(null, 100), null);
  assert.equal(findNearestSessionLevel({ mondayHigh: 100 }, 0), null);
  assert.equal(findNearestSessionLevel({ mondayHigh: 100 }, NaN), null);
});

// ── End-to-end: scanner mapper output is forwarder-ready ──────────────────────

test('end-to-end: SFP mapper output forwards cleanly through forwarder', async () => {
  _resetForwarderForTests();
  const restoreEnv = setEnv({
    SAE_FORWARDING_ENABLED: 'true',
    SAE_INGEST_TOKEN:       'tok',
    SAE_ENDPOINT:           'https://example.test/ta-events',
  });
  const fetchMock = installFetchMock(() => jsonResponse(200));
  try {
    const payload = buildSFPSAEPayload({
      symbol: 'BTC_USDT', direction: 'long', levelKey: 'mondayLow',
      levelPrice: 100000, currentPrice: 100300, locZone: 'L.RLZ-MM (0.618)', rank: 14,
    });
    const r = await forwardSignalToSAE(payload);
    assert.equal(r.success, true);
    const sent = JSON.parse(fetchMock.calls[0].init.body);
    assert.equal(sent.symbol, 'BTC_USDT');
    assert.equal(sent.pattern_type, 'SFP_long');
    assert.equal(sent.fib_zone, 'L.RLZ-MM');
    assert.equal(sent.nearest_session_level, 'monday_low');
    assert.equal(sent.source, 'mexc_scanner');
  } finally { fetchMock.restore(); restoreEnv(); }
});
