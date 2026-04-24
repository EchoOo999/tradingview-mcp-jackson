// Market Cockpit Panel — injected into TradingView Desktop
// Floating regime dashboard: Crypto + Macro scoring via Railway proxy.

(function () {
  'use strict';

  if (document.getElementById('market-cockpit-panel')) return;

  const RAILWAY_BASE = 'https://mexc-webhook-production.up.railway.app';

  // ── Config ────────────────────────────────────────────────────────────────────
  let cfg = {
    refreshSec: 60,
    threshold:  0.1,  // % change to count as ▲/▼ vs ▬
    tf:         '1d', // 1h | 4h | 1d | 1w  (default: Daily)
  };

  const TF_LABELS = { '1h': '1H%', '4h': '4H%', '1d': 'DAILY%', '1w': 'WEEKLY%' };

  // ── State ─────────────────────────────────────────────────────────────────────
  let cryptoData   = null;
  let macroData    = null;
  let lastTs       = 0;
  let refreshTimer = null;
  let activeTab    = 'crypto';
  let dragging     = false, ox = 0, oy = 0;

  // ── Metric definitions ────────────────────────────────────────────────────────

  const CRYPTO_METRICS = [
    { key: 'btcD',   label: 'BTC.D',   bullDir: 'down',
      meaning: (d) => d > cfg.threshold ? 'BTC dominance ▲' : d < -cfg.threshold ? 'Alts gaining'      : 'Stable dominance' },
    { key: 'usdtD',  label: 'USDT.D',  bullDir: 'down',
      meaning: (d) => d > cfg.threshold ? 'Risk-off flow'   : d < -cfg.threshold ? 'Risk-on flow'       : 'Neutral flow' },
    { key: 'ethBtc', label: 'ETH/BTC', bullDir: 'up',
      meaning: (d) => d > cfg.threshold ? 'Altseason signal' : d < -cfg.threshold ? 'BTC outperforming' : 'ETH/BTC ranging' },
    { key: 'total',  label: 'TOTAL',   bullDir: 'up',
      meaning: (d) => d > cfg.threshold ? 'Market expanding' : d < -cfg.threshold ? 'Market contracting' : 'Market ranging' },
    { key: 'total3', label: 'TOTAL3',  bullDir: 'up',
      meaning: (d) => d > cfg.threshold ? 'Alts expanding'  : d < -cfg.threshold ? 'ALT cap falling'    : 'Alts ranging' },
    { key: 'others', label: 'OTHERS',  bullDir: 'up',
      meaning: (d) => d > cfg.threshold ? 'Small caps rising' : d < -cfg.threshold ? 'Small caps falling' : 'Small caps flat' },
  ];

  const MACRO_METRICS = [
    { key: 'DXY',   label: 'DXY',   bullDir: 'down',
      meaning: (d) => d > cfg.threshold ? 'DXY rising, risk-off'  : d < -cfg.threshold ? 'Weak USD, risk-on'  : 'DXY flat' },
    { key: 'OIL',   label: 'OIL',   bullDir: 'down',
      meaning: (d) => d > cfg.threshold ? 'Inflation risk'         : d < -cfg.threshold ? 'Oil easing'         : 'Oil flat' },
    { key: 'GOLD',  label: 'GOLD',  bullDir: 'down',
      meaning: (d) => d > cfg.threshold ? 'Safe haven demand'      : d < -cfg.threshold ? 'Risk appetite up'   : 'Gold flat' },
    { key: 'SPX',   label: 'SPX',   bullDir: 'up',
      meaning: (d) => d > cfg.threshold ? 'Equities risk-on'       : d < -cfg.threshold ? 'Equities risk-off'  : 'SPX flat' },
    { key: 'NDX',   label: 'NDX',   bullDir: 'up',
      meaning: (d) => d > cfg.threshold ? 'Tech leading up'        : d < -cfg.threshold ? 'Tech leading down'  : 'NDX flat' },
    { key: 'US10Y', label: 'US10Y', bullDir: 'down',
      meaning: (d) => d > cfg.threshold ? 'Yields rising'          : d < -cfg.threshold ? 'Yields easing'      : 'Yields flat' },
    { key: 'VIX',   label: 'VIX',   bullDir: 'down',
      meaning: (d) => d > cfg.threshold ? 'Fear rising'            : d < -cfg.threshold ? 'Fear subsiding'     : 'VIX flat' },
  ];

  // ── Scoring ───────────────────────────────────────────────────────────────────

  function arrow(change) {
    if (change == null || !isFinite(change)) return '▬';
    if (change >  cfg.threshold) return '▲';
    if (change < -cfg.threshold) return '▼';
    return '▬';
  }

  function scoreMetrics(metrics, dataObj) {
    let score = 0;
    const details = [];
    for (const m of metrics) {
      const entry   = dataObj ? dataObj[m.key] : null;
      const change  = entry?.change ?? null;
      const value   = entry?.value  ?? null;
      const bullish = change != null && isFinite(change) && (
        m.bullDir === 'up' ? change > cfg.threshold : change < -cfg.threshold
      );
      if (bullish) score++;
      details.push({
        key: m.key, label: m.label, value, change, bullish,
        arrow:   arrow(change),
        meaning: change != null ? m.meaning(change) : '—',
      });
    }
    return { score, total: metrics.length, details };
  }

  function cryptoRegime(score) {
    if (score >= 6) return 'FULL ALT SEASON';
    if (score >= 4) return 'RISK-ON';
    if (score >= 3) return 'NEUTRAL';
    if (score >= 2) return 'BTC DEFENSIVE';
    return 'RISK-OFF';
  }

  function cryptoAction(score) {
    if (score >= 6) return 'Rotate into altcoins aggressively';
    if (score >= 4) return 'Favor altcoins, reduce BTC exposure';
    if (score >= 3) return 'Monitor BTC.D direction for bias';
    if (score >= 2) return 'Stick to BTC or reduce alt exposure';
    return 'Reduce exposure, hold stablecoins';
  }

  function macroRegime(score) {
    if (score >= 6) return 'FULL RISK-ON';
    if (score >= 4) return 'RISK-ON';
    if (score >= 3) return 'NEUTRAL';
    if (score >= 1) return 'RISK-OFF';
    return 'FULL RISK-OFF';
  }

  function macroAction(score) {
    if (score >= 6) return 'Full risk-on — favor growth assets';
    if (score >= 4) return 'Favor risk assets, manage positions';
    if (score >= 3) return 'Neutral — wait for directional confirmation';
    if (score >= 1) return 'Reduce risk exposure';
    return 'Risk-off — defensive positioning only';
  }

  // Classify raw scores into 3 tiers, then map the 3x3 matrix to crypto-trader-
  // focused labels. Gaps filled by severity (crypto-weakness dominates macro).
  function cryptoTier(s) { return s <= 1 ? 'OFF' : s >= 4 ? 'ON' : 'NEUTRAL'; }
  function macroTier(s)  { return s <= 2 ? 'OFF' : s >= 4 ? 'ON' : 'NEUTRAL'; }

  function masterRegime(cs, ms) {
    if (cs == null || ms == null) return null;
    const c = cryptoTier(cs);
    const m = macroTier(ms);
    if (c === 'ON'      && m === 'ON')      return '🚀 FULL RISK-ON';
    if (c === 'ON'      && m === 'OFF')     return '⚡ CRYPTO-ONLY RALLY';
    if (c === 'ON'      && m === 'NEUTRAL') return '🟢 CRYPTO LEADING';
    if (c === 'NEUTRAL' && m === 'ON')      return '🟡 MACRO TAILWIND';
    if (c === 'NEUTRAL' && m === 'NEUTRAL') return '➡️ MIXED';
    if (c === 'NEUTRAL' && m === 'OFF')     return '⚠️ MACRO HEADWIND';
    if (c === 'OFF'     && m === 'ON')      return '⚠️ CRYPTO DECOUPLING';
    return '💀 FULL RISK-OFF'; // c=OFF + (m=NEUTRAL | m=OFF)
  }

  const MASTER_ACTIONS = {
    '🚀 FULL RISK-ON':       'Max long positions, all systems go',
    '⚡ CRYPTO-ONLY RALLY':   'Crypto strong despite macro headwinds — longs possible but size smaller, watch for correlation return',
    '🟢 CRYPTO LEADING':     'Crypto strength, cautious longs OK',
    '🟡 MACRO TAILWIND':     'Favorable backdrop, wait for crypto confirmation',
    '➡️ MIXED':              'Wait for clarity, no strong bias',
    '⚠️ MACRO HEADWIND':      'TradFi weakness bleeding in — avoid new longs, wait for macro stabilization',
    '⚠️ CRYPTO DECOUPLING':   'Crypto weak despite TradFi strength — avoid crypto longs, consider stocks if you trade them',
    '💀 FULL RISK-OFF':      'Stay cash, no crypto longs',
  };

  function masterAction(regime) {
    if (!regime) return 'Fetching data…';
    return MASTER_ACTIONS[regime] || 'Wait for clarity';
  }

  function masterRegimeCls(regime) {
    if (!regime) return '';
    if (regime.includes('FULL RISK-ON'))     return 'regime-full-bull';     // bright green
    if (regime.includes('CRYPTO-ONLY'))      return 'regime-yellow-green';  // yellow-green
    if (regime.includes('CRYPTO LEADING'))   return 'regime-bull';          // soft green
    if (regime.includes('MACRO TAILWIND'))   return 'regime-neutral';       // yellow
    if (regime.includes('MIXED'))            return 'regime-mixed';         // gray
    if (regime.includes('DECOUPLING') || regime.includes('HEADWIND')) return 'regime-decoupling'; // orange
    if (regime.includes('FULL RISK-OFF'))    return 'regime-full-bear';     // dark red
    return '';
  }

  function topDrivers(cDetails, mDetails) {
    const all = [
      ...(cDetails || []).map(d => ({ ...d, group: 'C' })),
      ...(mDetails || []).map(d => ({ ...d, group: 'M' })),
    ];
    return all
      .filter(d => d.change != null && isFinite(d.change) && Math.abs(d.change) > 0)
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
      .slice(0, 3)
      .map(d => `[${d.group}] ${d.label}: ${d.change > 0 ? '+' : ''}${d.change.toFixed(2)}% ${d.arrow}`);
  }

  function regimeCls(r) {
    if (!r) return '';
    const u = r.toUpperCase();
    if (u.includes('FULL ALT SEASON') || u.includes('FULL RISK-ON')) return 'regime-full-bull';
    if (u.includes('RISK-ON') || u.includes('CRYPTO LEADING'))       return 'regime-bull';
    if (u.includes('NEUTRAL'))                                        return 'regime-neutral';
    if (u.includes('DEFENSIVE') || u.includes('RISK-OFF'))           return 'regime-bear';
    return 'regime-full-bear';
  }

  // ── Value formatters ──────────────────────────────────────────────────────────

  function fmtBig(n) {
    if (!isFinite(n)) return '—';
    if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (n >= 1e9)  return '$' + (n / 1e9).toFixed(1)  + 'B';
    return '$' + (n / 1e6).toFixed(0) + 'M';
  }

  function fmtCrypto(key, value) {
    if (value == null || !isFinite(value)) return '—';
    if (key === 'btcD' || key === 'usdtD') return value.toFixed(2) + '%';
    if (key === 'ethBtc') return value.toPrecision(5);
    return fmtBig(value);
  }

  function fmtMacro(key, value) {
    if (value == null || !isFinite(value)) return '—';
    if (key === 'OIL' || key === 'GOLD')  return '$' + value.toFixed(2);
    if (key === 'SPX' || key === 'NDX')   return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (key === 'US10Y')                   return value.toFixed(2) + '%';
    return value.toFixed(2);
  }

  // ── Data fetching ─────────────────────────────────────────────────────────────

  async function fetchAll() {
    setStatus('loading');
    const errors = [];
    const tfParam = `?tf=${cfg.tf}`;

    try {
      const r = await fetch(`${RAILWAY_BASE}/crypto-data${tfParam}`, { signal: AbortSignal.timeout(20_000) });
      const j = await r.json();
      if (j.success) cryptoData = j.data;
      else errors.push('Crypto: ' + (j.error || 'server error'));
    } catch (err) {
      errors.push('Crypto: ' + err.message.slice(0, 40));
    }

    try {
      const r = await fetch(`${RAILWAY_BASE}/market-data${tfParam}`, { signal: AbortSignal.timeout(20_000) });
      const j = await r.json();
      if (j.success) macroData = j.data;
      else errors.push('Macro: ' + (j.error || 'server error'));
    } catch (err) {
      errors.push('Macro: ' + err.message.slice(0, 40));
    }

    lastTs = Date.now();
    setStatus(errors.length ? 'error' : 'ok', errors.join(' | '));
    render();
    pushRegimeToSAE();
  }

  // ── SAE regime push ───────────────────────────────────────────────────────────
  // Fire-and-forget: after each cockpit refresh we POST the regime snapshot to
  // mexc-webhook's /cockpit/regime proxy, which forwards it (with the server-held
  // X-SAE-Token) to EchoOo-SAE /regime/external.
  //
  // The server-side `SAE_REGIME_PUSH_ENABLED` env flag gates forwarding — this
  // client always pushes; it's the server's job to honour the flag. That way
  // toggling the feature is an env flip + server redeploy, no extension reload.
  //
  // Soft rate-limit here matches the server's (55s min interval, allowing a
  // little jitter vs the 60s server-side floor).

  let lastRegimePush = 0;
  const REGIME_PUSH_MIN_INTERVAL_MS = 55_000;

  function dirFromChange(change) {
    if (change == null || !isFinite(change)) return null;
    if (change >  cfg.threshold) return 'up';
    if (change < -cfg.threshold) return 'down';
    return 'flat';
  }

  function buildRegimePushPayload() {
    if (!cryptoData || !macroData) return null;
    const cs          = scoreMetrics(CRYPTO_METRICS, cryptoData);
    const ms          = scoreMetrics(MACRO_METRICS,  macroData);
    const masterLabel = masterRegime(cs.score, ms.score);
    return {
      source:               'market_cockpit',
      source_tag:           'cockpit_chrome',
      timeframe:            cfg.tf,
      master_regime_label:  masterLabel,
      crypto_score:         cs.score,
      macro_score:          ms.score,
      btc_d_direction:      dirFromChange(cryptoData.btcD   ? cryptoData.btcD.change   : null),
      usdt_d_direction:     dirFromChange(cryptoData.usdtD  ? cryptoData.usdtD.change  : null),
      eth_btc_direction:    dirFromChange(cryptoData.ethBtc ? cryptoData.ethBtc.change : null),
      dxy_direction:        dirFromChange(macroData.DXY   ? macroData.DXY.change   : null),
      oil_direction:        dirFromChange(macroData.OIL   ? macroData.OIL.change   : null),
      gold_direction:       dirFromChange(macroData.GOLD  ? macroData.GOLD.change  : null),
      spx_direction:        dirFromChange(macroData.SPX   ? macroData.SPX.change   : null),
      ndx_direction:        dirFromChange(macroData.NDX   ? macroData.NDX.change   : null),
      us10y_direction:      dirFromChange(macroData.US10Y ? macroData.US10Y.change : null),
      vix_direction:        dirFromChange(macroData.VIX   ? macroData.VIX.change   : null),
      nq_correlation_state: null,      // not computed client-side (yet)
      sp_correlation_state: null,
      snapshot_at:          new Date().toISOString(),
      raw_crypto:           cryptoData,
      raw_macro:            macroData,
    };
  }

  function pushRegimeToSAE() {
    try {
      const now = Date.now();
      if (now - lastRegimePush < REGIME_PUSH_MIN_INTERVAL_MS) return;
      const payload = buildRegimePushPayload();
      if (!payload || !payload.master_regime_label) return;
      lastRegimePush = now;
      fetch(`${RAILWAY_BASE}/cockpit/regime`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(6_000),
      }).catch(err => {
        console.warn('[mc] regime push failed:', (err && err.message) || err);
      });
    } catch (err) {
      console.warn('[mc] regime push threw:', (err && err.message) || err);
    }
  }

  function setStatus(type, msg) {
    const errEl  = document.getElementById('mc-error');
    const loadEl = document.getElementById('mc-loading');
    if (!errEl || !loadEl) return;
    if (type === 'loading' && !cryptoData && !macroData) {
      loadEl.style.display = 'flex';
      errEl.style.display  = 'none';
    } else {
      loadEl.style.display = 'none';
      if (type === 'error' && msg) {
        errEl.textContent   = '⚠ ' + msg;
        errEl.style.display = 'block';
        setTimeout(() => { errEl.style.display = 'none'; }, 15_000);
      }
    }
  }

  // ── Render helpers ────────────────────────────────────────────────────────────

  function tableHTML(metrics, dataObj, fmtFn) {
    if (!dataObj) return '<div class="mc-no-data">Loading…</div>';
    const scored   = scoreMetrics(metrics, dataObj);
    const colLabel = TF_LABELS[cfg.tf] || 'CHG%';

    const rows = scored.details.map(d => `
      <tr class="${d.bullish ? 'mc-row-bull' : ''}">
        <td class="mc-cell-symbol">${d.label}</td>
        <td class="mc-cell-value">${fmtFn(d.key, d.value)}</td>
        <td class="mc-cell-change ${d.change > 0 ? 'pos' : d.change < 0 ? 'neg' : ''}">
          ${d.change != null ? (d.change > 0 ? '+' : '') + d.change.toFixed(2) + '%' : '—'}
        </td>
        <td class="mc-cell-arrow">${d.arrow}</td>
        <td class="mc-cell-meaning">${d.meaning}</td>
      </tr>
    `).join('');

    const pips = Array.from({ length: scored.total }, (_, i) =>
      `<div class="mc-pip ${i < scored.score ? 'filled' : ''}"></div>`
    ).join('');

    return `
      <table class="mc-table">
        <thead><tr><th>Symbol</th><th>Value</th><th>${colLabel}</th><th></th><th>Meaning</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="mc-score-bar">
        <span class="mc-score-label">Score: <strong>${scored.score}/${scored.total}</strong></span>
        <div class="mc-score-pips">${pips}</div>
      </div>
    `;
  }

  function regimeBoxHTML(regime, cls, action, large) {
    const boxCls = (large ? 'mc-regime-box mc-regime-box-large ' : 'mc-regime-box ') + cls;
    const actCls = large ? 'mc-action-box mc-action-box-large' : 'mc-action-box';
    const tooltipHTML = large
      ? ` <span class="mc-tooltip" title="Combines crypto internal strength + macro risk environment into one actionable signal for crypto trading. Divergence = crypto and TradFi disagreeing, usually means lower conviction.">?</span>`
      : '';
    return `
      <div class="${boxCls}">
        <div class="mc-regime-label">${large ? 'MASTER REGIME' : 'REGIME'}${tooltipHTML}</div>
        <div class="mc-regime-value">${regime || '—'}</div>
      </div>
      <div class="${actCls}">▶ ${action}</div>
    `;
  }

  function render() {
    if (lastTs) {
      const el = document.getElementById('mc-last-updated');
      if (el) el.textContent = Math.round((Date.now() - lastTs) / 1000) + 's ago';
    }

    // Update TF selector to reflect current state
    const tfSel = document.getElementById('mc-tf-select');
    if (tfSel && tfSel.value !== cfg.tf) tfSel.value = cfg.tf;

    const tab    = activeTab;
    const crypto = document.getElementById('mc-tab-crypto');
    const macro  = document.getElementById('mc-tab-macro');
    const master = document.getElementById('mc-tab-master');
    if (!crypto || !macro || !master) return;

    if (tab === 'crypto') {
      const s = scoreMetrics(CRYPTO_METRICS, cryptoData);
      crypto.innerHTML = tableHTML(CRYPTO_METRICS, cryptoData, fmtCrypto) +
        regimeBoxHTML(cryptoRegime(s.score), regimeCls(cryptoRegime(s.score)), cryptoAction(s.score), false);
    }

    if (tab === 'macro') {
      const s = scoreMetrics(MACRO_METRICS, macroData);
      macro.innerHTML = tableHTML(MACRO_METRICS, macroData, fmtMacro) +
        regimeBoxHTML(macroRegime(s.score), regimeCls(macroRegime(s.score)), macroAction(s.score), false);
    }

    if (tab === 'master') {
      const cs = scoreMetrics(CRYPTO_METRICS, cryptoData);
      const ms = scoreMetrics(MACRO_METRICS,  macroData);
      const csS  = cryptoData ? { ...cs, regime: cryptoRegime(cs.score) } : null;
      const msS  = macroData  ? { ...ms, regime: macroRegime(ms.score)  } : null;
      const regime = masterRegime(csS?.score ?? null, msS?.score ?? null);
      const drivers = topDrivers(csS?.details, msS?.details);

      master.innerHTML = `
        <div class="mc-master-grid">
          ${csS ? `<div class="mc-master-row"><span class="mc-master-key">CRYPTO</span><span class="mc-master-val">${csS.regime}</span><span class="mc-master-score">(${csS.score}/${csS.total})</span></div>` : ''}
          ${msS ? `<div class="mc-master-row"><span class="mc-master-key">MACRO</span><span class="mc-master-val">${msS.regime}</span><span class="mc-master-score">(${msS.score}/${msS.total})</span></div>` : ''}
        </div>
        ${regimeBoxHTML(regime, masterRegimeCls(regime), masterAction(regime), true)}
        ${drivers.length ? `<div class="mc-drivers"><div class="mc-drivers-label">TOP DRIVERS</div>${drivers.map(d => `<div class="mc-driver-item">${d}</div>`).join('')}</div>` : ''}
      `;
    }
  }

  // ── Panel HTML ────────────────────────────────────────────────────────────────

  const panel = document.createElement('div');
  panel.id    = 'market-cockpit-panel';
  panel.innerHTML = `
    <div id="mc-header">
      <span id="mc-title">📊 COCKPIT</span>
      <div id="mc-header-actions">
        <select id="mc-tf-select" title="Timeframe for change calculation">
          <option value="1h">1H</option>
          <option value="4h">4H</option>
          <option value="1d" selected>Daily</option>
          <option value="1w">Weekly</option>
        </select>
        <span id="mc-last-updated">—</span>
        <button id="mc-settings-btn" title="Settings">⚙</button>
        <button id="mc-minimize" title="Minimize">−</button>
        <button id="mc-close" title="Close">×</button>
      </div>
    </div>
    <div id="mc-body">
      <div id="mc-tabs">
        <button class="mc-tab active" data-tab="crypto">CRYPTO</button>
        <button class="mc-tab" data-tab="macro">MACRO</button>
        <button class="mc-tab" data-tab="master">MASTER</button>
      </div>
      <div id="mc-content">
        <div id="mc-loading" class="mc-loading"><div class="mc-spinner"></div><span>Fetching market data…</span></div>
        <div id="mc-error" class="mc-error" style="display:none"></div>
        <div id="mc-tab-crypto"  class="mc-tab-panel"></div>
        <div id="mc-tab-macro"   class="mc-tab-panel" style="display:none"></div>
        <div id="mc-tab-master"  class="mc-tab-panel" style="display:none"></div>
      </div>
    </div>
    <div id="mc-settings-panel" style="display:none">
      <div class="mc-settings-row">
        <label>Refresh</label>
        <select id="mc-refresh-select">
          <option value="30">30s</option>
          <option value="60" selected>60s</option>
          <option value="120">2min</option>
          <option value="300">5min</option>
        </select>
      </div>
      <div class="mc-settings-row">
        <label>Flat threshold %</label>
        <input id="mc-threshold-input" type="number" value="0.1" step="0.05" min="0" max="2" />
      </div>
      <div class="mc-settings-tooltip">
        <strong>Timeframe</strong> controls the change window:<br>
        1H = last hour · 4H = last 4h · Daily = today · Weekly = this week
      </div>
      <button id="mc-settings-apply">Apply</button>
      <button id="mc-reset-position">Reset Position</button>
    </div>
  `;
  document.body.appendChild(panel);

  const reopenBtn = document.createElement('div');
  reopenBtn.id    = 'mc-reopen-btn';
  reopenBtn.textContent = 'MC';
  reopenBtn.title = 'Open Market Cockpit';
  document.body.appendChild(reopenBtn);

  // ── Position management ───────────────────────────────────────────────────────

  function getDefaultPosition() {
    const mexc = document.getElementById('mexc-scalp-panel');
    if (mexc) {
      const r = mexc.getBoundingClientRect();
      const h = panel.offsetHeight || 400;
      return { top: Math.max(10, r.top - h - 8), left: r.left };
    }
    return { bottom: 320, right: 10 };
  }

  function applyPos(pos) {
    if (pos.top != null) {
      panel.style.top    = pos.top  + 'px';
      panel.style.left   = pos.left + 'px';
      panel.style.bottom = 'auto';
      panel.style.right  = 'auto';
    } else {
      panel.style.bottom = pos.bottom + 'px';
      panel.style.right  = pos.right  + 'px';
      panel.style.top    = 'auto';
      panel.style.left   = 'auto';
    }
  }

  function savePos() {
    const r = panel.getBoundingClientRect();
    try { chrome.storage.local.set({ marketCockpitPosition: { top: r.top, left: r.left } }); } catch (_) {}
  }

  // ── Storage restore ───────────────────────────────────────────────────────────

  try {
    chrome.storage.local.get(
      ['marketCockpitPosition', 'marketCockpitMinimized', 'marketCockpitTab', 'marketCockpitTf'],
      (result) => {
        if (result.marketCockpitPosition) {
          applyPos(result.marketCockpitPosition);
        } else {
          setTimeout(() => applyPos(getDefaultPosition()), 600);
        }
        if (result.marketCockpitMinimized) {
          panel.style.display     = 'none';
          reopenBtn.style.display = 'flex';
        }
        if (result.marketCockpitTab && ['crypto','macro','master'].includes(result.marketCockpitTab)) {
          switchTab(result.marketCockpitTab);
        }
        if (result.marketCockpitTf && ['1h','4h','1d','1w'].includes(result.marketCockpitTf)) {
          cfg.tf = result.marketCockpitTf;
          const sel = document.getElementById('mc-tf-select');
          if (sel) sel.value = cfg.tf;
        }
      }
    );
  } catch (_) {
    setTimeout(() => applyPos(getDefaultPosition()), 600);
  }

  // ── Draggable ─────────────────────────────────────────────────────────────────

  document.getElementById('mc-header').addEventListener('mousedown', (e) => {
    if (e.target.closest('#mc-header-actions')) return;
    dragging = true;
    const r = panel.getBoundingClientRect();
    ox = e.clientX - r.left;
    oy = e.clientY - r.top;
    panel.style.zIndex = '10000001';
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
    if (dragging) { dragging = false; savePos(); panel.style.zIndex = ''; }
  });

  // ── TF selector ───────────────────────────────────────────────────────────────

  document.getElementById('mc-tf-select').addEventListener('change', (e) => {
    cfg.tf = e.target.value;
    try { chrome.storage.local.set({ marketCockpitTf: cfg.tf }); } catch (_) {}
    fetchAll();
  });

  // ── Tabs ──────────────────────────────────────────────────────────────────────

  function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.mc-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.mc-tab-panel').forEach(p => { p.style.display = 'none'; });
    const el = document.getElementById('mc-tab-' + tab);
    if (el) el.style.display = '';
    try { chrome.storage.local.set({ marketCockpitTab: tab }); } catch (_) {}
    render();
  }

  document.getElementById('mc-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.mc-tab');
    if (btn) switchTab(btn.dataset.tab);
  });

  // ── Minimize / Close / Reopen ─────────────────────────────────────────────────

  function minimize() {
    panel.style.display     = 'none';
    reopenBtn.style.display = 'flex';
    try { chrome.storage.local.set({ marketCockpitMinimized: true }); } catch (_) {}
  }

  function expand() {
    panel.style.display     = '';
    reopenBtn.style.display = 'none';
    try { chrome.storage.local.set({ marketCockpitMinimized: false }); } catch (_) {}
  }

  document.getElementById('mc-minimize').addEventListener('click', minimize);
  document.getElementById('mc-close').addEventListener('click', minimize);
  reopenBtn.addEventListener('click', expand);

  // ── Settings ──────────────────────────────────────────────────────────────────

  let settingsOpen = false;
  document.getElementById('mc-settings-btn').addEventListener('click', () => {
    settingsOpen = !settingsOpen;
    document.getElementById('mc-settings-panel').style.display = settingsOpen ? 'block' : 'none';
  });

  document.getElementById('mc-settings-apply').addEventListener('click', () => {
    const refreshVal = parseInt(document.getElementById('mc-refresh-select').value);
    const threshVal  = parseFloat(document.getElementById('mc-threshold-input').value);
    if (refreshVal > 0) cfg.refreshSec = refreshVal;
    if (threshVal >= 0) cfg.threshold  = threshVal;
    settingsOpen = false;
    document.getElementById('mc-settings-panel').style.display = 'none';
    scheduleRefresh();
    fetchAll();
  });

  document.getElementById('mc-reset-position').addEventListener('click', () => {
    try { chrome.storage.local.remove('marketCockpitPosition'); } catch (_) {}
    applyPos(getDefaultPosition());
    settingsOpen = false;
    document.getElementById('mc-settings-panel').style.display = 'none';
  });

  // ── Refresh scheduler ─────────────────────────────────────────────────────────

  function scheduleRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(fetchAll, cfg.refreshSec * 1000);
  }

  setInterval(() => {
    if (!lastTs) return;
    const el = document.getElementById('mc-last-updated');
    if (el) el.textContent = Math.round((Date.now() - lastTs) / 1000) + 's ago';
  }, 1000);

  // ── Init ──────────────────────────────────────────────────────────────────────

  fetchAll();
  scheduleRefresh();

  // Retry after 30s if data still missing (Railway cold start)
  setTimeout(() => { if (!cryptoData || !macroData) fetchAll(); }, 30_000);

})();
