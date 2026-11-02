// Browser event-order regressions. These synthetic events do not substitute for
// a real Korean IME or Android/iOS keyboard acceptance test.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createTextworld } from '../server/index.js';

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
});
const results = [];

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
    const state = await page.evaluate(() => window.textworld.inspect());
    for (const [axis, extent, span] of [['x', state.world.width, state.viewport.cols], ['y', state.world.height, state.viewport.rows]]) {
      const distance = state.camera[axis] + span / 2 - state.cursor[axis] - 0.5;
      const wrapped = ((distance + extent / 2) % extent + extent) % extent - extent / 2;
      assert.ok(Math.abs(wrapped) < 1e-6, `${axis} native input cursor must remain centered`);
    }
    results.push(name);
    console.log(`PASS ${name}`);
  } finally {
    await context.close();
    await app.close();
  }
}

async function beginComposition(page, text = '한') {
  await page.evaluate(text => {
    const input = document.getElementById('input');
    input.focus();
    input.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    input.value = text;
    input.dispatchEvent(new InputEvent('input', {
      data: text, inputType: 'insertCompositionText', isComposing: true,
    }));
  }, text);
}

async function finishWithCompanionInput(page, text = '한') {
  // One task reflects the browser order compositionend → final input. The
  // companion event deliberately restores value, detecting duplicate replay.
  await page.evaluate(text => {
    const input = document.getElementById('input');
    input.dispatchEvent(new CompositionEvent('compositionend', { data: text }));
    input.value = text;
    input.dispatchEvent(new InputEvent('input', {
      data: text, inputType: 'insertFromComposition', isComposing: false,
    }));
  }, text);
  await page.waitForTimeout(100);
}

async function densitySnapshot(app, page, { moveTo, width = 64, height = 32 } = {}) {
  const state = await page.evaluate(() => window.textworld.inspect());
  const peers = state.peers.map(peer => ({ ...peer }));
  if (moveTo) Object.assign(peers[0], moveTo);
  const resize = app.world.resize(width, height, peers);
  for (const socket of app.wss.clients) socket.send(JSON.stringify({
    type: 'snapshot', ...app.world.snapshot(), selfId: peers[0].id, peers,
    reason: 'density-resize', resize,
  }));
  await page.waitForFunction(epoch => window.textworld.inspect().world.epoch === epoch, app.world.epoch);
}

try {
  await scenario('composition commits exactly once despite companion input', async ({ app, page }) => {
    await beginComposition(page);
    assert.equal(app.world.snapshot().cells.length, 0, 'uncommitted composition must stay local');
    await finishWithCompanionInput(page);
    assert.equal(app.world.seq, 1);
    assert.deepEqual(app.world.snapshot().cells.filter(cell => cell.text).map(({ x, y, text }) => ({ x, y, text })),
      [{ x: 7, y: 8, text: '한' }]);
    assert.deepEqual(await page.evaluate(() => window.textworld.inspect().cursor), { x: 9, y: 8 });
  });

  await scenario('snapshot cancels stale composition and suppresses companion input', async ({ app, page }) => {
    await beginComposition(page);
    const { peers } = await page.evaluate(() => window.textworld.inspect());
    for (const socket of app.wss.clients) socket.send(JSON.stringify({
      type: 'snapshot', ...app.world.snapshot(), selfId: peers[0].id, peers,
      reason: 'regression-sync',
    }));
    await page.waitForFunction(() => document.getElementById('input').value === '');
    await finishWithCompanionInput(page);
    assert.equal(app.world.seq, 0, 'stale completion must not become a new write');
    assert.equal(app.world.snapshot().cells.length, 0);
    assert.deepEqual(await page.evaluate(() => window.textworld.inspect().cursor), { x: 7, y: 8 });
  });

  await scenario('navigation cancels composition instead of writing at the new location', async ({ app, page }) => {
    await beginComposition(page);
    await page.evaluate(() => { location.hash = 'x=20&y=12'; });
    await page.waitForFunction(() => window.textworld.inspect().cursor.x === 20);
    await finishWithCompanionInput(page);
    assert.equal(app.world.snapshot().cells.length, 0);
    assert.equal(app.world.seq, 0);
    assert.deepEqual(await page.evaluate(() => window.textworld.inspect().cursor), { x: 20, y: 12 });
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
    await finishWithCompanionInput(page);
    assert.equal(app.world.snapshot().cells.length, 0);
    assert.equal(app.world.seq, 0);
    assert.deepEqual(await page.evaluate(() => window.textworld.inspect().cursor), { x: 9, y: 8 });
  });

  await scenario('retained native context does not duplicate a beforeinput deletion', async ({ app, page }) => {
    await page.mouse.click(400, 300);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'input');
    await page.keyboard.insertText('AB');
    await page.waitForFunction(() => window.textworld.inspect().cells.length === 2 && window.textworld.inspect().pending === 0);
    assert.equal(await page.locator('#input').inputValue(), 'AB', 'native text context must survive normal commits for Korean replacement');
    const accepted = await page.evaluate(() => document.getElementById('input').dispatchEvent(
      new InputEvent('beforeinput', {
        inputType: 'deleteContentBackward', bubbles: true, cancelable: true,
      }),
    ));
    assert.equal(accepted, false, 'default deletion must be prevented to avoid a second input event');
    await page.waitForFunction(() => window.textworld.inspect().cells.length === 1 && window.textworld.inspect().pending === 0);
    assert.equal(app.world.seq, 2);
    assert.equal(app.world.getCell(7, 8).text, 'A');
    assert.equal(app.world.getCell(8, 8).text, '');
    assert.deepEqual(await page.evaluate(() => window.textworld.inspect().cursor), { x: 8, y: 8 });
  });

  await scenario('A density resize at unchanged coordinates retains native Korean replacement context', async ({ app, page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.insertText', { text: 'ㅎ' });
    await page.waitForFunction(() => window.textworld.inspect().pending === 0);
    assert.equal(await page.locator('#input').inputValue(), 'ㅎ');
    await densitySnapshot(app, page);
    assert.equal(await page.locator('#input').inputValue(), 'ㅎ', 'safe density change must not erase the native replacement range');
    await cdp.send('Input.imeSetComposition', { text: '하', selectionStart: 1, selectionEnd: 1, replacementStart: 0, replacementEnd: 1 });
    await cdp.send('Input.insertText', { text: '한' });
    await page.waitForFunction(() => window.textworld.inspect().pending === 0);
    assert.equal(app.world.getCell(7, 8)?.text, '한');
    assert.equal(app.world.getCell(9, 8)?.text || '', '');
    assert.deepEqual(await page.evaluate(() => window.textworld.inspect().cursor), { x: 9, y: 8 });
  });

  await scenario('An active Korean composition survives a density resize that preserves its addresses', async ({ app, page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.insertText', { text: 'ㅎ' });
    await page.waitForFunction(() => window.textworld.inspect().pending === 0);
    await cdp.send('Input.imeSetComposition', { text: '하', selectionStart: 1, selectionEnd: 1, replacementStart: 0, replacementEnd: 1 });
    const seq = app.world.seq;
    await densitySnapshot(app, page);
    assert.equal(await page.locator('#input').inputValue(), '하');
    assert.equal(await page.evaluate(() => window.textworld.inspect().preedit), '하');
    assert.equal(app.world.seq, seq + 1, 'only the resize has been committed');
    await cdp.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.insertText', { text: '한' });
    await page.waitForFunction(() => window.textworld.inspect().pending === 0);
    assert.equal(app.world.getCell(7, 8)?.text, '한');
    assert.equal(app.world.getCell(9, 8)?.text || '', '');
    assert.equal(await page.evaluate(() => window.textworld.inspect().composing), false);
  });

  await scenario('A density snapshot with an uncertain write still cancels composition', async ({ app, page }) => {
    // Hold only acknowledgements: the browser really has an outstanding edit
    // while the server has accepted it. This exercises the uncertain-result boundary.
    for (const socket of app.wss.clients) {
      const send = socket.send.bind(socket);
      socket.send = (data, ...args) => {
        if (JSON.parse(String(data)).type !== 'ack') send(data, ...args);
      };
    }
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.insertText', { text: 'A' });
    await page.waitForFunction(() => window.textworld.inspect().pending === 1);
    await cdp.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
    await densitySnapshot(app, page);
    const seq = app.world.seq;
    assert.equal(await page.locator('#input').inputValue(), '');
    // Reset has ended Chromium's native range. A new CDP insertText would be
    // a fresh user insertion, so explicitly deliver the old range's late events.
    await finishWithCompanionInput(page);
    assert.equal(app.world.seq, seq, 'late composition must not become an edit after uncertain recovery');
    assert.equal(app.world.getCell(7, 8)?.text, 'A');
    assert.equal(app.world.getCell(8, 8)?.text || '', '');
  });

  await scenario('A density snapshot that changes the cursor cancels the old composition range', async ({ app, page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
    await densitySnapshot(app, page, { moveTo: { x: 20, y: 12 } });
    const seq = app.world.seq;
    await finishWithCompanionInput(page);
    assert.equal(app.world.seq, seq);
    assert.equal(app.world.snapshot().cells.length, 0);
    assert.deepEqual(await page.evaluate(() => window.textworld.inspect().cursor), { x: 20, y: 12 });
  });

  await scenario('An expansion that breaks a wrapped writing step cancels its native replacement range', async ({ app, page }) => {
    await page.evaluate(() => { location.hash = 'x=126&y=8'; });
    await page.waitForFunction(() => window.textworld.inspect().cursor.x === 126);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.insertText', { text: 'ㅎ' });
    await page.waitForFunction(() => window.textworld.inspect().pending === 0);
    assert.deepEqual(await page.evaluate(() => window.textworld.inspect().cursor), { x: 0, y: 8 });
    await cdp.send('Input.imeSetComposition', { text: '하', selectionStart: 1, selectionEnd: 1, replacementStart: 0, replacementEnd: 1 });
    // All old coordinates still exist, but 126 + two columns no longer reaches
    // 0 after expansion. Address preservation alone cannot preserve this range.
    await densitySnapshot(app, page, { width: 256, height: 128 });
    const seq = app.world.seq;
    assert.equal(await page.locator('#input').inputValue(), '');
    assert.equal(await page.evaluate(() => window.textworld.inspect().composing), false);
    await finishWithCompanionInput(page);
    assert.equal(app.world.seq, seq);
    assert.equal(app.world.getCell(126, 8)?.text, 'ㅎ');
    assert.equal(app.world.getCell(0, 8)?.text || '', '');
    assert.deepEqual(await page.evaluate(() => window.textworld.inspect().cursor), { x: 0, y: 8 });
  });
  console.log(JSON.stringify({ passed: results.length, coverage: 'native Chromium Korean ranges, density-resize snapshots, explicit late-event variants and retained-context deletion', results }));
} finally {
  await browser.close();
}
