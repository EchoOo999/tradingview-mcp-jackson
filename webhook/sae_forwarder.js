/**
 * SAE Forwarder — POSTs MEXC scanner detections to EchoOo-SAE /ta-events.
 *
 * Behaviour:
 *   - Gated by SAE_FORWARDING_ENABLED=true (default false — safe to import while disabled).
 *   - Auth via X-SAE-Token header (value = SAE_INGEST_TOKEN).
 *   - 5s timeout, 1x retry on network/5xx.
 *   - Soft rate-limit: max 10 signals / 60s; excess queued and drained on a timer.
 *   - Never throws — all errors logged and swallowed so scanner detection path is unaffected.
 *
 * Public API:
 *   forwardSignalToSAE(payload)  — fire-and-forget; returns Promise<{ success, status?, error? }>.
 *   _resetForwarderForTests()    — test-only state reset.
 */

const DEFAULT_ENDPOINT = 'https://botbridge-production.up.railway.app/ta-events';
const TIMEOUT_MS       = 5_000;
const RETRY_DELAY_MS   = 750;
const RATE_LIMIT       = 10;       // max sends per window
const RATE_WINDOW_MS   = 60_000;
const QUEUE_MAX        = 50;       // hard cap so a flood can't grow memory unbounded

const sendTimestamps = [];          // epoch ms of recent successful submissions (network attempt, not just intent)
const queue          = [];          // { payload, queuedAt }
let drainTimer       = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isEnabled() {
  return String(process.env.SAE_FORWARDING_ENABLED || '').toLowerCase() === 'true';
}

function endpoint() {
  return process.env.SAE_ENDPOINT || DEFAULT_ENDPOINT;
}

function token() {
  return process.env.SAE_INGEST_TOKEN || '';
}

function pruneRateWindow(now = Date.now()) {
  while (sendTimestamps.length && now - sendTimestamps[0] > RATE_WINDOW_MS) {
    sendTimestamps.shift();
  }
}

function canSendNow() {
  pruneRateWindow();
  return sendTimestamps.length < RATE_LIMIT;
}

function scheduleDrain() {
  if (drainTimer) return;
  pruneRateWindow();
  const waitMs = sendTimestamps.length
    ? Math.max(50, RATE_WINDOW_MS - (Date.now() - sendTimestamps[0]) + 25)
    : 50;
  drainTimer = setTimeout(async () => {
    drainTimer = null;
    while (queue.length && canSendNow()) {
      const { payload } = queue.shift();
      await postOnce(payload).catch(() => {});
    }
    if (queue.length) scheduleDrain();
  }, waitMs);
  if (typeof drainTimer.unref === 'function') drainTimer.unref();
}

async function postOnce(payload) {
  sendTimestamps.push(Date.now());
  const url = endpoint();
  const headers = {
    'Content-Type': 'application/json',
    'X-SAE-Token':  token(),
  };
  const body = JSON.stringify(payload);

  const attempt = async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res;
  };

  let lastErr = null;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await attempt();
      if (res.ok) {
        console.log(`[sae] forwarded ${payload.symbol} ${payload.pattern_type} → ${res.status}`);
        return { success: true, status: res.status };
      }
      // Retry only on 5xx
      if (res.status >= 500 && i === 0) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      const text = await res.text().catch(() => '');
      console.warn(`[sae] forward failed ${payload.symbol} ${payload.pattern_type}: HTTP ${res.status} ${text.slice(0, 200)}`);
      return { success: false, status: res.status, error: text.slice(0, 200) };
    } catch (err) {
      lastErr = err;
      if (i === 0) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
    }
  }
  console.warn(`[sae] forward failed ${payload.symbol} ${payload.pattern_type}: ${lastErr?.message || 'unknown error'}`);
  return { success: false, error: lastErr?.message || 'unknown error' };
}

export async function forwardSignalToSAE(payload) {
  try {
    if (!isEnabled()) {
      return { success: false, error: 'disabled' };
    }
    if (!token()) {
      console.warn('[sae] SAE_FORWARDING_ENABLED=true but SAE_INGEST_TOKEN is empty — skipping');
      return { success: false, error: 'missing_token' };
    }
    if (!payload || typeof payload !== 'object' || !payload.symbol || !payload.pattern_type) {
      console.warn('[sae] refusing to forward malformed payload');
      return { success: false, error: 'invalid_payload' };
    }

    if (!canSendNow()) {
      if (queue.length >= QUEUE_MAX) {
        console.warn(`[sae] queue full (${QUEUE_MAX}) — dropping ${payload.symbol} ${payload.pattern_type}`);
        return { success: false, error: 'queue_full' };
      }
      queue.push({ payload, queuedAt: Date.now() });
      scheduleDrain();
      return { success: true, queued: true };
    }

    return await postOnce(payload);
  } catch (err) {
    // Final safety net — never throw to caller.
    console.error(`[sae] forwarder crashed (swallowed): ${err.message}`);
    return { success: false, error: err.message };
  }
}

// Test-only — wipe in-memory state between tests.
export function _resetForwarderForTests() {
  sendTimestamps.length = 0;
  queue.length = 0;
  if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
}

// Test-only inspectors.
export function _inspectForwarderState() {
  return {
    enabled:    isEnabled(),
    endpoint:   endpoint(),
    queueLen:   queue.length,
    windowLen:  sendTimestamps.length,
  };
}
