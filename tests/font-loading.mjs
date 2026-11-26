import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';
import { createTextworld } from '../server/index.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const app = createTextworld({ storagePath: ':memory:', now: () => 1_000_000 });
const address = await app.listen(0, '127.0.0.1');
const origin = `http://127.0.0.1:${address.port}`;
const manifest = JSON.parse(await readFile(new URL('../public/fonts/subsets.json', import.meta.url)));
const reports = [];
const samples = ['iWM', '한', '글', '한글', '한', '中文日本語', 'あアｶ', 'éΩ—Ａ', '각', '字\u{E0100}', '0\uFE00', '！\uFE00', '가\u302e', 'A\u0301', 'العربية', '⠁⠂↔⬛', '𠮷'];
try {
  for (const engine of (process.env.BROWSERS || 'chromium,firefox,webkit').split(',')) {
    const launch = () => ({ chromium, firefox, webkit })[engine].launch({ headless: true,
      ...(engine === 'chromium' ? { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] } : {}) });
    const browser = await launch();
    let delayedBrowser;
    try {
      const context = await browser.newContext(); const page = await context.newPage();
      const fetched = [], errors = [];
      page.on('request', request => { if (request.url().endsWith('.woff2')) fetched.push(new URL(request.url()).pathname); });
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(origin); await page.waitForFunction(() => window.textworld?.inspect().connected);
      assert.equal(fetched.length, 1, 'an empty first visit fetches only the core part');
      assert.match(fetched[0], /-core-/);
      const results = await page.evaluate(async samples => {
        const original = new FontFace('Original Sarasa', 'url(/fonts/sarasa-fixed-k-regular-1.0.43.woff2)');
        document.fonts.add(await original.load());
        const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 80;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        function draw(text, font) {
          ctx.clearRect(0, 0, 400, 80); ctx.font = `18px "${font}"`; ctx.textBaseline = 'middle';
          ctx.fillText(text, 20, 40);
          return { width: ctx.measureText(text).width, pixels: ctx.getImageData(0, 0, 400, 80).data };

        }
        const results = [];
        for (const text of samples) {
          await document.fonts.load('18px "Textworld Sarasa"', text);
          await document.fonts.ready;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          if (!document.fonts.check('18px "Textworld Sarasa"', text)) throw new Error('Font part did not load: ' + text);
          const full = draw(text, 'Original Sarasa'), split = draw(text, 'Textworld Sarasa');
          if (!split.pixels.some(v => v > 0)) throw new Error('Glyph did not paint: ' + text);
          results.push({ text, originalWidth: full.width, subsetWidth: split.width,
            inkDifference: full.pixels.reduce((sum, value, i) => sum + (i % 4 === 3 ? Math.abs(value - split.pixels[i]) : 0), 0) / Math.max(1, full.pixels.reduce((sum, value, i) => sum + (i % 4 === 3 ? value : 0), 0)),
            maxDifference: full.pixels.reduce((max, value, i) => Math.max(max, Math.abs(value - split.pixels[i])), 0), differingChannels: full.pixels.reduce((count, value, i) => count + Number(value !== split.pixels[i]), 0) });
        }
        for (const text of ['한', '각', '힣']) {
          await document.fonts.load('18px "Textworld Sarasa"', text + text.normalize('NFD'));
          const nfc = draw(text, 'Textworld Sarasa'), nfd = draw(text.normalize('NFD'), 'Textworld Sarasa');
          results.push({ text: text + ' NFC/NFD', originalWidth: nfc.width, subsetWidth: nfd.width,
            inkDifference: nfc.pixels.some((v, i) => v !== nfd.pixels[i]) ? 1 : 0, differingChannels: 0 });
        }
        return results;
      }, samples);
      for (const result of results) {
        assert.ok(Math.abs(result.originalWidth - result.subsetWidth) < .01, `${engine}: width ${JSON.stringify(result)}`);
        // The builder verifies all outlines and variation mappings. Pixel AA can
        // differ between a full font and a subset, so record that difference.
        // Canonically equivalent Hangul must render identically within the face.
        if (result.text.endsWith('NFC/NFD')) assert.equal(result.inkDifference, 0, `${engine}: canonical Hangul ${JSON.stringify(result)}`);
      }
      assert.deepEqual(errors, []);
      reports.push({ engine, version: browser.version(), results, fontRequests: fetched.length });
      console.log(`${engine}: ${results.length} loaded font, advance and canonical Hangul checks passed (raster differences recorded)`);
      await context.close();
      // No further world traffic is needed to repaint a glyph whose font arrives late.
      // WebKit can retain decoded fonts across contexts in one browser process.
      delayedBrowser = await launch();
      const late = await delayedBrowser.newContext();
      let releaseFont, requestedFont;
      const held = new Promise(resolve => { releaseFont = resolve; });
      const requested = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Delayed font was never requested')), 10000);
        requestedFont = () => { clearTimeout(timer); resolve(); };
      });
      await late.route('**/fonts/sarasa.css', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replace(/(\/fonts\/[^"]*-hangul-[^"]*\.woff2)/g, '$1?late-font-test=1') });
      });
      await late.route('**/fonts/*-hangul-*.woff2*', async route => {
        requestedFont(); await held; await route.continue();
      });
      await late.addInitScript(() => {
        window.fontPaints = []; window.fontEvents = [];
        for (const type of ['loading', 'loadingdone', 'loadingerror']) document.fonts.addEventListener(type, () => window.fontEvents.push(type));
        const original = CanvasRenderingContext2D.prototype.fillText;
        CanvasRenderingContext2D.prototype.fillText = function (text, ...rest) {
          if (this.canvas.id === 'field' && text === '각') window.fontPaints.push([...document.fonts].find(face => /U\+AC00/i.test(face.unicodeRange))?.status === 'loaded');
          return original.call(this, text, ...rest);
        };
      });
      const delayed = await late.newPage();
      await delayed.goto(`${origin}/#x=10&y=8`);
      await delayed.waitForFunction(() => window.textworld?.inspect().connected);
      await delayed.mouse.click(300, 300); await delayed.keyboard.insertText('각');
      await requested;
      await delayed.waitForFunction(() => window.textworld.inspect().pending === 0 && window.fontPaints.length > 0);
      assert.equal(await delayed.evaluate(() => window.fontPaints.at(-1)), false);
      releaseFont();
      await delayed.waitForFunction(() => window.fontPaints.at(-1) === true, null, { timeout: 5000 }).catch(async error => {
        console.log(await delayed.evaluate(() => ({ events: window.fontEvents, paints: window.fontPaints, faces: [...document.fonts].filter(face => /ac00/i.test(face.unicodeRange)).map(face => ({ status: face.status, range: face.unicodeRange })) })));
        throw error;
      });
      await delayed.keyboard.press('Backspace');
      await delayed.waitForFunction(() => window.textworld.inspect().pending === 0);
      await late.close();
      console.log(`${engine}: delayed unicode-range font repaints an idle map`);
    } finally { await delayedBrowser?.close(); await browser.close(); }
  }
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/font-loading.json', JSON.stringify({ parts: manifest.parts.length, characters: manifest.characters, reports }, null, 2));
} finally { await app.close(); }
