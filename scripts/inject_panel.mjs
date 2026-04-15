#!/usr/bin/env node
/**
 * MEXC Scalp Panel — Desktop Injector
 *
 * Connects to TradingView Desktop (CDP :9222), injects the scalp panel
 * and coin-search overlay into the Electron renderer, and runs a local
 * bridge server on :9224 for symbol switching.
 *
 * Resilient design:
 *   - Polls until TV is ready on startup (no manual timing needed)
 *   - Heartbeat detects TV restarts and re-injects automatically
 *   - Re-injects on page navigation (TV internal reload / Ctrl+R)
 *
 * Usage:
 *   node scripts/inject_panel.mjs
 *   (or via scripts/start_desktop_panel.bat)
 */

import { readFileSync } from 'fs';
import { createServer }  from 'http';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';
import { getClient, evaluate, disconnect } from '../src/connection.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '..');

const BRIDGE_PORT        = 9224;
const REINJECT_DELAY_MS  = 2500;   // wait after loadEventFired before injecting
const CONNECT_RETRY_MS   = 3000;   // poll interval while waiting for TV
const HEARTBEAT_MS       = 5000;   // liveness check interval
const SYMBOL_REFRESH_MS  = 60 * 60 * 1000;

// ── Asset loading ────────────────────────────────────────────────────────────

const panelCSS = readFileSync(join(ROOT, 'chrome-extension', 'styles.css'),  'utf8');
const panelJS  = readFileSync(join(ROOT, 'chrome-extension', 'content.js'),  'utf8');
const searchJS = readFileSync(join(__dir, 'coin-search-overlay.js'), 'utf8');

// ── MEXC symbol list (fetched in Node — bypasses TV page CSP) ────────────────

let cachedSymbols = [];

async function fetchMexcSymbols() {
  try {
    const res  = await fetch('https://contract.mexc.com/api/v1/contract/detail');
    const data = await res.json();
    const list = (data.data || [])
      .filter(c => c.symbol && c.symbol.endsWith('_USDT'))
      .map(c => ({
        display:    c.symbol.replace('_USDT', ''),
        mexcSymbol: c.symbol,
        tvSymbol:   'MEXC:' + c.symbol.replace('_USDT', 'USDT') + '.P',
      }))
      .sort((a, b) => a.display.localeCompare(b.display));
    cachedSymbols = list;
    console.log(`[symbols] Loaded ${list.length} MEXC perpetuals`);
  } catch (err) {
    console.error('[symbols] Fetch failed:', err.message);
  }
}

// ── Panel injection ──────────────────────────────────────────────────────────

async function inject() {
  // 1. CSS
  await evaluate(`
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

  // 2. Panel (IIFE guards against double-inject via #mexc-scalp-panel check)
  await evaluate(panelJS);

  // 3. Pre-load symbol list into page before overlay runs
  await evaluate(`window.__mexcSymbols = ${JSON.stringify(cachedSymbols)}`);

  // 4. Coin-search overlay
  await evaluate(searchJS);

  console.log('[panel] Injected.');
}

// ── Wait for TV ───────────────────────────────────────────────────────────────
// Polls until CDP is reachable — no exit on startup, handles TV slow start.

async function waitForTV() {
  let logged = false;
  while (true) {
    try {
      await getClient();
      return;
    } catch {
      if (!logged) {
        console.log('[panel] Waiting for TradingView Desktop (CDP :9222)…');
        logged = true;
      }
      await new Promise(r => setTimeout(r, CONNECT_RETRY_MS));
    }
  }
}

// ── Navigation listener ───────────────────────────────────────────────────────

async function watchNavigation() {
  const c = await getClient();
  c.Page.on('loadEventFired', async () => {
    console.log('[panel] Page reloaded — re-injecting in', REINJECT_DELAY_MS, 'ms…');
    await new Promise(r => setTimeout(r, REINJECT_DELAY_MS));
    try { await inject(); } catch (err) {
      console.error('[panel] Re-injection failed:', err.message);
    }
  });
}

// ── Heartbeat / reconnect loop ───────────────────────────────────────────────
// Fires every 5s. If TV has restarted, reconnects and re-injects automatically.

async function startHeartbeat() {
  while (true) {
    await new Promise(r => setTimeout(r, HEARTBEAT_MS));
    try {
      await evaluate('1');  // liveness check
    } catch {
      console.log('[panel] TV connection lost — waiting for restart…');
      await disconnect().catch(() => {});

      // Wait for TV to come back
      await waitForTV();

      console.log('[panel] TV reconnected — re-injecting…');
      try {
        await watchNavigation();  // re-attach to new client
        await new Promise(r => setTimeout(r, REINJECT_DELAY_MS));
        await inject();
      } catch (err) {
        console.error('[panel] Post-reconnect injection failed:', err.message);
      }
    }
  }
}

// ── Bridge server ─────────────────────────────────────────────────────────────
// Receives { symbol: 'MEXC:BTCUSDT.P' } from the coin-search overlay and
// calls chart.setSymbol() — TV also auto-highlights the watchlist entry.

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

          await evaluate(`
            (function() {
              var chart = window.TradingViewApi._activeChartWidgetWV.value();
              chart.setSymbol(${JSON.stringify(symbol)}, {});
            })()
          `);

          console.log(`[bridge] → ${symbol}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, symbol }));
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
  // Fetch symbol list before anything (overlay needs it at inject time)
  await fetchMexcSymbols();
  setInterval(fetchMexcSymbols, SYMBOL_REFRESH_MS);

  // Start bridge first (doesn't depend on TV being up)
  startBridge();

  // Wait for TV — no timeout, no exit on failure
  console.log('[panel] Connecting to TradingView Desktop (CDP :9222)…');
  await waitForTV();
  console.log('[panel] CDP connected.');

  await watchNavigation();
  await new Promise(r => setTimeout(r, REINJECT_DELAY_MS));

  try {
    await inject();
  } catch (err) {
    console.error('[panel] Initial injection failed:', err.message);
    console.error('[panel] Will retry on next page load or reconnect.');
  }

  // Keep running: heartbeat handles TV restarts automatically
  startHeartbeat();
  console.log('[panel] Running. Ctrl+C to stop.');
}

main().catch(err => { console.error(err); process.exit(1); });
