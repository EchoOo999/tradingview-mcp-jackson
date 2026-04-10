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
    // Strip everything except digits, dots, commas — then remove commas
    const n = parseFloat(str.replace(/[^0-9.,]/g, '').replace(/,/g, ''));
    return (n > 0) ? n : null;
  }

  function getCurrentPrice() {
    console.log('[MSP] getCurrentPrice() called, title=', document.title);

    // ── Strategy 1: Page title ─────────────────────────────────────────────────
    // TV Desktop title: "BTCUSDT.P 72,890.2 ▲ +1.59% Main Layout"
    // TV Web title:     "84,250.12 · BTCUSDT.P · MEXC · TradingView"
    // Scan every whitespace/separator token — pick the first one that parses > 100
    try {
      const segments = document.title.split(/[\s·\|\-–—]+/);
      console.log('[MSP] S1 title segments:', segments);
      for (const seg of segments) {
        const n = parsePrice(seg);
        console.log('[MSP] S1 segment:', JSON.stringify(seg), '→ parsed:', n);
        if (n && n > 100) { console.log('[MSP] S1 WIN:', n); return n; }
      }
    } catch (e) { console.log('[MSP] S1 error:', e.message); }

    // ── Strategy 2: Named price-axis SVG containers ────────────────────────────
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
      console.log('[MSP] S2 price-axis nodes found:', nodes.length, 'valid nums:', nums);
      if (nums.length >= 2) {
        nums.sort((a, b) => a - b);
        const result = nums[Math.floor(nums.length / 2)];
        console.log('[MSP] S2 WIN:', result);
        return result;
      }
    } catch (e) { console.log('[MSP] S2 error:', e.message); }

    // ── Strategy 3: ALL SVG text elements — magnitude cluster ─────────────────
    // The price axis always has 4-10 labels all at the same order of magnitude
    // (e.g. 72000, 72500, 73000…). Group every SVG number by floor(log10(n))
    // and take the median of the biggest group — that's the price axis cluster.
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
      console.log('[MSP] S3 magnitude groups:', JSON.stringify(groups));
      const best = Object.values(groups).sort((a, b) => b.length - a.length)[0];
      if (best && best.length >= 3) {
        best.sort((a, b) => a - b);
        const result = best[Math.floor(best.length / 2)];
        console.log('[MSP] S3 WIN:', result, 'from group size', best.length);
        return result;
      } else {
        console.log('[MSP] S3 MISS: best group', best, '(need ≥3)');
      }
    } catch (e) { console.log('[MSP] S3 error:', e.message); }

    // ── Strategy 4: Visible DOM elements with data-price / aria attributes ─────
    try {
      for (const attr of ['data-price', 'data-last-price', 'data-value']) {
        const el = document.querySelector(`[${attr}]`);
        if (el) {
          const n = parsePrice(el.getAttribute(attr));
          console.log('[MSP] S4 attr', attr, '=', el.getAttribute(attr), '→ parsed:', n);
          if (n > 1) { console.log('[MSP] S4 WIN:', n); return n; }
        }
      }
    } catch (e) { console.log('[MSP] S4 error:', e.message); }

    console.log('[MSP] ALL STRATEGIES FAILED — returning null');
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
        </div>
        <div id="msp-min-warn" class="msp-min-warn" style="display:none"></div>
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
            <span class="msp-rr-label">Position Size</span>
            <span id="msp-rr-size" class="msp-rr-val">—</span>
          </div>
          <div class="msp-rr-cell">
            <span class="msp-rr-label">Margin Required</span>
            <span id="msp-rr-margin" class="msp-rr-val">—</span>
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

  // Managed interval for Market-mode auto-fill
  let marketInterval = null;

  function startMarketFill() {
    stopMarketFill();
    syncEntryPrice();                              // immediate fill on switch
    marketInterval = setInterval(syncEntryPrice, 2000);
  }

  function stopMarketFill() {
    if (marketInterval) { clearInterval(marketInterval); marketInterval = null; }
  }

  function applyEntryMode(mode) {
    const isMarket = mode === 'market';
    console.log('[MSP] applyEntryMode:', mode, '| isMarket:', isMarket);
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

  // ─── R/R Preview ───────────────────────────────────────────────────────────

  function fmt(n, decimals = 2) {
    return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }

  const entryInput = document.getElementById('msp-entry');

  function syncEntryPrice() {
    const p = getCurrentPrice();
    console.log('[MSP] syncEntryPrice → price:', p, '| current field:', entryInput.value, '| readOnly:', entryInput.readOnly);
    if (!p || p <= 0) { console.log('[MSP] syncEntryPrice: no price, skipping'); return; }
    if (p === parseFloat(entryInput.value)) { console.log('[MSP] syncEntryPrice: price unchanged, skipping'); return; }
    entryInput.value = p;
    console.log('[MSP] syncEntryPrice: SET field to', p);
    updatePreview();
  }

  // Apply initial market state on load (starts interval if default is Market)
  applyEntryMode(typeToggle.getValue());

  function updatePreview() {
    const elProfit = document.getElementById('msp-rr-profit');
    const elLoss   = document.getElementById('msp-rr-loss');
    const elRatio  = document.getElementById('msp-rr-ratio');
    const elSize   = document.getElementById('msp-rr-size');
    const elMargin = document.getElementById('msp-rr-margin');

    const leverage = parseFloat(document.getElementById('msp-leverage').value) || 0;
    const usdRisk  = parseFloat(document.getElementById('msp-risk').value)     || 0;
    const tp       = parseFloat(document.getElementById('msp-tp').value)       || 0;
    const sl       = parseFloat(document.getElementById('msp-sl').value)       || 0;
    const entry    = parseFloat(entryInput.value)                              || 0;

    const reset = (...els) => els.forEach(el => { el.textContent = '—'; el.className = 'msp-rr-val'; });
    const warnEl = document.getElementById('msp-min-warn');

    // USD Risk = max loss — always fixed
    // Need entry + SL to compute position size
    if (entry <= 0 || sl <= 0 || usdRisk <= 0) {
      reset(elLoss, elProfit, elRatio, elSize, elMargin);
      warnEl.style.display = 'none';
      return;
    }

    const slDistPct = Math.abs(entry - sl) / entry;
    if (slDistPct <= 0) { reset(elLoss, elProfit, elRatio, elSize, elMargin); warnEl.style.display = 'none'; return; }

    // Direction check — warn if TP and SL are on wrong sides
    if (tp > 0) {
      const isLong = sl < entry;
      if ((isLong && tp < entry) || (!isLong && tp > entry)) {
        reset(elLoss, elProfit, elSize, elMargin);
        elRatio.textContent = '⚠ TP/SL sides wrong';
        elRatio.className   = 'msp-rr-val warn';
        warnEl.style.display = 'none';
        return;
      }
    }

    // Core formulas
    const positionSize = usdRisk / slDistPct;           // USD notional
    const contracts    = positionSize / entry;
    const loss         = usdRisk;                        // always = USD Risk
    const margin       = leverage > 0 ? positionSize / leverage : 0;

    // Minimum risk warning: min 1 contract → minRisk = entry × slDistPct
    const minRisk = entry * slDistPct;
    if (contracts < 1) {
      warnEl.textContent = '⚠ Too small — Min Risk: $' + fmt(minRisk);
      warnEl.style.display = 'block';
    } else {
      warnEl.style.display = 'none';
    }

    elLoss.textContent = '-$' + fmt(loss);
    elLoss.className   = 'msp-rr-val loss';

    elSize.textContent = '$' + fmt(positionSize);
    elSize.className   = 'msp-rr-val';

    elMargin.textContent = leverage > 0 ? '$' + fmt(margin) : '—';
    elMargin.className   = 'msp-rr-val';

    if (tp <= 0) {
      reset(elProfit, elRatio);
      return;
    }

    const profit = contracts * Math.abs(tp - entry);
    const ratio  = profit / loss;

    elProfit.textContent = '+$' + fmt(profit);
    elProfit.className   = 'msp-rr-val profit';
    elRatio.textContent  = '1 : ' + fmt(ratio);
    elRatio.className    = 'msp-rr-val ratio' + (ratio >= 2 ? ' good' : ratio < 1 ? ' bad' : '');
  }

  // Wire live updates on all inputs
  ['msp-entry', 'msp-leverage', 'msp-risk', 'msp-tp', 'msp-sl'].forEach(id =>
    document.getElementById(id).addEventListener('input', updatePreview)
  );
  document.getElementById('msp-margin-toggle').addEventListener('change', updatePreview);

  // Initial preview render (entry may already be filled from applyEntryMode above)
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

  // ─── Balance Fetch ─────────────────────────────────────────────────────────

  async function fetchBalance() {
    const el = document.getElementById('msp-bal-total');
    try {
      const res  = await fetch(WEBHOOK_URL.replace('/webhook', '/balance'));
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch (_) { el.textContent = 'bad response'; el.className = 'msp-balance-val err'; return; }
      if (data.success) {
        el.textContent = '$' + fmt(data.total);
        el.className = 'msp-balance-val ok';
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
