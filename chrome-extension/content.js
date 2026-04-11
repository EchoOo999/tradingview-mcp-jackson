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

  function parsePrice(str) {
    if (!str) return null;
    const n = parseFloat(str.replace(/[^0-9.,]/g, '').replace(/,/g, ''));
    return (n > 0) ? n : null;
  }

  function getCurrentPrice() {
    try {
      const segments = document.title.split(/[\s·\|\-–—]+/);
      for (const seg of segments) {
        const n = parsePrice(seg);
        if (n && n > 100) return n;
      }
    } catch (_) {}

    try {
      const nodes = document.querySelectorAll([
        '.price-axis text',
        '[class*="priceAxis"] text',
        '[class*="price-axis"] text',
        '[class*="priceScale"] text',
        '[class*="price-scale"] text',
      ].join(', '));
      const nums = [];
      nodes.forEach(el => { const n = parsePrice(el.textContent); if (n > 1) nums.push(n); });
      if (nums.length >= 2) {
        nums.sort((a, b) => a - b);
        return nums[Math.floor(nums.length / 2)];
      }
    } catch (_) {}

    try {
      const groups = {};
      document.querySelectorAll('svg text').forEach(el => {
        if (el.children.length > 0) return;
        const n = parsePrice(el.textContent.trim());
        if (!n || n <= 1) return;
        const mag = Math.floor(Math.log10(n));
        if (!groups[mag]) groups[mag] = [];
        groups[mag].push(n);
      });
      const best = Object.values(groups).sort((a, b) => b.length - a.length)[0];
      if (best && best.length >= 3) {
        best.sort((a, b) => a - b);
        return best[Math.floor(best.length / 2)];
      }
    } catch (_) {}

    try {
      for (const attr of ['data-price', 'data-last-price', 'data-value']) {
        const el = document.querySelector(`[${attr}]`);
        if (el) { const n = parsePrice(el.getAttribute(attr)); if (n > 1) return n; }
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

      <!-- Entry Price (always visible) -->
      <div id="msp-entry-row">
        <div class="msp-field full">
          <span class="msp-label" id="msp-entry-label">Entry Price</span>
          <input id="msp-entry" class="msp-input" type="number" min="0" step="any" placeholder="Current price (for calc)" />
        </div>
      </div>

      <!-- Leverage + USD Risk -->
      <div class="msp-row">
        <div class="msp-field">
          <span class="msp-label">Leverage</span>
          <input id="msp-leverage" class="msp-input" type="number" value="10" min="1" max="200" step="1" />
        </div>
        <div class="msp-field">
          <span class="msp-label">USD Risk (Margin)</span>
          <input id="msp-risk" class="msp-input" type="number" value="50" min="0.01" step="0.01" />
        </div>
      </div>

      <!-- Risk Mode Toggle -->
      <div id="msp-risk-mode-wrap">
        <div class="msp-toggle-group msp-toggle-sm" id="msp-risk-toggle">
          <button class="msp-toggle-btn active" data-value="manual">Manual $</button>
          <button class="msp-toggle-btn" data-value="pct">% of Balance</button>
        </div>
        <div id="msp-risk-pct-row" style="display:none">
          <div class="msp-slider-row">
            <input id="msp-risk-slider" class="msp-slider" type="range" min="1" max="100" value="10" />
            <span id="msp-risk-pct-label" class="msp-pct-label">10%</span>
          </div>
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
          <span id="msp-rr-dir-badge" class="msp-rr-dir-badge"></span>
        </div>
        <div class="msp-rr-grid">

          <div class="msp-rr-cell">
            <span class="msp-rr-label">Quantity (USDT)</span>
            <span id="msp-rr-qty" class="msp-rr-val">—</span>
          </div>
          <div class="msp-rr-cell">
            <span class="msp-rr-label">Margin</span>
            <span id="msp-rr-margin" class="msp-rr-val">—</span>
          </div>

          <div class="msp-rr-cell">
            <span class="msp-rr-label">PNL @ TP</span>
            <span id="msp-rr-pnl-tp" class="msp-rr-val">—</span>
          </div>
          <div class="msp-rr-cell">
            <span class="msp-rr-label">PNL @ SL</span>
            <span id="msp-rr-pnl-sl" class="msp-rr-val">—</span>
          </div>

          <div class="msp-rr-cell msp-rr-cell-full">
            <span class="msp-rr-label">Liq Price</span>
            <span id="msp-rr-liq" class="msp-rr-val">—</span>
          </div>

        </div>
      </div>

      <div class="msp-divider"></div>

      <!-- Direction selectors -->
      <div id="msp-buttons">
        <button id="msp-long-btn"  class="msp-btn msp-dir-btn">LONG</button>
        <button id="msp-short-btn" class="msp-btn msp-dir-btn">SHORT</button>
      </div>

      <!-- Push order button -->
      <button id="msp-push-btn" class="msp-push-btn push-idle">Select direction</button>

      <div id="msp-status" class="empty"></div>

      <!-- Wallet Balance -->
      <div id="msp-balance-box">
        <span class="msp-balance-label">Total Balance</span>
        <span id="msp-bal-total" class="msp-balance-val">…</span>
      </div>
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
  const riskToggle   = wireToggle('msp-risk-toggle');

  // ─── Market / Limit entry price ────────────────────────────────────────────

  let marketInterval = null;

  function startMarketFill() {
    stopMarketFill();
    // Attempt immediately, then retry quickly in case chart DOM hasn't settled
    syncEntryPrice();
    setTimeout(syncEntryPrice, 150);
    setTimeout(syncEntryPrice, 400);
    marketInterval = setInterval(syncEntryPrice, 2000);
  }

  function stopMarketFill() {
    if (marketInterval) { clearInterval(marketInterval); marketInterval = null; }
  }

  function applyEntryMode(mode) {
    const isMarket = mode === 'market';
    entryInput.readOnly = isMarket;
    entryInput.classList.toggle('msp-entry-market', isMarket);
    document.getElementById('msp-entry-label').textContent =
      isMarket ? 'Entry Price (live)' : 'Entry Price (Limit)';
    if (isMarket) startMarketFill();
    else          stopMarketFill();
  }

  document.getElementById('msp-type-toggle').addEventListener('change', (e) => {
    applyEntryMode(e.detail);
    updatePreview();
  });

  // ─── Formatters ────────────────────────────────────────────────────────────

  function fmt(n, decimals = 2) {
    return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }

  function fmtPrice(p) {
    if (p >= 100)  return fmt(p, 2);
    if (p >= 1)    return fmt(p, 4);
    return fmt(p, 6);
  }

  // ─── Entry Input ref ───────────────────────────────────────────────────────

  const entryInput = document.getElementById('msp-entry');

  function syncEntryPrice() {
    const p = getCurrentPrice();
    if (!p || p <= 0) return;
    if (p === parseFloat(entryInput.value)) return;
    entryInput.value = p;
    updatePreview();
  }

  applyEntryMode(typeToggle.getValue());

  // ─── % of Balance Risk Mode ────────────────────────────────────────────────

  let lastBalance = 0;

  function applyRiskPct() {
    const pct = parseInt(document.getElementById('msp-risk-slider').value, 10);
    document.getElementById('msp-risk-pct-label').textContent = pct + '%';
    updatePreview(); // updatePreview computes the USDT value and updates the display
  }

  document.getElementById('msp-risk-slider').addEventListener('input', applyRiskPct);

  document.getElementById('msp-risk-toggle').addEventListener('change', (e) => {
    const isPct      = e.detail === 'pct';
    const riskInput  = document.getElementById('msp-risk');
    const pctRow     = document.getElementById('msp-risk-pct-row');
    riskInput.readOnly = isPct;
    riskInput.classList.toggle('msp-entry-market', isPct);
    pctRow.style.display = isPct ? 'block' : 'none';
    if (isPct) applyRiskPct();
    updatePreview();
  });

  // ─── Direction State ───────────────────────────────────────────────────────

  let selectedDirection = null; // 'long' | 'short' | null

  // ─── R/R Preview ───────────────────────────────────────────────────────────

  function updatePreview() {
    const leverage = parseFloat(document.getElementById('msp-leverage').value) || 0;
    const tp       = parseFloat(document.getElementById('msp-tp').value)       || 0;
    const sl       = parseFloat(document.getElementById('msp-sl').value)       || 0;
    const entry    = parseFloat(entryInput.value)                              || 0;

    // Resolve usdRisk from the active mode — pct mode computes directly from
    // slider + balance so the input field is never a stale intermediate.
    let usdRisk;
    const riskInput = document.getElementById('msp-risk');
    if (riskToggle.getValue() === 'pct' && lastBalance > 0 && leverage > 0) {
      const pct = parseInt(document.getElementById('msp-risk-slider').value, 10);
      // % of available buying power (balance × leverage), matching MEXC position calculator
      usdRisk = (pct / 100) * lastBalance * leverage;
      // Show the resulting USDT position size in the input so user can see it
      riskInput.value = usdRisk.toFixed(2);
    } else {
      usdRisk = parseFloat(riskInput.value) || 0;
    }

    const allIds = [
      'msp-rr-qty', 'msp-rr-margin',
      'msp-rr-pnl-tp', 'msp-rr-pnl-sl',
      'msp-rr-liq',
    ];
    function resetAll() {
      allIds.forEach(id => {
        const el = document.getElementById(id);
        el.textContent = '—';
        el.className   = 'msp-rr-val';
      });
    }
    function setVal(id, text, cls) {
      const el = document.getElementById(id);
      el.textContent = text;
      el.className   = 'msp-rr-val ' + (cls || '');
    }
    function setPnl(id, pnlUsd, margin) {
      const pct  = margin > 0 ? (pnlUsd / margin) * 100 : 0;
      const sign = pnlUsd >= 0 ? '+' : '-';
      const cls  = pnlUsd >= 0 ? 'profit' : 'loss';
      setVal(id, `${sign}$${fmt(Math.abs(pnlUsd))} (${sign}${fmt(Math.abs(pct))}%)`, cls);
    }

    if (entry <= 0 || usdRisk <= 0 || leverage <= 0) { resetAll(); return; }

    // MEXC native formulas:
    // USD Risk input = Quantity (USDT notional)
    // Contracts = Quantity / Entry
    // Margin (collateral) = Quantity / Leverage
    // PNL % = PNL / Margin × 100
    const quantity  = usdRisk;
    const contracts = quantity / entry;
    const margin    = quantity / leverage;

    setVal('msp-rr-qty',    '$' + fmt(quantity), 'qty');
    setVal('msp-rr-margin', '$' + fmt(margin));

    // PNL and Liq only shown when a direction is selected
    if (!selectedDirection) {
      setVal('msp-rr-pnl-tp', '—');
      setVal('msp-rr-pnl-sl', '—');
      setVal('msp-rr-liq', '—');
      return;
    }

    const isLong = selectedDirection === 'long';

    // Liq price — long: entry moves down to liquidate; short: entry moves up
    const liq = isLong
      ? entry * (1 - 1 / leverage + 0.005)
      : entry * (1 + 1 / leverage - 0.005);
    setVal('msp-rr-liq', '$' + fmtPrice(liq), 'liq');

    // PNL @ TP
    if (tp > 0) {
      const pnlTp = isLong ? contracts * (tp - entry) : contracts * (entry - tp);
      setPnl('msp-rr-pnl-tp', pnlTp, margin);
    } else {
      setVal('msp-rr-pnl-tp', '—');
    }

    // PNL @ SL
    if (sl > 0) {
      const pnlSl = isLong ? contracts * (sl - entry) : contracts * (entry - sl);
      setPnl('msp-rr-pnl-sl', pnlSl, margin);
    } else {
      setVal('msp-rr-pnl-sl', '—');
    }
  }

  // Wire live updates
  function bindPreview(id) {
    const el = document.getElementById(id);
    el.addEventListener('input',  updatePreview);
    el.addEventListener('change', updatePreview);
  }
  bindPreview('msp-entry');
  bindPreview('msp-leverage');
  bindPreview('msp-risk');
  bindPreview('msp-tp');
  bindPreview('msp-sl');
  document.getElementById('msp-margin-toggle').addEventListener('change', updatePreview);

  // Fallback: re-run every second so any missed event still updates
  setInterval(updatePreview, 1000);
  setTimeout(updatePreview, 100);

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

  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      setTimeout(refreshSymbol, 600);
    }
  }, 500);

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

  // ─── Balance Fetch ─────────────────────────────────────────────────────────

  async function fetchBalance() {
    const el = document.getElementById('msp-bal-total');
    try {
      const res  = await fetch(WEBHOOK_URL.replace('/webhook', '/balance'));
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch (_) { el.textContent = 'bad response'; el.className = 'msp-balance-val err'; return; }
      if (data.success) {
        lastBalance = data.total;
        el.textContent = '$' + fmt(data.total);
        el.className = 'msp-balance-val ok';
        if (riskToggle.getValue() === 'pct') applyRiskPct();
      } else {
        el.textContent = data.error ? data.error.slice(0, 24) : 'api error';
        el.className = 'msp-balance-val err';
      }
    } catch (_) {
      el.textContent = 'network err';
      el.className = 'msp-balance-val err';
    }
  }

  fetchBalance();
  setInterval(fetchBalance, 10000);

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

    const pushButton = document.getElementById('msp-push-btn');
    pushButton.disabled = true;
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
      pushButton.disabled = false;
    }
  }

  // ─── Direction Selection ────────────────────────────────────────────────────

  const longBtn  = document.getElementById('msp-long-btn');
  const shortBtn = document.getElementById('msp-short-btn');
  const pushBtn  = document.getElementById('msp-push-btn');

  function setDirection(dir) {
    // Toggle off if same direction clicked again
    selectedDirection = (selectedDirection === dir) ? null : dir;

    longBtn.classList.toggle('dir-long-active',   selectedDirection === 'long');
    longBtn.classList.toggle('dir-inactive',       selectedDirection === 'short');
    shortBtn.classList.toggle('dir-short-active',  selectedDirection === 'short');
    shortBtn.classList.toggle('dir-inactive',       selectedDirection === 'long');

    const badge = document.getElementById('msp-rr-dir-badge');
    if (selectedDirection === 'long') {
      pushBtn.textContent = 'PUSH LONG';
      pushBtn.className   = 'msp-push-btn push-long';
      badge.textContent   = 'LONG';
      badge.className     = 'msp-rr-dir-badge badge-long';
    } else if (selectedDirection === 'short') {
      pushBtn.textContent = 'PUSH SHORT';
      pushBtn.className   = 'msp-push-btn push-short';
      badge.textContent   = 'SHORT';
      badge.className     = 'msp-rr-dir-badge badge-short';
    } else {
      pushBtn.textContent = 'Select direction';
      pushBtn.className   = 'msp-push-btn push-idle';
      badge.textContent   = '';
      badge.className     = 'msp-rr-dir-badge';
    }

    updatePreview();
  }

  longBtn .addEventListener('click', () => setDirection('long'));
  shortBtn.addEventListener('click', () => setDirection('short'));

  pushBtn.addEventListener('click', () => {
    if (!selectedDirection) {
      setStatus('❌ Select LONG or SHORT first', 'error');
      return;
    }
    sendOrder(selectedDirection === 'long' ? 'open_long' : 'open_short');
  });

})();
