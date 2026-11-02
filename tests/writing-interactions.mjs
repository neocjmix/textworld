// User-intent regressions for spatial writing. Native Chromium keyboard/IME paths
// are mixed with explicit beforeinput events for mobile event variants; these do
// not claim physical Android/iOS keyboard coverage.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createTextworld } from '../server/index.js';

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
});
const passed = [], failed = [];
const state = page => page.evaluate(() => window.textworld.inspect());
const settle = page => page.waitForFunction(() => window.textworld.inspect().pending === 0);
const cell = (app, x, y) => app.world.getCell(x, y)?.text || '';

async function centered(page) {
  const s = await state(page);
  for (const [axis, span, extent] of [['x', s.viewport.cols, s.world.width], ['y', s.viewport.rows, s.world.height]]) {
    const delta = s.camera[axis] + span / 2 - s.cursor[axis] - .5;
    const wrapped = ((delta + extent / 2) % extent + extent) % extent - extent / 2;
    assert.ok(Math.abs(wrapped) < 1e-6, `${axis}: writing cursor left screen center`);
  }
}
async function at(page, x, y) {
  await page.waitForFunction(({ x, y }) => {
    const cursor = window.textworld.inspect().cursor;
    return cursor.x === x && cursor.y === y;
  }, { x, y });
  assert.deepEqual((await state(page)).cursor, { x, y });
  await centered(page);
}
async function goTo(page, x, y) {
  await page.evaluate(({ x, y }) => {
    history.replaceState(null, '', location.pathname);
    location.hash = `x=${x}&y=${y}`;
  }, { x, y });
  await at(page, x, y);
}
async function type(page, text) {
  await page.keyboard.insertText(text);
  await settle(page);
}
async function paste(page, text) {
  await page.evaluate(text => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    document.getElementById('input').dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: data, bubbles: true, cancelable: true,
    }));
  }, text);
  await settle(page);
}
async function beforeInput(page, inputType) {
  return page.evaluate(inputType => document.getElementById('input').dispatchEvent(
    new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true }),
  ), inputType);
}

async function scenario(name, run, { x = 10, y = 8, mobile = false, seed = [] } = {}) {
  const app = createTextworld({ storagePath: ':memory:', now: () => 1_000_000 });
  for (const [index, entry] of seed.entries()) app.world.applyWrite({
    author: 'neighbor', id: `seed-${index}`, epoch: app.world.epoch, ...entry,
  });
  const { port } = await app.listen(0, '127.0.0.1');
  const context = await browser.newContext(mobile
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
    : { viewport: { width: 1200, height: 900 } });
  const observerContext = await browser.newContext();
  const page = await context.newPage(), observer = await observerContext.newPage();
  let actorId;
  page.on('websocket', socket => socket.on('framereceived', frame => {
    const message = JSON.parse(frame.payload.toString());
    if (message.type === 'snapshot') actorId = message.selfId;
  }));
  const errors = [];
  for (const item of [page, observer]) {
    item.setDefaultTimeout(5000);
    item.on('pageerror', error => errors.push(error.message));
  }
  try {
    const url = `http://127.0.0.1:${port}/#x=${x}&y=${y}`;
    await page.goto(url);
    await page.waitForFunction(() => window.textworld?.inspect().connected);
    actorId ||= (await state(page)).peers[0].id;
    await observer.goto(url);
    await observer.waitForFunction(() => window.textworld?.inspect().connected && window.textworld.inspect().peers.length === 2);
    if (mobile) await page.touchscreen.tap(160, 300); else await page.mouse.click(450, 350);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'input');
    await run({ app, page, observer, context, actorId });
    await settle(page);
    const final = await state(page);
    await observer.waitForFunction(({ id, cursor }) => window.textworld.inspect().peers.some(
      peer => peer.id === id && peer.x === cursor.x && peer.y === cursor.y,
    ), { id: actorId, cursor: final.cursor });
    await centered(page);
    assert.deepEqual(errors, []);
    passed.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    failed.push({ name, error: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
  } finally {
    await context.close(); await observerContext.close(); await app.close();
  }
}

try {
  await scenario('Enter returns to local writing origin, not current column or global zero', async ({ app, page, observer }) => {
    await page.keyboard.type('ABC'); await settle(page);
    const seq = app.world.seq;
    await page.keyboard.press('Enter'); await at(page, 10, 9);
    assert.equal(app.world.seq, seq, 'Return must not insert/erase a world cell');
    await type(page, 'D');
    await page.keyboard.press('Enter'); await at(page, 10, 10);
    await type(page, 'EF'); await at(page, 12, 10);
    assert.equal(cell(app, 10, 8), 'A'); assert.equal(cell(app, 12, 8), 'C');
    assert.equal(cell(app, 10, 9), 'D'); assert.equal(cell(app, 11, 10), 'F');
    assert.equal(cell(app, 9, 9), 'L'); assert.equal(cell(app, 15, 9), 'R');
    await observer.waitForFunction(() => window.textworld.inspect().cells.some(c => c.x === 11 && c.y === 10 && c.text === 'F'));
  }, { seed: [{ x: 9, y: 9, text: 'L' }, { x: 15, y: 9, text: 'R' }] });

  await scenario('Shift+Enter and consecutive returns preserve the same origin and empty rows', async ({ app, page }) => {
    await type(page, 'AB');
    const seq = app.world.seq;
    await page.keyboard.press('Shift+Enter'); await at(page, 10, 9);
    await page.keyboard.press('Enter'); await at(page, 10, 10);
    await page.keyboard.press('Enter'); await at(page, 10, 11);
    assert.equal(app.world.seq, seq);
    await page.keyboard.press('Backspace'); await at(page, 10, 10);
    await page.keyboard.press('Backspace'); await at(page, 10, 9);
    await page.keyboard.press('Backspace'); await at(page, 12, 8);
    assert.equal(app.world.seq, seq, 'Retracing returns must not delete neighboring cells');
    assert.equal(cell(app, 9, 10), 'N');
  }, { seed: [{ x: 9, y: 10, text: 'N' }] });

  await scenario('Backspace at a return retraces the caret and protects unrelated text', async ({ app, page }) => {
    await type(page, 'ABC');
    await page.keyboard.press('Enter'); await at(page, 10, 9);
    const seq = app.world.seq;
    await page.keyboard.press('Backspace'); await at(page, 13, 8);
    assert.equal(app.world.seq, seq);
    assert.equal(cell(app, 9, 9), 'L'); assert.equal(cell(app, 12, 9), 'N');
    assert.equal(cell(app, 12, 8), 'C');
    await page.keyboard.press('Backspace'); await settle(page); await at(page, 12, 8);
    assert.equal(cell(app, 12, 8), ''); assert.equal(cell(app, 11, 8), 'B');
    assert.equal(cell(app, 12, 9), 'N');
  }, { seed: [{ x: 9, y: 9, text: 'L' }, { x: 12, y: 9, text: 'N' }] });

  await scenario('Typing then CRLF paste aligns later rows with the established origin', async ({ app, page, observer }) => {
    await page.keyboard.type('ABC'); await settle(page);
    await paste(page, 'D\r\nE'); await at(page, 11, 9);
    assert.equal(cell(app, 13, 8), 'D'); assert.equal(cell(app, 10, 9), 'E');
    assert.equal(cell(app, 13, 9), 'N');
    await observer.waitForFunction(() => window.textworld.inspect().cells.some(c => c.x === 10 && c.y === 9 && c.text === 'E'));
    await page.keyboard.press('Backspace'); await settle(page); await at(page, 10, 9);
    const seq = app.world.seq;
    await page.keyboard.press('Backspace'); await at(page, 14, 8);
    assert.equal(app.world.seq, seq, 'Pasted newline must be retraceable like keyboard Return');
    await page.keyboard.press('Backspace'); await settle(page); await at(page, 13, 8);
    assert.equal(cell(app, 13, 8), ''); assert.equal(cell(app, 12, 8), 'C');
  }, { seed: [{ x: 13, y: 9, text: 'N' }] });

  await scenario('Mobile beforeinput return intents use the same origin without text mutation', async ({ app, page }) => {
    await type(page, 'ABC');
    const seq = app.world.seq;
    assert.equal(await beforeInput(page, 'insertParagraph'), false, 'Native paragraph insertion must be handled explicitly');
    await at(page, 10, 9);
    assert.equal(await beforeInput(page, 'insertLineBreak'), false);
    await at(page, 10, 10);
    assert.equal(app.world.seq, seq);
    await type(page, '한'); await at(page, 11, 10);
    assert.equal(cell(app, 10, 10), '한');
  }, { mobile: true });

  await scenario('Input-only newline fallback matches Return instead of starting a new margin', async ({ app, page }) => {
    await type(page, 'ABC'); const seq = app.world.seq;
    await page.evaluate(() => {
      const input = document.getElementById('input');
      input.value = '\n';
      input.dispatchEvent(new InputEvent('input', { data: '\n', inputType: 'insertLineBreak', bubbles: true }));
    });
    await at(page, 10, 9);
    assert.equal(app.world.seq, seq, 'Navigation-only newline must not create a write transaction');
  });

  await scenario('Arrows before writing establish a margin while zoom preserves it', async ({ app, page }) => {
    await page.keyboard.press('ArrowRight'); await at(page, 11, 8);
    await page.keyboard.press('ArrowDown'); await at(page, 11, 9);
    await type(page, 'ABC');
    await page.locator('#zoom-in').click();
    await page.keyboard.press('Enter'); await at(page, 11, 10);
    await type(page, 'Z'); assert.equal(cell(app, 11, 10), 'Z');
  });

  await scenario('Correcting a typo with arrows and Backspace preserves the writing margin', async ({ app, page }) => {
    await type(page, 'ABC'); await at(page, 13, 8);
    await page.keyboard.press('ArrowLeft'); await at(page, 12, 8);
    await page.keyboard.press('Backspace'); await settle(page); await at(page, 11, 8);
    assert.equal(cell(app, 11, 8), ''); assert.equal(cell(app, 12, 8), 'C');
    await type(page, 'X'); await at(page, 12, 8);
    await page.keyboard.press('Enter'); await at(page, 10, 9);
    assert.equal(cell(app, 10, 8), 'A'); assert.equal(cell(app, 11, 8), 'X');
    assert.equal(cell(app, 12, 8), 'C', 'Typo correction must not shift existing cells');
  });

  await scenario('Home returns to the local margin while End cannot invent a line boundary', async ({ app, page }) => {
    await type(page, 'ABC'); const seq = app.world.seq;
    await page.keyboard.press('Home'); await at(page, 10, 8);
    assert.equal(app.world.seq, seq);
    await type(page, 'X'); await at(page, 11, 8);
    await page.keyboard.press('End'); await at(page, 11, 8);
    assert.equal(app.world.seq, seq + 1);
    assert.ok((await page.locator('#notice').textContent()).length > 0);
    await page.keyboard.press('Enter'); await at(page, 10, 9);
    assert.equal(cell(app, 10, 8), 'X'); assert.equal(cell(app, 12, 8), 'C');
  });

  await scenario('Range-selection shortcuts and clipboard cut cannot act on the hidden keyboard bridge', async ({ app, page }) => {
    await type(page, 'ABC'); const seq = app.world.seq;
    for (const key of ['Shift+ArrowLeft', 'Shift+ArrowRight', 'Shift+ArrowUp', 'Shift+ArrowDown', 'Shift+Home', 'Shift+End', 'Shift+Delete', 'Control+a', 'Control+c', 'Control+x', 'Control+Insert']) {
      await page.keyboard.press(key); await at(page, 13, 8);
      assert.equal(app.world.seq, seq, `${key} must not alter world cells`);
      assert.ok((await page.locator('#notice').textContent()).length > 0);
    }
    for (const type of ['copy', 'cut']) {
      const result = await page.evaluate(type => {
        const clipboardData = new DataTransfer();
        const accepted = document.getElementById('input').dispatchEvent(new ClipboardEvent(type, {
          clipboardData, bubbles: true, cancelable: true,
        }));
        return { accepted, text: clipboardData.getData('text/plain') };
      }, type);
      assert.equal(result.accepted, false, `${type} must explicitly report unsupported spatial selection`);
      assert.equal(result.text, ''); await at(page, 13, 8); assert.equal(app.world.seq, seq);
    }
    assert.equal(cell(app, 10, 8), 'A'); assert.equal(cell(app, 12, 8), 'C');
    await page.keyboard.press('Enter'); await at(page, 10, 9);
  });

  await scenario('Map panning and shared-location navigation start fresh local margins', async ({ app, page }) => {
    await type(page, 'ABC');
    await page.mouse.move(600, 450); await page.mouse.wheel(48, 60); await at(page, 15, 10);
    await type(page, 'XY'); await page.keyboard.press('Enter'); await at(page, 15, 11);
    await goTo(page, 30, 12); await type(page, 'QR');
    await page.keyboard.press('Enter'); await at(page, 30, 13);
    assert.equal(cell(app, 15, 10), 'X'); assert.equal(cell(app, 30, 12), 'Q');
  });

  await scenario('Return across toroidal seams retains the spatial margin and grapheme cells', async ({ app, page }) => {
    await type(page, '한👨‍👩‍👧‍👦'); await at(page, 0, 63);
    await page.keyboard.press('Enter'); await at(page, 126, 0);
    await type(page, '끝'); await at(page, 127, 0);
    assert.equal(cell(app, 126, 63), '한'); assert.equal(cell(app, 127, 63), '👨‍👩‍👧‍👦');
    assert.equal(cell(app, 126, 0), '끝');
    await page.keyboard.press('Backspace'); await settle(page); await at(page, 126, 0);
    await page.keyboard.press('Backspace'); await at(page, 0, 63);
    await page.keyboard.press('Backspace'); await settle(page); await at(page, 127, 63);
    assert.equal(cell(app, 127, 63), ''); assert.equal(cell(app, 126, 63), '한');
  }, { x: 126, y: 63 });

  await scenario('IME confirmation Enter does not also return; the next Enter does', async ({ app, page, context }) => {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
    assert.equal(app.world.snapshot().cells.length, 0);
    // The OS owns confirmation. This key represents its composing keydown,
    // followed by Chromium's native commit path, not a second application Return.
    await page.evaluate(() => document.getElementById('input').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }),
    ));
    await at(page, 10, 8);
    await cdp.send('Input.insertText', { text: '한' }); await settle(page); await at(page, 11, 8);
    assert.equal(app.world.seq, 1); assert.equal(cell(app, 10, 8), '한');
    await page.keyboard.press('Enter'); await at(page, 10, 9);
    assert.equal(app.world.seq, 1);
  });

  await scenario('Delete keeps the cursor, clears one cell, and leaves the local margin intact', async ({ app, page }) => {
    await type(page, 'AB'); await at(page, 12, 8);
    await page.keyboard.press('Delete'); await settle(page); await at(page, 12, 8);
    assert.equal(cell(app, 12, 8), ''); assert.equal(cell(app, 13, 8), 'N');
    await page.keyboard.press('Enter'); await at(page, 10, 9);
  }, { seed: [{ x: 12, y: 8, text: 'T' }, { x: 13, y: 8, text: 'N' }] });

  await scenario('Zoom and opening help do not silently change the writing margin', async ({ page }) => {
    await type(page, 'ABC');
    await page.locator('#help-toggle').click(); await page.locator('#help-close').click();
    await page.locator('#zoom-out').click();
    await page.keyboard.press('Enter'); await at(page, 10, 9);
  });

  await scenario('Explicit placement discards an old return route before ordinary Backspace', async ({ app, page }) => {
    await type(page, 'ABC'); await page.keyboard.press('Enter'); await at(page, 10, 9);
    await goTo(page, 20, 12); await goTo(page, 10, 9);
    await page.keyboard.press('Backspace'); await settle(page); await at(page, 9, 9);
    assert.equal(cell(app, 9, 9), ''); assert.equal(cell(app, 12, 8), 'C');
  }, { seed: [{ x: 9, y: 9, text: 'N' }] });

  await scenario('Settled same-epoch reconnect preserves the local margin and return route', async ({ app, page, observer }) => {
    await type(page, 'ABC'); await page.keyboard.press('Enter'); await at(page, 10, 9);
    await observer.waitForFunction(() => window.textworld.inspect().peers.some(p => p.x === 10 && p.y === 9));
    const seq = app.world.seq;
    for (const socket of app.wss.clients) socket.terminate();
    await page.waitForFunction(() => !window.textworld.inspect().connected);
    await page.waitForFunction(() => window.textworld.inspect().connected);
    await observer.waitForFunction(() => window.textworld.inspect().connected);
    await at(page, 10, 9);
    await page.keyboard.press('Backspace'); await at(page, 13, 8);
    assert.equal(app.world.seq, seq);
    await page.keyboard.press('Enter'); await at(page, 10, 9);
  });

  await scenario('Unsupported native undo, word deletion and replacement cannot silently rewrite cells', async ({ app, page }) => {
    await type(page, 'ABC');
    const seq = app.world.seq;
    for (const inputType of ['historyUndo', 'historyRedo', 'deleteWordBackward', 'deleteWordForward', 'insertReplacementText']) {
      const accepted = await page.evaluate(inputType => document.getElementById('input').dispatchEvent(
        new InputEvent('beforeinput', { inputType, data: 'unexpected replacement', bubbles: true, cancelable: true }),
      ), inputType);
      assert.equal(accepted, false, `${inputType} must be explicitly prevented`);
      await at(page, 13, 8); assert.equal(app.world.seq, seq);
    }
    // Some mobile engines deliver a non-cancellable input without beforeinput.
    await page.evaluate(() => {
      const input = document.getElementById('input'); input.value = 'old draft';
      input.dispatchEvent(new InputEvent('input', { inputType: 'historyUndo', data: 'old draft', bubbles: true }));
    });
    await at(page, 13, 8); assert.equal(app.world.seq, seq);
    assert.equal(await page.locator('#input').inputValue(), '');
    assert.ok((await page.locator('#notice').textContent()).length > 0);
    assert.equal(cell(app, 10, 8), 'A'); assert.equal(cell(app, 12, 8), 'C');
  });

  console.log(JSON.stringify({ passed: passed.length, failed: failed.length, failures: failed }));
  if (failed.length) process.exitCode = 1;
} finally {
  await browser.close();
}
