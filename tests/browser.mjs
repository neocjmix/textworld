import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createTextworld } from '../server/index.js';

// Freeze the adaptation clock; density transitions are covered by engine tests.
const app = createTextworld({ storagePath: ':memory:', now: () => 1_000_000 });
const address = await app.listen(0, '127.0.0.1');
const url = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
});
const errors = [], checks = [];
const state = page => page.evaluate(() => window.textworld.inspect());
const ready = page => page.waitForFunction(() => window.textworld?.inspect().connected);
const settle = page => page.waitForFunction(() => window.textworld.inspect().pending === 0);
const waitCell = (page, x, y, text) => page.waitForFunction(({ x, y, text }) =>
  window.textworld.inspect().cells.find(cell => cell.x === x && cell.y === y)?.text === text,
{ x, y, text });
const check = label => { checks.push(label); console.log(`PASS ${label}`); };
const observe = page => page.on('pageerror', error => errors.push(error.message));
const wrap = (value, size) => ((value % size) + size) % size;

async function centered(page) {
  const snapshot = await state(page);
  for (const [axis, extent, span] of [
    ['x', snapshot.world.width, snapshot.viewport.cols],
    ['y', snapshot.world.height, snapshot.viewport.rows],
  ]) {
    const center = snapshot.camera[axis] + span / 2;
    const expected = snapshot.cursor[axis] + 0.5;
    const error = Math.abs(wrap(center - expected + extent / 2, extent) - extent / 2);
    assert.ok(error < 1e-6, `${axis}: cursor must be at viewport center, error ${error}`);
  }
  const geometry = await page.evaluate(() => {
    const field = document.getElementById('field').getBoundingClientRect();
    const input = document.getElementById('input').getBoundingClientRect();
    return {
      fieldX: field.x + field.width / 2, fieldY: field.y + field.height / 2,
      inputX: input.x + input.width / 2, inputY: input.y + input.height / 2,
    };
  });
  assert.ok(Math.abs(geometry.fieldX - geometry.inputX) <= 1, 'native input anchor must share cursor x');
  assert.ok(Math.abs(geometry.fieldY - geometry.inputY) <= 1, 'native input anchor must share cursor y');
}

async function fullscreen(page) {
  const geometry = await page.evaluate(() => {
    const field = document.getElementById('field').getBoundingClientRect();
    const visual = window.visualViewport;
    return {
      x: field.x, y: field.y, width: field.width, height: field.height,
      expectedX: visual?.offsetLeft || 0, expectedY: visual?.offsetTop || 0,
      expectedWidth: visual?.width || innerWidth, expectedHeight: visual?.height || innerHeight,
      overflowX: document.documentElement.scrollWidth > innerWidth,
      overflowY: document.documentElement.scrollHeight > innerHeight,
      panelCount: document.querySelectorAll('.composer').length,
    };
  });
  for (const [key, expected] of [['x', 'expectedX'], ['y', 'expectedY'], ['width', 'expectedWidth'], ['height', 'expectedHeight']]) {
    assert.ok(Math.abs(geometry[key] - geometry[expected]) <= 1, `${key}: field must fill visual viewport`);
  }
  assert.equal(geometry.panelCount, 0, 'the separate composer panel must be removed');
  assert.equal(geometry.overflowX, false);
  assert.equal(geometry.overflowY, false);
}

async function goTo(page, x, y) {
  await page.evaluate(({ x, y }) => {
    history.replaceState(null, '', location.pathname);
    location.hash = `x=${x}&y=${y}`;
  }, { x, y });
  await page.waitForFunction(({ x, y }) => {
    const current = window.textworld.inspect().cursor;
    return current.x === x && current.y === y;
  }, { x, y });
  await centered(page);
}

try {
  await mkdir('artifacts', { recursive: true });
  const contextA = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const contextB = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const a = await contextA.newPage(), b = await contextB.newPage();
  observe(a); observe(b);
  await Promise.all([a.goto(`${url}/#x=64&y=32`), b.goto(`${url}/#x=64&y=32`)]);
  await Promise.all([ready(a), ready(b)]);
  await fullscreen(a); await centered(a); await fullscreen(b); await centered(b);
  check('map fills the viewport and separate composer panel is absent');
  await a.waitForFunction(() => window.textworld.inspect().peers.length === 2);
  check('two independent browser contexts share live presence');

  await a.evaluate(() => document.activeElement?.blur());
  await a.keyboard.type('Z'); await settle(a); await waitCell(b, 64, 32, 'Z');
  assert.equal((await state(a)).cursor.x, 65); await centered(a);
  await goTo(a, 64, 32);
  check('desktop physical typing focuses native map input without a separate field');

  const beforeTap = (await state(a)).cursor;
  await a.mouse.click(440, 380);
  assert.equal(await a.evaluate(() => document.activeElement?.id), 'input');
  assert.deepEqual((await state(a)).cursor, beforeTap);
  check('map tap opens native input at center without moving to the tap point');
  await a.keyboard.insertText('안녕👨‍👩‍👧‍👦');
  await settle(a); await waitCell(b, 64, 32, '안'); await waitCell(b, 66, 32, '👨‍👩‍👧‍👦');
  assert.equal((await state(a)).cursor.x, 67); await centered(a);
  check('Korean and emoji write directly into cells while camera follows centered cursor');

  await b.mouse.click(460, 350); await b.keyboard.insertText('별');
  await settle(b); await waitCell(a, 64, 32, '별'); await waitCell(a, 65, 32, '녕');
  await centered(b);
  check('overwrite changes only addressed cell without shifting neighbors');
  await b.keyboard.press('Backspace'); await settle(b);
  await a.waitForFunction(() => !window.textworld.inspect().cells.some(cell => cell.x === 64 && cell.y === 32));
  await waitCell(a, 65, 32, '녕'); await centered(b);
  check('backspace clears preceding cell and keeps cursor centered');

  await a.mouse.click(400, 340); await a.keyboard.insertText('A\tB'); await settle(a);
  assert.equal((await state(a)).cursor.x, 73);
  await b.waitForFunction(() => window.textworld.inspect().peers.some(peer => peer.x === 73 && peer.y === 32));
  await centered(a);
  check('tab paste shares identical cursor projection with server presence');

  // Native Chromium IME path, not a synthetic composition handler invocation.
  const cdp = await contextA.newCDPSession(a), beforeComposition = (await state(a)).cells.length;
  for (const text of ['ㅎ', '하', '한']) {
    await cdp.send('Input.imeSetComposition', { text, selectionStart: 1, selectionEnd: 1 });
  }
  assert.equal((await state(a)).cells.length, beforeComposition);
  await centered(a);
  await a.screenshot({ path: 'artifacts/desktop-composition.png' });
  await cdp.send('Input.insertText', { text: '한' });
  await settle(a); await waitCell(b, 73, 32, '한');
  assert.equal((await state(a)).cursor.x, 74); await centered(a);
  check('native Korean IME composes at center and commits final syllable exactly once');

  await goTo(a, 64, 32);
  const dimensions = await a.evaluate(() => {
    const field = document.getElementById('field').getBoundingClientRect();
    const viewport = window.textworld.inspect().viewport;
    return { width: field.width / viewport.cols, height: field.height / viewport.rows };
  });
  await a.mouse.move(650, 450); await a.mouse.wheel(dimensions.width * 2, dimensions.height * 3);
  await a.waitForFunction(() => window.textworld.inspect().cursor.x === 66 && window.textworld.inspect().cursor.y === 35);
  await centered(a);
  await b.waitForFunction(() => window.textworld.inspect().peers.some(peer => peer.x === 66 && peer.y === 35));
  check('xy scroll directly moves cursor in both axes and updates remote presence');

  await a.mouse.move(600, 450); await a.mouse.down();
  await a.mouse.move(600 + dimensions.width * 3, 450 + dimensions.height * 2, { steps: 8 });
  await a.mouse.up();
  await a.waitForFunction(() => window.textworld.inspect().cursor.x === 63 && window.textworld.inspect().cursor.y === 33);
  await centered(a);
  check('dragging the map moves world beneath the stationary center cursor');

  await goTo(a, 64, 32);
  await a.evaluate(({ width, height }) => {
    const field = document.getElementById('field');
    for (let index = 0; index < 20; index++) field.dispatchEvent(new WheelEvent('wheel', {
      deltaX: width / 20, deltaY: height / 20, bubbles: true, cancelable: true,
    }));
  }, dimensions);
  await a.waitForFunction(() => window.textworld.inspect().cursor.x === 65 && window.textworld.inspect().cursor.y === 33);
  await centered(a);
  check('small trackpad deltas accumulate into cell movement instead of disappearing');

  const beforeZoom = (await state(a)).cursor;
  for (let index = 0; index < 10; index++) if (await a.locator('#zoom-out').isEnabled()) await a.locator('#zoom-out').click();
  assert.equal((await state(a)).zoom, 0.6); await centered(a);
  for (let index = 0; index < 12; index++) if (await a.locator('#zoom-in').isEnabled()) await a.locator('#zoom-in').click();
  assert.equal((await state(a)).zoom, 2); assert.deepEqual((await state(a)).cursor, beforeZoom); await centered(a);
  check('zoom is bounded and preserves center cell identity');
  await a.keyboard.type('Q'); await settle(a);
  await waitCell(b, beforeZoom.x, beforeZoom.y, 'Q'); await centered(a);
  check('mouse-operated map controls return desktop typing to the center cell');

  await goTo(a, 127, 63); await a.mouse.click(520, 370); await a.keyboard.insertText('끝처');
  await settle(a); await waitCell(b, 127, 63, '끝'); await waitCell(b, 0, 63, '처');
  assert.equal((await state(a)).cursor.x, 1); await centered(a);
  await a.keyboard.press('ArrowDown'); assert.equal((await state(a)).cursor.y, 0); await centered(a);
  check('writing and navigation cross both toroidal seams without losing screen center');

  const beforeDisconnect = (await state(a)).cursor;
  for (const socket of app.wss.clients) socket.terminate();
  await a.waitForFunction(() => !window.textworld.inspect().connected);
  assert.ok(await a.locator('#input').isDisabled());
  await ready(a); await ready(b); await waitCell(a, 127, 63, '끝');
  assert.deepEqual((await state(a)).cursor, beforeDisconnect);
  assert.equal((await state(a)).pending, 0); await centered(a);
  check('disconnect disables input and reconnect restores cursor position at center');

  await goTo(a, 62, 30); await a.mouse.click(500, 400); await a.keyboard.insertText('여기, 함께.'); await settle(a);
  await a.screenshot({ path: 'artifacts/desktop.png' });

  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    geolocation: { latitude: 37.5665, longitude: 126.978 }, permissions: ['geolocation'],
  });
  const mobile = await mobileContext.newPage(); observe(mobile);
  await mobile.goto(url); await ready(mobile);
  await mobile.waitForFunction(() => window.textworld.inspect().cursor.x === 109);
  assert.equal((await state(mobile)).cursor.y, 12); await centered(mobile); await fullscreen(mobile);
  check('GPS placement centers mobile map on projected geographic cell');
  await mobileContext.setGeolocation({ latitude: 0, longitude: 0 });
  await mobile.locator('#gps').click();
  await mobile.waitForFunction(() => window.textworld.inspect().cursor.x === 64 && window.textworld.inspect().cursor.y === 32);
  await centered(mobile);
  check('GPS return reads updated position and recenters map');

  const beforeMobileTap = (await state(mobile)).cursor;
  await mobile.touchscreen.tap(120, 340);
  assert.equal(await mobile.evaluate(() => document.activeElement?.id), 'input');
  assert.deepEqual((await state(mobile)).cursor, beforeMobileTap);
  await mobile.keyboard.insertText('모바일'); await settle(mobile); await centered(mobile);
  check('mobile map tap focuses native keyboard bridge and writes directly at center');

  const touch = await mobileContext.newCDPSession(mobile), beforeDrag = (await state(mobile)).cursor;
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 190, y: 350 }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 70, y: 230 }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.notDeepEqual((await state(mobile)).cursor, beforeDrag); await centered(mobile); await fullscreen(mobile);
  await mobile.screenshot({ path: 'artifacts/mobile.png' });
  check('mobile touch drag changes cursor location with no page scrolling');

  const beforePinch = await state(mobile);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 120, y: 310 }, { x: 220, y: 310 }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 95, y: 310 }, { x: 245, y: 310 }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.ok((await state(mobile)).zoom > beforePinch.zoom);
  assert.deepEqual((await state(mobile)).cursor, beforePinch.cursor); await centered(mobile);
  check('two-finger pinch zooms around the same center cell');

  const beforeResize = (await state(mobile)).cursor;
  await mobile.setViewportSize({ width: 390, height: 440 });
  await mobile.waitForTimeout(100);
  await fullscreen(mobile); await centered(mobile);
  assert.deepEqual((await state(mobile)).cursor, beforeResize);
  await mobile.screenshot({ path: 'artifacts/mobile-keyboard-height.png' });
  check('keyboard-sized visual viewport keeps the same cell at visible screen center');

  // Emulate visualViewport offset/height events independently of layout viewport.
  // This tests geometry handling, not a physical Android/iOS software keyboard.
  await mobile.evaluate(() => {
    Object.defineProperty(visualViewport, 'height', { configurable: true, value: 300 });
    Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, value: 40 });
    visualViewport.dispatchEvent(new Event('resize'));
    visualViewport.dispatchEvent(new Event('scroll'));
  });
  await mobile.waitForTimeout(100); await fullscreen(mobile); await centered(mobile);
  assert.deepEqual((await state(mobile)).cursor, beforeResize);
  check('visual viewport offset and keyboard occlusion preserve centered input geometry');

  const deniedContext = await browser.newContext();
  await deniedContext.addInitScript(() => Object.defineProperty(navigator, 'geolocation', {
    value: { getCurrentPosition: (_ok, fail) => fail({ code: 1 }) },
  }));
  const denied = await deniedContext.newPage(); observe(denied);
  await denied.goto(url); await ready(denied);
  await denied.locator('#gps').click();
  await denied.waitForFunction(() => document.getElementById('notice').textContent.includes('얻지 못했습니다'));
  assert.equal(await denied.locator('#input').isEnabled(), true); await centered(denied);
  check('denied GPS retains direct map input at fallback center');

  assert.deepEqual(errors, []); check('no browser runtime errors');
  console.log(`${checks.length} browser checks passed. Screenshots: artifacts/desktop.png, mobile.png, mobile-keyboard-height.png, desktop-composition.png`);
} finally {
  await browser.close();
  await app.close();
}
