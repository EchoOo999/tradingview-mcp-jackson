/**
 * SAE Regime Forwarder — proxies the Chrome Cockpit's 60s regime snapshot
 * to EchoOo-SAE `POST /regime/external`.
 *
 * Why a server-side proxy instead of the cockpit POSTing directly?
 *   The X-SAE-Token header value lives in mexc-webhook's env. We do NOT want
 *   to inject that secret into the browser-side cockpit.
 *
 * Behaviour:
 *   - Gated by SAE_REGIME_PUSH_ENABLED=true (default false — safe to import
 *     while disabled).
 *   - Auth via X-SAE-Token (value = SAE_INGEST_TOKEN, shared with scanner).
 *   - 5s timeout, 1x retry on network error or 5xx.
 *   - Soft rate-limit: max 1 push per 60s to match the cockpit refresh cadence.
 *     Excess pushes are dropped (not queued — a stale regime snapshot isn't
 *     worth delaying the next fresh one).
 *   - Never throws — all errors logged and swallowed so the /cockpit/regime
 *     HTTP handler's response path is unaffected.
 *
 * Public API:
 *   forwardRegimeToSAE(payload)      — fire-and-forget; returns Promise<{ success, status?, error? }>
 *   _resetRegimeForwarderForTests()  — test-only state reset
 *   _inspectRegimeForwarderState()   — test-only inspector
 */

const DEFAULT_ENDPOINT      = 'https://botbridge-production.up.railway.app/regime/external';
const TIMEOUT_MS            = 5_000;
const RETRY_DELAY_MS        = 750;
const MIN_INTERVAL_MS       = 60_000;  // 1 push / 60s max

let lastSuccessfulSendAt = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isEnabled() {
  return String(process.env.SAE_REGIME_PUSH_ENABLED || '').toLowerCase() === 'true';
}

function endpoint() {
  return process.env.SAE_REGIME_ENDPOINT || DEFAULT_ENDPOINT;
}

function token() {
  return process.env.SAE_INGEST_TOKEN || '';
}

function canSendNow(now = Date.now()) {
  return now - lastSuccessfulSendAt >= MIN_INTERVAL_MS;
}

async function postOnce(payload) {
  const url = endpoint();
  const headers = {
    'Content-Type': 'application/json',
    'X-SAE-Token':  token(),
  };
  const body = JSON.stringify(payload);

  const attempt = async () => {
    return await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  };

  let lastErr = null;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await attempt();
      if (res.ok) {
        lastSuccessfulSendAt = Date.now();
        console.log(`[sae-regime] forwarded ${payload.master_regime_label || '?'} → ${res.status}`);
        return { success: true, status: res.status };
      }
      if (res.status >= 500 && i === 0) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      const text = await res.text().catch(() => '');
      console.warn(`[sae-regime] forward failed: HTTP ${res.status} ${text.slice(0, 200)}`);
      return { success: false, status: res.status, error: text.slice(0, 200) };
    } catch (err) {
      lastErr = err;
      if (i === 0) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
    }
  }
  console.warn(`[sae-regime] forward failed: ${lastErr?.message || 'unknown error'}`);
  return { success: false, error: lastErr?.message || 'unknown error' };
}

export async function forwardRegimeToSAE(payload) {
  try {
    if (!isEnabled()) {
      return { success: false, error: 'disabled' };
    }
    if (!token()) {
      console.warn('[sae-regime] SAE_REGIME_PUSH_ENABLED=true but SAE_INGEST_TOKEN is empty — skipping');
      return { success: false, error: 'missing_token' };
    }
    if (!payload || typeof payload !== 'object') {
      console.warn('[sae-regime] refusing to forward malformed payload');
      return { success: false, error: 'invalid_payload' };
    }
    if (!canSendNow()) {
      return { success: false, error: 'rate_limited' };
    }
    return await postOnce(payload);
  } catch (err) {
    console.error(`[sae-regime] forwarder crashed (swallowed): ${err.message}`);
    return { success: false, error: err.message };
  }
}

export function _resetRegimeForwarderForTests() {
  lastSuccessfulSendAt = 0;
}

export function _inspectRegimeForwarderState() {
  return {
    enabled:              isEnabled(),
    endpoint:             endpoint(),
    lastSuccessfulSendAt,
    canSendNow:           canSendNow(),
  };
}
