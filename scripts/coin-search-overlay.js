/**
 * Watchlist Symbol Search Overlay — injected into TradingView Desktop renderer
 *
 * Press Ctrl+F  → open search (reads your TV watchlist live from the DOM)
 * Type          → filter in real-time
 * ↑ / ↓        → navigate results
 * Enter / GO    → switch active chart to selected symbol via bridge (localhost:9224)
 * Esc           → close
 * Click outside → close
 *
 * Symbol list: read from TV watchlist DOM [data-symbol-full] on every open.
 * Works with any symbol — ES, NQ, Oil, MEXC perps, anything in the watchlist.
 *
 * Symbol switch: POST { symbol: tvSymbol } → localhost:9224/set-symbol (via XHR)
 * NOTE: click listeners removed from rows — TV intercepts mouse events on rows.
 *       Use Enter key or the GO button to switch to the highlighted symbol.
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
    const seen = new Set();
    const results = [];
    const nodes = document.querySelectorAll('[data-symbol-full], [data-field="symbol"]');
    for (const el of nodes) {
      const tvSymbol = el.getAttribute('data-symbol-full') || el.textContent.trim();
      if (!tvSymbol || !tvSymbol.includes(':')) continue;
      if (seen.has(tvSymbol)) continue;
      seen.add(tvSymbol);
      results.push({ display: tvSymbol.split(':').pop(), tvSymbol });
    }
    return results;
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

  // Header
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
    headerLeft.textContent = 'Watchlist (' + allSymbols.length + ')';
    try {
      var sym = window.TradingViewApi._activeChartWidgetWV.value().symbol();
      headerRight.textContent = sym ? sym.replace(/^[^:]+:/, '') : '';
    } catch (e) { headerRight.textContent = ''; }
  }

  // Input row: input + GO button
  const inputRow = document.createElement('div');
  Object.assign(inputRow.style, {
    display:      'flex',
    alignItems:   'stretch',
    borderBottom: '1px solid #363a45',
  });

  const input = document.createElement('input');
  input.type         = 'text';
  input.autocomplete = 'off';
  input.spellcheck   = false;
  Object.assign(input.style, {
    background: '#131722',
    border:     'none',
    color:      '#d1d4dc',
    fontSize:   '15px',
    padding:    '12px 16px',
    outline:    'none',
    flex:       '1',
    boxSizing:  'border-box',
    transition: 'color 0.15s',
  });

  const goBtn = document.createElement('button');
  goBtn.textContent = 'GO';
  Object.assign(goBtn.style, {
    background:   '#f0b90b',
    color:        '#131722',
    border:       'none',
    padding:      '0 18px',
    fontSize:     '13px',
    fontWeight:   '700',
    cursor:       'pointer',
    letterSpacing:'0.5px',
    flexShrink:   '0',
    outline:      'none',
  });
  goBtn.addEventListener('mouseenter', () => { goBtn.style.background = '#ffd740'; });
  goBtn.addEventListener('mouseleave', () => { goBtn.style.background = '#f0b90b'; });

  inputRow.appendChild(input);
  inputRow.appendChild(goBtn);

  function setInputPlaceholder(text) {
    input.placeholder = text;
  }

  const list = document.createElement('div');
  Object.assign(list.style, { overflowY: 'auto', flex: '1' });

  box.appendChild(header);
  box.appendChild(inputRow);
  box.appendChild(list);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  // ── Rendering ───────────────────────────────────────────────────────────────

  function renderList() {
    list.innerHTML = '';

    if (!allSymbols.length) {
      var msg = document.createElement('div');
      Object.assign(msg.style, { padding: '16px', color: '#787b86', fontSize: '13px' });
      msg.textContent = 'No watchlist symbols found — add symbols to your TV watchlist';
      list.appendChild(msg);
      return;
    }

    if (!filtered.length) {
      var msg2 = document.createElement('div');
      Object.assign(msg2.style, { padding: '16px', color: '#787b86', fontSize: '13px' });
      msg2.textContent = 'No results';
      list.appendChild(msg2);
      return;
    }

    filtered.slice(0, 60).forEach(function (item, i) {
      var row = document.createElement('div');
      Object.assign(row.style, {
        padding:      '9px 16px',
        cursor:       'default',
        display:      'flex',
        alignItems:   'center',
        gap:          '10px',
        background:   i === selIdx ? '#2a2e3a' : 'transparent',
        borderBottom: '1px solid #1a1e2a',
        userSelect:   'none',
      });

      var coinEl = document.createElement('span');
      Object.assign(coinEl.style, { fontWeight: '600', color: '#f0b90b', minWidth: '80px', fontSize: '14px' });
      coinEl.textContent = item.display;

      var tvEl = document.createElement('span');
      Object.assign(tvEl.style, { color: '#787b86', fontSize: '12px' });
      tvEl.textContent = item.tvSymbol;

      // Hint text at end
      var hintEl = document.createElement('span');
      Object.assign(hintEl.style, { color: '#444', fontSize: '11px', marginLeft: 'auto' });
      hintEl.textContent = i === selIdx ? '← Enter / GO' : '';

      row.appendChild(coinEl);
      row.appendChild(tvEl);
      row.appendChild(hintEl);

      // mouseenter for highlight only
      row.addEventListener('mouseenter', function () { selIdx = i; renderList(); });
      // pointerdown fires before TV's mousedown/click interceptors
      row.addEventListener('pointerdown', (function (capturedItem) {
        return function (e) {
          e.preventDefault();
          e.stopImmediatePropagation();
          pick(capturedItem);
        };
      })(item));

      list.appendChild(row);
    });
  }

  // ── Filtering ───────────────────────────────────────────────────────────────

  function applyFilter(query) {
    var q = query.trim().toUpperCase();
    if (!q) {
      filtered = allSymbols.slice(0, 60);
    } else {
      filtered = allSymbols
        .filter(function (s) {
          return s.display.toUpperCase().includes(q) || s.tvSymbol.toUpperCase().includes(q);
        })
        .sort(function (a, b) {
          var aStart = a.display.toUpperCase().startsWith(q) ? 0 : 1;
          var bStart = b.display.toUpperCase().startsWith(q) ? 0 : 1;
          return aStart - bStart || a.display.localeCompare(b.display);
        });
    }
    selIdx = 0;
    renderList();
  }

  // ── Symbol selection ────────────────────────────────────────────────────────
  // Strategy: try direct TradingViewApi first (no CORS/CSP issues since we're
  // already in the renderer), fall back to XHR bridge if the API isn't exposed.

  function pick(item) {
    var sym         = item.tvSymbol;
    var displayName = item.display;

    input.value       = '';
    input.style.color = '#f0b90b';
    setInputPlaceholder('Switching to ' + displayName + '…');
    list.innerHTML = '';

    // ── Primary: direct TradingViewApi call ──────────────────────────────────
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      chart.setSymbol(sym, {});
      console.log('[coin-search] Switched (direct API) ->', sym);
      input.style.color = '#089981';
      setInputPlaceholder('Switched to ' + displayName);
      setTimeout(hide, 700);
      return;
    } catch (e) {
      console.warn('[coin-search] Direct API failed, trying XHR bridge:', e.message);
    }

    // ── Fallback: XHR to bridge at localhost:9224 ────────────────────────────
    var xhr = new XMLHttpRequest();
    xhr.open('POST', BRIDGE + '/set-symbol', true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.timeout = 5000;

    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        console.log('[coin-search] Switched (XHR bridge) ->', sym);
        input.style.color = '#089981';
        setInputPlaceholder('Switched to ' + displayName);
        setTimeout(hide, 700);
      } else {
        var errMsg = 'HTTP ' + xhr.status;
        try { errMsg = JSON.parse(xhr.responseText).error || errMsg; } catch (e) {}
        onFail(errMsg);
      }
    };

    xhr.onerror = function () {
      onFail('Network error — is inject_panel.mjs running?');
    };

    xhr.ontimeout = function () {
      onFail('Timeout — bridge not responding');
    };

    function onFail(msg) {
      console.error('[coin-search] Switch failed for', sym, ':', msg);
      input.style.color = '#f23645';
      setInputPlaceholder('Failed: ' + msg);
      setTimeout(function () {
        input.style.color = '#d1d4dc';
        setInputPlaceholder('Search symbol…');
        applyFilter('');
      }, 3000);
    }

    xhr.send(JSON.stringify({ symbol: sym }));
  }

  function pickSelected() {
    if (filtered[selIdx]) pick(filtered[selIdx]);
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
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { input.focus(); });
    });
  }

  function hide() {
    overlay.style.display = 'none';
    input.value       = '';
    input.style.color = '#d1d4dc';
  }

  function isOpen() { return overlay.style.display !== 'none'; }

  // ── Keyboard ─────────────────────────────────────────────────────────────────

  // Ctrl+F: use keyup — TV's keydown capture handler calls stopImmediatePropagation()
  // on Ctrl+F before our listener runs. keyup is not intercepted by TV.
  window.addEventListener('keyup', function (e) {
    if (e.ctrlKey && e.key === 'f') {
      e.preventDefault();
      e.stopImmediatePropagation();
      isOpen() ? hide() : show();
    }
  }, true);

  // Escape: keydown is fine here (TV doesn't eat Escape)
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      hide();
    }
  }, true);

  input.addEventListener('input', function () { applyFilter(input.value); });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') {
      selIdx = Math.min(selIdx + 1, Math.min(filtered.length, 60) - 1);
      renderList();
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      selIdx = Math.max(selIdx - 1, 0);
      renderList();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      pickSelected();
    }
  });

  // GO button click — safe: this is our own button, not a TV element
  goBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    pickSelected();
  });

  overlay.addEventListener('mousedown', function (e) {
    if (e.target === overlay) hide();
  });

  console.log('[coin-search] Ready — Ctrl+F to search watchlist. Use Enter or GO button to switch symbol.');
})();
