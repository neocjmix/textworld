// Actual Chromium composition and target ranges through the complete app and
// two independent WebSocket clients. CDP is not a physical OS keyboard test.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createTextworld } from '../server/index.js';

await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const passed = [], failed = [], measurements = [];
const state = page => page.evaluate(() => window.textworld.inspect());
const settle = page => page.waitForFunction(() => window.textworld.inspect().pending === 0);
const paint = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const compose = (cdp, text, extra = {}) => cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length, ...extra });
const commit = async (cdp, page, text) => { await cdp.send('Input.insertText', { text }); await settle(page); };
const textAt = (app, x, y = 8) => app.world.getCell(x, y)?.text || '';
const cellAt = (app, x, y = 8) => ({ ...app.world.getCell(x, y) });

async function centered(page) {
  await page.waitForFunction(() => {
    const s = window.textworld.inspect(); return !s.cameraActive && !s.motionActive;
  });
  const s = await state(page);
  for (const [axis, span, extent] of [['x', s.viewport.cols, s.world.width], ['y', s.viewport.rows, s.world.height]]) {
    const distance = s.camera[axis] + span * (axis === 'y' ? .43 : .5) - s.cursor[axis] - .5;
    const wrapped = ((distance + extent / 2) % extent + extent) % extent - extent / 2;
    assert.ok(Math.abs(wrapped) < 1e-6, `${axis} cursor must remain at the map center`);
  }
  const surface = await page.evaluate(() => {
    const r = document.getElementById('field').getBoundingClientRect();
    return { x: r.x, y: r.y, ancestors: ['app', 'viewport'].map(id => { const el = document.getElementById(id); return [id, el.scrollLeft, el.scrollTop]; }) };
  });
  assert.equal(surface.x, 0); assert.equal(surface.y, 0);
  assert.ok(surface.ancestors.every(([, left, top]) => left === 0 && top === 0), `native caret must not scroll map ancestors: ${JSON.stringify(surface)}`);
}

async function observed(observer, x, y, text, version) {
  await observer.waitForFunction(({ x, y, text, version }) => window.textworld.inspect().cells.some(
    cell => cell.x === x && cell.y === y && cell.text === text && cell.version === version,
  ), { x, y, text, version });
}

async function nativeDraft(page, text, start, anchor) {
  await paint(page);
  const geometry = await page.evaluate(({ text, start, anchor }) => {
    const host = document.getElementById('input'), style = getComputedStyle(host);
    const hostBox = host.getBoundingClientRect(), mapBox = document.getElementById('field').getBoundingClientRect();
    const cursorBox = document.getElementById('cursor').getBoundingClientRect();
    const s = window.textworld.inspect(), column = mapBox.width / s.viewport.cols, row = mapBox.height / s.viewport.rows;
    function nativeRange(from, to) {
      const result = document.createRange(), walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      let node, offset = 0, found = false;
      while ((node = walker.nextNode())) {
        const end = offset + node.length;
        if (!found && from <= end) { result.setStart(node, from - offset); found = true; }
        if (found && to <= end) { result.setEnd(node, to - offset); return result; }
        offset = end;
      }
      throw new Error('Native draft range is absent from its editing host');
    }
    const range = nativeRange(start, start + text.length), rect = range.getBoundingClientRect();
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = `${style.fontSize} ${style.fontFamily}`; measure.textBaseline = 'middle';
    const pathData = style.clipPath.match(/^path\(["'](.+)["']\)$/)?.[1];
    const path = pathData ? new Path2D(pathData) : null;
    const centerVisible = r => path ? measure.isPointInPath(path, r.x + r.width / 2 - hostBox.x, r.y + r.height / 2 - hostBox.y) : false;
    const candidateRects = [...range.getClientRects()].filter(r => r.width > .01);
    const outsideRects = [];
    if (start > 0) outsideRects.push(...nativeRange(0, start).getClientRects());
    if (start + text.length < host.textContent.length) outsideRects.push(...nativeRange(start + text.length, host.textContent.length).getClientRects());
    const delta = (value, extent) => ((value + extent / 2) % extent + extent) % extent - extent / 2;
    const cursorCenter = { x: cursorBox.x + cursorBox.width / 2, y: cursorBox.y + cursorBox.height / 2 };
    const worldScreen = (axis, span, extent, scale, origin) => {
      const distance = s.cursor[axis] + .5 - s.camera[axis];
      return origin + (distance + Math.round((span / 2 - distance) / extent) * extent) * scale;
    };
    return {
      nativeText: range.toString(), active: document.activeElement === host, opacity: style.opacity, font: `${style.fontSize} ${style.fontFamily}`,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      target: {
        x: cursorCenter.x - column / 2 + delta(anchor.x - s.cursor.x, s.world.width) * column,
        y: cursorCenter.y + 1 + delta(anchor.y - s.cursor.y, s.world.height) * row - measure.measureText('한').fontBoundingBoxAscent,
        cellTop: cursorCenter.y - row / 2 + delta(anchor.y - s.cursor.y, s.world.height) * row,
        width: measure.measureText(text).width,
      },
      cursorCenter, cameraActive: s.cameraActive,
      expectedCursorCenter: { x: worldScreen('x', s.viewport.cols, s.world.width, column, mapBox.x), y: worldScreen('y', s.viewport.rows, s.world.height, row, mapBox.y) },
      clipPath: style.clipPath, candidateVisible: candidateRects.map(centerVisible),
      contextVisible: outsideRects.filter(r => r.width > .01).map(centerVisible),
      canvasDrafts: window.mapPaints.filter(p => p.color === '#287054' && /Textworld Sarasa/.test(p.font)),
      uncommittedCanvasGlyphs: window.lastMapPaints.filter(p => /Textworld Sarasa/.test(p.font)
        && !(s.localCells || s.cells).some(cell => cell.text === p.text)),
      nativePreview: host.hasAttribute('data-native-preview'),
    };
  }, { text, start, anchor });
  assert.equal(geometry.nativeText, text); assert.equal(geometry.active, true); assert.equal(geometry.opacity, '1');
  assert.equal(geometry.nativePreview, true);
  for (const axis of ['x', 'y']) assert.ok(Math.abs(geometry.cursorCenter[axis] - geometry.expectedCursorCenter[axis]) < .05,
    `native cursor must follow its actual world position during camera movement: ${JSON.stringify(geometry)}`);
  assert.match(geometry.font, /^18px .*Textworld Sarasa/);
  for (const metric of ['x', 'y', 'width']) assert.ok(Math.abs(geometry.rect[metric] - geometry.target[metric]) < .05,
    `native draft ${metric}: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.candidateVisible.length > 0 && geometry.candidateVisible.every(Boolean), 'the actual native candidate must remain inside its visible clip');
  assert.ok(geometry.contextVisible.every(visible => !visible), 'retained native prefix/suffix must not leak into the map');
  assert.deepEqual(geometry.canvasDrafts, [], 'Canvas must not duplicate the native composition glyphs');
  assert.deepEqual(geometry.uncommittedCanvasGlyphs, [], 'uncommitted glyphs must be rendered exclusively by the native editing host');
  await centered(page);
  return geometry;
}

async function scenario(name, run, { mobile = false, x = 10, y = 8, seed = [], largeWorld = false } = {}) {
  const app = createTextworld({ storagePath: ':memory:', now: () => 1_000_000 });
  if (largeWorld) app.world.resize(1024, 512);
  for (const [index, entry] of seed.entries()) app.world.applyWrite({ author: 'neighbor', id: `seed-${index}`, epoch: app.world.epoch, ...entry });
  const { port } = await app.listen(0, '127.0.0.1');
  const context = await browser.newContext(mobile
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
    : { viewport: { width: 1200, height: 900 } });
  const observerContext = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await context.addInitScript(() => {
    window.mapPaints = []; window.lastMapPaints = [];
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.id === 'field') window.lastMapPaints = [];
      return clear.apply(this, args);
    };
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      if (this.canvas.id === 'field') {
        const glyph = { text: String(args[0]), x: args[1], y: args[2], color: this.fillStyle, font: this.font, argumentCount: args.length };
        window.mapPaints.push(glyph); window.lastMapPaints.push(glyph);
        if (window.mapPaints.length > 4000) window.mapPaints.splice(0, 2000);
      }
      return original.apply(this, args);
    };
  });
  const page = await context.newPage(), observer = await observerContext.newPage();
  const errors = [], actorMessages = [], observerMessages = [];
  for (const [item, messages] of [[page, actorMessages], [observer, observerMessages]]) {
    item.setDefaultTimeout(6000);
    item.on('pageerror', error => errors.push(error.message));
    item.on('websocket', socket => socket.on('framereceived', frame => messages.push(JSON.parse(frame.payload.toString()))));
  }
  try {
    const url = `http://127.0.0.1:${port}/#x=${x}&y=${y}`;
    await Promise.all([page.goto(url), observer.goto(url)]);
    await Promise.all([page, observer].map(item => item.waitForFunction(() => {
      const s = window.textworld?.inspect(); return s?.connected && s.fontReady && s.peers.length === 2;
    })));
    if (mobile) await page.touchscreen.tap(160, 300); else await page.mouse.click(450, 350);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'input');
    const cdp = await context.newCDPSession(page);
    await run({ app, page, observer, context, cdp, actorMessages, observerMessages });
    await settle(page); await centered(page); await paint(page);
    assert.equal(await page.locator('#input').evaluate(el => getComputedStyle(el).opacity), '0', 'the retained native context is hidden after composition');
    assert.deepEqual(errors, []);
    passed.push(name); console.log(`PASS ${name}`);
  } catch (error) {
    failed.push({ name, error: error.stack }); console.error(`FAIL ${name}: ${error.stack}`);
  } finally { await context.close(); await observerContext.close(); await app.close(); }
}

try {
  await scenario('Chinese Pinyin drafts stay local; the whole candidate arrives at both clients in one version', async ({ app, page, observer, cdp, observerMessages }) => {
    const seq = app.world.seq;
    await compose(cdp, 'nihao'); await paint(page);
    assert.equal((await state(page)).preedit, 'nihao'); assert.equal(app.world.seq, seq);
    await nativeDraft(page, 'nihao', 0, { x: 10, y: 8 });
    assert.equal((await state(observer)).cells.length, 0);
    await compose(cdp, '你好'); await paint(page);
    assert.equal((await state(page)).preedit, '你好'); assert.equal(app.world.seq, seq);
    await nativeDraft(page, '你好', 0, { x: 10, y: 8 });
    assert.equal(observerMessages.filter(message => message.type === 'view' && message.observation.cells.length).length, 0);
    await commit(cdp, page, '你好');
    assert.equal(app.world.seq, seq + 1);
    await observed(observer, 12, 8, '好', seq + 1);
    assert.deepEqual([10, 11, 12, 13].map(x => cellAt(app, x).version), [seq + 1, seq + 1, seq + 1, seq + 1]);
    assert.equal(textAt(app, 10), '你'); assert.equal(cellAt(app, 11).leadX, 10);
    assert.deepEqual((await state(page)).cursor, { x: 14, y: 8 });
    assert.equal(await page.locator('#input').textContent(), '你好');
    const patches = observerMessages.filter(message => message.type === 'view' && message.observation.cells.length);
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0].observation.cells.map(cell => cell.version), [seq + 1, seq + 1, seq + 1, seq + 1]);
  });

  await scenario('Korean provisional jamo is replaced in place and consecutive syllables retain native context', async ({ app, page, observer, cdp }) => {
    await commit(cdp, page, 'ㅎ'); const provisional = app.world.seq;
    await compose(cdp, '하', { replacementStart: 0, replacementEnd: 1 });
    await compose(cdp, '한'); await paint(page);
    assert.equal(app.world.seq, provisional); assert.equal(textAt(app, 10), 'ㅎ');
    await nativeDraft(page, '한', 0, { x: 10, y: 8 });
    await commit(cdp, page, '한');
    assert.equal(app.world.seq, provisional + 1); assert.equal(textAt(app, 10), '한');
    assert.equal(cellAt(app, 10).width, 2); assert.equal(cellAt(app, 11).leadX, 10);
    await compose(cdp, '글'); await commit(cdp, page, '글');
    assert.equal(app.world.seq, provisional + 2); assert.equal(textAt(app, 12), '글');
    assert.equal(textAt(app, 14), ''); assert.equal(await page.locator('#input').textContent(), '한글');
    assert.deepEqual((await state(page)).cursor, { x: 14, y: 8 });
    await observed(observer, 12, 8, '글', app.world.seq);
    assert.ok(!(await state(observer)).cells.some(cell => cell.text === 'ㅎ' || cell.text === '하'));
  });

  await scenario('Japanese middle reconversion leaves the unchanged suffix at its original address and version', async ({ app, page, observer, cdp, observerMessages }) => {
    await commit(cdp, page, '東京で日本語を学びます。');
    const prefix = cellAt(app, 10), suffix = cellAt(app, 22), seq = app.world.seq;
    await compose(cdp, 'にほん', { replacementStart: 3, replacementEnd: 6 });
    await compose(cdp, '日本'); await paint(page);
    assert.equal(app.world.seq, seq); assert.equal(textAt(app, 20), '語');
    await nativeDraft(page, '日本', 3, { x: 16, y: 8 });
    await commit(cdp, page, '日本');
    assert.equal(app.world.seq, seq + 1);
    assert.deepEqual(cellAt(app, 10), prefix); assert.deepEqual(cellAt(app, 22), suffix);
    assert.equal(textAt(app, 16), '日'); assert.equal(textAt(app, 18), '本');
    assert.equal(textAt(app, 20), ''); assert.equal(textAt(app, 21), '');
    assert.equal(await page.locator('#input').textContent(), '東京で日本を学びます。');
    assert.deepEqual((await state(page)).cursor, { x: 20, y: 8 });
    await observed(observer, 18, 8, '本', seq + 1);
    const patches = observerMessages.filter(message => message.type === 'view' && message.observation.cells.some(cell => cell.version === seq + 1));
    assert.equal(patches.length, 1); assert.ok(patches[0].observation.cells.every(cell => cell.version === seq + 1));
    assert.ok(!patches[0].observation.cells.some(cell => cell.x >= 22));
    assert.deepEqual(patches[0].observation.forget, [{ x: 20, y: 8 }, { x: 21, y: 8 }]);
  });

  await scenario('Reconversion after multiline paste previews and commits on the earlier row without moving the later row', async ({ app, page, observer, context, cdp }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
    await page.evaluate(() => navigator.clipboard.writeText('東京\n日本語'));
    await page.keyboard.press('Control+v'); await settle(page);
    assert.equal(await page.locator('#input').textContent(), '東京\n日本語');
    assert.deepEqual((await state(page)).cursor, { x: 16, y: 9 });
    const laterRow = Array.from({ length: 6 }, (_, index) => cellAt(app, 10 + index, 9)), seq = app.world.seq;
    await page.evaluate(() => { window.mapPaints = []; });
    await compose(cdp, '大阪', { replacementStart: 0, replacementEnd: 2 }); await paint(page);
    assert.equal(app.world.seq, seq); assert.equal((await state(page)).preedit, '大阪');
    await nativeDraft(page, '大阪', 0, { x: 10, y: 8 });
    await commit(cdp, page, '大阪'); assert.equal(app.world.seq, seq + 1);
    assert.equal(textAt(app, 10, 8), '大'); assert.equal(textAt(app, 12, 8), '阪');
    assert.deepEqual(Array.from({ length: 6 }, (_, index) => cellAt(app, 10 + index, 9)), laterRow);
    assert.equal(await page.locator('#input').textContent(), '大阪\n日本語');
    assert.deepEqual((await state(page)).cursor, { x: 14, y: 8 });
    await observed(observer, 12, 8, '阪', seq + 1);
  });

  await scenario('Long Japanese composition retains every character beyond the former 32-character context limit', async ({ app, page, observer, cdp }) => {
    const phrase = '日本語の長い文章を変換し三十二文字を超えても途中で切れず正しい候補が一度だけ共有されます';
    assert.ok(phrase.length > 32); const seq = app.world.seq;
    await compose(cdp, phrase); await paint(page); assert.equal(app.world.seq, seq);
    await nativeDraft(page, phrase, 0, { x: 10, y: 8 });
    await commit(cdp, page, phrase); assert.equal(app.world.seq, seq + 1);
    for (const [index, glyph] of [...phrase].entries()) assert.equal(textAt(app, 10 + 2 * index), glyph);
    assert.equal(await page.locator('#input').textContent(), phrase);
    await observed(observer, 10 + 2 * (phrase.length - 1), 8, phrase.at(-1), seq + 1);
  });

  await scenario('A long mobile CJK commit follows its bounded writing path without revealing the rest of a large world', async ({ app, page, observer, cdp }) => {
    const phrase = '日本語の長い文章を変換し三十二文字を超えても途中で切れず正しい候補が一度だけ共有されます';
    const before = await state(page), seq = app.world.seq;
    assert.ok(phrase.length * 2 > before.observedView.cols, 'The native candidate must span more than this phone can observe');
    await compose(cdp, phrase); await paint(page);
    assert.equal(app.world.seq, seq, 'Uncommitted native drafts remain local');
    await commit(cdp, page, phrase);
    assert.equal(app.world.seq, seq + 1, 'The complete native candidate is one atomic world edit');
    for (const [index, glyph] of [...phrase].entries()) assert.equal(textAt(app, 100 + 2 * index, 100), glyph);
    const after = await state(page);
    assert.deepEqual(after.cursor, { x: 100 + 2 * phrase.length, y: 100 });
    assert.equal(await page.locator('#input').textContent(), phrase);
    assert.equal(after.observedView.cols, before.observedView.cols, 'Typing cannot expand observation privileges');
    assert.ok(after.cells.every(cell => ((cell.x - after.observedView.x + after.world.width) % after.world.width) < after.observedView.cols + 1));
    assert.ok(!after.cells.some(cell => cell.x === 100 && cell.y === 100), 'Earlier text outside the new view must leave the browser cache');
    await observed(observer, 100, 100, phrase[0], seq + 1);
  }, { mobile: true, x: 100, y: 100, largeWorld: true });

  await scenario('Narrow-to-wide native replacement overwrites its footprint without shifting surviving neighbors', async ({ app, page, observer, cdp }) => {
    await commit(cdp, page, 'aX!Z'); const prefix = cellAt(app, 10), suffix = cellAt(app, 13), seq = app.world.seq;
    await compose(cdp, '中', { replacementStart: 1, replacementEnd: 2 }); await commit(cdp, page, '中');
    assert.equal(app.world.seq, seq + 1); assert.deepEqual(cellAt(app, 10), prefix); assert.deepEqual(cellAt(app, 13), suffix);
    assert.equal(textAt(app, 11), '中'); assert.equal(cellAt(app, 12).leadX, 11); assert.equal(cellAt(app, 12).width, 0);
    assert.deepEqual((await state(page)).cursor, { x: 13, y: 8 });
    await observed(observer, 11, 8, '中', seq + 1);
  });

  await scenario('UTF-16 ranges after emoji replace a complete combining grapheme and preserve other coordinates', async ({ app, page, observer, cdp }) => {
    await commit(cdp, page, '🙂e\u0301__Z'); const emoji = cellAt(app, 10), suffix = cellAt(app, 15), seq = app.world.seq;
    assert.equal(textAt(app, 12), 'é');
    await compose(cdp, '한', { replacementStart: 2, replacementEnd: 4 }); await commit(cdp, page, '한');
    assert.equal(app.world.seq, seq + 1); assert.deepEqual(cellAt(app, 10), emoji); assert.deepEqual(cellAt(app, 15), suffix);
    assert.equal(textAt(app, 12), '한'); assert.equal(cellAt(app, 13).leadX, 12); assert.equal(textAt(app, 14), '_');
    assert.equal(await page.locator('#input').textContent(), '🙂한__Z');
    await observed(observer, 12, 8, '한', seq + 1);
  });

  const sample = [
    { x: 25, y: 24, text: 'Textworld  함께 쓰는 지도' },
    { x: 25, y: 26, text: 'iWM 012345  한글 가나다라마바사' },
    { x: 25, y: 27, text: '日本語 かな カナ  中文你好世界' },
    { x: 25, y: 28, text: 'ABC한글DEF  123中文456  ｶﾅ' },
    { x: 25, y: 33, text: '화면 중심에서 바로 입력하세요.' },
    { x: 25, y: 35, text: '한 칸 9px  /  두 칸 18px' },
  ];
  async function checkFontAndGeometry(page) {
    await centered(page); await paint(page);
    const metrics = await page.evaluate(() => {
      const s = window.textworld.inspect(), canvas = document.getElementById('field'), input = document.getElementById('input');
      const box = canvas.getBoundingClientRect(), inputBox = input.getBoundingClientRect();
      const context = document.createElement('canvas').getContext('2d'); context.font = '18px "Textworld Sarasa"';
      return {
        loaded: document.fonts.check('18px "Textworld Sarasa"', '한글日本中文iWM'),
        widths: Object.fromEntries(['i', 'W', 'M', 'é', 'e\u0301', '한', '한', '中', 'あ', 'Ａ', 'ｶ'].map(text => [text, context.measureText(text).width])),
        column: box.width / s.viewport.cols, row: box.height / s.viewport.rows,
        input: { fontSize: getComputedStyle(input).fontSize, fontFamily: getComputedStyle(input).fontFamily, lineHeight: getComputedStyle(input).lineHeight, width: inputBox.width, height: inputBox.height, x: inputBox.x, y: inputBox.y },
        viewport: { width: box.width, height: box.height }, paints: window.mapPaints.filter(p => /Textworld Sarasa/.test(p.font)),
        nativeEditable: input.contentEditable,
      };
    });
    assert.equal(metrics.loaded, true); assert.equal(metrics.column, 9); assert.equal(metrics.row, 26);
    assert.equal(metrics.input.width, 9); assert.equal(metrics.input.height, 26); assert.equal(metrics.input.fontSize, '18px');
    assert.match(metrics.input.fontFamily, /Textworld Sarasa/); assert.equal(metrics.input.lineHeight, '26px');
    assert.equal(metrics.nativeEditable, 'true');
    for (const glyph of ['i', 'W', 'M', 'é', 'e\u0301', 'ｶ']) assert.ok(Math.abs(metrics.widths[glyph] - 9) < .01, `${glyph} must advance 9px`);
    for (const glyph of ['한', '한', '中', 'あ', 'Ａ']) assert.ok(Math.abs(metrics.widths[glyph] - 18) < .01, `${glyph} must advance 18px`);
    assert.ok(metrics.paints.length > 30); assert.ok(metrics.paints.every(paint => /^18px /.test(paint.font) && paint.argumentCount === 3), 'new glyphs must use natural 18px Sarasa advances without fillText maxWidth');
    assert.equal(metrics.input.x + metrics.input.width / 2, metrics.viewport.width / 2);
    assert.equal(metrics.input.y + metrics.input.height / 2, metrics.viewport.height * .43);
    delete metrics.paints; measurements.push(metrics);
    await centered(page);
  }
  async function reachableControls(page) {
    const controls = await page.evaluate(() => ['share', 'gps'].map(id => {
      const el = document.getElementById(id), r = el.getBoundingClientRect();
      return { id, inside: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        hit: el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)),
        coversCenter: r.left <= innerWidth / 2 && r.right >= innerWidth / 2 && r.top <= innerHeight / 2 && r.bottom >= innerHeight / 2 };
    }));
    assert.ok(controls.every(control => control.inside && control.hit && !control.coversCenter), JSON.stringify(controls));
  }
  await scenario('Desktop renders native 9/18px Sarasa advances on a centered full-screen 9×26 grid', async ({ app, page, observer, cdp }) => {
    await checkFontAndGeometry(page); await reachableControls(page);
    await page.screenshot({ path: 'artifacts/standard-cjk-desktop.png' });
    const seq = app.world.seq;
    await compose(cdp, '日本語を入力しています'); await paint(page);
    assert.equal(app.world.seq, seq); assert.equal((await state(page)).preedit, '日本語を入力しています');
    const draftGeometry = await nativeDraft(page, '日本語を入力しています', 0, { x: 40, y: 30 });
    await page.screenshot({ path: 'artifacts/standard-cjk-composition.png' });
    await commit(cdp, page, '日本語を入力しています'); await paint(page);
    assert.equal(app.world.seq, seq + 1); await observed(observer, 48, 30, '入', seq + 1);
    const committedGeometry = await page.evaluate(() => {
      const glyph = window.lastMapPaints.find(p => p.text === '入');
      if (!glyph) throw new Error('The committed candidate was not drawn by the world renderer');
      const context = document.createElement('canvas').getContext('2d'); context.font = glyph.font; context.textBaseline = 'middle';
      const s = window.textworld.inspect(), mapBox = document.getElementById('field').getBoundingClientRect();
      const row = mapBox.height / s.viewport.rows, distance = 30 - s.camera.y;
      const cellTop = (distance + Math.round((s.viewport.rows / 2 - distance) / s.world.height) * s.world.height) * row;
      return { glyphY: glyph.y, top: glyph.y - context.measureText('入').fontBoundingBoxAscent, cellTop, row };
    });
    assert.ok(Math.abs(committedGeometry.glyphY - (committedGeometry.cellTop + committedGeometry.row / 2 + 1)) < .05);
    assert.ok(Math.abs((committedGeometry.top - committedGeometry.cellTop) - (draftGeometry.rect.y - draftGeometry.target.cellTop)) < .05,
      'native-to-world handoff must preserve the glyph baseline relative to its cell during camera movement');
    await centered(page); await paint(page);
    await page.screenshot({ path: 'artifacts/standard-cjk-committed.png' });
  }, { x: 40, y: 30, seed: sample });

  await scenario('Mobile map and reduced-height viewport preserve usable controls, natural spacing and centered input', async ({ app, page, cdp }) => {
    await checkFontAndGeometry(page); await reachableControls(page);
    await page.screenshot({ path: 'artifacts/standard-cjk-mobile.png' });
    const seq = app.world.seq;
    await compose(cdp, '한'.repeat(40)); await nativeDraft(page, '한'.repeat(40), 0, { x: 40, y: 30 });
    assert.equal(app.world.seq, seq);
    await compose(cdp, '한글 입력'); await nativeDraft(page, '한글 입력', 0, { x: 40, y: 30 });
    await page.screenshot({ path: 'artifacts/standard-cjk-composition-mobile.png' });
    await compose(cdp, ''); await paint(page); assert.equal(app.world.seq, seq);
    await page.setViewportSize({ width: 390, height: 390 }); await paint(page); await reachableControls(page); await centered(page);
    assert.equal(await page.locator('#help-toggle, #zoom-in, #zoom-out').count(), 0);
  }, { x: 40, y: 30, mobile: true, seed: sample });

  await writeFile('artifacts/standard-cjk-results.json', JSON.stringify({ passed: passed.length, failed, measurements, coverage: 'Chromium native CDP composition, native DOM range placement/clipping, committed Canvas handoff and actual app/WebSocket; physical OS keyboards and candidate windows remain unverified' }, null, 2));
  console.log(JSON.stringify({ passed: passed.length, failed: failed.length, coverage: 'native Chromium composition, 2 independent contexts, font metrics, desktop/mobile layout; no physical OS keyboard claim' }));
  if (failed.length) process.exitCode = 1;
} finally { await browser.close(); }
