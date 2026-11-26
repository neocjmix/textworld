// Explicit, bounded production probe: two ordinary browsers, one glyph/12 s.
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const [duration, output] = process.argv.slice(2), seconds = Number(duration);
if (!Number.isInteger(seconds) || seconds < 12 || seconds > 930 || !output) {
  throw Error('Usage: node experiments/public-paint.mjs SECONDS(12..930) OUTPUT.json');
}
const origin = 'https://textworld-production-987c.up.railway.app';
const options = { executablePath: '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] };
if (process.env.HTTPS_PROXY) {
  const proxy = new URL(process.env.HTTPS_PROXY);
  options.proxy = { server: proxy.protocol + '//' + proxy.host };
  if (proxy.username) options.proxy.username = decodeURIComponent(proxy.username);
  if (proxy.password) options.proxy.password = decodeURIComponent(proxy.password);
}
const browser = await chromium.launch(options);
const samples = [], errors = [], startedAt = new Date().toISOString();
const watchdog = setTimeout(() => void browser.close(), (seconds + 120) * 1000);
watchdog.unref();
try {
  const pages = [];
  for (const width of [1200, 390]) {
    const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width, height: 844 } });
    page.on('pageerror', error => errors.push(error.name));
    await page.addInitScript(() => {
      const fill = CanvasRenderingContext2D.prototype.fillText;
      window.paintProbe = {};
      CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
        if (text === window.paintProbe.target && !window.paintProbe.at) {
          window.paintProbe.at = performance.timeOrigin + performance.now();
        }
        return fill.call(this, text, ...args);
      };
    });
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => window.textworld?.inspect().connected, null, { timeout: 30000 });
    pages.push(page);
  }
  const [writer, reader] = pages, start = Date.now();
  for (let i = 0; i * 12 < seconds; i++) {
    await sleep(Math.max(0, start + i * 12000 - Date.now()));
    const glyph = String.fromCodePoint(0x5a00 + i);
    const before = await reader.evaluate(async () => {
      const health = await (await fetch('/health', { cache: 'no-store', signal: AbortSignal.timeout(10000) })).json();
      const view = window.textworld.inspect();
      return { peers: health.peers, capacity: health.capacity, revision: health.revision,
        world: health.world, visiblePeers: view.peers.length, visibleCells: view.cells.length };
    });
    const sample = { at: new Date().toISOString(), elapsedSeconds: (Date.now() - start) / 1000, ...before };
    await Promise.all(pages.map(page => page.evaluate(target => { window.paintProbe = { target }; }, glyph)));
    try {
      await writer.locator('#input').focus();
      const sent = await writer.evaluate(() => performance.timeOrigin + performance.now());
      await writer.keyboard.insertText(glyph);
      await reader.waitForFunction(() => window.paintProbe.at, null, { timeout: 4000, polling: 40 });
      const [local, remote] = await Promise.all(pages.map(page => page.evaluate(() => window.paintProbe.at)));
      Object.assign(sample, { localMs: local - sent, remoteMs: remote - sent });
      await writer.keyboard.press('Home');
    } catch { sample.missed = true; }
    samples.push(sample);
    console.log(JSON.stringify(sample));
  }
  await sleep(Math.max(0, start + seconds * 1000 - Date.now()));
} finally {
  clearTimeout(watchdog);
  await browser.close();
  await writeFile(output, JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), origin,
    desktopWidth: 1200, mobileWidth: 390, samples, errors }, null, 2));
}
