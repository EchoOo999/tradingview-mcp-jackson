/**
 * Creates 2 missing SFP Screener pine_alert alerts via CDP Fetch interception.
 * - BINGX:BTCUSDT / SFP Screener 1 / SUI/BEAT/VET/INJ/ETHFI (pane 0)
 * - SP:SPX        / SFP Screener 6 / NEAR/SOL/LINK/LTC/AVAX  (pane 5)
 */
import CDP from 'chrome-remote-interface';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const ALERT_DEFS = [
  {
    pane: 0,
    symbol: 'BINGX:BTCUSDT',
    pine_id: 'USER;d1409c5badd147b29c7576c2766de734',
    pine_version: '6.0',
    inputs: {
      "__profile": false,
      "in_0": true,  "in_1": "MEXC:SUIUSDT.P",
      "in_2": true,  "in_3": "MEXC:BEATUSDT.P",
      "in_4": true,  "in_5": "MEXC:VETUSDT.P",
      "in_6": true,  "in_7": "MEXC:INJUSDT.P",
      "in_8": true,  "in_9": "MEXC:ETHFIUSDT.P",
      "in_10": 20, "in_11": 14, "in_12": 12, "in_13": 26, "in_14": 9,
      "in_15": true, "in_16": "top_right", "in_17": "small", "in_18": true,
      "pineFeatures": "{\"indicator\":1,\"plot\":1,\"str\":1,\"ta\":1,\"math\":1,\"alert\":1,\"alertcondition\":1,\"table\":1,\"request.security\":1}"
    }
  },
  {
    pane: 5,
    symbol: 'SP:SPX',
    pine_id: 'USER;19b6d50438f84eb8b65147a205365c3e',
    pine_version: '9.0',
    inputs: {
      "__profile": false,
      "in_0": true,  "in_1": "MEXC:NEARUSDT.P",
      "in_2": true,  "in_3": "MEXC:SOLUSDT.P",
      "in_4": true,  "in_5": "MEXC:LINKUSDT.P",
      "in_6": true,  "in_7": "MEXC:LTCUSDT.P",
      "in_8": true,  "in_9": "MEXC:AVAXUSDT.P",
      "in_10": 20, "in_11": 14, "in_12": 12, "in_13": 26, "in_14": 9,
      "in_15": true, "in_16": "top_right", "in_17": "small", "in_18": true,
      "pineFeatures": "{\"indicator\":1,\"plot\":1,\"str\":1,\"ta\":1,\"math\":1,\"alert\":1,\"alertcondition\":1,\"table\":1,\"request.security\":1}"
    }
  },
];

async function findChartTarget() {
  const resp = await fetch('http://localhost:9222/json/list');
  const targets = await resp.json();
  return (
    targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url)) ||
    targets.find(t => t.type === 'page' && /tradingview/i.test(t.url))
  );
}

async function runtimeEval(client, expression) {
  const res = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: false });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  return res.result?.value;
}

async function focusPane(client, paneIndex) {
  await runtimeEval(client, `
    (function() {
      var cwc = window.TradingViewApi._chartWidgetCollection;
      var charts = cwc.getAll ? cwc.getAll() : (cwc._charts || cwc._widgets || []);
      var chart = charts[${paneIndex}];
      if (chart && chart._mainDiv) { chart._mainDiv.click(); return true; }
      if (chart && chart.model && chart.model()._mainDiv) { chart.model()._mainDiv.click(); return true; }
      return false;
    })()
  `);
  await sleep(800);
}

async function openCreateAlertDialog(client) {
  // Close any existing modal
  await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await client.Input.dispatchKeyEvent({ type: 'keyUp',  key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await sleep(400);

  const found = await runtimeEval(client, `
    (function() {
      var btns = Array.from(document.querySelectorAll('button'));
      // Look for the header toolbar "Alert" / "Create alert" button (visible)
      var btn = btns.find(function(b) {
        var label = b.getAttribute('aria-label') || '';
        var text = b.textContent.trim();
        return (label === 'Create alert' || text === 'Alert') && b.offsetParent !== null;
      });
      if (!btn) btn = btns.find(function(b) { return b.getAttribute('data-name') === 'alerts-create-button' && b.offsetParent !== null; });
      if (btn) { btn.click(); return 'clicked: ' + (btn.getAttribute('aria-label') || btn.textContent.trim()); }
      return null;
    })()
  `);
  console.log('  Open dialog:', found || 'not found via button');
  await sleep(2000);
}

async function clickCreateButton(client) {
  const result = await runtimeEval(client, `
    (function() {
      var btns = Array.from(document.querySelectorAll('button'));
      // The submit/create button in the alert dialog
      var btn = btns.find(function(b) {
        var t = b.textContent.trim();
        return /^create$/i.test(t) && b.offsetParent !== null;
      });
      if (!btn) btn = document.querySelector('button[data-name="submit"], button[type="submit"]');
      if (btn) { btn.click(); return btn.textContent.trim(); }
      // Log all visible buttons for debugging
      return 'NOT FOUND. Visible btns: ' + btns.filter(b => b.offsetParent !== null).map(b => b.textContent.trim().slice(0,20)).join(' | ').slice(0,200);
    })()
  `);
  return result;
}

function buildCondition(def) {
  return {
    type: 'pine_alert',
    frequency: '60',
    series: [{
      type: 'study',
      study: 'Script@tv-scripting-101',
      pine_id: def.pine_id,
      pine_version: def.pine_version,
      inputs: def.inputs,
      offsets_by_plot: { plot_1: 0, plot_2: 0, plot_3: 0, plot_4: 0, plot_5: 0 }
    }],
    cross_interval: false,
    resolution: '5'
  };
}

async function main() {
  console.log('Connecting to CDP on localhost:9222...');
  const target = await findChartTarget();
  if (!target) throw new Error('No TradingView chart target found. Is TV open?');
  console.log('Target:', target.url.slice(0, 80));

  const client = await CDP({ host: 'localhost', port: 9222, target: target.id });
  await client.Runtime.enable();
  await client.Fetch.enable({ patterns: [{ urlPattern: '*create_alert*', requestStage: 'Request' }] });
  console.log('Fetch interception enabled for *create_alert*');

  let interceptResolve = null;
  let currentDef = null;

  client.Fetch.requestPaused(async ({ requestId, request }) => {
    if (request.method === 'OPTIONS') { await client.Fetch.continueRequest({ requestId }); return; }
    if (!request.url.includes('create_alert')) { await client.Fetch.continueRequest({ requestId }); return; }

    console.log(`  >> Intercepted: ${request.url}`);
    console.log(`  >> Method: ${request.method}, postData length: ${(request.postData || '').length}`);

    let payload;
    try { payload = JSON.parse(request.postData || '{}'); } catch { payload = { payload: {} }; }
    if (!payload.payload) payload.payload = {};

    const condition = buildCondition(currentDef);
    payload.payload.conditions = [condition];
    payload.payload.symbol = currentDef.symbol;
    payload.payload.resolution = '5';
    payload.payload.active = true;
    payload.payload.ignore_warnings = true;

    const newBody = JSON.stringify(payload);
    console.log(`  >> Replacing body with pine_alert for ${currentDef.symbol}`);
    console.log(`  >> pine_id=${currentDef.pine_id}, ver=${currentDef.pine_version}`);
    console.log(`  >> coins: ${[currentDef.inputs.in_1, currentDef.inputs.in_3, currentDef.inputs.in_5, currentDef.inputs.in_7, currentDef.inputs.in_9].join(', ')}`);

    await client.Fetch.continueRequest({ requestId, postData: Buffer.from(newBody).toString('base64') });
    if (interceptResolve) { interceptResolve(true); interceptResolve = null; }
  });

  let created = 0;
  let failed = 0;

  for (let i = 0; i < ALERT_DEFS.length; i++) {
    const def = ALERT_DEFS[i];
    currentDef = def;
    console.log(`\n[${i+1}/${ALERT_DEFS.length}] ${def.symbol} (pane ${def.pane})`);

    await focusPane(client, def.pane);
    console.log('  Pane focused.');

    const interceptPromise = new Promise(resolve => { interceptResolve = resolve; });

    await openCreateAlertDialog(client);

    const btnText = await clickCreateButton(client);
    console.log('  Create button result:', btnText);

    if (btnText && btnText.startsWith('NOT FOUND')) {
      console.log('  SKIP: dialog not ready');
      await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await client.Input.dispatchKeyEvent({ type: 'keyUp',  key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      failed++;
      interceptResolve = null;
      continue;
    }

    const intercepted = await Promise.race([
      interceptPromise,
      sleep(15000).then(() => false),
    ]);

    if (intercepted) {
      console.log(`  OK: Alert created for ${def.symbol}`);
      created++;
    } else {
      console.log(`  TIMEOUT: no intercept within 15s for ${def.symbol}`);
      failed++;
    }

    await sleep(2500);
  }

  await client.Fetch.disable();
  await client.close();

  console.log(`\n=== Done: ${created}/${ALERT_DEFS.length} created, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
