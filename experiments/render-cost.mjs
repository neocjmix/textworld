// Browser-only paint comparison, NOT a server concurrency test. Inject a fixed
// 1,000-cursor observation fixture through a real browser WebSocket route.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { decodeWire } from '../shared/wire.js';

const root = resolve(process.env.RENDER_TARGET_ROOT || '.');
const { createTextworld } = await import(pathToFileURL(resolve(root, 'server/index.js')));
const app = createTextworld({ storagePath: ':memory:', now: () => 1_000_000 });
app.world.densityController.decide = () => ({ changed: false });
for (let y = 22; y < 42; y++) app.world.applyWrite({ author: 'seed', id: String(y), epoch: 1, x: 34, y, text: '漢'.repeat(28) });
const { port } = await app.listen(0, '127.0.0.1');
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const people = Array.from({ length: 999 }, (_, i) => ({ id: 'fixture-' + i, name: '독자' + i, color: '#487a61',
    x: 20 + i % 90, y: 21 + Math.floor(i / 90) }));
  let client;
  await page.routeWebSocket('**/ws', socket => {
    client = socket;
    const upstream = socket.connectToServer();
    socket.onMessage(raw => upstream.send(raw));
    upstream.onMessage(raw => {
      const envelope = decodeWire(JSON.parse(String(raw)));
      for (const message of envelope.messages || [envelope]) {
        if (message.type === 'snapshot' && message.peers) message.peers.push(...people);
        if (message.type === 'view' && !message.observation.partial) message.observation.peers.push(...people);
      }
      socket.send(JSON.stringify(envelope));
    });
  });
  await page.addInitScript(() => {
    sessionStorage.setItem('textworld-intro-seen', '1');
    window.paintSamples = []; window.collectPaint = false;
    let glyphs = 0;
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(...args) {
      if (this.canvas.id === 'field') glyphs++;
      return fillText.apply(this, args);
    };
    const raf = requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => raf(time => {
      const start = performance.now(), before = glyphs;
      const answer = callback(time);
      if (window.collectPaint && glyphs !== before) window.paintSamples.push({ ms: performance.now() - start, glyphs: glyphs - before });
      return answer;
    });
  });
  await page.goto(`http://127.0.0.1:${port}/#x=64&y=32`);
  await page.waitForFunction(() => window.textworld?.inspect().connected && !window.textworld.inspect().cameraActive);
  await page.evaluate(() => document.fonts.load('18px "Textworld Sarasa"', '한漢'));
  await page.waitForTimeout(200);
  const state = await page.evaluate(() => window.textworld.inspect());
  assert.equal(state.peers.length, 1000);
  let revision = state.viewRevision;
  await page.evaluate(() => { window.collectPaint = true; window.paintSamples = []; });
  for (let n = 0; n < 120; n++) {
    const x = 40 + 2 * (n % 20), y = 26 + n % 10, version = 10000 + n;
    const peer = { ...people[n % people.length], x: 24 + n % 70, y: 25 + n % 10 };
    client.send(JSON.stringify({ type: 'view', world: state.world, observation: {
      partial: true, revision: ++revision, view: state.observedView,
      cells: [{ x, y, text: n % 2 ? '한' : '漢', width: 2, leadX: null, version },
        { x: x + 1, y, text: '', width: 0, leadX: x, version }], forget: [], marks: [], unmark: [],
      freshness: { [version]: 'now' }, colors: { [version]: n % 2 ? '#34715e' : '#2a536a' },
      forgetVersions: [], peers: [peer], departed: [] } }));
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(100);
  const samples = await page.evaluate(() => window.paintSamples);
  const quantile = (key, p) => samples.map(s => s[key]).sort((a, b) => a - b)[Math.ceil(samples.length * p) - 1];
  const result = { fixture: '1000 visible cursors, 560 CJK glyphs, 20 remote updates/s, desktop Chromium, browser paint only',
    source: createHash('sha256').update(await readFile(resolve(root, 'public/app.js'))).digest('hex'),
    samples: samples.length, frameP50Ms: quantile('ms', .5), frameP95Ms: quantile('ms', .95),
    frameMaxMs: quantile('ms', 1), drawCallsP50: quantile('glyphs', .5), drawCallsP95: quantile('glyphs', .95), raw: samples };
  assert(samples.length >= 100);
  await page.evaluate(() => { window.paintSamples = []; });
  await page.mouse.move(500, 400);
  for (let n = 0; n < 60; n++) { await page.mouse.wheel(n < 30 ? 9 : -9, 0); await page.waitForTimeout(25); }
  await page.waitForFunction(() => !window.textworld.inspect().cameraActive);
  const motion = await page.evaluate(() => window.paintSamples.map(s => s.ms).sort((a,b) => a-b));
  assert(motion.length >= 60);
  result.motion = { frames: motion.length, p50Ms: motion[Math.ceil(motion.length*.5)-1],
    p95Ms: motion[Math.ceil(motion.length*.95)-1], maxMs: motion.at(-1) };
  await writeFile(process.argv[2], JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, raw: undefined }));
} finally { await browser.close(); await app.close(); }
