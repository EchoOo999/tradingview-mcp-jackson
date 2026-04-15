/**
 * MEXC Coin Search Overlay — injected into TradingView Desktop renderer
 *
 * Press Ctrl+F  → open search
 * Type          → filter MEXC perpetuals in real-time
 * ↑ / ↓        → navigate results
 * Enter / click → switch active chart to selected symbol (MEXC:BTCUSDT.P format)
 * Esc           → close
 * Click outside → close
 *
 * Symbol list is pre-loaded by inject_panel.mjs into window.__mexcSymbols
 * (fetched server-side to avoid TV's CSP restrictions).
 * Each entry: { display: 'BTC', mexcSymbol: 'BTC_USDT', tvSymbol: 'MEXC:BTCUSDT.P' }
 *
 * Symbol switch: POST { symbol: tvSymbol } → localhost:9224/set-symbol
 * Bridge calls chart.setSymbol(tvSymbol) — TV auto-highlights watchlist entry.
 */
(function () {
  'use strict';

  if (document.getElementById('mexc-coin-search-overlay')) return;

  const BRIDGE = 'http://localhost:9224';

  // ── Symbol list — injected by Node before this script runs ─────────────────
  // window.__mexcSymbols: Array<{ display, mexcSymbol, tvSymbol }>
  let allSymbols = Array.isArray(window.__mexcSymbols) ? window.__mexcSymbols : [];
  let filtered   = [];
  let selIdx     = 0;

  // ── DOM ─────────────────────────────────────────────────────────────────────

  const overlay = document.createElement('div');
  overlay.id = 'mexc-coin-search-overlay';
  Object.assign(overlay.style, {
    display:        'none',
    position:       'fixed',
    inset:          '0',
    background:     'rgba(0,0,0,0.65)',
    zIndex:         '99999999',
    alignItems:     'flex-start',
    justifyContent: 'center',
    paddingTop:     '80px',
    fontFamily:     "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  });

  const box = document.createElement('div');
  Object.assign(box.style, {
    background:    '#1e222d',
    border:        '1px solid #363a45',
    borderRadius:  '8px',
    width:         '440px',
    maxHeight:     '520px',
    display:       'flex',
    flexDirection: 'column',
    overflow:      'hidden',
    boxShadow:     '0 12px 40px rgba(0,0,0,0.55)',
  });

  // Header — shows symbol count + current chart symbol
  const header = document.createElement('div');
  Object.assign(header.style, {
    padding:       '10px 16px 6px',
    color:         '#787b86',
    fontSize:      '11px',
    letterSpacing: '0.5px',
    textTransform: 'uppercase',
    display:       'flex',
    justifyContent:'space-between',
    alignItems:    'center',
  });

  const headerLeft  = document.createElement('span');
  headerLeft.textContent = `MEXC Perpetuals (${allSymbols.length})`;

  const headerRight = document.createElement('span');
  Object.assign(headerRight.style, { color: '#f0b90b', fontWeight: '600' });

  header.appendChild(headerLeft);
  header.appendChild(headerRight);

  // Update current symbol badge whenever the overlay opens
  function refreshCurrentSymbol() {
    try {
      const sym = window.TradingViewApi._activeChartWidgetWV.value().symbol();
      // MEXC:BTCUSDT.P  →  show just "BTCUSDT.P" to keep it short
      headerRight.textContent = sym ? sym.replace('MEXC:', '') : '';
    } catch { headerRight.textContent = ''; }
  }

  const input = document.createElement('input');
  input.type         = 'text';
  input.placeholder  = allSymbols.length
    ? 'Search coin  (BTC, SOL, DOGE…)'
    : 'Symbol list not loaded — restart inject_panel.mjs';
  input.autocomplete = 'off';
  input.spellcheck   = false;
  Object.assign(input.style, {
    background:   '#131722',
    border:       'none',
    borderBottom: '1px solid #363a45',
    color:        '#d1d4dc',
    fontSize:     '15px',
    padding:      '12px 16px',
    outline:      'none',
    width:        '100%',
    boxSizing:    'border-box',
  });

  const list = document.createElement('div');
  Object.assign(list.style, { overflowY: 'auto', flex: '1' });

  box.appendChild(header);
  box.appendChild(input);
  box.appendChild(list);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  // ── Rendering ───────────────────────────────────────────────────────────────

  function renderList() {
    list.innerHTML = '';

    if (!allSymbols.length) {
      const msg = document.createElement('div');
      Object.assign(msg.style, { padding: '16px', color: '#787b86', fontSize: '13px' });
      msg.textContent = 'No symbols — restart inject_panel.mjs to reload';
      list.appendChild(msg);
      return;
    }

    if (!filtered.length) {
      const msg = document.createElement('div');
      Object.assign(msg.style, { padding: '16px', color: '#787b86', fontSize: '13px' });
      msg.textContent = 'No results';
      list.appendChild(msg);
      return;
    }

    filtered.slice(0, 60).forEach((item, i) => {
      const row = document.createElement('div');
      Object.assign(row.style, {
        padding:      '9px 16px',
        cursor:       'pointer',
        display:      'flex',
        alignItems:   'center',
        gap:          '10px',
        background:   i === selIdx ? '#2a2e3a' : 'transparent',
        borderBottom: '1px solid #1a1e2a',
      });

      const coinEl = document.createElement('span');
      Object.assign(coinEl.style, { fontWeight: '600', color: '#f0b90b', minWidth: '80px', fontSize: '14px' });
      coinEl.textContent = item.display;

      const tvEl = document.createElement('span');
      Object.assign(tvEl.style, { color: '#787b86', fontSize: '12px' });
      tvEl.textContent = item.tvSymbol;

      row.appendChild(coinEl);
      row.appendChild(tvEl);
      row.addEventListener('mouseenter', () => { selIdx = i; renderList(); });
      row.addEventListener('click', () => pick(item));
      list.appendChild(row);
    });
  }

  // ── Filtering ───────────────────────────────────────────────────────────────

  function applyFilter(query) {
    const q = query.trim().toUpperCase();
    if (!q) {
      filtered = allSymbols.slice(0, 60);
    } else {
      filtered = allSymbols
        .filter(s => s.display.startsWith(q) || s.display.includes(q))
        .sort((a, b) => {
          const aExact = a.display.startsWith(q) ? 0 : 1;
          const bExact = b.display.startsWith(q) ? 0 : 1;
          return aExact - bExact || a.display.localeCompare(b.display);
        });
    }
    selIdx = 0;
    renderList();
  }

  // ── Symbol selection ────────────────────────────────────────────────────────

  async function pick(item) {
    hide();

    const sym = item.tvSymbol;

    try {
      const res = await fetch(`${BRIDGE}/set-symbol`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ symbol: sym }),
      });
      if (res.ok) {
        console.log('[coin-search] ✓ Switched →', sym);
        return;
      }
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    } catch (e) {
      console.error('[coin-search] Bridge error for', sym, ':', e.message);
      alert(`MEXC coin search: could not switch symbol.\n\n${e.message}\n\nMake sure inject_panel.mjs is running.`);
    }
  }

  // ── Show / hide ─────────────────────────────────────────────────────────────

  function show() {
    refreshCurrentSymbol();
    overlay.style.display = 'flex';
    input.value = '';
    applyFilter('');
    requestAnimationFrame(() => requestAnimationFrame(() => input.focus()));
  }

  function hide() {
    overlay.style.display = 'none';
    input.value = '';
  }

  function isOpen() { return overlay.style.display !== 'none'; }

  // ── Keyboard events ──────────────────────────────────────────────────────────

  // window capture fires before document capture — intercepts Ctrl+F even if
  // TradingView has its own document-level capture listener registered first.
  window.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'f') {
      e.preventDefault();
      e.stopImmediatePropagation();
      isOpen() ? hide() : show();
      return;
    }
    if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      hide();
    }
  }, true);

  input.addEventListener('input', () => applyFilter(input.value));

  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') {
      selIdx = Math.min(selIdx + 1, Math.min(filtered.length, 60) - 1);
      renderList();
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      selIdx = Math.max(selIdx - 1, 0);
      renderList();
      e.preventDefault();
    } else if (e.key === 'Enter' && filtered[selIdx]) {
      pick(filtered[selIdx]);
    }
  });

  overlay.addEventListener('mousedown', e => {
    if (e.target === overlay) hide();
  });

  console.log(`[coin-search] Ready — ${allSymbols.length} symbols loaded. Ctrl+F to search.`);
})();
