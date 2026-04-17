/**
 * Creates 6 SFP Screener pine_alert alerts via CDP Fetch interception.
 * Each alert creation: focus pane → open dialog → click Create → interceptor replaces body.
 */
import CDP from 'chrome-remote-interface';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const ALERT_DEFS = [
  { pane: 0, pine_id: 'USER;d1409c5badd147b29c7576c2766de734',  symbol: 'BINGX:BTCUSDT'      },
  { pane: 1, pine_id: 'USER;caad3eb9f4db4a489eaccb543d80706f',  symbol: 'BINGX:ETHUSDT'      },
  { pane: 2, pine_id: 'USER;fb6adc6400cb4b77a07662d199fb803a',  symbol: 'BINANCE:SOLUSDT'    },
  { pane: 3, pine_id: 'USER;0b9735efd2344e5288862a3e959cdc19',  symbol: 'BINANCE:BNBUSDT'    },
  { pane: 4, pine_id: 'USER;a3320a47ff9a42a3b32b1a61bb88f0ab',  symbol: 'TVC:USOIL'          },
  { pane: 5, pine_id: 'USER;19b6d50438f84eb8b65147a205365c3e',  symbol: 'CME_MINI_DL:ES1!'   },
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
  const res = await client.Runtime.evaluate({ expression, returnByValue: true });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  }
  return res.result?.value;
}

async function getStudyInputs(client, paneIndex, pineId) {
  const result = await runtimeEval(client, `
    (function() {
      try {
        var cwc = window.TradingViewApi._chartWidgetCollection;
        var chart = cwc.getAll()[${paneIndex}];
        if (!chart) return null;
        var sources = chart.model().model().dataSources();
        for (var i = 0; i < sources.length; i++) {
          var src = sources[i];
          if (!src.metaInfo) continue;
          var meta = src.metaInfo();
          if (!meta || !meta.pine) continue;
          if (meta.pine.pineId === ${JSON.stringify(pineId)}) {
            var inputDefs = meta.inputs || [];
            var inputs = {};
            if (src.properties) {
              var props = src.properties();
              var userInputs = props && props.userInputs ? props.userInputs : null;
              if (userInputs) {
                Object.keys(userInputs).forEach(function(k) {
                  inputs[k] = userInputs[k].value !== undefined ? userInputs[k].value : userInputs[k];
                });
              }
            }
            return JSON.stringify(inputs);
          }
        }
        return null;
      } catch(e) {
        return 'ERR:' + e.message;
      }
    })()
  `);
  if (!result || result.startsWith('ERR:') || result === 'null') return {};
  try { return JSON.parse(result); } catch { return {}; }
}

async function focusPane(client, paneIndex) {
  await runtimeEval(client, `
    (function() {
      var cwc = window.TradingViewApi._chartWidgetCollection;
      var chart = cwc.getAll()[${paneIndex}];
      if (chart && chart._mainDiv) chart._mainDiv.click();
    })()
  `);
  await sleep(600);
}

async function openCreateAlertDialog(client) {
  // Try button first
  const opened = await runtimeEval(client, `
    (function() {
      var btn = document.querySelector('[aria-label="Create Alert"]')
        || document.querySelector('[data-name="alerts"]');
      if (btn) { btn.click(); return true; }
      return false;
    })()
  `);
  if (!opened) {
    // Fall back to Alt+A keyboard shortcut
    await client.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 1, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
    await client.Input.dispatchKeyEvent({ type: 'keyUp', modifiers: 1, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
  }
  await sleep(1500);
}

async function clickCreateButton(client) {
  const clicked = await runtimeEval(client, `
    (function() {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var t = btns[i].textContent.trim();
        if (/^create$/i.test(t) || t === 'Create alert') {
          btns[i].click();
          return btns[i].textContent.trim();
        }
      }
      // Try submit button
      var sub = document.querySelector('button[data-name="submit"], button[type="submit"]');
      if (sub) { sub.click(); return sub.textContent.trim(); }
      return null;
    })()
  `);
  return clicked;
}

function buildCondition(pineId, inputs) {
  return {
    type: 'pine_alert',
    frequency: '60',
    series: [{
      type: 'study',
      study: 'Script@tv-scripting-101',
      pine_id: pineId,
      pine_version: '5.0',
      inputs: inputs,
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
  console.log(`Target: ${target.url}`);

  const client = await CDP({ host: 'localhost', port: 9222, target: target.id });
  await client.Runtime.enable();
  await client.Fetch.enable({ patterns: [{ urlPattern: '*create_alert*', requestStage: 'Request' }] });

  console.log('Fetch interception enabled.');

  let interceptResolve = null;
  let currentDef = null;

  client.Fetch.requestPaused(async ({ requestId, request }) => {
    // Skip preflight OPTIONS
    if (request.method === 'OPTIONS') {
      await client.Fetch.continueRequest({ requestId });
      return;
    }
    if (!request.url.includes('create_alert')) {
      await client.Fetch.continueRequest({ requestId });
      return;
    }

    console.log(`  Intercepted create_alert request for ${currentDef?.symbol}`);

    // Parse original body (TV sends raw JSON, not base64)
    let payload;
    try {
      payload = JSON.parse(request.postData || '{}');
    } catch {
      payload = { payload: {} };
    }

    // Replace conditions with SFP Screener pine_alert
    const condition = buildCondition(currentDef.pine_id, currentDef.inputs || {});
    if (!payload.payload) payload.payload = {};
    payload.payload.conditions = [condition];
    payload.payload.active = true;
    payload.payload.ignore_warnings = true;
    // Keep resolution at 5m
    payload.payload.resolution = '5';

    const newBodyStr = JSON.stringify(payload);
    const newBodyB64 = Buffer.from(newBodyStr).toString('base64');

    console.log(`  New condition: pine_id=${currentDef.pine_id}, inputs=${JSON.stringify(currentDef.inputs)}`);

    await client.Fetch.continueRequest({
      requestId,
      postData: newBodyB64,
    });

    if (interceptResolve) interceptResolve(true);
  });

  let created = 0;
  let failed = 0;

  for (let i = 0; i < ALERT_DEFS.length; i++) {
    const def = ALERT_DEFS[i];
    currentDef = def;

    console.log(`\n[${i + 1}/6] Creating alert for ${def.symbol} (pane ${def.pane})...`);

    // Read study inputs from the chart model
    console.log('  Reading study inputs...');
    def.inputs = await getStudyInputs(client, def.pane, def.pine_id);
    console.log(`  Inputs: ${JSON.stringify(def.inputs)}`);

    // Focus the pane
    await focusPane(client, def.pane);

    // Set up intercept promise
    const interceptPromise = new Promise(resolve => { interceptResolve = resolve; });

    // Open Create Alert dialog
    await openCreateAlertDialog(client);

    // Click Create
    const btnText = await clickCreateButton(client);
    if (!btnText) {
      console.log('  WARNING: Create button not found, closing dialog and skipping...');
      // Close dialog if open
      await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      failed++;
      continue;
    }
    console.log(`  Clicked: "${btnText}"`);

    // Wait for interception (max 10 seconds)
    const result = await Promise.race([
      interceptPromise,
      sleep(10000).then(() => false),
    ]);

    if (result) {
      console.log(`  OK: Alert request intercepted and modified.`);
      created++;
    } else {
      console.log(`  TIMEOUT: No intercept for ${def.symbol} within 10s`);
      failed++;
    }

    await sleep(1500);
  }

  await client.Fetch.disable();
  await client.close();

  console.log(`\nDone. Created: ${created}/6, Failed: ${failed}/6`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
