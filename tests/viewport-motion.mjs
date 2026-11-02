// Real Chromium viewport geometry, native composition, and wheel integration.
// visualViewport is simulated here; this does not exercise a physical OS keyboard.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createTextworld } from '../server/index.js';

await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const passed = [], failed = [], evidence = [];
const origin = { x: 512, y: 256 }, marker = { x: 506, y: 254 };
const inspect = page => page.evaluate(() => window.textworld.inspect());
const delay = (page, ms) => page.waitForTimeout(ms);
async function settled(page) {
  // Let ResizeObserver and the first camera frame observe a new viewport before
  // accepting the previously settled state as evidence of the new target.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(() => {
    const s = window.textworld.inspect();
    const delta = (n, extent) => ((n + extent / 2) % extent + extent) % extent - extent / 2;
    const dx = delta(s.cursor.x + .5 - s.camera.x - s.viewport.cols / 2, s.world.width) * 9 * s.zoom;
    const dy = delta(s.cursor.y + .5 - s.camera.y - s.viewport.rows / 2, s.world.height) * 26 * s.zoom;
    return !s.motionActive && Math.abs(dx) < .15 && Math.abs(dy) < .15;
  }, null, { timeout: 5000 });
  await delay(page, 30);
}
async function snapshot(page) { return page.evaluate(() => window.viewportSample()); }
async function trace(page) {
  await page.evaluate(() => {
    window.viewportFrames = []; window.viewportTracing = true;
    const frame = () => {
      if (!window.viewportTracing) return;
      window.viewportFrames.push(window.viewportSample());
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}
async function finishTrace(page) {
  return page.evaluate(() => { window.viewportTracing = false; return window.viewportFrames; });
}
async function viewport(page, changes) {
  await page.evaluate(changes => {
    for (const [name, value] of Object.entries(changes)) Object.defineProperty(visualViewport, name, { configurable: true, value });
    visualViewport.dispatchEvent(new Event('resize'));
    visualViewport.dispatchEvent(new Event('scroll'));
  }, changes);
}
function close(actual, expected, tolerance = .25, message = 'pixel geometry') {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
}
function smoothTransition(before, frames, after, axis) {
  const name = axis === 'y' ? 'markerY' : 'markerX';
  const start = before[name], end = after[name], travel = end - start;
  assert.ok(Math.abs(travel) > 1, 'fixture must actually move the map');
  const progress = frames.map(frame => (frame[name] - start) / travel);
  assert.ok(progress.some(value => value > .02 && value < .9), 'at least one painted frame must lie between the old and new map positions');
  assert.ok(progress.every(value => value > -.03 && value < 1.03), 'viewport transition must not overshoot or reverse');
  for (const frame of frames) {
    assert.ok(Number.isFinite(frame.markerX) && Number.isFinite(frame.markerY));
    assert.equal(frame.zoom, before.zoom, 'keyboard resize must not change map scale');
    assert.equal(frame.fontSize, before.fontSize, 'keyboard resize must not change the native font size');
    assert.equal(frame.fieldLeft, frame.viewportLeft, 'canvas follows the actual visible viewport');
    assert.equal(frame.fieldTop, frame.viewportTop, 'canvas follows the actual visible viewport');
  }
}
async function fixture(name, run, { mobile = true, reducedMotion = 'no-preference' } = {}) {
  const app = createTextworld({ storagePath: ':memory:', now: () => 1_000_000 });
  app.world.resize(1024, 512);
  app.world.applyWrite({ author: 'fixture', id: 'marker', epoch: app.world.epoch, ...marker, text: 'Q' });
  const { port } = await app.listen(0, '127.0.0.1');
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1200, height: 900 }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1, reducedMotion });
  await context.addInitScript(({ marker }) => {
    window.viewportPaints = [];
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      if (this.canvas.id === 'field' && args[0] === 'Q' && window.textworld) {
        const s = window.textworld.inspect(), box = this.canvas.getBoundingClientRect();
        const cursor = document.getElementById('cursor').getBoundingClientRect();
        window.viewportPaints.push({ x: args[1] + box.left, y: args[2] + box.top, font: this.font, camera: s.camera, zoom: s.zoom, box: { left: box.left, top: box.top },
          fieldHeight: box.height, bitmapHeight: this.canvas.height / devicePixelRatio, cursorY: cursor.top + cursor.height / 2 });
      }
      return fillText.apply(this, args);
    };
    window.viewportSample = () => {
      const s = window.textworld.inspect(), field = document.getElementById('field').getBoundingClientRect();
      const cursor = document.getElementById('cursor').getBoundingClientRect(), input = document.getElementById('input');
      const d = { x: 9 * s.zoom, y: 26 * s.zoom };
      let native = null;
      if (input.hasAttribute('data-native-preview')) {
        const range = document.createRange(); range.selectNodeContents(input);
        const rect = range.getClientRects()[0]; if (rect) native = { left: rect.left, top: rect.top };
      }
      return { time: performance.now(), cursor: s.cursor, camera: s.camera, zoom: s.zoom, fontSize: getComputedStyle(input).fontSize,
        markerX: field.left + (marker.x - s.camera.x) * d.x + d.x / 2,
        markerY: field.top + (marker.y - s.camera.y) * d.y + d.y / 2 + 1,
        cursorLeft: cursor.left, cursorTop: cursor.top, cursorX: cursor.left + cursor.width / 2, cursorY: cursor.top + cursor.height / 2,
        fieldLeft: field.left, fieldTop: field.top, fieldWidth: field.width, fieldHeight: field.height,
        bitmapHeight: document.getElementById('field').height / devicePixelRatio,
        viewportLeft: visualViewport.offsetLeft, viewportTop: visualViewport.offsetTop, native,
        scrolls: ['app', 'viewport', 'input'].map(id => { const node = document.getElementById(id); return [node.scrollLeft, node.scrollTop]; }),
      };
    };
  }, { marker });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(6000);
  try {
    await page.goto(`http://127.0.0.1:${port}/#x=${origin.x}&y=${origin.y}`);
    await page.waitForFunction(() => window.textworld?.inspect().connected && window.textworld.inspect().fontReady);
    await settled(page);
    await page.locator('#input').focus();
    await run({ page, context, app });
    await settled(page);
    const paints = await page.evaluate(() => window.viewportPaints);
    assert.ok(paints.length > 0, 'the real map must have painted the marker');
    for (const paint of paints) {
      close(paint.x, paint.box.left + (marker.x - paint.camera.x) * 9 * paint.zoom + 4.5 * paint.zoom, .01, 'actual Canvas marker x');
      close(paint.y, paint.box.top + (marker.y - paint.camera.y) * 26 * paint.zoom + 13 * paint.zoom + 1, .01, 'actual Canvas marker y');
      assert.ok(paint.font.includes('Textworld Sarasa'));
    }
    assert.deepEqual(errors, []);
    passed.push(name); console.log(`PASS ${name}`);
  } catch (error) {
    const state = await inspect(page).catch(() => null);
    failed.push({ name, error: error.stack, state }); console.error(`FAIL ${name}: ${error.stack}`);
  }
  finally { await context.close(); await app.close(); }
}

try {
  await fixture('keyboard opening preserves map scale and eases the same world toward the smaller visible center', async ({ page, context, app }) => {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
    const before = await snapshot(page), seq = app.world.seq;
    assert.ok(before.native, 'the actual native composition surface must be visible');
    await trace(page); await viewport(page, { height: 440 }); await settled(page);
    const frames = await finishTrace(page), after = await snapshot(page);
    smoothTransition(before, frames.filter(frame => frame.fieldHeight === 440), after, 'y');
    assert.deepEqual(after.cursor, before.cursor); assert.equal(app.world.seq, seq);
    close(after.fieldHeight, 440); close(after.cursorY, 220);
    const nativeDelta = { x: before.native.left - before.cursorLeft, y: before.native.top - before.cursorTop };
    for (const frame of frames.filter(frame => frame.native)) {
      close(frame.native.left - frame.cursorLeft, nativeDelta.x, .25, 'composition follows the same world cell x during resize');
      close(frame.native.top - frame.cursorTop, nativeDelta.y, .25, 'composition follows the same world cell y during resize');
      assert.deepEqual(frame.scrolls, [[0, 0], [0, 0], [0, 0]]);
    }
    assert.equal(await page.locator('#input').textContent(), '한');
    await page.screenshot({ path: 'artifacts/viewport-keyboard-open.png' });
    await cdp.send('Input.insertText', { text: '한' });
    await page.waitForFunction(() => window.textworld.inspect().pending === 0);
    assert.equal(app.world.getCell(origin.x, origin.y)?.text, '한');
    evidence.push({ name: 'keyboard-open', before, after, frames });
  });

  await fixture('keyboard closing eases back without rescaling glyphs or changing the addressed cell', async ({ page }) => {
    await viewport(page, { height: 440 }); await settled(page);
    const before = await snapshot(page); await trace(page); await viewport(page, { height: 844 }); await settled(page);
    const frames = await finishTrace(page), after = await snapshot(page);
    smoothTransition(before, frames.filter(frame => frame.fieldHeight === 844), after, 'y');
    assert.deepEqual(after.cursor, before.cursor); close(after.cursorY, 422);
    evidence.push({ name: 'keyboard-close', before, after, frames });
  });

  await fixture('a very small keyboard viewport keeps the caret visible before easing from the nearest edge', async ({ page }) => {
    const before = await snapshot(page); await trace(page); await viewport(page, { height: 300 }); await settled(page);
    const frames = await finishTrace(page), after = await snapshot(page);
    // RAF can run before this frame's ResizeObserver delivery. A CSS-sized
    // canvas still holding its previous bitmap is not the newly painted frame.
    const smaller = frames.filter(frame => frame.fieldHeight === 300 && frame.bitmapHeight === 300);
    assert.ok(smaller.length > 2);
    const paints = await page.evaluate(() => window.viewportPaints.filter(paint => paint.fieldHeight === 300 && paint.bitmapHeight === 300));
    assert.ok(paints.length > 2);
    for (const paint of paints) assert.ok(paint.cursorY >= 12.5 && paint.cursorY <= 287.5, 'every newly painted small viewport keeps the addressed cursor visible');
    for (const frame of smaller) {
      assert.ok(frame.cursorY >= 12.5 && frame.cursorY <= 287.5, 'the addressed cursor remains inside the visible keyboard viewport');
      assert.equal(frame.zoom, before.zoom); assert.equal(frame.fontSize, before.fontSize);
    }
    assert.ok(smaller.some(frame => frame.cursorY > 155 && frame.cursorY < 287.5), 'minimal edge correction must still ease toward the center');
    assert.deepEqual(after.cursor, before.cursor); close(after.cursorY, 150);
    evidence.push({ name: 'keyboard-small', before, after, frames });
  });

  await fixture('visual viewport offset compensates world pixels before easing to its new center', async ({ page }) => {
    await viewport(page, { height: 440 }); await settled(page);
    const before = await snapshot(page); await trace(page); await viewport(page, { offsetTop: 80, offsetLeft: 20 }); await settled(page);
    const frames = await finishTrace(page), after = await snapshot(page), moved = frames.filter(frame => frame.fieldTop === 80);
    smoothTransition(before, moved, after, 'y');
    assert.ok(moved.some(frame => Math.abs(frame.markerY - before.markerY) < 70), 'new viewport origin must not instantly shift the world by its full offset');
    close(after.cursorY, 300); close(after.cursorX, 215); assert.deepEqual(after.cursor, before.cursor);
    evidence.push({ name: 'viewport-offset', before, after, frames });
  });

  await fixture('retargeting an interrupted keyboard transition converges without overshoot', async ({ page }) => {
    const before = await snapshot(page); await trace(page);
    await viewport(page, { height: 440 }); await delay(page, 45); await viewport(page, { height: 600 }); await settled(page);
    const frames = await finishTrace(page), after = await snapshot(page);
    assert.ok(frames.some(frame => frame.fieldHeight === 440), 'intermediate keyboard viewport must be exercised');
    assert.ok(frames.some(frame => frame.fieldHeight === 600 && Math.abs(frame.cursorY - 300) > 1), 'new target must retain an intermediate camera frame');
    assert.ok(frames.every(frame => frame.markerY <= before.markerY + .5 && frame.markerY >= before.markerY - 202.5), 'retargeted world stays inside the old and smallest-viewport bounds');
    close(after.cursorY, 300); assert.equal(after.zoom, before.zoom); assert.deepEqual(after.cursor, before.cursor);
    evidence.push({ name: 'keyboard-retarget', before, after, frames });
  });

  await fixture('wheel navigation paints fractional camera positions between addressed cells', async ({ page }) => {
    const before = await snapshot(page); await trace(page);
    await page.locator('#field').dispatchEvent('wheel', { deltaX: 90, deltaY: 52, deltaMode: 0 });
    await settled(page); const frames = await finishTrace(page), after = await snapshot(page);
    assert.equal(after.cursor.x, before.cursor.x + 10); assert.equal(after.cursor.y, before.cursor.y + 2);
    assert.ok(frames.some(frame => Math.abs((frame.camera.x - before.camera.x) - Math.round(frame.camera.x - before.camera.x)) > .05), 'camera must render sub-cell progress');
    assert.ok(frames.some(frame => Math.abs(frame.cursorX - frame.fieldWidth / 2) > .1 || Math.abs(frame.cursorY - frame.fieldHeight / 2) > .1), 'cursor may temporarily leave the center while the camera follows');
    smoothTransition(before, frames, after, 'x'); close(after.cursorX, 600); close(after.cursorY, 450);
    evidence.push({ name: 'wheel', before, after, frames });
  }, { mobile: false });

  await fixture('a reversed wheel gesture settles without drifting or restarting a long transition', async ({ page }) => {
    const before = await snapshot(page); await trace(page);
    await page.locator('#field').dispatchEvent('wheel', { deltaX: 90, deltaY: 0, deltaMode: 0 });
    await delay(page, 45);
    await page.locator('#field').dispatchEvent('wheel', { deltaX: -90, deltaY: 0, deltaMode: 0 });
    await settled(page); const frames = await finishTrace(page), after = await snapshot(page);
    assert.deepEqual(after.cursor, before.cursor); close(after.markerX, before.markerX);
    assert.ok(frames.some(frame => Math.abs(frame.markerX - before.markerX) > .5));
    assert.ok(frames.every(frame => frame.markerX <= before.markerX + .5 && frame.markerX >= before.markerX - 90.5));
    evidence.push({ name: 'wheel-reverse', before, after, frames });
  }, { mobile: false });

  await fixture('grabbing an approaching camera freezes the map and the first drag follows only the pointer distance', async ({ page }) => {
    await page.keyboard.insertText('abcdefghijklmnopqrstuvwx');
    assert.equal((await inspect(page)).cameraActive, true, 'typing must create a camera transition before the new grab');
    await page.mouse.move(600, 450); await page.mouse.down();
    const grabbed = await snapshot(page);
    assert.equal((await inspect(page)).cameraActive, false, 'pointerdown freezes the displayed camera without snapping to its destination');
    await delay(page, 100);
    const held = await snapshot(page);
    close(held.markerX, grabbed.markerX, .01, 'world must stay still while a new pointer holds it');
    close(held.markerY, grabbed.markerY, .01, 'vertical camera position must also freeze');
    await page.mouse.move(590, 450);
    const moved = await snapshot(page);
    close(moved.markerX - held.markerX, -10, .01, 'first 10px drag must not also consume the old camera lag');
    close(moved.markerY, held.markerY, .01, 'horizontal dragging must not settle unrelated vertical lag');
    await page.mouse.up(); await settled(page);
    const after = await snapshot(page);
    close(after.cursorX, 600); close(after.cursorY, 450);
    evidence.push({ name: 'grab-interrupt', grabbed, held, moved, after });
  }, { mobile: false });

  await fixture('reduced motion keeps viewport and wheel changes immediate', async ({ page }) => {
    const before = await snapshot(page); await viewport(page, { height: 440 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    let after = await snapshot(page); close(after.cursorY, 220); assert.equal(after.zoom, before.zoom);
    await page.locator('#field').dispatchEvent('wheel', { deltaX: 90, deltaY: 0, deltaMode: 0 });
    after = await snapshot(page); assert.equal(after.cursor.x, before.cursor.x + 10); close(after.cursorX, after.fieldWidth / 2);
    evidence.push({ name: 'reduced-motion', before, after });
  }, { reducedMotion: 'reduce' });
} finally { await browser.close(); }

await writeFile('artifacts/viewport-motion-results.json', JSON.stringify({ passed: passed.length, failed: failed.length, failures: failed, evidence, scope: 'Chromium with simulated visualViewport events; no physical OS keyboard' }, null, 2));
console.log(JSON.stringify({ passed: passed.length, failed: failed.length, failures: failed }));
if (failed.length) process.exitCode = 1;
