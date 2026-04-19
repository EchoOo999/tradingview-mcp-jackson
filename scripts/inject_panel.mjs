#!/usr/bin/env node
/**
 * MEXC Scalp Panel — Desktop Injector
 *
 * Connects to TradingView Desktop (CDP :9222), injects the scalp panel
 * and coin-search overlay into ALL open Electron renderer tabs, and runs
 * a local bridge server on :9224 for symbol switching.
 *
 * Resilient design:
 *   - Polls until TV is ready on startup (no manual timing needed)
 *   - Heartbeat detects TV restarts and re-injects automatically
 *   - Re-injects on page navigation (TV internal reload / Ctrl+R)
 *   - Injects into ALL open TV chart tabs, not just the first one
 *
 * Usage:
 *   node scripts/inject_panel.mjs
 *   (or via scripts/start_desktop_panel.bat)
 */

import CDP            from 'chrome-remote-interface';
import { readFileSync } from 'fs';
import { createServer }  from 'http';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '..');

const CDP_HOST           = 'localhost';
const CDP_PORT           = 9222;
const BRIDGE_PORT        = 9224;
const REINJECT_DELAY_MS  = 2500;   // wait after loadEventFired before injecting
const CONNECT_RETRY_MS   = 3000;   // poll interval while waiting for TV
const HEARTBEAT_MS       = 5000;   // liveness check interval
const SYMBOL_REFRESH_MS  = 60 * 60 * 1000;  // unused — kept for reference

// ── Asset loading ────────────────────────────────────────────────────────────

const panelCSS  = readFileSync(join(ROOT, 'chrome-extension', 'styles.css'),       'utf8');
const panelJS   = readFileSync(join(ROOT, 'chrome-extension', 'content.js'),       'utf8');
const cockpitJS = readFileSync(join(ROOT, 'chrome-extension', 'market-cockpit.js'),'utf8');
const searchJS  = readFileSync(join(__dir, 'coin-search-overlay.js'), 'utf8');

// ── Symbol list: read from TV watchlist DOM at injection time ─────────────────
// The overlay queries [data-symbol-full] directly on each open — no pre-fetch needed.

// ── Per-target CDP client management ─────────────────────────────────────────
// Map from targetId → { client, label }

const clients = new Map();

async function getAllChartTargets() {
  try {
    const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
    const targets = await resp.json();
    return targets.filter(
      t => t.type === 'page' && /tradingview/i.test(t.url)
    );
  } catch {
    return [];
  }
}

async function evaluateOnTarget(client, expression) {
  const result = await client.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: false,
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS eval error: ${msg}`);
  }
  return result.result?.value;
}

async function injectIntoClient(client, label) {
  // 1. CSS
  await evaluateOnTarget(client, `
    (function() {
      var id = 'mexc-scalp-styles';
      var old = document.getElementById(id);
      if (old) old.remove();
      var s = document.createElement('style');
      s.id = id;
      s.textContent = ${JSON.stringify(panelCSS)};
      document.head.appendChild(s);
    })()
  `);

  // 2. Panel JS (IIFE guards against double-inject via #mexc-scalp-panel check)
  await evaluateOnTarget(client, panelJS);

  // 3. Market Cockpit panel (IIFE guards via #market-cockpit-panel check)
  await evaluateOnTarget(client, cockpitJS);

  // 4. Coin-search overlay (reads watchlist from TV DOM directly on each open)
  await evaluateOnTarget(client, searchJS);

  console.log(`[panel] Injected → ${label}`);
}

async function connectTarget(target) {
  if (clients.has(target.id)) return clients.get(target.id);

  const label = target.title || target.url.slice(0, 60);
  try {
    const c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });
    await c.Runtime.enable();
    await c.Page.enable();

    // Re-inject on page navigation
    c.Page.on('loadEventFired', async () => {
      console.log(`[panel] Page reloaded (${label}) — re-injecting in ${REINJECT_DELAY_MS}ms…`);
      await new Promise(r => setTimeout(r, REINJECT_DELAY_MS));
      try {
        await injectIntoClient(c, label);
      } catch (err) {
        console.error(`[panel] Re-injection failed (${label}):`, err.message);
      }
    });

    clients.set(target.id, { client: c, label });
    return { client: c, label };
  } catch (err) {
    console.error(`[panel] Could not connect to target (${label}):`, err.message);
    return null;
  }
}

async function injectAllTargets() {
  const targets = await getAllChartTargets();
  if (!targets.length) {
    console.log('[panel] No TV chart targets found.');
    return;
  }

  for (const target of targets) {
    const entry = await connectTarget(target);
    if (!entry) continue;
    try {
      await injectIntoClient(entry.client, entry.label);
    } catch (err) {
      console.error(`[panel] Injection failed (${entry.label}):`, err.message);
    }
  }
}

// ── Wait for TV (any chart target) ───────────────────────────────────────────

async function waitForTV() {
  let logged = false;
  while (true) {
    const targets = await getAllChartTargets();
    if (targets.length) return;
    if (!logged) {
      console.log('[panel] Waiting for TradingView Desktop (CDP :9222)…');
      logged = true;
    }
    await new Promise(r => setTimeout(r, CONNECT_RETRY_MS));
  }
}

// ── Heartbeat / reconnect loop ───────────────────────────────────────────────
// Every 5s: liveness-check all known clients + discover new tabs.

async function startHeartbeat() {
  while (true) {
    await new Promise(r => setTimeout(r, HEARTBEAT_MS));

    // Check existing clients
    for (const [targetId, { client, label }] of clients) {
      try {
        await evaluateOnTarget(client, '1');
      } catch {
        console.log(`[panel] Lost connection (${label}) — removing.`);
        try { await client.close(); } catch {}
        clients.delete(targetId);
      }
    }

    // If all clients gone, TV restarted — wait and re-inject
    if (clients.size === 0) {
      console.log('[panel] All TV connections lost — waiting for restart…');
      await waitForTV();
      console.log('[panel] TV reconnected — re-injecting all tabs…');
      await new Promise(r => setTimeout(r, REINJECT_DELAY_MS));
      await injectAllTargets();
      continue;
    }

    // Discover any newly opened tabs
    const liveTargets = await getAllChartTargets();
    for (const target of liveTargets) {
      if (!clients.has(target.id)) {
        console.log(`[panel] New TV tab detected — injecting…`);
        const entry = await connectTarget(target);
        if (entry) {
          await new Promise(r => setTimeout(r, REINJECT_DELAY_MS));
          try {
            await injectIntoClient(entry.client, entry.label);
          } catch (err) {
            console.error(`[panel] Injection failed (${entry.label}):`, err.message);
          }
        }
      }
    }
  }
}

// ── Bridge server ─────────────────────────────────────────────────────────────
// Receives { symbol: 'MEXC:BTCUSDT.P' } from the coin-search overlay (fallback)
// and calls chart.setSymbol() on the ACTIVE (first live) client.

function startBridge() {
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === 'POST' && req.url === '/set-symbol') {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', async () => {
        try {
          const { symbol } = JSON.parse(body);
          if (!symbol) throw new Error('symbol required');

          // Try each connected client until one succeeds
          let lastErr;
          for (const { client, label } of clients.values()) {
            try {
              await evaluateOnTarget(client, `
                (function() {
                  var chart = window.TradingViewApi._activeChartWidgetWV.value();
                  chart.setSymbol(${JSON.stringify(symbol)}, {});
                })()
              `);
              console.log(`[bridge] → ${symbol} (via ${label})`);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, symbol }));
              return;
            } catch (err) {
              lastErr = err;
            }
          }

          throw lastErr || new Error('No active TV clients');
        } catch (err) {
          console.error('[bridge] Error:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[bridge] Port ${BRIDGE_PORT} in use — kill the old process first:`);
      console.error(`         netstat -ano | findstr :${BRIDGE_PORT}`);
    } else {
      console.error('[bridge] Server error:', err.message);
    }
  });

  server.listen(BRIDGE_PORT, 'localhost', () =>
    console.log(`[bridge] Listening on http://localhost:${BRIDGE_PORT}`)
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Start bridge first (doesn't depend on TV being up)
  startBridge();

  // Wait for TV — no timeout, no exit on failure
  console.log('[panel] Connecting to TradingView Desktop (CDP :9222)…');
  await waitForTV();
  console.log('[panel] CDP connected.');

  await new Promise(r => setTimeout(r, REINJECT_DELAY_MS));

  try {
    await injectAllTargets();
  } catch (err) {
    console.error('[panel] Initial injection failed:', err.message);
    console.error('[panel] Will retry on next page load or reconnect.');
  }

  // Keep running: heartbeat handles TV restarts + new tabs automatically
  startHeartbeat();
  console.log('[panel] Running. Ctrl+C to stop.');
}

main().catch(err => { console.error(err); process.exit(1); });
