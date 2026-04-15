#!/usr/bin/env node
/**
 * MEXC Scalp Panel — Desktop Injector
 *
 * Connects to TradingView Desktop (CDP :9222), injects the scalp panel
 * and coin-search overlay into the Electron renderer, and runs a local
 * bridge server on :9224 that handles symbol-switch requests from the
 * coin-search UI.
 *
 * Usage:
 *   node scripts/inject_panel.mjs
 *
 * Prerequisites:
 *   TradingView Desktop must be running with CDP enabled — launch via:
 *   cscript scripts\launch_tv_debug.vbs
 */

import { readFileSync } from 'fs';
import { createServer }  from 'http';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';
import { getClient, evaluate } from '../src/connection.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '..');

const BRIDGE_PORT       = 9224;
const REINJECT_DELAY_MS = 2000;
const SYMBOL_REFRESH_MS = 60 * 60 * 1000;  // refresh symbol list every hour

// ── Asset loading ────────────────────────────────────────────────────────────

const panelCSS = readFileSync(join(ROOT, 'chrome-extension', 'styles.css'),  'utf8');
const panelJS  = readFileSync(join(ROOT, 'chrome-extension', 'content.js'),  'utf8');
const searchJS = readFileSync(join(__dir, 'coin-search-overlay.js'), 'utf8');

// ── MEXC symbol list (fetched in Node — no CSP restrictions) ─────────────────
//
// TV symbol format for MEXC perps: MEXC:BTCUSDT.P
// Overlay receives this pre-built list and never needs to fetch from the page.

let cachedSymbols = [];  // { display, mexcSymbol, tvSymbol }

async function fetchMexcSymbols() {
  try {
    const res  = await fetch('https://contract.mexc.com/api/v1/contract/detail');
    const data = await res.json();
    const list = (data.data || [])
      .filter(c => c.symbol && c.symbol.endsWith('_USDT'))
      .map(c => ({
        display:    c.symbol.replace('_USDT', ''),                    // BTC
        mexcSymbol: c.symbol,                                          // BTC_USDT
        tvSymbol:   'MEXC:' + c.symbol.replace('_USDT', 'USDT') + '.P', // MEXC:BTCUSDT.P
      }))
      .sort((a, b) => a.display.localeCompare(b.display));
    cachedSymbols = list;
    console.log(`[symbols] Loaded ${list.length} MEXC perpetuals`);
  } catch (err) {
    console.error('[symbols] Fetch failed:', err.message);
  }
}

// ── Panel + search injection ─────────────────────────────────────────────────

async function inject() {
  // 1. Inject / replace CSS
  await evaluate(`
    (function() {
      var id  = 'mexc-scalp-styles';
      var old = document.getElementById(id);
      if (old) old.remove();
      var style = document.createElement('style');
      style.id  = id;
      style.textContent = ${JSON.stringify(panelCSS)};
      document.head.appendChild(style);
    })()
  `);

  // 2. Inject panel JS (IIFE guards against double-injection via #mexc-scalp-panel)
  await evaluate(panelJS);

  // 3. Push symbol list into the page before the overlay runs.
  //    The overlay reads window.__mexcSymbols synchronously — no fetch needed.
  await evaluate(`window.__mexcSymbols = ${JSON.stringify(cachedSymbols)}`);

  // 4. Inject coin-search overlay
  await evaluate(searchJS);

  console.log('[panel] Injected.');
}

// ── Local bridge server ──────────────────────────────────────────────────────
//
// The coin-search overlay POSTs { symbol: 'MEXC:BTCUSDT.P' } here.
// We call TV's chart.setSymbol() via CDP — no format conversion needed
// because the overlay already sends the correct TV-format symbol.

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

          // symbol is already in TV format: MEXC:BTCUSDT.P
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

  server.listen(BRIDGE_PORT, 'localhost', () =>
    console.log(`[bridge] Listening on http://localhost:${BRIDGE_PORT}`)
  );
}

// ── Re-inject on page navigation ─────────────────────────────────────────────

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

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[panel] Connecting to TradingView Desktop (CDP :9222)…');

  try {
    await getClient();
    console.log('[panel] CDP connected.');
  } catch {
    console.error('[panel] Cannot reach TradingView. Launch it first:');
    console.error('        cscript scripts\\launch_tv_debug.vbs');
    process.exit(1);
  }

  // Fetch symbols before anything else — overlay needs them at inject time
  await fetchMexcSymbols();
  // Refresh list hourly (runs silently in background)
  setInterval(fetchMexcSymbols, SYMBOL_REFRESH_MS);

  startBridge();
  await watchNavigation();

  await new Promise(r => setTimeout(r, REINJECT_DELAY_MS));

  try {
    await inject();
  } catch (err) {
    console.error('[panel] Initial injection failed:', err.message);
    console.error('[panel] TV may still be loading — will inject on next page load.');
  }

  console.log('[panel] Running. Ctrl+C to stop.');
}

main().catch(err => { console.error(err); process.exit(1); });
