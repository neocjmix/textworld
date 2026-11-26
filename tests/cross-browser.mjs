// Real browser input and multi-user updates; this does not emulate an OS IME.
import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';
import { createTextworld } from '../server/index.js';
import { readAssetRelease } from '../server/asset-release.js';
import { resolve } from 'node:path';

const app = createTextworld({ storagePath: ':memory:', now: () => 1_000_000,
  staticRelease: process.env.TEXTWORLD_BUILT_ASSETS ? await readAssetRelease(resolve('.')) : null });
const address = await app.listen(0, '127.0.0.1');
const origin = process.env.BROWSER_TEST_URL || `http://127.0.0.1:${address.port}`;
const engines = (process.env.BROWSERS || 'chromium,firefox,webkit').split(',');
const state = page => page.evaluate(() => window.textworld.inspect());
const settled = page => page.waitForFunction(() => window.textworld.inspect().pending === 0);
const cell = (page, x, y, text) => page.waitForFunction(({ x, y, text }) =>
  (window.textworld.inspect().cells.find(c => c.x === x && c.y === y)?.text || '') === text, { x, y, text });
try {
  for (const engine of engines) {
    const browser = await ({ chromium, firefox, webkit })[engine].launch({ headless: true,
      ...(engine === 'chromium' ? { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] } : {}) });
    try {
      const errors = [];
      const aContext = await browser.newContext({ viewport: { width: 1100, height: 800 } });
      const bContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
      const a = await aContext.newPage(), b = await bContext.newPage();
      for (const page of [a, b]) page.on('pageerror', e => errors.push(e.message));
      await Promise.all([a.goto(`${origin}/#x=10&y=8`), b.goto(`${origin}/#x=10&y=8`)]);
      for (const page of [a, b]) await page.waitForFunction(() => window.textworld?.inspect().connected && window.textworld.inspect().peers.length >= 2);
      await a.mouse.click(400, 300); await a.keyboard.insertText('한A日'); await settled(a);
      await cell(b, 10, 8, '한'); await cell(b, 12, 8, 'A'); await cell(b, 13, 8, '日');
      assert.deepEqual((await state(a)).cursor, { x: 15, y: 8 });
      await a.keyboard.press('Enter'); await a.keyboard.insertText('Z'); await settled(a);
      await cell(b, 10, 9, 'Z');
      await a.keyboard.press('Backspace'); await settled(a); await cell(b, 10, 9, '');
      await b.touchscreen.tap(120, 350); await b.keyboard.insertText('별'); await settled(b);
      await cell(a, 10, 8, '별'); await cell(a, 12, 8, 'A');
      await a.keyboard.press('ArrowRight'); await settled(a);
      assert.deepEqual((await state(a)).cursor, { x: 11, y: 9 });
      const geometry = await b.evaluate(() => {
        const box = document.getElementById('field').getBoundingClientRect();
        return { width: box.width, height: box.height, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.deepEqual(geometry, { width: 390, height: 844, overflow: false });
      await a.reload(); await a.waitForFunction(() => window.textworld?.inspect().connected);
      await cell(a, 10, 8, '별'); await cell(a, 12, 8, 'A');
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ engine, version: browser.version(), status: 'passed', checks: ['two independent views', 'CJK width', 'Enter', 'Backspace', 'overwrite', 'arrow', 'touch input', 'mobile viewport', 'reload convergence', 'no runtime errors'] }));
    } finally { await browser.close(); }
  }
} finally { await app.close(); }
