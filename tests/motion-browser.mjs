// Real Chromium pointer/wheel/touch integration. This is not a physical device
// or OS-trackpad validation; native wheel tails are supplied explicitly below.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createTextworld } from '../server/index.js';

const app = createTextworld({ storagePath: ':memory:', now: () => 1_000_000 });
const { port } = await app.listen(0, '127.0.0.1');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const url = `http://127.0.0.1:${port}/#x=64&y=32`, checks = [], errors = [];
const state = page => page.evaluate(() => window.textworld.inspect());
const check = label => { checks.push(label); console.log(`PASS ${label}`); };
const wrap = (n, extent) => ((n % extent) + extent) % extent;
const settled = page => page.waitForFunction(() => window.textworld.inspect().motionActive === false);
async function ready(page) {
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(5000); await page.goto(url);
  await page.waitForFunction(() => window.textworld?.inspect().connected);
}
async function centered(page) {
  const s = await state(page);
  for (const [axis, extent, span] of [['x', s.world.width, s.viewport.cols], ['y', s.world.height, s.viewport.rows]]) {
    const error = wrap(s.camera[axis] + span / 2 - s.cursor[axis] - .5 + extent / 2, extent) - extent / 2;
    assert.ok(Math.abs(error) < 1e-6, `${axis}: moving cursor must stay at screen center`);
  }
}
async function location(page, x = 64, y = 32) {
  await page.evaluate(({ x, y }) => {
    history.replaceState(null, '', location.pathname);
    location.hash = `x=${x}&y=${y}`;
  }, { x, y });
  await page.waitForFunction(({ x, y }) => {
    const s = window.textworld.inspect(); return s.cursor.x === x && s.cursor.y === y && !s.motionActive;
  }, { x, y });
}
async function mouseFlick(page) {
  await page.mouse.move(600, 450); await page.mouse.down();
  for (let i = 1; i <= 5; i++) {
    await page.waitForTimeout(20);
    await page.mouse.move(600 - 18 * i, 450 - 12 * i);
  }
  await page.mouse.up();
  assert.equal((await state(page)).motionActive, true, 'a timed flick must release with momentum');
}
async function stable(page, duration = 200) {
  const before = (await state(page)).cursor;
  await page.waitForTimeout(duration);
  assert.deepEqual((await state(page)).cursor, before, 'cancelled motion must not move later');
  await centered(page);
}

try {
  const first = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const second = await browser.newContext();
  const a = await first.newPage(), b = await second.newPage();
  let actor;
  a.on('websocket', socket => socket.on('framereceived', frame => {
    const msg = JSON.parse(frame.payload.toString()); if (msg.type === 'snapshot') actor = msg.selfId;
  }));
  await Promise.all([ready(a), ready(b)]);
  await mouseFlick(a);
  const released = (await state(a)).cursor;
  await a.waitForFunction(before => {
    const s = window.textworld.inspect(); return s.cursor.x !== before.x && s.cursor.y !== before.y;
  }, released);
  await centered(a); await settled(a);
  const final = (await state(a)).cursor;
  await b.waitForFunction(({ actor, final }) => window.textworld.inspect().peers.some(peer => peer.id === actor && peer.x === final.x && peer.y === final.y), { actor, final });
  await stable(a);
  check('diagonal mouse flick continues, settles, stays centered and sends its final presence');

  await location(a); await mouseFlick(a); await a.keyboard.type('K');
  await a.waitForFunction(() => window.textworld.inspect().pending === 0);
  assert.equal((await state(a)).motionActive, false);
  await stable(a);
  check('physical typing immediately stops inertia before writing');

  await location(a); await mouseFlick(a);
  const ime = await first.newCDPSession(a);
  await ime.send('Input.imeSetComposition', { text: 'ㅎ', selectionStart: 1, selectionEnd: 1 });
  assert.equal((await state(a)).motionActive, false); await stable(a);
  await ime.send('Input.insertText', { text: '한' });
  await a.waitForFunction(() => window.textworld.inspect().pending === 0);
  await stable(a);
  check('native IME composition stops movement before candidate input begins');

  await location(a);
  const dimensions = await a.evaluate(() => {
    const field = document.getElementById('field').getBoundingClientRect(), s = window.textworld.inspect();
    return { x: field.width / s.viewport.cols, y: field.height / s.viewport.rows };
  });
  await a.mouse.move(600, 450);
  // Three decreasing deltas represent the tail already produced by an OS.
  for (const weight of [.5, .3, .2]) {
    await a.mouse.wheel(dimensions.x * 10 * weight, dimensions.y * 4 * weight);
    await a.waitForTimeout(20);
  }
  await settled(a);
  assert.deepEqual((await state(a)).cursor, { x: 74, y: 36 });
  await stable(a);
  check('wheel smoothing consumes exactly the supplied OS momentum without a second fling');

  await location(a); await mouseFlick(a); await a.locator('#zoom-out').click();
  assert.equal((await state(a)).motionActive, false); await stable(a);
  await location(a); await mouseFlick(a); await a.locator('#help-toggle').click();
  assert.equal((await state(a)).motionActive, false); await stable(a);
  await a.locator('#help-close').click();
  await location(a); await mouseFlick(a); await location(a, 40, 20); await stable(a);
  check('zoom, help and coordinate navigation cancel old inertial movement');

  await location(a); await mouseFlick(a);
  // Visibility change is explicit here; the unit suite separately verifies a
  // long suspended animation frame without an explicit visibility event.
  await a.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal((await state(a)).motionActive, false); await stable(a);
  await a.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await stable(a);
  check('hiding and restoring the page cannot resume old inertia');

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobile = await mobileContext.newPage(); await ready(mobile);
  const beforeTap = (await state(mobile)).cursor;
  await mobile.touchscreen.tap(130, 330);
  assert.equal(await mobile.evaluate(() => document.activeElement.id), 'input');
  assert.deepEqual((await state(mobile)).cursor, beforeTap);
  assert.equal((await state(mobile)).motionActive, false);
  const touch = await mobileContext.newCDPSession(mobile);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: 250, y: 420 }] });
  for (let i = 1; i <= 5; i++) {
    await mobile.waitForTimeout(20);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: 250 - 18 * i, y: 420 - 12 * i }] });
  }
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal((await state(mobile)).motionActive, true);
  await mobile.touchscreen.tap(130, 330);
  assert.equal((await state(mobile)).motionActive, false); await stable(mobile);
  check('touch tap opens native typing without drifting; a later tap stops a touch fling');

  await location(mobile);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: 140, y: 330 }] });
  await mobile.waitForTimeout(20);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: 120, y: 320 }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: 120, y: 320 }, { id: 2, x: 240, y: 320 }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: 100, y: 320 }, { id: 2, x: 260, y: 320 }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ id: 1, x: 100, y: 320 }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal((await state(mobile)).motionActive, false); await stable(mobile);
  check('pinching and releasing the remaining finger never reuse pre-pinch velocity');

  const reducedContext = await browser.newContext({ viewport: { width: 1200, height: 900 }, reducedMotion: 'reduce' });
  const reduced = await reducedContext.newPage(); await ready(reduced);
  await reduced.mouse.move(600, 450); await reduced.mouse.down();
  for (let i = 1; i <= 4; i++) { await reduced.waitForTimeout(20); await reduced.mouse.move(600 - 18 * i, 450 - 12 * i); }
  await reduced.mouse.up();
  assert.equal((await state(reduced)).motionActive, false); await stable(reduced);
  const beforeWheel = await state(reduced);
  await reduced.mouse.wheel(24, 30);
  await reduced.waitForFunction(before => {
    const s = window.textworld.inspect(); return s.cursor.x !== before.x || s.cursor.y !== before.y;
  }, beforeWheel.cursor);
  assert.equal((await state(reduced)).motionActive, false); await stable(reduced);
  check('reduced-motion keeps direct drag and wheel navigation while disabling coasting');

  assert.deepEqual(errors, []); check('no browser runtime errors during motion and native focus changes');
  console.log(JSON.stringify({ passed: checks.length, checks }));
} finally { await browser.close(); await app.close(); }
