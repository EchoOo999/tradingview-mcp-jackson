/**
 * Adds correct SFP Screener to each pane using pane-scoped indicators button.
 * Current state: panes 1-4 empty, pane 5 has wrong SFP2 (needs SFP6).
 */
import CDP from 'chrome-remote-interface';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function findTarget() {
  const resp = await fetch('http://localhost:9222/json/list');
  const targets = await resp.json();
  return targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    || targets.find(t => t.type === 'page' && /tradingview/i.test(t.url));
}

async function eval_(client, expr) {
  const res = await client.Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'eval error');
  return res.result?.value;
}

async function getStudyEntities(client, paneIndex) {
  return eval_(client, `
    (function() {
      var all = window.TradingViewApi._chartWidgetCollection.getAll();
      var chartWidget = all[${paneIndex}];
      if (chartWidget && chartWidget._mainDiv) chartWidget._mainDiv.click();
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var studies = chart.getAllStudies();
      return JSON.stringify(studies.map(function(s) { return { id: s.id, name: s.name || s.title }; }));
    })()
  `);
}

async function removeStudy(client, paneIndex, entityId) {
  await eval_(client, `
    (function() {
      var all = window.TradingViewApi._chartWidgetCollection.getAll();
      if (all[${paneIndex}] && all[${paneIndex}]._mainDiv) all[${paneIndex}]._mainDiv.click();
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      chart.removeEntity('${entityId}');
    })()
  `);
  await sleep(400);
}

async function addStudyToPane(client, paneIndex, scriptName) {
  // Open the indicators dialog scoped to THIS pane's button
  const opened = await eval_(client, `
    (function() {
      var all = window.TradingViewApi._chartWidgetCollection.getAll();
      var paneEl = all[${paneIndex}] && all[${paneIndex}]._mainDiv;
      if (!paneEl) return 'no pane element';
      // Click pane first to make it active
      paneEl.click();
      // Find the indicators button within this pane's element
      var btn = paneEl.querySelector('[data-name="open-indicators-dialog"]');
      if (btn) { btn.click(); return 'clicked pane btn'; }
      // Fallback: global indicators button
      var global = document.querySelector('[data-name="open-indicators-dialog"]');
      if (global) { global.click(); return 'clicked global btn'; }
      return 'no button found';
    })()
  `);
  console.log('  Dialog open:', opened);
  await sleep(1500);

  // Get search input coords within the dialog
  const searchCoords = await eval_(client, `
    (function() {
      var inputs = Array.from(document.querySelectorAll('input'));
      var vis = inputs.filter(function(i) { return i.offsetParent !== null; });
      // Prefer the search input (placeholder = "Search")
      var inp = vis.find(function(i) { return /search/i.test(i.placeholder); }) || vis[vis.length - 1];
      if (!inp) return null;
      var r = inp.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()
  `);

  if (!searchCoords) {
    console.log('  No search input. Closing.');
    await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 });
    await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape' });
    return false;
  }
  console.log('  Search input at', searchCoords);

  // Click search and type name
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: searchCoords.x, y: searchCoords.y, button: 'left', clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: searchCoords.x, y: searchCoords.y, button: 'left', clickCount: 1 });
  await sleep(150);
  await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'a', modifiers: 2, windowsVirtualKeyCode: 65 });
  await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', modifiers: 2 });
  await sleep(50);
  for (const char of scriptName) {
    await client.Input.dispatchKeyEvent({ type: 'char', text: char });
    await sleep(20);
  }
  await sleep(1200);

  // Find the result and get its coords
  const resultCoords = await eval_(client, `
    (function() {
      var name = '${scriptName}';
      var items = Array.from(document.querySelectorAll('[class*="itemRow"], [class*="listItem"], [class*="item-"]'));
      var match = items.find(function(el) {
        return el.textContent.trim().startsWith(name) && el.offsetParent !== null;
      });
      if (!match) {
        // broader search
        match = items.find(function(el) { return el.textContent.includes(name) && el.offsetParent !== null; });
      }
      if (!match) return null;
      var r = match.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: match.textContent.trim().slice(0, 60) };
    })()
  `);

  if (!resultCoords) {
    console.log('  Result not found for:', scriptName);
    await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 });
    await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape' });
    return false;
  }
  console.log('  Result at', resultCoords.x, resultCoords.y, ':', resultCoords.text.slice(0, 40));

  // Click result
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: resultCoords.x, y: resultCoords.y, button: 'left', clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: resultCoords.x, y: resultCoords.y, button: 'left', clickCount: 1 });
  await sleep(1000);

  // Close dialog
  await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 });
  await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape' });
  await sleep(600);
  return true;
}

async function main() {
  const target = await findTarget();
  if (!target) throw new Error('TradingView not found');
  console.log('Connected:', target.url);

  const client = await CDP({ host: 'localhost', port: 9222, target: target.id });
  await client.Runtime.enable();

  // Current state:
  //  Pane 1: ETHUSDT | EMPTY → needs SFP2
  //  Pane 2: XRPUSDT | EMPTY → needs SFP4
  //  Pane 3: SOLUSDT | EMPTY → needs SFP3
  //  Pane 4: USOIL   | EMPTY → needs SFP5
  //  Pane 5: SPX     | SFP2  → remove SFP2, add SFP6

  // Step 1: Remove wrong SFP2 from pane 5
  console.log('\nPane 5: removing wrong SFP2...');
  const p5Str = await getStudyEntities(client, 5);
  const p5Studies = JSON.parse(p5Str || '[]');
  for (const s of p5Studies) {
    if (s.name && s.name.includes('SFP Screener 2')) {
      console.log('  Removing:', s.name, '(', s.id, ')');
      await removeStudy(client, 5, s.id);
    }
  }

  // Step 2: Add correct scripts to panes 1-5
  const ops = [
    { pane: 1, add: 'SFP Screener 2 - Claude' },
    { pane: 2, add: 'SFP Screener 4 - Claude' },
    { pane: 3, add: 'SFP Screener 3 - Claude' },
    { pane: 4, add: 'SFP Screener 5 - Claude' },
    { pane: 5, add: 'SFP Screener 6 - Claude' },
  ];

  for (const op of ops) {
    console.log(`\nPane ${op.pane}: adding "${op.add}"`);
    await addStudyToPane(client, op.pane, op.add);
    await sleep(300);

    // Verify
    const afterStr = await getStudyEntities(client, op.pane);
    const after = JSON.parse(afterStr || '[]');
    const sfpStudies = after.filter(s => s.name && s.name.includes('SFP'));
    console.log('  After:', sfpStudies.map(s => s.name).join(', ') || 'EMPTY');
  }

  // Final state
  console.log('\n--- Final State ---');
  for (let i = 0; i < 6; i++) {
    const str = await eval_(client, `
      (function() {
        var all = window.TradingViewApi._chartWidgetCollection.getAll();
        if (all[${i}] && all[${i}]._mainDiv) all[${i}]._mainDiv.click();
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        var sym = chart.symbol();
        var studies = chart.getAllStudies().filter(function(s) { return s.name && s.name.includes('SFP'); }).map(function(s) { return s.name; });
        return sym + ' | ' + (studies.join(', ') || 'EMPTY');
      })()
    `);
    console.log('  Pane', i + ':', str);
  }

  await client.close();
  console.log('\nDone.');
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
