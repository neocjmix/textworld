// Native Chromium edit ranges plus explicit late-event regressions. CDP and
// synthetic boundary cases do not replace real OS keyboard acceptance tests.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createTextworld } from '../server/index.js';

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
});
const results = [];
const sessions = new WeakMap();

async function nativeSession(page) {
  if (!sessions.has(page)) sessions.set(page, await page.context().newCDPSession(page));
  return sessions.get(page);
}

async function nativeText(page) {
  return page.locator('#input').textContent();
}

async function scenario(name, run) {
  const app = createTextworld({ storagePath: ':memory:' });
  const address = await app.listen(0, '127.0.0.1');
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`http://127.0.0.1:${address.port}/#x=7&y=8`);
    await page.waitForFunction(() => {
      const state = window.textworld?.inspect();
      return state?.connected && state.peers[0]?.x === 7 && state.peers[0]?.y === 8;
    });
    await run({ app, page });
    await page.waitForFunction(() => {
      const state = window.textworld.inspect();
      return !state.motionActive && !state.cameraActive;
    });
    const state = await page.evaluate(() => window.textworld.inspect());
    for (const [axis, extent, span] of [['x', state.world.width, state.viewport.cols], ['y', state.world.height, state.viewport.rows]]) {
      const distance = state.camera[axis] + span / 2 - state.cursor[axis] - 0.5;
      const wrapped = ((distance + extent / 2) % extent + extent) % extent - extent / 2;
      assert.ok(Math.abs(wrapped) < 1e-6, `${axis} native input cursor must return to center after motion settles`);
    }
    results.push(name);
    console.log(`PASS ${name}`);
  } finally {
    await context.close();
    await app.close();
  }
}

async function beginComposition(page, text = '한', replacement = {}) {
  await page.evaluate(({ text, replacement }) => {
    const input = document.getElementById('input');
    input.focus();
    const selection = getSelection();
    const before = document.createRange();
    before.selectNodeContents(input);
    before.setEnd(selection.anchorNode, selection.anchorOffset);
    const start = replacement.replacementStart ?? before.toString().length;
    window.regressionCompositionRange = { start, end: start + text.length };
  }, { text, replacement });
  await (await nativeSession(page)).send('Input.imeSetComposition', {
    text, selectionStart: text.length, selectionEnd: text.length, ...replacement,
  });
}

async function finishComposition(page, text = '한') {
  await (await nativeSession(page)).send('Input.insertText', { text });
  await page.waitForFunction(() => window.textworld.inspect().pending === 0);
}

async function finishInvalidatedComposition(page, text = '한') {
  // Navigation invalidates the world mapping while the IME still owns this DOM
  // range. Deliver its late replacement/end explicitly. A fresh CDP insertText
  // after the range has ended would represent a legitimate new user insertion.
  await page.evaluate(text => {
    const input = document.getElementById('input');
    const { start, end } = window.regressionCompositionRange;
    const pointAt = offset => {
      const walker = document.createTreeWalker(input, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (offset <= node.length) return { node, offset };
        offset -= node.length;
      }
      if (offset === 0) return { node: input, offset: input.childNodes.length };
      throw new Error('The invalidated native composition range was rewritten');
    };
    const first = pointAt(start), last = pointAt(end);
    const target = new StaticRange({
      startContainer: first.node, startOffset: first.offset,
      endContainer: last.node, endOffset: last.offset,
    });
    input.dispatchEvent(new InputEvent('beforeinput', {
      data: text, inputType: 'insertCompositionText', isComposing: true,
      bubbles: true, cancelable: false, targetRanges: [target],
    }));
    const range = document.createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset);
    range.deleteContents();
    const inserted = document.createTextNode(text);
    range.insertNode(inserted);
    getSelection().setBaseAndExtent(inserted, text.length, inserted, text.length);
    input.dispatchEvent(new InputEvent('input', {
      data: text, inputType: 'insertCompositionText', isComposing: true, bubbles: true,
    }));
    input.dispatchEvent(new CompositionEvent('compositionend', { data: text }));
    // A final result notification carries no new target range or DOM change.
    input.dispatchEvent(new InputEvent('input', {
      data: text, inputType: 'insertText', isComposing: false, bubbles: true,
    }));
  }, text);
  await page.waitForFunction(() => !window.textworld.inspect().composing && window.textworld.inspect().pending === 0);
}

async function densitySnapshot(app, page, { width = 64, height = 32 } = {}) {
  const resize = app.world.resize(width, height, undefined, { seed:42 });
  await page.waitForFunction(epoch => window.textworld.inspect().world.epoch === epoch, app.world.epoch);
  return {resize,state:await page.evaluate(()=>window.textworld.inspect())};
}

try {
  await scenario('native composition commits exactly once despite a repeated final result', async ({ app, page }) => {
    await beginComposition(page);
    assert.equal(app.world.snapshot().cells.length, 0, 'uncommitted composition must stay local');
    await finishComposition(page);
    await page.evaluate(() => document.getElementById('input').dispatchEvent(new InputEvent('input', {
      data: '한', inputType: 'insertText', isComposing: false, bubbles: true,
    })));
    await page.waitForFunction(() => window.textworld.inspect().pending === 0);
    assert.equal(app.world.seq, 1);
    assert.deepEqual(app.world.snapshot().cells.filter(cell => cell.text).map(({ x, y, text }) => ({ x, y, text })),
      [{ x: 7, y: 8, text: '한' }]);
    assert.deepEqual(await page.evaluate(() => window.textworld.inspect().cursor), { x: 9, y: 8 });
  });

  await scenario('snapshot invalidates stale composition without rewriting its native DOM', async ({ app, page }) => {
    await beginComposition(page);
    const { peers } = await page.evaluate(() => window.textworld.inspect());
    for (const socket of app.wss.clients) socket.send(JSON.stringify({
      type: 'snapshot', ...app.world.snapshot(), selfId: peers[0].id, peers,
      reason: 'regression-sync',
    }));
    await page.waitForFunction(() => window.textworld.inspect().preedit === '');
    assert.equal(await nativeText(page), '한', 'the native IME owns its DOM until compositionend');
    await finishInvalidatedComposition(page);
    assert.equal(await nativeText(page), '');
    assert.equal(app.world.seq, 0, 'stale completion must not become a new write');
    assert.equal(app.world.snapshot().cells.length, 0);
    assert.deepEqual(await page.evaluate(() => window.textworld.inspect().cursor), { x: 7, y: 8 });
  });

  await scenario('navigation cancels composition instead of writing at the new location', async ({ app, page }) => {
    await beginComposition(page);
    await page.evaluate(() => { location.hash = 'x=20&y=12'; });
    await page.waitForFunction(() => window.textworld.inspect().cursor.x === 20);
    assert.equal(await nativeText(page), '한');
    await finishInvalidatedComposition(page);
    assert.equal(app.world.snapshot().cells.length, 0);
    assert.equal(app.world.seq, 0);
    assert.deepEqual(await page.evaluate(() => window.textworld.inspect().cursor), { x:20,y:12 });
  });

  await scenario('map panning cancels composition before a late completion', async ({ app, page }) => {
    await beginComposition(page);
    await page.evaluate(() => {
      const canvas = document.getElementById('field');
      const state = window.textworld.inspect();
      const width = canvas.getBoundingClientRect().width / state.viewport.cols;
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaX: width * 2, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => window.textworld.inspect().cursor.x === 9);
    await page.evaluate(() => document.getElementById('input').dispatchEvent(
      new CompositionEvent('compositionupdate', { data: '하' }),
    ));
    assert.equal(await page.evaluate(() => window.textworld.inspect().preedit), '', 'cancelled preedit must not reappear');
    assert.equal(await nativeText(page), '한');
    await finishInvalidatedComposition(page);
    assert.equal(app.world.snapshot().cells.length, 0);
    assert.equal(app.world.seq, 0);
    assert.deepEqual(await page.evaluate(() => window.textworld.inspect().cursor), { x: 9, y: 8 });
  });

  await scenario('native beforeinput deletion commits once and retains the surrounding context', async ({ app, page }) => {
    await page.locator('#input').focus();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'input');
    await page.keyboard.insertText('AB');
    await page.waitForFunction(() => window.textworld.inspect().cells.length === 2 && window.textworld.inspect().pending === 0);
    assert.equal(await nativeText(page), 'AB', 'native text context must survive normal commits for Korean replacement');
    await page.evaluate(() => {
      window.regressionDeletionEvents = [];
      const input = document.getElementById('input');
      for (const type of ['beforeinput', 'input']) input.addEventListener(type, event => {
        if (event.inputType !== 'deleteContentBackward') return;
        const range = event.getTargetRanges()[0];
        window.regressionDeletionEvents.push({
          type, text: input.textContent,
          range: range ? [range.startOffset, range.endOffset] : null,
        });
      });
    });
    await page.keyboard.press('Backspace');
    await page.waitForFunction(() => window.textworld.inspect().cells.length === 1 && window.textworld.inspect().pending === 0);
    assert.equal(app.world.seq, 2);
    assert.equal(app.world.getCell(7, 8).text, 'A');
    assert.equal(app.world.getCell(8, 8).text, '');
    assert.equal(await nativeText(page), 'A');
    assert.deepEqual(await page.evaluate(() => window.regressionDeletionEvents), [
      { type: 'beforeinput', text: 'AB', range: [1, 2] },
      { type: 'input', text: 'A', range: null },
    ]);
    assert.deepEqual(await page.evaluate(() => window.textworld.inspect().cursor), { x: 8, y: 8 });
  });

  await scenario('Scattered resize invalidates old native ranges and allows new Korean input', async ({ app, page }) => {
    const cdp = await nativeSession(page);
    await cdp.send('Input.insertText', { text: 'ㅎ' });
    await page.waitForFunction(() => window.textworld.inspect().pending === 0);
    const {state}=await densitySnapshot(app,page);
    assert.equal(await nativeText(page),'');
    await cdp.send('Input.insertText',{text:'한'});
    await page.waitForFunction(()=>window.textworld.inspect().pending===0);
    assert.equal(app.world.getCell(state.cursor.x,state.cursor.y)?.text,'한');
  });
  await scenario('Active composition is cancelled safely when scattered resize changes its addresses', async ({ app,page })=>{
    const cdp=await nativeSession(page);await cdp.send('Input.insertText',{text:'ㅎ'});
    await page.waitForFunction(()=>window.textworld.inspect().pending===0);
    await beginComposition(page,'하',{replacementStart:0,replacementEnd:1});
    await densitySnapshot(app,page);const seq=app.world.seq;
    assert.equal(await page.evaluate(()=>window.textworld.inspect().preedit),'');
    await finishInvalidatedComposition(page);
    assert.equal(app.world.seq,seq);
  });

  await scenario('A density snapshot with an uncertain write still cancels composition', async ({ app, page }) => {
    // Hold both acceptance notifications: a cells broadcast now confirms a
    // local edit before its ack. The server accepts it, but the browser cannot
    // know the result yet when the density snapshot arrives.
    for (const socket of app.wss.clients) {
      const send = socket.send.bind(socket);
      socket.send = (data, ...args) => {
        if (!['ack', 'cells'].includes(JSON.parse(String(data)).type)) send(data, ...args);
      };
    }
    const cdp = await nativeSession(page);
    await cdp.send('Input.insertText', { text: 'A' });
    await page.waitForFunction(() => window.textworld.inspect().pending === 1);
    await beginComposition(page);
    await densitySnapshot(app, page);
    const seq = app.world.seq;
    assert.equal(await nativeText(page), 'A한', 'uncertain recovery must preserve active native DOM until its end');
    assert.equal(await page.evaluate(() => window.textworld.inspect().preedit), '');
    await finishInvalidatedComposition(page);
    assert.equal(app.world.seq, seq, 'late composition must not become an edit after uncertain recovery');
    assert.equal(app.world.snapshot().cells.filter(c=>c.text==='A').length,1);
  });

  await scenario('A density snapshot that changes the cursor cancels the old composition range', async ({ app, page }) => {
    await beginComposition(page);
    const {state:relocated}=await densitySnapshot(app, page);
    const seq = app.world.seq;
    assert.equal(await nativeText(page), '한');
    await finishInvalidatedComposition(page);
    assert.equal(app.world.seq, seq);
    assert.equal(app.world.snapshot().cells.length, 0);
    assert.deepEqual(await page.evaluate(() => window.textworld.inspect().cursor), relocated.cursor);
  });

  await scenario('An expansion that breaks a wrapped writing step cancels its native replacement range', async ({ app, page }) => {
    await page.evaluate(() => { location.hash = 'x=126&y=8'; });
    await page.waitForFunction(() => window.textworld.inspect().cursor.x === 126);
    const cdp = await nativeSession(page);
    await cdp.send('Input.insertText', { text: 'ㅎ' });
    await page.waitForFunction(() => window.textworld.inspect().pending === 0);
    assert.deepEqual(await page.evaluate(() => window.textworld.inspect().cursor), { x: 0, y: 8 });
    await beginComposition(page, '하', { replacementStart: 0, replacementEnd: 1 });
    // All old coordinates still exist, but 126 + two columns no longer reaches
    // 0 after expansion. Address preservation alone cannot preserve this range.
    const {state:remapped}=await densitySnapshot(app, page, { width: 256, height: 128 });
    const seq = app.world.seq;
    assert.equal(await nativeText(page), '하', 'a broken world path must not rewrite the active native range');
    assert.equal(await page.evaluate(() => window.textworld.inspect().preedit), '');
    await finishInvalidatedComposition(page);
    assert.equal(app.world.seq, seq);
    assert.equal(app.world.snapshot().cells.filter(c=>c.text==='ㅎ').length,1);
    assert.deepEqual(await page.evaluate(() => window.textworld.inspect().cursor), remapped.cursor);
  });
  await scenario('Selecting the current world address resets both native context and its spatial mapping', async ({ app, page }) => {
    await page.keyboard.insertText('ABC');
    await page.waitForFunction(() => window.textworld.inspect().pending === 0);
    assert.equal(await nativeText(page), 'ABC');
    assert.deepEqual(await page.evaluate(() => window.textworld.inspect().cursor), { x: 10, y: 8 });
    await page.evaluate(() => new Promise(resolve => {
      addEventListener('hashchange', () => requestAnimationFrame(resolve), { once: true });
      location.hash = 'x=10&y=8';
    }));
    assert.equal(await nativeText(page), '', 'same-address navigation must reset the DOM and ledger together');
    await page.keyboard.insertText('D');
    await page.waitForFunction(() => window.textworld.inspect().pending === 0);
    assert.equal(app.world.getCell(10, 8)?.text, 'D');
    assert.equal(app.world.getCell(9, 8)?.text, 'C');
    assert.deepEqual(await page.evaluate(() => window.textworld.inspect().cursor), { x: 11, y: 8 });
  });

  await scenario('Unsupported word and page navigation cannot move a hidden native caret away from the world cursor', async ({ app, page }) => {
    await page.keyboard.insertText('ABC');
    await page.waitForFunction(() => window.textworld.inspect().pending === 0);
    const seq = app.world.seq;
    const selected = () => page.evaluate(() => {
      const selection = getSelection(), input = document.getElementById('input');
      const range = document.createRange(); range.selectNodeContents(input);
      range.setEnd(selection.focusNode, selection.focusOffset);
      return { offset: range.toString().length, cursor: window.textworld.inspect().cursor };
    });
    for (const key of ['Control+ArrowLeft', 'Control+ArrowRight', 'Control+ArrowUp', 'Control+ArrowDown',
      'Control+Home', 'Control+End', 'Alt+ArrowLeft', 'Alt+ArrowRight', 'Meta+ArrowLeft', 'Meta+ArrowRight',
      'Control+PageUp', 'Control+PageDown', 'PageUp', 'PageDown']) {
      await page.keyboard.press(key);
      assert.deepEqual(await selected(), { offset: 3, cursor: { x: 10, y: 8 } }, `${key} changed only the hidden caret`);
      assert.equal(app.world.seq, seq, `${key} must not edit cells`);
    }
    await page.keyboard.insertText('D');
    await page.waitForFunction(() => window.textworld.inspect().pending === 0);
    assert.equal(app.world.getCell(10, 8)?.text, 'D');
    assert.deepEqual(await page.evaluate(() => window.textworld.inspect().cursor), { x: 11, y: 8 });
  });
  console.log(JSON.stringify({ passed: results.length, coverage: 'native Chromium Korean ranges, density-resize snapshots, explicit late-event variants, context resets and visible navigation', results }));
} finally {
  await browser.close();
}
