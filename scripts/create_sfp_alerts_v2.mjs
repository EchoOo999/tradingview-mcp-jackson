/**
 * Creates 6 SFP Screener pine_alert alerts via CDP Fetch interception.
 * Correct pane→symbol→pineId mapping for Pine Scripts layout.
 */
import CDP from 'chrome-remote-interface';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const ALERT_DEFS = [
  { pane: 0, pine_id: 'USER;d1409c5badd147b29c7576c2766de734', pine_version: '6.0', symbol: 'BINGX:BTCUSDT',
    inputs: {"__profile":false,"in_0":true,"in_1":"MEXC:IRYSUSDT.P","in_2":true,"in_3":"MEXC:LIGHTUSDT.P","in_4":true,"in_5":"MEXC:ARUSDT.P","in_6":true,"in_7":"MEXC:SKYUSDT.P","in_8":true,"in_9":"MEXC:BLUAIUSDT.P","in_10":20,"in_11":14,"in_12":12,"in_13":26,"in_14":9,"in_15":true,"in_16":"top_right","in_17":"small","in_18":true,"pineFeatures":"{\"indicator\":1,\"plot\":1,\"str\":1,\"ta\":1,\"math\":1,\"alert\":1,\"alertcondition\":1,\"table\":1,\"request.security\":1}"} },
  { pane: 1, pine_id: 'USER;fb6adc6400cb4b77a07662d199fb803a', pine_version: '4.0', symbol: 'BINANCE:SOLUSDT',
    inputs: {"__profile":false,"in_0":true,"in_1":"MEXC:ASTERUSDT.P","in_2":true,"in_3":"MEXC:HYPEUSDT.P","in_4":true,"in_5":"MEXC:UNIUSDT.P","in_6":true,"in_7":"MEXC:AXSUSDT.P","in_8":true,"in_9":"MEXC:VIRTUALUSDT.P","in_10":20,"in_11":14,"in_12":12,"in_13":26,"in_14":9,"in_15":true,"in_16":"top_right","in_17":"small","in_18":true,"pineFeatures":"{\"indicator\":1,\"plot\":1,\"str\":1,\"ta\":1,\"math\":1,\"alert\":1,\"alertcondition\":1,\"table\":1,\"request.security\":1}"} },
  { pane: 2, pine_id: 'USER;a3320a47ff9a42a3b32b1a61bb88f0ab', pine_version: '4.0', symbol: 'TVC:USOIL',
    inputs: {"__profile":false,"in_0":true,"in_1":"MEXC:CVXUSDT.P","in_2":true,"in_3":"MEXC:ENAUSDT.P","in_4":true,"in_5":"MEXC:LITUSDT.P","in_6":true,"in_7":"MEXC:KAVAUSDT.P","in_8":true,"in_9":"MEXC:CHZUSDT.P","in_10":20,"in_11":14,"in_12":12,"in_13":26,"in_14":9,"in_15":true,"in_16":"top_right","in_17":"small","in_18":true,"pineFeatures":"{\"indicator\":1,\"plot\":1,\"str\":1,\"ta\":1,\"math\":1,\"alert\":1,\"alertcondition\":1,\"table\":1,\"request.security\":1}"} },
  { pane: 3, pine_id: 'USER;caad3eb9f4db4a489eaccb543d80706f', pine_version: '3.0', symbol: 'BINGX:ETHUSDT',
    inputs: {"__profile":false,"in_0":true,"in_1":"MEXC:IRYSUSDT.P","in_2":true,"in_3":"MEXC:LIGHTUSDT.P","in_4":true,"in_5":"MEXC:ARUSDT.P","in_6":true,"in_7":"MEXC:SKYUSDT.P","in_8":true,"in_9":"MEXC:BLUAIUSDT.P","in_10":20,"in_11":14,"in_12":12,"in_13":26,"in_14":9,"in_15":true,"in_16":"top_right","in_17":"small","in_18":true,"pineFeatures":"{\"indicator\":1,\"plot\":1,\"str\":1,\"ta\":1,\"math\":1,\"alert\":1,\"alertcondition\":1,\"table\":1,\"request.security\":1}"} },
  { pane: 4, pine_id: 'USER;0b9735efd2344e5288862a3e959cdc19', pine_version: '4.0', symbol: 'BINANCE:XRPUSDT',
    inputs: {"__profile":false,"in_0":true,"in_1":"MEXC:QNTUSDT.P","in_2":true,"in_3":"MEXC:SIRENUSDT.P","in_4":true,"in_5":"MEXC:STXUSDT.P","in_6":true,"in_7":"MEXC:SAHARAUSDT.P","in_8":false,"in_9":"MEXC:BTCUSDT.P","in_10":20,"in_11":14,"in_12":12,"in_13":26,"in_14":9,"in_15":true,"in_16":"top_right","in_17":"small","in_18":true,"pineFeatures":"{\"indicator\":1,\"plot\":1,\"str\":1,\"ta\":1,\"math\":1,\"alert\":1,\"alertcondition\":1,\"table\":1,\"request.security\":1}"} },
  { pane: 5, pine_id: 'USER;19b6d50438f84eb8b65147a205365c3e', pine_version: '5.0', symbol: 'SP:SPX',
    inputs: {"__profile":false,"in_0":true,"in_1":"MEXC:IRYSUSDT.P","in_2":true,"in_3":"MEXC:LIGHTUSDT.P","in_4":true,"in_5":"MEXC:ARUSDT.P","in_6":true,"in_7":"MEXC:SKYUSDT.P","in_8":true,"in_9":"MEXC:BLUAIUSDT.P","in_10":20,"in_11":14,"in_12":12,"in_13":26,"in_14":9,"in_15":true,"in_16":"top_right","in_17":"small","in_18":true,"pineFeatures":"{\"indicator\":1,\"plot\":1,\"str\":1,\"ta\":1,\"math\":1,\"alert\":1,\"alertcondition\":1,\"table\":1,\"request.security\":1}"} },
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

async function focusPane(client, paneIndex) {
  await runtimeEval(client, `
    (function() {
      var cwc = window.TradingViewApi._chartWidgetCollection;
      var chart = cwc.getAll()[${paneIndex}];
      if (chart && chart._mainDiv) chart._mainDiv.click();
    })()
  `);
  await sleep(700);
}

async function openCreateAlertDialog(client) {
  // Close any open dialog first
  await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(400);

  // Click the header toolbar "Create alert" button (aria-label lowercase, text="Alert")
  await runtimeEval(client, `
    (function() {
      var btns = Array.from(document.querySelectorAll('button'));
      // Find the toolbar Alert button (has text "Alert" and aria-label "Create alert")
      var btn = btns.find(function(b) {
        return b.getAttribute('aria-label') === 'Create alert' && b.textContent.trim() === 'Alert' && b.offsetParent !== null;
      });
      // Fallback: any visible "Create alert" button
      if (!btn) btn = btns.find(function(b) { return b.getAttribute('aria-label') === 'Create alert' && b.offsetParent !== null; });
      if (btn) btn.click();
    })()
  `);
  await sleep(2000);
}

async function clickCreateButton(client) {
  const clicked = await runtimeEval(client, `
    (function() {
      var btns = Array.from(document.querySelectorAll('button'));
      for (var i = 0; i < btns.length; i++) {
        var t = btns[i].textContent.trim();
        if (/^create$/i.test(t) || t === 'Create alert') {
          btns[i].click();
          return btns[i].textContent.trim();
        }
      }
      var sub = document.querySelector('button[data-name="submit"], button[type="submit"]');
      if (sub) { sub.click(); return sub.textContent.trim(); }
      return null;
    })()
  `);
  return clicked;
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
  if (!target) throw new Error('No TradingView chart target found.');
  console.log(`Target: ${target.url}`);

  const client = await CDP({ host: 'localhost', port: 9222, target: target.id });
  await client.Runtime.enable();
  await client.Fetch.enable({ patterns: [{ urlPattern: '*create_alert*', requestStage: 'Request' }] });

  console.log('Fetch interception enabled.');

  let interceptResolve = null;
  let currentDef = null;

  client.Fetch.requestPaused(async ({ requestId, request }) => {
    if (request.method === 'OPTIONS') {
      await client.Fetch.continueRequest({ requestId });
      return;
    }
    if (!request.url.includes('create_alert')) {
      await client.Fetch.continueRequest({ requestId });
      return;
    }

    console.log(`  Intercepted create_alert for ${currentDef?.symbol}`);

    let payload;
    try { payload = JSON.parse(request.postData || '{}'); } catch { payload = { payload: {} }; }

    const condition = buildCondition(currentDef);
    if (!payload.payload) payload.payload = {};
    payload.payload.conditions = [condition];
    payload.payload.symbol = currentDef.symbol;
    payload.payload.resolution = '5';
    payload.payload.active = true;
    payload.payload.ignore_warnings = true;

    const newBodyB64 = Buffer.from(JSON.stringify(payload)).toString('base64');
    console.log(`  New condition: pine_id=${currentDef.pine_id}`);

    await client.Fetch.continueRequest({ requestId, postData: newBodyB64 });
    if (interceptResolve) interceptResolve(true);
  });

  let created = 0;
  let failed = 0;

  for (let i = 0; i < ALERT_DEFS.length; i++) {
    const def = ALERT_DEFS[i];
    currentDef = def;

    console.log(`\n[${i + 1}/6] Creating alert for ${def.symbol} (pane ${def.pane})...`);

    await focusPane(client, def.pane);

    const interceptPromise = new Promise(resolve => { interceptResolve = resolve; });

    await openCreateAlertDialog(client);

    const btnText = await clickCreateButton(client);
    if (!btnText) {
      console.log('  WARNING: Create button not found. Closing dialog...');
      await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      failed++;
      continue;
    }
    console.log(`  Clicked: "${btnText}"`);

    const result = await Promise.race([
      interceptPromise,
      sleep(12000).then(() => false),
    ]);

    if (result) {
      console.log(`  OK: Alert created for ${def.symbol}`);
      created++;
    } else {
      console.log(`  TIMEOUT: No intercept for ${def.symbol} within 12s`);
      failed++;
    }

    await sleep(2000);
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
