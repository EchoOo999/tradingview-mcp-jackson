// MEXC Scalp Panel — Content Script
// Injects a floating trading panel into TradingView (read-only, no chart modifications)

(function () {
  'use strict';

  if (document.getElementById('mexc-scalp-panel')) return;

  const WEBHOOK_URL = 'https://mexc-webhook-production.up.railway.app/webhook';
  const SECRET = 'scalp2024';

  // ─── Symbol Detection ──────────────────────────────────────────────────────

  function getRawSymbol() {
    try {
      const s = new URLSearchParams(window.location.search).get('symbol');
      if (s) return s.split(':').pop().trim();
    } catch (_) {}

    try {
      const m = document.title.match(/^([A-Z0-9]+(?:\.[A-Z]+)?)/);
      if (m && m[1].length > 2) return m[1];
    } catch (_) {}

    try {
      for (const sel of [
        '[class*="symbol-info"] [class*="ticker"]',
        '[class*="pane-legend"] [class*="title"]',
        '[data-symbol]',
      ]) {
        const el = document.querySelector(sel);
        if (el) {
          const txt = (el.textContent || el.getAttribute('data-symbol') || '').trim();
          if (txt.length > 2) return txt.split(':').pop();
        }
      }
    } catch (_) {}

    return null;
  }

  function toMexcSymbol(raw) {
    if (!raw) return '';
    let s = raw.toUpperCase().replace(/\.P$/, '').split(':').pop();
    s = s.replace(/(USDT|BUSD|USDC|BTC|ETH)$/, '_$1');
    return s;
  }

  // ─── Current Price Detection ───────────────────────────────────────────────

  function getCurrentPrice() {
    // Try DOM selectors in order of reliability
    const selectors = [
      // Price in chart legend / header bar
      '[class*="priceWrapper"] [class*="last"]',
      '[class*="lastPrice"]',
      '[class*="price-last"]',
      // Symbol info bar (top of chart)
      '[class*="symbolInfo"] [class*="last"]',
      '[class*="symbol-info"] [class*="last"]',
      // Pane legend price
      '[class*="paneRow"] [class*="price"]',
      '[class*="mainSeries"] [class*="price"]',
      // Broad fallback: any element whose text looks like a price
    ];

    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          const n = parseFloat(el.textContent.replace(/[^0-9.]/g, ''));
          if (n > 0) return n;
        }
      } catch (_) {}
    }

    // Last resort: scan all elements with "price" in className for a numeric value
    try {
      const candidates = document.querySelectorAll('[class*="price"]');
      for (const el of candidates) {
        if (el.children.length > 0) continue; // skip containers
        const n = parseFloat(el.textContent.replace(/[^0-9.]/g, ''));
        if (n > 100) return n; // price must be > 100 to avoid matching tiny values
      }
    } catch (_) {}

    return null;
  }

  // ─── Build Panel HTML ──────────────────────────────────────────────────────

  const panel = document.createElement('div');
  panel.id = 'mexc-scalp-panel';
  panel.innerHTML = `
    <div id="msp-header">
      <span id="msp-title">MEXC Scalp</span>
      <span id="msp-symbol-badge" title="Click to refresh symbol">—</span>
      <button id="msp-minimize" title="Collapse">−</button>
    </div>
    <div id="msp-body">

      <!-- Margin Mode -->
      <div class="msp-toggle-group" id="msp-margin-toggle">
        <button class="msp-toggle-btn active" data-value="cross">Cross</button>
        <button class="msp-toggle-btn" data-value="isolated">Isolated</button>
      </div>

      <!-- Order Type -->
      <div class="msp-toggle-group" id="msp-type-toggle">
        <button class="msp-toggle-btn active" data-value="market">Market</button>
        <button class="msp-toggle-btn" data-value="limit">Limit</button>
      </div>

      <!-- Entry Price (Limit only) -->
      <div id="msp-entry-row" class="hidden">
        <div class="msp-field full">
          <span class="msp-label">Entry Price</span>
          <input id="msp-entry" class="msp-input" type="number" min="0" step="any" placeholder="Limit price" />
        </div>
      </div>

      <!-- Leverage + USD Risk -->
      <div class="msp-row">
        <div class="msp-field">
          <span class="msp-label">Leverage</span>
          <input id="msp-leverage" class="msp-input" type="number" value="10" min="1" max="200" step="1" />
        </div>
        <div class="msp-field">
          <span class="msp-label">USD Risk</span>
          <input id="msp-risk" class="msp-input" type="number" value="50" min="1" step="1" />
        </div>
      </div>

      <!-- TP + SL (actual prices) -->
      <div class="msp-row">
        <div class="msp-field">
          <span class="msp-label">TP Price</span>
          <input id="msp-tp" class="msp-input" type="number" min="0" step="any" placeholder="0 = none" />
        </div>
        <div class="msp-field">
          <span class="msp-label">SL Price</span>
          <input id="msp-sl" class="msp-input" type="number" min="0" step="any" placeholder="0 = none" />
        </div>
      </div>

      <!-- R/R Preview -->
      <div id="msp-rr-box">
        <div class="msp-rr-header">
          <span>R/R PREVIEW</span>
          <span id="msp-rr-entry-price" class="msp-rr-entry-price">—</span>
        </div>
        <div class="msp-rr-grid">
          <div class="msp-rr-cell">
            <span class="msp-rr-label">Profit (TP)</span>
            <span id="msp-rr-profit" class="msp-rr-val profit">—</span>
          </div>
          <div class="msp-rr-cell">
            <span class="msp-rr-label">Loss (SL)</span>
            <span id="msp-rr-loss" class="msp-rr-val loss">—</span>
          </div>
          <div class="msp-rr-cell">
            <span class="msp-rr-label">R/R Ratio</span>
            <span id="msp-rr-ratio" class="msp-rr-val ratio">—</span>
          </div>
          <div class="msp-rr-cell">
            <span class="msp-rr-label">Position</span>
            <span id="msp-rr-size" class="msp-rr-val">—</span>
          </div>
        </div>
      </div>

      <div class="msp-divider"></div>

      <!-- Order Buttons -->
      <div id="msp-buttons">
        <button id="msp-long-btn"  class="msp-btn">🟢 LONG</button>
        <button id="msp-short-btn" class="msp-btn">🔴 SHORT</button>
      </div>

      <div id="msp-status" class="empty"></div>
    </div>
  `;

  document.body.appendChild(panel);

  // ─── Segmented Toggle Logic ────────────────────────────────────────────────

  function wireToggle(groupId) {
    const group = document.getElementById(groupId);
    let active = group.querySelector('.msp-toggle-btn.active').dataset.value;

    group.addEventListener('click', (e) => {
      const btn = e.target.closest('.msp-toggle-btn');
      if (!btn || btn.classList.contains('active')) return;
      group.querySelectorAll('.msp-toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      active = btn.dataset.value;
      group.dispatchEvent(new CustomEvent('change', { detail: active }));
    });

    return { getValue: () => active };
  }

  const marginToggle = wireToggle('msp-margin-toggle');
  const typeToggle   = wireToggle('msp-type-toggle');

  // Show/hide entry price field based on order type
  document.getElementById('msp-type-toggle').addEventListener('change', (e) => {
    document.getElementById('msp-entry-row').classList.toggle('hidden', e.detail !== 'limit');
    updatePreview();
  });

  // ─── R/R Preview ───────────────────────────────────────────────────────────

  function fmt(n, decimals = 2) {
    return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }

  function updatePreview() {
    const elProfit = document.getElementById('msp-rr-profit');
    const elLoss   = document.getElementById('msp-rr-loss');
    const elRatio  = document.getElementById('msp-rr-ratio');
    const elSize   = document.getElementById('msp-rr-size');
    const elEntry  = document.getElementById('msp-rr-entry-price');

    const leverage = parseFloat(document.getElementById('msp-leverage').value) || 0;
    const usdRisk  = parseFloat(document.getElementById('msp-risk').value)     || 0;
    const tp       = parseFloat(document.getElementById('msp-tp').value)       || 0;
    const sl       = parseFloat(document.getElementById('msp-sl').value)       || 0;
    const isLimit  = typeToggle.getValue() === 'limit';
    const limitPx  = parseFloat(document.getElementById('msp-entry').value)    || 0;

    // Resolve entry price
    const chartPrice = getCurrentPrice();
    const entry = isLimit ? (limitPx || chartPrice) : chartPrice;

    if (!entry || entry <= 0) {
      elEntry.textContent = 'price N/A';
      elEntry.className = 'msp-rr-entry-price na';
      [elProfit, elLoss, elRatio, elSize].forEach(el => { el.textContent = '—'; el.className = 'msp-rr-val'; });
      return;
    }

    elEntry.textContent = '$' + fmt(entry);
    elEntry.className = 'msp-rr-entry-price';

    // Position size (base currency units)
    const notional = usdRisk * leverage;
    const contracts = notional / entry;
    elSize.textContent = fmt(contracts, 4) + ' units';

    if ((!tp && !sl) || leverage <= 0 || usdRisk <= 0) {
      [elProfit, elLoss, elRatio].forEach(el => { el.textContent = '—'; el.className = 'msp-rr-val'; });
      return;
    }

    // Infer direction: tp > entry → long, tp < entry → short
    // Fall back to sl if tp not set
    let isLong;
    if (tp > 0)      isLong = tp > entry;
    else if (sl > 0) isLong = sl < entry;
    else             isLong = true;

    const tpDelta = tp > 0 ? Math.abs(tp - entry) : 0;
    const slDelta = sl > 0 ? Math.abs(entry - sl)  : 0;

    // Validate direction consistency
    if (tp > 0 && sl > 0) {
      const tpCorrect = isLong ? tp > entry : tp < entry;
      const slCorrect = isLong ? sl < entry : sl > entry;
      if (!tpCorrect || !slCorrect) {
        elRatio.textContent = '⚠ check prices';
        elRatio.className = 'msp-rr-val warn';
      }
    }

    if (tp > 0) {
      const profit = contracts * tpDelta;
      elProfit.textContent = '+$' + fmt(profit);
      elProfit.className = 'msp-rr-val profit';
    } else {
      elProfit.textContent = '—';
      elProfit.className = 'msp-rr-val';
    }

    if (sl > 0) {
      const loss = contracts * slDelta;
      elLoss.textContent = '-$' + fmt(loss);
      elLoss.className = 'msp-rr-val loss';
    } else {
      elLoss.textContent = '—';
      elLoss.className = 'msp-rr-val';
    }

    if (tp > 0 && sl > 0 && slDelta > 0) {
      const ratio = tpDelta / slDelta;
      elRatio.textContent = '1 : ' + fmt(ratio);
      elRatio.className = 'msp-rr-val ratio' + (ratio >= 1.5 ? ' good' : ratio < 1 ? ' bad' : '');
    } else if (!(tp > 0 && sl > 0)) {
      elRatio.textContent = '—';
      elRatio.className = 'msp-rr-val';
    }
  }

  // Wire live updates to all relevant inputs
  ['msp-leverage', 'msp-risk', 'msp-tp', 'msp-sl', 'msp-entry'].forEach(id => {
    document.getElementById(id).addEventListener('input', updatePreview);
  });
  document.getElementById('msp-margin-toggle').addEventListener('change', updatePreview);

  // Poll chart price every 2s to keep entry price live
  setInterval(updatePreview, 2000);

  // Initial render
  setTimeout(updatePreview, 500);

  // ─── Symbol Badge ──────────────────────────────────────────────────────────

  const badge = document.getElementById('msp-symbol-badge');

  function refreshSymbol() {
    const raw  = getRawSymbol();
    const mexc = toMexcSymbol(raw);
    badge.textContent = mexc || '?';
    badge.title = raw
      ? `TV: ${raw} → MEXC: ${mexc}\nClick to refresh`
      : 'Symbol not detected. Click to retry.';
  }

  refreshSymbol();
  badge.addEventListener('click', refreshSymbol);

  // Auto-refresh on URL change (TV updates URL on symbol switch)
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      setTimeout(refreshSymbol, 600);
    }
  }, 500);

  // Watch title changes
  const titleEl = document.querySelector('title');
  if (titleEl) new MutationObserver(refreshSymbol).observe(titleEl, { childList: true });

  // ─── Draggable ─────────────────────────────────────────────────────────────

  let dragging = false, ox = 0, oy = 0;
  const header = document.getElementById('msp-header');

  header.addEventListener('mousedown', (e) => {
    if (e.target.id === 'msp-minimize') return;
    dragging = true;
    const r = panel.getBoundingClientRect();
    ox = e.clientX - r.left;
    oy = e.clientY - r.top;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    panel.style.left  = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  e.clientX - ox)) + 'px';
    panel.style.top   = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - oy)) + 'px';
    panel.style.right = 'auto';
  });

  document.addEventListener('mouseup', () => { dragging = false; });

  // ─── Collapse / Expand ─────────────────────────────────────────────────────

  const minimizeBtn = document.getElementById('msp-minimize');
  minimizeBtn.addEventListener('click', () => {
    panel.classList.toggle('collapsed');
    minimizeBtn.textContent = panel.classList.contains('collapsed') ? '+' : '−';
  });

  // ─── Status Helper ─────────────────────────────────────────────────────────

  const statusEl = document.getElementById('msp-status');
  let statusTimer = null;

  function setStatus(msg, type, autoClear = 4000) {
    statusEl.textContent = msg;
    statusEl.className = type;
    clearTimeout(statusTimer);
    if (autoClear) statusTimer = setTimeout(() => {
      statusEl.textContent = '';
      statusEl.className = 'empty';
    }, autoClear);
  }

  // ─── Order Execution ───────────────────────────────────────────────────────

  async function sendOrder(side) {
    const symbol = toMexcSymbol(getRawSymbol());
    if (!symbol || symbol.startsWith('_') || symbol === '') {
      setStatus('❌ Symbol not detected — click badge to refresh', 'error');
      return;
    }

    const orderType   = typeToggle.getValue();
    const marginMode  = marginToggle.getValue();
    const leverage    = parseFloat(document.getElementById('msp-leverage').value) || 10;
    const usd_risk    = parseFloat(document.getElementById('msp-risk').value)     || 50;
    const tp          = parseFloat(document.getElementById('msp-tp').value)        || 0;
    const sl          = parseFloat(document.getElementById('msp-sl').value)        || 0;
    const entryPrice  = parseFloat(document.getElementById('msp-entry').value)     || 0;

    if (orderType === 'limit' && entryPrice <= 0) {
      setStatus('❌ Entry price required for Limit orders', 'error');
      return;
    }

    const payload = {
      secret: SECRET,
      symbol,
      side,
      type: orderType,
      margin_mode: marginMode,
      leverage,
      usd_risk,
    };
    if (orderType === 'limit') payload.price = entryPrice;
    if (tp > 0) payload.tp = tp;
    if (sl > 0) payload.sl = sl;

    const longBtn  = document.getElementById('msp-long-btn');
    const shortBtn = document.getElementById('msp-short-btn');
    longBtn.disabled  = true;
    shortBtn.disabled = true;
    setStatus('⏳ Sending…', 'loading', 0);

    try {
      const res  = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch (_) { data = { message: text }; }

      if (res.ok) {
        const dir = side === 'open_long' ? '🟢 LONG' : '🔴 SHORT';
        setStatus(`✅ ${dir} ${symbol} sent`, 'success');
      } else {
        setStatus(`❌ ${res.status}: ${data.message || data.error || text}`, 'error', 6000);
      }
    } catch (err) {
      setStatus(`❌ Network error: ${err.message}`, 'error', 6000);
    } finally {
      longBtn.disabled  = false;
      shortBtn.disabled = false;
    }
  }

  document.getElementById('msp-long-btn') .addEventListener('click', () => sendOrder('open_long'));
  document.getElementById('msp-short-btn').addEventListener('click', () => sendOrder('open_short'));

})();
