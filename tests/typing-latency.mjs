// Real browser editing against a real server with held inbound messages.
// A 300ms minimum delivery delay exposes optimistic paint/ack handoff bugs
// without making correctness depend on a test machine's animation frame rate.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { createTextworld } from '../server/index.js';

await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const passed = [], failed = [], measurements = [];
const state = page => page.evaluate(() => window.textworld.inspect());
const paint = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const settled = page => page.waitForFunction(() => window.textworld.inspect().pending === 0);
async function settledCamera(page) {
  await page.waitForFunction(() => !window.textworld.inspect().cameraActive);
  const s = await state(page);
  for (const [axis, span, extent] of [['x', s.viewport.cols, s.world.width], ['y', s.viewport.rows, s.world.height]]) {
    const displacement = s.camera[axis] + span / 2 - s.cursor[axis] - .5;
    const wrapped = displacement - Math.round(displacement / extent) * extent;
    assert.ok(Math.abs(wrapped) < 1e-6, 'The visual camera must settle on the logical cursor');
  }
}
const cell = (cells, x, y = 8) => cells.find(c => c.x === x && c.y === y);
const next = (predicate, label) => new Promise((resolve, reject) => {
  const start = performance.now();
  const check = () => predicate() ? resolve() : performance.now() - start > 5000 ? reject(new Error(label)) : setTimeout(check, 5);
  check();
});
async function transport(context) {
  let holding = false, heldAt = 0, frames = [];
  await context.routeWebSocket('**/ws', ws => {
    const server = ws.connectToServer();
    server.onMessage(data => {
      if (holding) frames.push({ data, send: () => ws.send(data), message: JSON.parse(String(data)) });
      else ws.send(data);
    });
    ws.onMessage(data => server.send(data));
  });
  return {
    hold() { holding = true; heldAt = performance.now(); },
    get messages() { return frames.map(frame => frame.message); },
    async release() {
      const remainder = 300 - (performance.now() - heldAt);
      if (remainder > 0) await new Promise(resolve => setTimeout(resolve, remainder));
      holding = false; const ready = frames; frames = []; for (const frame of ready) frame.send();
    },
    async deliverThroughAck(id) {
      await next(() => frames.some(frame => frame.message.type === 'ack' && frame.message.id === id), 'Expected held ack');
      const end = frames.findIndex(frame => frame.message.type === 'ack' && frame.message.id === id);
      const ready = frames.splice(0, end + 1); for (const frame of ready) frame.send();
    },
  };
}
async function scenario(name, run, { seed = [] } = {}) {
  const app = createTextworld({ storagePath: ':memory:', now: () => 1_000_000 });
  for (const [index, entry] of seed.entries()) app.world.applyWrite({ author: 'neighbor', id: `seed-${index}`, epoch: app.world.epoch, ...entry });
  const { port } = await app.listen(0, '127.0.0.1');
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const observerContext = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const wire = await transport(context);
  await context.addInitScript(() => {
    window.typingFrames = []; window.typingInputs = [];
    let current;
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.id === 'field') {
        const s = window.textworld?.inspect();
        current = { t: performance.now(), text: [], camera: s?.camera, world: s?.world, zoom: s?.zoom }; window.typingFrames.push(current);
        if (window.typingFrames.length > 200) window.typingFrames.shift();
      }
      return clear.apply(this, args);
    };
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      if (this.canvas.id === 'field' && current) current.text.push({ text: String(args[0]), x: args[1], y: args[2], color: this.fillStyle });
      return fill.apply(this, args);
    };
    document.addEventListener('input', event => window.typingInputs.push({ t: performance.now(), data: event.data, inputType: event.inputType }), true);
  });
  const page = await context.newPage(), observer = await observerContext.newPage();
  const errors = [];
  for (const item of [page, observer]) { item.setDefaultTimeout(6000); item.on('pageerror', error => errors.push(error.message)); }
  try {
    await Promise.all([page, observer].map(item => item.goto(`http://127.0.0.1:${port}/#x=10&y=8`)));
    await Promise.all([page, observer].map(item => item.waitForFunction(() => window.textworld?.inspect().connected && window.textworld.inspect().peers.length === 2)));
    await page.locator('#input').focus(); await paint(page);
    const cdp = await context.newCDPSession(page);
    await run({ app, page, observer, cdp, wire });
    await wire.release(); await settled(page); await settledCamera(page); await paint(page);
    assert.deepEqual(errors, []);
    passed.push(name); console.log(`PASS ${name}`);
  } catch (error) { failed.push({ name, error: error.stack }); console.error(`FAIL ${name}: ${error.stack}`); }
  finally { await context.close(); await observerContext.close(); await app.close(); }
}
async function lastPaint(page) { return page.evaluate(() => window.typingFrames.at(-1)); }
async function visibleBeforeReply(page, text, x, y = 8) {
  await paint(page);
  const s = await state(page);
  assert.equal(cell(s.localCells, x, y)?.text, text, 'Display cells must already contain native input');
  const frame = await lastPaint(page), glyph = frame.text.find(glyph => glyph.text === text);
  assert.ok(glyph, 'Canvas must paint local text before a server response');
  // Local text follows the currently displayed camera while that camera eases
  // toward the logical cursor. A target-camera paint would visibly slide twice.
  const width = cell(s.localCells, x, y).width || 1, dx = 9 * frame.zoom, dy = 26 * frame.zoom;
  const expectedX = (x - frame.camera.x + width / 2) * dx;
  const expectedY = (y - frame.camera.y + .5) * dy + 1;
  const wrapsX = (glyph.x - expectedX) / (frame.world.width * dx);
  const wrapsY = (glyph.y - expectedY) / (frame.world.height * dy);
  assert.ok(Math.abs(wrapsX - Math.round(wrapsX)) < 1e-6, 'Local glyph x must match the current visual camera');
  assert.ok(Math.abs(wrapsY - Math.round(wrapsY)) < 1e-6, 'Local glyph y must match the current visual camera');
  const measure = await page.evaluate(text => {
    const input = window.typingInputs.at(-1);
    const frame = window.typingFrames.find(frame => frame.t >= input.t && frame.text.some(glyph => glyph.text === text));
    return { text, inputToLocalPaintMs: frame?.t - input.t };
  }, text);
  measurements.push(measure);
  return s;
}
try {
  await scenario('ASCII paints locally while authoritative replies are held for 300ms', async ({ page, observer, cdp, wire }) => {
    wire.hold();
    await cdp.send('Input.insertText', { text: 'Q' });
    const s = await visibleBeforeReply(page, 'Q', 10);
    assert.equal(cell(s.cells, 10)?.text, undefined, 'Authoritative response must still be withheld');
    assert.deepEqual(s.cursor, { x: 11, y: 8 });
    await observer.waitForFunction(() => window.textworld.inspect().cells.some(c => c.x === 10 && c.y === 8 && c.text === 'Q'));
    await wire.release(); await settled(page); await paint(page);
    const final = await state(page);
    assert.equal(cell(final.cells, 10).text, 'Q'); assert.equal(cell(final.localCells, 10).text, 'Q');
    assert.deepEqual(final.cursor, s.cursor, 'Echo must not move the logical caret again');
  });

  await scenario('Native Korean composition is visible locally without a canvas copy or shared draft', async ({ app, page, cdp }) => {
    const seq = app.world.seq;
    await cdp.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
    await paint(page);
    const s = await state(page), native = await page.locator('#input').evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      const box = range.getBoundingClientRect(), host = element.getBoundingClientRect(), style = getComputedStyle(element);
      return { text: element.textContent, opacity: Number(style.opacity), color: style.color, fill: style.webkitTextFillColor,
        visibility: style.visibility, box: { x: box.x, y: box.y, width: box.width, height: box.height },
        host: { x: host.x, y: host.y, width: host.width, height: host.height } };
    });
    assert.equal(native.text, '한'); assert.ok(native.opacity > .9); assert.equal(native.visibility, 'visible');
    assert.ok(native.box.width >= 17 && native.box.height > 0, 'Native draft must have a real visible glyph range');
    assert.ok(!['transparent', 'rgba(0, 0, 0, 0)'].includes(native.fill), 'Native text paint must be enabled');
    assert.ok(!(await lastPaint(page)).text.some(glyph => glyph.text === '한'), 'The browser draft must not be redrawn into canvas');
    assert.equal(app.world.seq, seq); assert.equal(s.cells.length, 0);
    await page.screenshot({ path: 'artifacts/native-composition-latency.png' });
    await cdp.send('Input.insertText', { text: '한' }); await settled(page);
  });

  await scenario('Korean commit has no empty frame between native draft and delayed shared text', async ({ page, cdp, wire }) => {
    await cdp.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 }); await paint(page);
    wire.hold(); await cdp.send('Input.insertText', { text: '한' });
    const s = await visibleBeforeReply(page, '한', 10);
    assert.equal(cell(s.localCells, 10).width, 2); assert.equal(cell(s.localCells, 11).width, 0);
    assert.equal(cell(s.cells, 10), undefined); assert.equal(s.preedit, '');
    const frames = await page.evaluate(() => {
      const input = window.typingInputs.at(-1); return window.typingFrames.filter(frame => frame.t >= input.t);
    });
    assert.ok(frames.length > 0 && frames.every(frame => frame.text.some(glyph => glyph.text === '한')), 'Every commit frame must retain the syllable');
    await wire.release(); await settled(page); await paint(page);
    assert.deepEqual((await state(page)).cursor, s.cursor);
  });

  await scenario('Backspace clears a wide character immediately while its server echo is delayed', async ({ page, cdp, wire }) => {
    await cdp.send('Input.insertText', { text: '한' }); await settled(page); await paint(page);
    wire.hold(); await page.keyboard.press('Backspace'); await paint(page);
    const s = await state(page);
    assert.equal(cell(s.cells, 10).text, '한');
    assert.ok(!cell(s.localCells, 10)?.text && cell(s.localCells, 11)?.width !== 0);
    assert.ok(!(await lastPaint(page)).text.some(glyph => glyph.text === '한'));
    assert.deepEqual(s.cursor, { x: 10, y: 8 });
    await wire.release(); await settled(page); assert.equal(cell((await state(page)).cells, 10), undefined);
  });

  await scenario('Delete clears an existing wide world character before its delayed server response', async ({ page, wire }) => {
    wire.hold(); await page.keyboard.press('Delete'); await paint(page);
    const s = await state(page);
    assert.equal(cell(s.cells, 10).text, '한');
    assert.ok(!cell(s.localCells, 10)?.text && cell(s.localCells, 11)?.width !== 0);
    assert.ok(!(await lastPaint(page)).text.some(glyph => glyph.text === '한'));
    assert.deepEqual(s.cursor, { x: 10, y: 8 });
    await wire.release(); await settled(page); assert.equal(cell((await state(page)).cells, 10), undefined);
  }, { seed: [{ x: 10, y: 8, text: '한' }] });

  await scenario('An older acknowledgement never rolls back newer local typing', async ({ page, cdp, wire }) => {
    wire.hold(); await cdp.send('Input.insertText', { text: 'Q' });
    await next(() => wire.messages.some(message => message.type === 'ack'), 'First native edit must reach server');
    const firstId = wire.messages.find(message => message.type === 'ack').id;
    await cdp.send('Input.insertText', { text: 'R' }); await paint(page);
    await wire.deliverThroughAck(firstId); await paint(page);
    const s = await state(page);
    assert.equal(cell(s.localCells, 10).text, 'Q'); assert.equal(cell(s.localCells, 11).text, 'R');
    assert.deepEqual(s.cursor, { x: 12, y: 8 });
    assert.ok((await lastPaint(page)).text.some(glyph => glyph.text === 'R'));
    await wire.release(); await settled(page);
    const final = await state(page); assert.equal(cell(final.cells, 11).text, 'R'); assert.deepEqual(final.cursor, s.cursor);
  });

  await scenario('A later remote overwrite wins after pending local text is acknowledged', async ({ page, observer, cdp, wire }) => {
    wire.hold(); await cdp.send('Input.insertText', { text: 'Q' });
    await observer.waitForFunction(() => window.textworld.inspect().cells.some(c => c.x === 10 && c.y === 8 && c.text === 'Q'));
    await observer.locator('#input').focus(); await observer.keyboard.insertText('R'); await settled(observer);
    await paint(page); assert.equal(cell((await state(page)).localCells, 10).text, 'Q');
    await wire.release(); await settled(page);
    await page.waitForFunction(() => window.textworld.inspect().cells.some(c => c.x === 10 && c.y === 8 && c.text === 'R'));
    await paint(page);
    assert.equal(cell((await state(page)).localCells, 10).text, 'R');
    assert.ok((await lastPaint(page)).text.some(glyph => glyph.text === 'R'));
  });

  await scenario('A new local edit following a remote overwrite keeps server order under delay', async ({ page, observer, cdp, wire }) => {
    wire.hold(); await cdp.send('Input.insertText', { text: 'Q' });
    await observer.waitForFunction(() => window.textworld.inspect().cells.some(c => c.x === 10 && c.y === 8 && c.text === 'Q'));
    await observer.locator('#input').focus(); await observer.keyboard.insertText('R'); await settled(observer);
    await cdp.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1, replacementStart: 0, replacementEnd: 1 });
    await cdp.send('Input.insertText', { text: '한' });
    await visibleBeforeReply(page, '한', 10);
    await wire.release(); await settled(page);
    await page.waitForFunction(() => window.textworld.inspect().cells.some(c => c.x === 10 && c.y === 8 && c.text === '한'));
    const final = await state(page);
    assert.equal(cell(final.localCells, 10).text, '한'); assert.equal(cell(final.cells, 11).width, 0);
    assert.deepEqual(final.cursor, { x: 12, y: 8 });
  });
} finally { await browser.close(); }
await writeFile('artifacts/typing-latency-results.json', JSON.stringify({ passed, failed, measurements }, null, 2));
console.log(JSON.stringify({ passed: passed.length, failed: failed.length, measurements }));
if (failed.length) process.exitCode = 1;
