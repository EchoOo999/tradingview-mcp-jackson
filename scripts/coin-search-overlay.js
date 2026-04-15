/**
 * Watchlist Symbol Search Overlay — injected into TradingView Desktop renderer
 *
 * Press Ctrl+F  → open search (reads your TV watchlist live from the DOM)
 * Type          → filter in real-time
 * ↑ / ↓        → navigate results
 * Enter / click → switch active chart to selected symbol via bridge (localhost:9224)
 * Esc           → close
 * Click outside → close
 *
 * Symbol list: read from TV watchlist DOM [data-symbol-full] on every open.
 * Works with any symbol — ES, NQ, Oil, MEXC perps, anything in the watchlist.
 *
 * Symbol switch: POST { symbol: tvSymbol } → localhost:9224/set-symbol
 */
(function () {
  'use strict';

  if (document.getElementById('mexc-coin-search-overlay')) return;

  const BRIDGE = 'http://localhost:9224';

  let allSymbols = [];
  let filtered   = [];
  let selIdx     = 0;

  // ── Read watchlist from TV DOM ───────────────────────────────────────────────
  function loadWatchlistSymbols() {
    const nodes = document.querySelectorAll('[data-symbol-full]');
    if (!nodes.length) return [];
    return Array.from(nodes).map(el => {
      const tvSymbol = el.getAttribute('data-symbol-full') || '';
      const display  = tvSymbol.split(':').pop();
      return { display, tvSymbol };
    });
  }

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

  // Header — symbol count + current chart symbol
  const header = document.createElement('div');
  Object.assign(header.style, {
    padding:        '10px 16px 6px',
    color:          '#787b86',
    fontSize:       '11px',
    letterSpacing:  '0.5px',
    textTransform:  'uppercase',
    display:        'flex',
    justifyContent: 'space-between',
    alignItems:     'center',
  });

  const headerLeft  = document.createElement('span');
  const headerRight = document.createElement('span');
  Object.assign(headerRight.style, { color: '#f0b90b', fontWeight: '600' });
  header.appendChild(headerLeft);
  header.appendChild(headerRight);

  function refreshHeader() {
    headerLeft.textContent = `Watchlist (${allSymbols.length})`;
    try {
      const sym = window.TradingViewApi._activeChartWidgetWV.value().symbol();
      headerRight.textContent = sym ? sym.replace(/^[^:]+:/, '') : '';
    } catch { headerRight.textContent = ''; }
  }

  const input = document.createElement('input');
  input.type         = 'text';
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
    transition:   'color 0.15s',
  });

  function setInputPlaceholder(text) {
    input.placeholder = text;
  }

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
      msg.textContent = 'No watchlist symbols found — add symbols to your TV watchlist';
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
        .filter(s => s.display.toUpperCase().includes(q) || s.tvSymbol.toUpperCase().includes(q))
        .sort((a, b) => {
          const aStart = a.display.toUpperCase().startsWith(q) ? 0 : 1;
          const bStart = b.display.toUpperCase().startsWith(q) ? 0 : 1;
          return aStart - bStart || a.display.localeCompare(b.display);
        });
    }
    selIdx = 0;
    renderList();
  }

  // ── Symbol selection ────────────────────────────────────────────────────────

  async function pick(item) {
    const sym         = item.tvSymbol;
    const displayName = item.display;

    // Immediate visual feedback — keep overlay open
    input.value       = '';
    input.style.color = '#f0b90b';
    setInputPlaceholder(`Switching to ${displayName}…`);
    list.innerHTML    = '';

    try {
      const res = await fetch(`${BRIDGE}/set-symbol`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ symbol: sym }),
      });
      if (res.ok) {
        console.log('[coin-search] ✓ Switched →', sym);
        input.style.color = '#089981';
        setInputPlaceholder(`✓ Switched to ${displayName}`);
        setTimeout(hide, 700);
        return;
      }
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    } catch (e) {
      console.error('[coin-search] Bridge error for', sym, ':', e.message);
      input.style.color = '#f23645';
      setInputPlaceholder(`✗ ${e.message} — is inject_panel.mjs running?`);
      setTimeout(() => {
        input.style.color = '#d1d4dc';
        setInputPlaceholder('Search symbol…');
        applyFilter('');
      }, 3000);
    }
  }

  // ── Show / hide ─────────────────────────────────────────────────────────────

  function show() {
    allSymbols = loadWatchlistSymbols();
    refreshHeader();
    setInputPlaceholder(allSymbols.length ? 'Search symbol…' : 'No watchlist symbols found');
    input.style.color = '#d1d4dc';
    overlay.style.display = 'flex';
    input.value = '';
    applyFilter('');
    requestAnimationFrame(() => requestAnimationFrame(() => input.focus()));
  }

  function hide() {
    overlay.style.display = 'none';
    input.value       = '';
    input.style.color = '#d1d4dc';
  }

  function isOpen() { return overlay.style.display !== 'none'; }

  // ── Keyboard ─────────────────────────────────────────────────────────────────

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

  console.log('[coin-search] Ready — Ctrl+F to search your watchlist.');
})();
