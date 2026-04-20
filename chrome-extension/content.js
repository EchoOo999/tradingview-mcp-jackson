// MEXC Scalp Panel — Content Script
// Injects a floating trading panel into TradingView (read-only, no chart modifications)

(function () {
  'use strict';

  if (document.getElementById('mexc-scalp-panel')) return;

  const WEBHOOK_URL = 'https://mexc-webhook-production.up.railway.app/webhook';
  const SECRET = 'scalp2024';

  // ─── Symbol Detection ──────────────────────────────────────────────────────

  function getRawSymbol() {
    // Primary: TV Desktop chart API — document.title is always the generic
    // TradingView homepage title on Desktop and never contains the symbol.
    try {
      const sym = window.TradingViewApi._activeChartWidgetWV.value().symbol();
      if (sym && sym.length > 2) return sym.split(':').pop(); // 'MEXC:BTCUSDT.P' → 'BTCUSDT.P'
    } catch (_) {}

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

  function getBaseCoin() {
    const mexc = toMexcSymbol(getRawSymbol());
    if (!mexc) return '';
    return mexc.split('_')[0] || '';
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
      <button id="msp-close"    title="Close">×</button>
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

      <!-- Drawing Capture -->
      <button id="msp-capture-btn" title="Fill Entry / TP / SL from a selected Long/Short Position drawing on the chart">📋 From Drawing</button>

      <!-- R/R Preview -->
      <div id="msp-rr-box">
        <div class="msp-rr-header">
          <span>R/R PREVIEW</span>
          <span id="msp-rr-dir-badge" class="msp-rr-dir-badge"></span>
        </div>
        <div class="msp-rr-grid">

          <div class="msp-rr-cell">
            <span class="msp-rr-label">Position Size</span>
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

  // Restore saved position (overrides CSS default when available)
  try {
    chrome.storage.local.get('mexcScalpPosition', (result) => {
      if (result.mexcScalpPosition) {
        const p = result.mexcScalpPosition;
        panel.style.top    = p.top  + 'px';
        panel.style.left   = p.left + 'px';
        panel.style.bottom = 'auto';
        panel.style.right  = 'auto';
      }
    });
  } catch (_) {}

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
    if (riskToggle.getValue() === 'pct' && lastBalance > 0) {
      const pct = parseInt(document.getElementById('msp-risk-slider').value, 10);
      // % of balance = margin amount; position size = margin × leverage (done below)
      usdRisk = (pct / 100) * lastBalance;
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
    // USD Risk = Quantity (USDT notional position size)
    // Contracts = USD Risk / Entry
    // Margin = USD Risk / Leverage (display only)
    // PNL % = PNL / Margin × 100
    const quantity  = usdRisk;
    const contracts = usdRisk / entry;
    const margin    = usdRisk / leverage;

    const coin    = getBaseCoin();
    const coinAmt = fmt(contracts, 4) + (coin ? ' ' + coin : '');
    setVal('msp-rr-qty', '$' + fmt(quantity) + ' / ' + coinAmt, 'qty');
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
  const previewInterval = setInterval(updatePreview, 1000);
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
  // Poll every 2s — TV Desktop title is always the generic homepage string,
  // so we rely entirely on the chart API which changes on pane/symbol switch.
  setInterval(refreshSymbol, 2000);

  // ─── Draggable ─────────────────────────────────────────────────────────────

  let dragging = false, ox = 0, oy = 0;
  const header = document.getElementById('msp-header');

  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('#msp-minimize, #msp-close')) return;
    dragging = true;
    const r = panel.getBoundingClientRect();
    ox = e.clientX - r.left;
    oy = e.clientY - r.top;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    panel.style.left   = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  e.clientX - ox)) + 'px';
    panel.style.top    = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - oy)) + 'px';
    panel.style.right  = 'auto';
    panel.style.bottom = 'auto';
  });

  document.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      const r = panel.getBoundingClientRect();
      try { chrome.storage.local.set({ mexcScalpPosition: { top: r.top, left: r.left } }); } catch (_) {}
    }
  });

  // ─── Collapse / Expand / Close ─────────────────────────────────────────────

  const minimizeBtn = document.getElementById('msp-minimize');

  // Restore minimize state (now that minimizeBtn is available)
  try {
    chrome.storage.local.get('mexcScalpMinimized', (result) => {
      if (result.mexcScalpMinimized) {
        panel.classList.add('collapsed');
        minimizeBtn.textContent = '+';
      }
    });
  } catch (_) {}

  minimizeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.classList.toggle('collapsed');
    minimizeBtn.textContent = panel.classList.contains('collapsed') ? '+' : '−';
    try { chrome.storage.local.set({ mexcScalpMinimized: panel.classList.contains('collapsed') }); } catch (_) {}
  });

  // ─── Floating Reopen Button ────────────────────────────────────────────────
  // Always visible at bottom-right. Restores the panel when it is collapsed
  // or hidden. Panel is never fully destroyed — just collapsed.
  const reopenBtn = document.createElement('div');
  reopenBtn.id    = 'msp-reopen-btn';
  reopenBtn.textContent = 'MS';
  reopenBtn.title = 'Open MEXC Scalp Panel';
  document.body.appendChild(reopenBtn);

  reopenBtn.addEventListener('click', () => {
    panel.style.display = '';
    panel.classList.remove('collapsed');
    minimizeBtn.textContent = '−';
  });

  const closeBtn = document.getElementById('msp-close');
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Collapse rather than destroy — use the MS button at bottom-right to restore
    panel.classList.add('collapsed');
    minimizeBtn.textContent = '+';
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

  async function getBalanceApiKey() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get('balanceApiKey', (result) => {
          resolve(result && result.balanceApiKey ? result.balanceApiKey : null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  async function fetchBalance() {
    const el = document.getElementById('msp-bal-total');
    const apiKey = await getBalanceApiKey();
    if (!apiKey) {
      console.warn('[mexc-scalp] Balance API key not configured — open extension options to set it.');
      el.textContent = 'set key in options';
      el.className = 'msp-balance-val err';
      return;
    }
    try {
      const res  = await fetch(WEBHOOK_URL.replace('/webhook', '/balance'), {
        headers: { 'X-API-Key': apiKey },
      });
      if (res.status === 401) {
        el.textContent = 'unauthorized (bad key)';
        el.className = 'msp-balance-val err';
        return;
      }
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
  const balanceInterval = setInterval(fetchBalance, 10000);

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

    // Re-fetch live price one final time for Market orders before building payload
    if (orderType === 'market') {
      const freshPrice = getCurrentPrice();
      if (freshPrice && freshPrice > 0) {
        entryInput.value = freshPrice;
        updatePreview();
      }
    }

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
    const savedText  = pushButton.textContent;
    const savedClass = pushButton.className;

    function restorePush() {
      pushButton.disabled    = false;
      pushButton.textContent = savedText;
      pushButton.className   = savedClass;
      // Re-apply direction button visual state — never let push restore reset it
      longBtn.classList.toggle('dir-long-active',  selectedDirection === 'long');
      longBtn.classList.toggle('dir-inactive',      selectedDirection === 'short');
      shortBtn.classList.toggle('dir-short-active', selectedDirection === 'short');
      shortBtn.classList.toggle('dir-inactive',     selectedDirection === 'long');
    }

    pushButton.disabled    = true;
    pushButton.textContent = 'SENDING...';

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
        pushButton.textContent = '✅ SENT';
        setStatus(`✅ ${dir} ${symbol} sent`, 'success');
        setTimeout(restorePush, 2000);
      } else {
        pushButton.textContent = '❌ FAILED';
        setStatus(`❌ ${res.status}: ${data.message || data.error || text}`, 'error', 6000);
        setTimeout(restorePush, 3000);
      }
    } catch (err) {
      pushButton.textContent = '❌ FAILED';
      setStatus(`❌ Network error: ${err.message}`, 'error', 6000);
      setTimeout(restorePush, 3000);
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

  // ─── Position Drawing Capture ─────────────────────────────────────────────

  // Detect if a shape name matches a Long/Short Position drawing tool
  function _isRRShape(name) {
    if (!name) return false;
    const n = name.toLowerCase();
    return n.includes('riskreward') || n === 'long_position' || n === 'short_position' ||
           n === 'linetoollongtrade' || n === 'linetoolshorttrade';
  }

  function tryReadPositionDrawing() {
    try {
      const widget = window.TradingViewApi?._activeChartWidgetWV?.value?.();
      if (!widget) return null;

      // widget IS the chart — getAllShapes() lives directly on it
      const allShapes = widget.getAllShapes?.() ?? [];

      // Find Long/Short Position drawings; also check internal toolname via getShapeById
      let found = null;
      for (const shape of allShapes) {
        let isRR = _isRRShape(shape.name);
        let internalName = shape.name;

        if (!isRR) {
          try {
            const tn = widget.getShapeById?.(shape.id)?._source?.toolname ?? '';
            if (/LineToolRiskReward|LongTrade|ShortTrade/i.test(tn)) {
              isRR = true;
              internalName = tn;
            }
          } catch (_) {}
        }

        if (isRR) found = { ...shape, internalName };
      }

      if (!found) return null;

      // Determine direction from shape name
      const nameStr = (found.internalName || found.name || '').toLowerCase();
      const isLong = !nameStr.includes('short');

      const entity = widget.getShapeById?.(found.id);
      if (!entity) return { shapeFound: true, isLong };

      // Entry price from getPoints() — RiskReward tool returns only the entry point
      const points = entity.getPoints?.() ?? [];
      const entry = points[0]?.price;
      if (!(entry > 0)) return { shapeFound: true, isLong };

      // profitLevel / stopLevel are tick-offsets from entry (confirmed via CDP)
      const props = entity.getProperties?.() ?? {};
      const profitTicks = props.profitLevel;
      const stopTicks   = props.stopLevel;

      if (!(profitTicks > 0) || !(stopTicks > 0)) return { shapeFound: true, isLong };

      // tickSize = minmov / pricescale from the symbol info
      let tickSize = 0;
      try {
        const si = widget._chartWidget?._modelWV?._value?.m_model
                         ?._mainSeries?._symbolInfo?._value;
        const minmov = si?.minmov ?? 1;
        const pricescale = si?.pricescale ?? 1;
        tickSize = minmov / pricescale;
      } catch (_) {}

      // Fallback: infer tick size from entry decimal places
      if (tickSize <= 0) {
        const decimals = (entry.toString().split('.')[1] || '').length;
        tickSize = Math.pow(10, -decimals) || 0.01;
      }

      const round = (x) => Math.round(x / tickSize) * tickSize;
      let tp, sl;
      if (isLong) {
        tp = round(entry + profitTicks * tickSize);
        sl = round(entry - stopTicks  * tickSize);
      } else {
        tp = round(entry - profitTicks * tickSize);
        sl = round(entry + stopTicks  * tickSize);
      }

      return { entry, tp, sl, isLong };

    } catch (err) {
      console.warn('[MSP] tryReadPositionDrawing:', err.message);
      return null;
    }
  }

  function applyCapture(data) {
    if (!data) {
      setStatus('❌ No Long/Short Position drawing found on chart', 'error', 5000);
      return;
    }
    if (data.shapeFound && !data.entry) {
      setStatus('❌ Drawing detected but prices unreadable — try selecting it first', 'error', 5000);
      return;
    }

    const { entry, tp, sl, isLong } = data;
    if (!(entry > 0)) {
      setStatus('❌ Could not read prices from drawing', 'error', 5000);
      return;
    }

    // Auto-set direction from drawing type
    if (isLong != null) setDirection(isLong ? 'long' : 'short');

    // TP and SL always come from the drawing
    document.getElementById('msp-tp').value = tp > 0 ? tp : '';
    document.getElementById('msp-sl').value = sl > 0 ? sl : '';

    // Entry: use live market price for Market mode; drawing's entry for Limit mode
    // (Market mode auto-refreshes entry every 2s via syncEntryPrice anyway)
    const livePrice = getCurrentPrice();
    if (typeToggle.getValue() === 'market') {
      // Keep live price — don't overwrite with stale drawing entry
      if (livePrice && livePrice > 0) entryInput.value = livePrice;
    } else {
      // Limit mode: drawing's entry is the intended limit price
      entryInput.value = entry;
    }
    updatePreview();

    const dir = isLong ? '🟢 LONG' : '🔴 SHORT';
    setStatus(
      `✅ ${dir} · Entry ${fmtPrice(entry)}${tp > 0 ? ' · TP ' + fmtPrice(tp) : ''}${sl > 0 ? ' · SL ' + fmtPrice(sl) : ''}`,
      'success', 6000
    );
  }

  document.getElementById('msp-capture-btn').addEventListener('click', () => applyCapture(tryReadPositionDrawing()));

})();
