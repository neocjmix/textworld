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
  const s = await state(page);
  for (const [axis, span, extent] of [['x', s.viewport.cols, s.world.width], ['y', s.viewport.rows, s.world.height]]) {
    const distance = s.camera[axis] + span / 2 - s.cursor[axis] - .5;
    const wrapped = ((distance + extent / 2) % extent + extent) % extent - extent / 2;
    assert.ok(Math.abs(wrapped) < 1e-6, `${axis} cursor must remain at the map center`);
  }
}

async function observed(observer, x, y, text, version) {
  await observer.waitForFunction(({ x, y, text, version }) => window.textworld.inspect().cells.some(
    cell => cell.x === x && cell.y === y && cell.text === text && cell.version === version,
  ), { x, y, text, version });
}

async function scenario(name, run, { mobile = false, x = 10, y = 8, seed = [] } = {}) {
  const app = createTextworld({ storagePath: ':memory:', now: () => 1_000_000 });
  for (const [index, entry] of seed.entries()) app.world.applyWrite({ author: 'neighbor', id: `seed-${index}`, epoch: app.world.epoch, ...entry });
  const { port } = await app.listen(0, '127.0.0.1');
  const context = await browser.newContext(mobile
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
    : { viewport: { width: 1200, height: 900 } });
  const observerContext = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await context.addInitScript(() => {
    window.mapPaints = [];
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      if (this.canvas.id === 'field') {
        window.mapPaints.push({ text: String(args[0]), x: args[1], y: args[2], color: this.fillStyle, font: this.font, argumentCount: args.length });
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
    await settle(page); await centered(page);
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
    assert.equal((await state(observer)).cells.length, 0);
    await compose(cdp, '你好'); await paint(page);
    assert.equal((await state(page)).preedit, '你好'); assert.equal(app.world.seq, seq);
    assert.equal(observerMessages.filter(message => message.type === 'cells').length, 0);
    await commit(cdp, page, '你好');
    assert.equal(app.world.seq, seq + 1);
    await observed(observer, 12, 8, '好', seq + 1);
    assert.deepEqual([10, 11, 12, 13].map(x => cellAt(app, x).version), [seq + 1, seq + 1, seq + 1, seq + 1]);
    assert.equal(textAt(app, 10), '你'); assert.equal(cellAt(app, 11).leadX, 10);
    assert.deepEqual((await state(page)).cursor, { x: 14, y: 8 });
    assert.equal(await page.locator('#input').textContent(), '你好');
    assert.equal(observerMessages.filter(message => message.type === 'cells').length, 1);
  });

  await scenario('Korean provisional jamo is replaced in place and consecutive syllables retain native context', async ({ app, page, observer, cdp }) => {
    await commit(cdp, page, 'ㅎ'); const provisional = app.world.seq;
    await compose(cdp, '하', { replacementStart: 0, replacementEnd: 1 });
    await compose(cdp, '한'); await paint(page);
    assert.equal(app.world.seq, provisional); assert.equal(textAt(app, 10), 'ㅎ');
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
    await commit(cdp, page, '日本');
    assert.equal(app.world.seq, seq + 1);
    assert.deepEqual(cellAt(app, 10), prefix); assert.deepEqual(cellAt(app, 22), suffix);
    assert.equal(textAt(app, 16), '日'); assert.equal(textAt(app, 18), '本');
    assert.equal(textAt(app, 20), ''); assert.equal(textAt(app, 21), '');
    assert.equal(await page.locator('#input').textContent(), '東京で日本を学びます。');
    assert.deepEqual((await state(page)).cursor, { x: 20, y: 8 });
    await observed(observer, 18, 8, '本', seq + 1);
    const patches = observerMessages.filter(message => message.type === 'cells' && message.seq === seq + 1);
    assert.equal(patches.length, 1); assert.ok(patches[0].cells.every(cell => cell.version === seq + 1));
    assert.ok(!patches[0].cells.some(cell => cell.x >= 22));
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
    const preview = await page.evaluate(() => {
      const r = document.getElementById('field').getBoundingClientRect();
      return { glyphs: window.mapPaints.filter(p => p.color === '#287054' && ['大', '阪'].includes(p.text)), width: r.width, height: r.height };
    });
    assert.ok(preview.glyphs.length >= 2, 'both uncommitted candidate glyphs must be painted');
    for (const glyph of preview.glyphs) {
      assert.equal(glyph.y, preview.height / 2 + 1 - 26, 'earlier-row candidate must be painted one row above the center');
      assert.equal(glyph.x, preview.width / 2 + (10 - 16) * 9 + 4.5 + (glyph.text === '阪' ? 18 : 0));
    }
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
    await commit(cdp, page, phrase); assert.equal(app.world.seq, seq + 1);
    for (const [index, glyph] of [...phrase].entries()) assert.equal(textAt(app, 10 + 2 * index), glyph);
    assert.equal(await page.locator('#input').textContent(), phrase);
    await observed(observer, 10 + 2 * (phrase.length - 1), 8, phrase.at(-1), seq + 1);
  });

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
    await paint(page);
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
    assert.equal(metrics.input.y + metrics.input.height / 2, metrics.viewport.height / 2);
    delete metrics.paints; measurements.push(metrics);
    await centered(page);
  }
  async function reachableControls(page) {
    const controls = await page.evaluate(() => ['share', 'help-toggle', 'gps', 'zoom-in', 'zoom-out'].map(id => {
      const el = document.getElementById(id), r = el.getBoundingClientRect();
      return { id, inside: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        hit: el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)),
        coversCenter: r.left <= innerWidth / 2 && r.right >= innerWidth / 2 && r.top <= innerHeight / 2 && r.bottom >= innerHeight / 2 };
    }));
    assert.ok(controls.every(control => control.inside && control.hit && !control.coversCenter), JSON.stringify(controls));
  }
  await scenario('Desktop renders native 9/18px Sarasa advances on a centered full-screen 9×26 grid', async ({ app, page, cdp }) => {
    await checkFontAndGeometry(page); await reachableControls(page);
    await page.screenshot({ path: 'artifacts/standard-cjk-desktop.png' });
    const seq = app.world.seq;
    await compose(cdp, '日本語を入力しています'); await paint(page);
    assert.equal(app.world.seq, seq); assert.equal((await state(page)).preedit, '日本語を入力しています');
    await page.screenshot({ path: 'artifacts/standard-cjk-composition.png' });
    await compose(cdp, ''); assert.equal(app.world.seq, seq);
  }, { x: 40, y: 30, seed: sample });

  await scenario('Mobile map and reduced-height help preserve usable controls, natural spacing and centered input', async ({ page }) => {
    await checkFontAndGeometry(page); await reachableControls(page);
    await page.screenshot({ path: 'artifacts/standard-cjk-mobile.png' });
    await page.locator('#help-toggle').click();
    assert.equal(await page.locator('#help').evaluate(el => el.open), true);
    assert.match(await page.locator('#help').textContent(), /영문은 한 칸, 한글·한자는 두 칸/);
    await page.screenshot({ path: 'artifacts/standard-cjk-help-mobile.png' });
    await page.locator('#help-close').click();
    await page.setViewportSize({ width: 390, height: 390 }); await paint(page); await reachableControls(page); await centered(page);
    await page.locator('#help-toggle').click();
    const help = await page.locator('#help').evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: el.clientWidth, contentWidth: el.scrollWidth, height: el.clientHeight, contentHeight: el.scrollHeight }; });
    assert.ok(help.x >= 0 && help.y >= 0 && help.right <= 390 && help.bottom <= 390);
    assert.ok(help.contentWidth <= help.width, 'help text must not cause horizontal overflow');
    assert.ok(help.contentHeight > help.height, 'reduced viewport uses a scrollable help dialog');
    await page.locator('#help-close').click();
  }, { x: 40, y: 30, mobile: true, seed: sample });

  await writeFile('artifacts/standard-cjk-results.json', JSON.stringify({ passed: passed.length, failed, measurements, coverage: 'Chromium native CDP composition and actual app/WebSocket/canvas; physical OS keyboards and candidate windows remain unverified' }, null, 2));
  console.log(JSON.stringify({ passed: passed.length, failed: failed.length, coverage: 'native Chromium composition, 2 independent contexts, font metrics, desktop/mobile layout; no physical OS keyboard claim' }));
  if (failed.length) process.exitCode = 1;
} finally { await browser.close(); }
