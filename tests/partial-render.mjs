// Compare incremental pixels with an invalidated full repaint of the same state.
import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createTextworld } from '../server/index.js';
import { decodeWire } from '../shared/wire.js';

const results = [];
for (const engine of (process.env.BROWSERS || 'chromium').split(',')) {
  let now = 10_000_000;
  const app = createTextworld({ storagePath: ':memory:', now: () => now });
  app.world.densityController.decide = () => ({ changed: false, reason: 'pixel-fixture' });
  now -= 80000;
  app.world.registerAuthor('seed', '#245389');
  for (let y = 24; y < 40; y++) app.world.applyWrite({ author: 'seed', id: String(y), epoch: app.world.epoch,
    x: 38, y, text: '한A日B😀é　'.repeat(4) });
  now += 80000;
  const { port } = await app.listen(0, '127.0.0.1');
  const browser = await ({ chromium, firefox, webkit })[engine].launch({ headless: true,
    ...(engine === 'chromium' ? { executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] } : {}) });
  const writers = [];
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1.25 });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/#x=64&y=32`);
    const rest = () => page.waitForFunction(() => window.textworld?.inspect().connected && !window.textworld.inspect().cameraActive && !window.textworld.inspect().pending);
    await rest();
    await page.evaluate(() => document.fonts.load('18px "Textworld Sarasa"', '國界本é'));
    const check = async label => {
      await rest();
      const result = await page.evaluate(async () => {
        await document.fonts.ready;
        const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await frame();
        const canvas = document.getElementById('field'), ctx = canvas.getContext('2d');
        const before = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const beforeState = window.textworld.inspect(), beforePng = canvas.toDataURL();
        const paint = window.textworld.inspect().paint;
        window.textworld.repaint();
        await frame();
        const forcedFull = window.textworld.inspect().paint.fullFrames - paint.fullFrames;
        const after = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let differingChannels = 0, maxDifference = 0;
        for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) {
          differingChannels++; maxDifference = Math.max(maxDifference, Math.abs(before[i] - after[i]));
        }
        return { differingChannels, maxDifference, channels: before.length, paint, forcedFull, full: window.textworld.inspect().paint,
          ...(differingChannels ? { beforeCamera: beforeState.camera, afterCamera: window.textworld.inspect().camera,
            beforePng, afterPng: canvas.toDataURL() } : {}) };
      });
      if (result.differingChannels) {
        await mkdir('artifacts', { recursive: true });
        for (const key of ['beforePng', 'afterPng']) {
          await writeFile(`artifacts/damage-${key}.png`, Buffer.from(result[key].split(',')[1], 'base64'));
          delete result[key];
        }
      }
      results.push({ engine, label, ...result });
      // Chromium's fractional-DPR clipped text can round a small number of
      // channels by one level. Larger differences (including edge ink buildup)
      // and widespread changes remain a failure.
      assert(result.maxDifference <= 1 && result.differingChannels <= result.channels * .001,
        `${engine} ${label}: ${JSON.stringify(result)}`);
      assert(result.forcedFull >= 1, 'A full repaint must actually occur before comparing pixels: ' + JSON.stringify(result));
      return result;
    };
    const writer = async name => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { localAddress: '127.0.0.2' });
      writers.push(ws);
      let seq = 0, epoch;
      const initial = new Promise(resolve => ws.once('message', raw => { epoch = JSON.parse(raw).world.epoch; resolve(); }));
      await initial;
      const waits = new Map();
      ws.on('message', raw => {
        const envelope = decodeWire(JSON.parse(raw));
        for (const m of envelope.messages || [envelope]) {
          if (m.world) epoch = m.world.epoch;
          if (m.type === 'ack') waits.get(m.id)?.resolve(m);
          if (m.type === 'error') waits.get(m.id)?.reject(Error(JSON.stringify(m)));
        }
      });
      ws.send(JSON.stringify({ type: 'hello', name, batchVersion: 1, wireVersion: 1, topologyDelta: 1 }));
      return async action => {
        const id = 'test-' + ++seq, deferred = Promise.withResolvers(); waits.set(id, deferred);
        ws.send(JSON.stringify({ type: 'input', id, sequence: seq, epoch, action }));
        const ack = await deferred.promise;
        await page.waitForTimeout(90);
        return ack;
      };
    };
    const first = await writer('겹친 이름 A'), second = await writer('겹친 이름 B');
    await first({ kind: 'goto', x: 64, y: 32, newOrigin: true });
    await second({ kind: 'goto', x: 65, y: 32, newOrigin: true });
    await check('overlapping peer labels and CJK');
    await first({ kind: 'type', text: '國' });
    const overwrite = await check('wide overwrite and moving remote cursor');
    assert(overwrite.paint.fraction < .1, JSON.stringify(overwrite));
    await first({ kind: 'backspace' });
    await check('erase old wide glyph');
    await first({ kind: 'type', text: 'é' });
    await check('combining glyph and cursor occlusion');
    now += 16000;
    await page.waitForFunction(() => {
      const s = window.textworld.inspect(), c = s.cells.find(c => c.x === 64 && c.y === 32);
      return c && s.freshness[c.version] === 'recent';
    });
    await check('freshness opacity');
    writers[1].close(); await once(writers[1], 'close'); await page.waitForTimeout(100);
    await check('departed label footprint');
    await page.locator('#input').focus(); await page.keyboard.insertText('本');
    await check('optimistic typing and camera movement');
    await page.setViewportSize({ width: 390, height: 844 });
    // ResizeObserver and the keyboard/viewport CSS transition can start after
    // the first idle-camera check; compare pixels only after layout settles.
    await page.waitForTimeout(1000);
    await check('mobile viewport resize');
    app.world.resize(32, 16);
    await page.waitForFunction(epoch => window.textworld.inspect().world.epoch === epoch, app.world.epoch);
    await check('tiny torus repeats and topology correction');
    await first({ kind: 'type', text: '界' });
    await check('partial damage on repeated torus');
    now += 190000;
    await page.waitForFunction(() => window.textworld.inspect().cells.length === 0, null, { timeout: 15000 });
    await check('actual expiry deletes pixels');
    assert.deepEqual(errors, []);
    console.log(engine + ': ' + results.filter(r => r.engine === engine).length + ' pixel comparisons passed');
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: `artifacts/partial-render-${engine}.png` });
  } finally {
    for (const writer of writers) writer.terminate();
    await browser.close(); await app.close();
  }
}
await writeFile('artifacts/partial-render.json', JSON.stringify(results, null, 2));
