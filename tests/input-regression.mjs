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

try {
  await scenario('composition commits exactly once despite companion input', async ({ app, page }) => {
    await beginComposition(page);
    assert.equal(app.world.snapshot().cells.length, 0, 'uncommitted composition must stay local');
    await finishWithCompanionInput(page);
    assert.equal(app.world.seq, 1);
    assert.deepEqual(app.world.snapshot().cells.map(({ x, y, text }) => ({ x, y, text })),
      [{ x: 7, y: 8, text: '한' }]);
    assert.deepEqual(await page.evaluate(() => window.textworld.inspect().cursor), { x: 8, y: 8 });
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

  await scenario('empty-textarea beforeinput deletion erases exactly one world cell', async ({ app, page }) => {
    await page.mouse.click(400, 300);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'input');
    await page.keyboard.insertText('AB');
    await page.waitForFunction(() => window.textworld.inspect().cells.length === 2 && window.textworld.inspect().pending === 0);
    assert.equal(await page.locator('#input').inputValue(), '');
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
  console.log(JSON.stringify({ passed: results.length, coverage: 'synthetic Chromium IME event ordering and empty-textarea deletion', results }));
} finally {
  await browser.close();
}
