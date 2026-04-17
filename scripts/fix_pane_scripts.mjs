/**
 * Fixes Pine Scripts layout — removes Liquidity Sweep from all panes,
 * removes wrong SFP Screeners, adds correct ones via createStudy full ID.
 *
 * Target:
 *  Pane 0: BINGX:BTCUSDT   → SFP 1  (already correct — skip)
 *  Pane 1: BINANCE:SOLUSDT → SFP 3  (empty — add)
 *  Pane 2: TVC:USOIL       → SFP 5  (empty — add)
 *  Pane 3: BINGX:ETHUSDT   → SFP 2  (has Liq+SFP4 — remove both, add SFP 2)
 *  Pane 4: BINANCE:XRPUSDT → SFP 4  (has Liq+SFP5 — remove both, add SFP 4)
 *  Pane 5: SP:SPX           → SFP 6  (has Liq+SFP6 — remove only Liq)
 */
import CDP from 'chrome-remote-interface';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const STUDY_IDS = {
  sfp2: 'Script$USER;caad3eb9f4db4a489eaccb543d80706f@tv-scripting',
  sfp3: 'Script$USER;fb6adc6400cb4b77a07662d199fb803a@tv-scripting',
  sfp4: 'Script$USER;0b9735efd2344e5288862a3e959cdc19@tv-scripting',
  sfp5: 'Script$USER;a3320a47ff9a42a3b32b1a61bb88f0ab@tv-scripting',
  liq:  'Script$USER;a400ccd0491f47f6a58008ac69a17f76@tv-scripting',
};

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

async function getPaneStudies(client, paneIndex) {
  return eval_(client, `
    (function() {
      var cwc = window.TradingViewApi._chartWidgetCollection;
      var all = cwc.getAll();
      var sources = all[${paneIndex}].model().model().dataSources();
      var studies = [];
      sources.forEach(function(s) {
        if (!s.metaInfo) return;
        try {
          var m = s.metaInfo();
          var chartApi = window.TradingViewApi._activeChartWidgetWV.value();
          // We need entity IDs from getAllStudies
        } catch(e) {}
      });
      return JSON.stringify(studies);
    })()
  `);
}

async function focusPane(client, paneIndex) {
  await eval_(client, `
    (function() {
      var cwc = window.TradingViewApi._chartWidgetCollection;
      var all = cwc.getAll();
      if (all[${paneIndex}]._mainDiv) all[${paneIndex}]._mainDiv.click();
    })()
  `);
  await sleep(400);
}

async function getStudyEntities(client) {
  return eval_(client, `
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var studies = chart.getAllStudies();
      return JSON.stringify(studies.map(function(s) { return { id: s.id, name: s.name || s.title }; }));
    })()
  `);
}

async function removeStudy(client, entityId) {
  await eval_(client, `
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      chart.removeEntity('${entityId}');
    })()
  `);
  await sleep(300);
}

async function addStudyViaDialog(client, scriptName) {
  // Open indicators dialog, search, and click result
  await eval_(client, `
    (function() {
      var btn = document.querySelector('[data-name="open-indicators-dialog"]');
      if (btn) btn.click();
    })()
  `);
  await sleep(1000);

  // Type into search (use CDP Input events for reliability)
  // Clear first, then type
  await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'a', modifiers: 2, windowsVirtualKeyCode: 65 });
  await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', modifiers: 2 });
  await sleep(100);

  for (const char of scriptName) {
    await client.Input.dispatchKeyEvent({
      type: 'char',
      text: char,
    });
    await sleep(30);
  }
  await sleep(800);

  // Click first result
  const clicked = await eval_(client, `
    (function() {
      var items = Array.from(document.querySelectorAll('[class*="itemRow"], [class*="listItem"], [class*="item-"]'));
      var match = items.find(function(el) {
        return el.textContent.includes('${scriptName}') && el.offsetParent !== null;
      });
      if (match) { match.click(); return 'clicked: ' + match.textContent.trim().slice(0,50); }

      // Fallback: find any clickable element with the text
      var all = Array.from(document.querySelectorAll('[class*="title"], [class*="name"]'));
      var m2 = all.find(function(el) { return el.textContent.trim() === '${scriptName}'; });
      if (m2) {
        var parent = m2.closest('[class*="item"], [class*="row"], li');
        if (parent) { parent.click(); return 'clicked parent: ' + parent.textContent.slice(0,50); }
        m2.click(); return 'clicked title: ' + m2.textContent;
      }

      var allText = items.map(function(el) { return el.textContent.trim().slice(0,40); });
      return 'not found. items: ' + JSON.stringify(allText.slice(0,5));
    })()
  `);
  console.log('  Add result:', clicked);
  await sleep(800);

  // Close dialog
  await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 });
  await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape' });
  await sleep(500);
}

async function main() {
  const target = await findTarget();
  if (!target) throw new Error('TradingView not found');
  console.log('Connected to:', target.url);

  const client = await CDP({ host: 'localhost', port: 9222, target: target.id });
  await client.Runtime.enable();
  await client.Input.enable?.().catch(() => {});

  // Step 1: Remove Liquidity Sweep + wrong scripts from panes 3, 4, 5
  const paneOps = [
    { pane: 3, remove: ['Liquidity Sweep', 'SFP Screener 4'], add: 'SFP Screener 2 - Claude' },
    { pane: 4, remove: ['Liquidity Sweep', 'SFP Screener 5'], add: 'SFP Screener 4 - Claude' },
    { pane: 5, remove: ['Liquidity Sweep'], add: null },
    { pane: 1, remove: [], add: 'SFP Screener 3 - Claude' },
    { pane: 2, remove: [], add: 'SFP Screener 5 - Claude' },
  ];

  for (const op of paneOps) {
    console.log(`\nPane ${op.pane}: removing [${op.remove.join(', ')}]${op.add ? ', adding ' + op.add : ''}`);

    await focusPane(client, op.pane);

    const entitiesStr = await getStudyEntities(client);
    const entities = JSON.parse(entitiesStr || '[]');
    console.log('  Current entities:', entities.map(e => e.name).join(', ') || 'none');

    // Remove matching studies
    for (const entity of entities) {
      const shouldRemove = op.remove.some(function(r) {
        return entity.name && entity.name.includes(r);
      });
      if (shouldRemove) {
        console.log('  Removing:', entity.name, '(', entity.id, ')');
        await removeStudy(client, entity.id);
      }
    }

    await sleep(500);

    if (op.add) {
      await addStudyViaDialog(client, op.add);
      await sleep(500);

      // Verify
      await focusPane(client, op.pane);
      const afterStr = await getStudyEntities(client);
      const after = JSON.parse(afterStr || '[]');
      console.log('  After:', after.map(e => e.name).join(', ') || 'empty');
    }
  }

  // Final state
  console.log('\n--- Final State ---');
  for (let i = 0; i < 6; i++) {
    await focusPane(client, i);
    const str = await eval_(client, `
      (function() {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        var sym = chart.symbol();
        var studies = chart.getAllStudies().map(function(s) { return s.name || s.title; });
        return sym + ' | ' + (studies.join(', ') || 'EMPTY');
      })()
    `);
    console.log(`  Pane ${i}: ${str}`);
  }

  await client.close();
  console.log('\nDone.');
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
