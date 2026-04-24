/**
 * Tests for sae_regime_forwarder.js.
 *
 * Run:  node --test webhook/sae_regime_forwarder.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  forwardRegimeToSAE,
  _resetRegimeForwarderForTests,
  _inspectRegimeForwarderState,
} from './sae_regime_forwarder.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

const SAMPLE_REGIME = {
  source: 'market_cockpit',
  source_tag: 'cockpit_chrome',
  timeframe: '4h',
  master_regime_label: 'FULL RISK-OFF',
  crypto_score: 0,
  macro_score: 1,
  btc_d_direction: 'flat',
  usdt_d_direction: 'up',
  eth_btc_direction: 'down',
  dxy_direction: 'up',
  oil_direction: 'up',
  gold_direction: 'down',
  spx_direction: 'down',
  ndx_direction: 'down',
  us10y_direction: 'up',
  vix_direction: 'up',
  snapshot_at: '2026-04-24T08:00:00Z',
};

// ── Gating / validation ───────────────────────────────────────────────────────

test('regime forwarder — no-op when SAE_REGIME_PUSH_ENABLED is unset', async () => {
  _resetRegimeForwarderForTests();
  const restoreEnv = setEnv({ SAE_REGIME_PUSH_ENABLED: undefined, SAE_INGEST_TOKEN: 'tok' });
  const fetchMock = installFetchMock(() => jsonResponse(200));
  try {
    const r = await forwardRegimeToSAE(SAMPLE_REGIME);
    assert.equal(r.success, false);
    assert.equal(r.error, 'disabled');
    assert.equal(fetchMock.calls.length, 0);
  } finally { fetchMock.restore(); restoreEnv(); }
});

test('regime forwarder — skips when SAE_INGEST_TOKEN is empty', async () => {
  _resetRegimeForwarderForTests();
  const restoreEnv = setEnv({ SAE_REGIME_PUSH_ENABLED: 'true', SAE_INGEST_TOKEN: '' });
  const fetchMock = installFetchMock(() => jsonResponse(200));
  try {
    const r = await forwardRegimeToSAE(SAMPLE_REGIME);
    assert.equal(r.success, false);
    assert.equal(r.error, 'missing_token');
    assert.equal(fetchMock.calls.length, 0);
  } finally { fetchMock.restore(); restoreEnv(); }
});

test('regime forwarder — rejects malformed payload', async () => {
  _resetRegimeForwarderForTests();
  const restoreEnv = setEnv({ SAE_REGIME_PUSH_ENABLED: 'true', SAE_INGEST_TOKEN: 'tok' });
  const fetchMock = installFetchMock(() => jsonResponse(200));
  try {
    assert.equal((await forwardRegimeToSAE(null)).error,      'invalid_payload');
    assert.equal((await forwardRegimeToSAE('string')).error,  'invalid_payload');
    assert.equal(fetchMock.calls.length, 0);
  } finally { fetchMock.restore(); restoreEnv(); }
});

// ── Happy path / auth header ──────────────────────────────────────────────────

test('regime forwarder — POSTs with correct URL, headers, body', async () => {
  _resetRegimeForwarderForTests();
  const restoreEnv = setEnv({
    SAE_REGIME_PUSH_ENABLED: 'true',
    SAE_INGEST_TOKEN:        'token-xyz',
    SAE_REGIME_ENDPOINT:     'https://example.test/regime/external',
  });
  const fetchMock = installFetchMock(() => jsonResponse(200, { status: 'accepted', id: 'abc' }));
  try {
    const r = await forwardRegimeToSAE(SAMPLE_REGIME);
    assert.equal(r.success, true);
    assert.equal(r.status, 200);
    assert.equal(fetchMock.calls.length, 1);
    const { url, init } = fetchMock.calls[0];
    assert.equal(url, 'https://example.test/regime/external');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.equal(init.headers['X-SAE-Token'], 'token-xyz');
    const sentBody = JSON.parse(init.body);
    assert.deepEqual(sentBody, SAMPLE_REGIME);
  } finally { fetchMock.restore(); restoreEnv(); }
});

// ── Rate limit ────────────────────────────────────────────────────────────────

test('regime forwarder — second push inside 60s is rate-limited (not POSTed)', async () => {
  _resetRegimeForwarderForTests();
  const restoreEnv = setEnv({
    SAE_REGIME_PUSH_ENABLED: 'true',
    SAE_INGEST_TOKEN:        'tok',
    SAE_REGIME_ENDPOINT:     'https://example.test/regime/external',
  });
  const fetchMock = installFetchMock(() => jsonResponse(200));
  try {
    const r1 = await forwardRegimeToSAE(SAMPLE_REGIME);
    assert.equal(r1.success, true);
    assert.equal(fetchMock.calls.length, 1);
    const r2 = await forwardRegimeToSAE(SAMPLE_REGIME);
    assert.equal(r2.success, false);
    assert.equal(r2.error, 'rate_limited');
    assert.equal(fetchMock.calls.length, 1);                // still 1
    const state = _inspectRegimeForwarderState();
    assert.equal(state.enabled, true);
    assert.equal(state.canSendNow, false);
  } finally { fetchMock.restore(); restoreEnv(); }
});

// ── Auth failure / retry ──────────────────────────────────────────────────────

test('regime forwarder — 401 response surfaces as failure, no retry', async () => {
  _resetRegimeForwarderForTests();
  const restoreEnv = setEnv({
    SAE_REGIME_PUSH_ENABLED: 'true',
    SAE_INGEST_TOKEN:        'badtoken',
    SAE_REGIME_ENDPOINT:     'https://example.test/regime/external',
  });
  const fetchMock = installFetchMock(() => jsonResponse(401, { error: 'bad token' }));
  try {
    const r = await forwardRegimeToSAE(SAMPLE_REGIME);
    assert.equal(r.success, false);
    assert.equal(r.status, 401);
    assert.equal(fetchMock.calls.length, 1);                // no retry on 4xx
  } finally { fetchMock.restore(); restoreEnv(); }
});

test('regime forwarder — retries once on 503 then succeeds', async () => {
  _resetRegimeForwarderForTests();
  const restoreEnv = setEnv({
    SAE_REGIME_PUSH_ENABLED: 'true',
    SAE_INGEST_TOKEN:        'tok',
    SAE_REGIME_ENDPOINT:     'https://example.test/regime/external',
  });
  const fetchMock = installFetchMock((u, i, n) =>
    n === 1 ? jsonResponse(503) : jsonResponse(200)
  );
  try {
    const r = await forwardRegimeToSAE(SAMPLE_REGIME);
    assert.equal(r.success, true);
    assert.equal(fetchMock.calls.length, 2);
  } finally { fetchMock.restore(); restoreEnv(); }
});

test('regime forwarder — network error retried then gives up gracefully', async () => {
  _resetRegimeForwarderForTests();
  const restoreEnv = setEnv({
    SAE_REGIME_PUSH_ENABLED: 'true',
    SAE_INGEST_TOKEN:        'tok',
  });
  const fetchMock = installFetchMock(() => { throw new Error('ECONNREFUSED'); });
  try {
    const r = await forwardRegimeToSAE(SAMPLE_REGIME);
    assert.equal(r.success, false);
    assert.match(r.error, /ECONNREFUSED/);
    assert.equal(fetchMock.calls.length, 2);                // try + retry
  } finally { fetchMock.restore(); restoreEnv(); }
});

test('regime forwarder — swallows fetch crash, never throws to caller', async () => {
  _resetRegimeForwarderForTests();
  const restoreEnv = setEnv({ SAE_REGIME_PUSH_ENABLED: 'true', SAE_INGEST_TOKEN: 'tok' });
  const fetchMock = installFetchMock(() => { throw new TypeError('synthetic boom'); });
  try {
    let threw = false;
    let result;
    try { result = await forwardRegimeToSAE(SAMPLE_REGIME); }
    catch { threw = true; }
    assert.equal(threw, false, 'forwardRegimeToSAE must never throw');
    assert.equal(result.success, false);
  } finally { fetchMock.restore(); restoreEnv(); }
});
