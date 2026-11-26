// Explicit, bounded production probe: two ordinary browsers, one glyph/12 s.
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const [duration, output] = process.argv.slice(2), seconds = Number(duration);
if (!Number.isInteger(seconds) || seconds < 12 || seconds > 930 || !output) {
  throw Error('Usage: node experiments/public-paint.mjs SECONDS(12..930) OUTPUT.json');
}
const origin = 'https://textworld-production-987c.up.railway.app';
const point = process.env.PUBLIC_PAINT_POINT;
if (point && !/^\d{1,6},\d{1,6}$/.test(point)) throw Error('PUBLIC_PAINT_POINT must be nonnegative x,y');
const entry = point ? '/#x=' + point.split(',')[0] + '&y=' + point.split(',')[1] : '/';
const quietFrom = Date.parse(process.env.PUBLIC_PAINT_QUIET_FROM || '');
const quietUntil = Date.parse(process.env.PUBLIC_PAINT_QUIET_UNTIL || '');
if ((process.env.PUBLIC_PAINT_QUIET_FROM || process.env.PUBLIC_PAINT_QUIET_UNTIL)
  && !(Number.isFinite(quietFrom) && Number.isFinite(quietUntil) && quietUntil > quietFrom)) {
  throw Error('Quiet window requires two valid ISO times, in increasing order');
}
const glyphBase = 0x4e00 + Date.now() % 8000;
const screenshotAt = Number(process.env.PUBLIC_PAINT_SCREENSHOT_AT || 0);
if (!Number.isInteger(screenshotAt) || screenshotAt < 0 || screenshotAt > 1000) {
  throw Error('Screenshot threshold must be an integer from 0 to 1000');
}
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
const samples = [], errors = [], screenshots = [], startedAt = new Date().toISOString();
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
      const Socket = window.WebSocket;
      window.WebSocket = class extends Socket {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', event => {
            const probe = window.paintProbe, data = event.data;
            if (!probe.target || typeof data !== 'string') return;
            if (!probe.receivedAt && data.includes(JSON.stringify(probe.target))) {
              probe.receivedAt = performance.timeOrigin + performance.now();
            }
            if (data.includes('"type":"error"') || data.includes('"type":"ack"')) {
              const message = JSON.parse(data);
              if (message.type === 'ack' && message.id === probe.id) probe.accepted = true;
              if (message.type === 'error') (probe.errors ??= []).push({ code: message.code,
                status: message.status, target: message.id === probe.id, requestType: message.requestType });
            }
          });
        }
        send(data) {
          const probe = window.paintProbe;
          if (probe.target && typeof data === 'string' && data.includes(JSON.stringify(probe.target))) {
            const message = JSON.parse(data);
            if (message.type === 'input') probe.id = message.id;
          }
          return super.send(data);
        }
      };
      CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
        if (text === window.paintProbe.target && !window.paintProbe.at) {
          window.paintProbe.at = performance.timeOrigin + performance.now();
        }
        return fill.call(this, text, ...args);
      };
    });
    await page.goto(origin + entry, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => window.textworld?.inspect().connected, null, { timeout: 30000 });
    pages.push(page);
  }
  await Promise.all(pages.map(page => page.waitForFunction(() => document.getElementById('intro').hidden)));
  const [writer, reader] = pages, start = Date.now();
  for (let i = 0; i * 12 < seconds; i++) {
    await sleep(Math.max(0, start + i * 12000 - Date.now()));
    const glyph = String.fromCodePoint(glyphBase + i);
    const before = await reader.evaluate(async () => {
      const health = await (await fetch('/health', { cache: 'no-store', signal: AbortSignal.timeout(10000) })).json();
      const view = window.textworld.inspect();
      return { peers: health.peers, capacity: health.capacity, revision: health.revision,
        world: health.world, visiblePeers: view.peers.length, visibleCells: view.cells.length };
    });
    const sample = { at: new Date().toISOString(), elapsedSeconds: (Date.now() - start) / 1000, ...before };
    if (Date.now() >= quietFrom && Date.now() < quietUntil) {
      samples.push({ ...sample, quiet: true });
      console.log(JSON.stringify(samples.at(-1)));
      continue;
    }
    await Promise.all(pages.map(page => page.evaluate(target => { window.paintProbe = { target }; }, glyph)));
    try {
      await writer.locator('#input').focus();
      const sent = await writer.evaluate(() => performance.timeOrigin + performance.now());
      await writer.keyboard.insertText(glyph);
      await reader.waitForFunction(() => window.paintProbe.at, null, { timeout: 4000, polling: 40 });
      const [local, remote] = await Promise.all(pages.map(page => page.evaluate(() => window.paintProbe.at)));
      Object.assign(sample, { localMs: local - sent, remoteMs: remote - sent });
      await writer.keyboard.press('Home');
    } catch {
      sample.missed = true;
      sample.stateAfterMiss = await Promise.all(pages.map(page => page.evaluate(() => {
        const state = window.textworld.inspect(), target = window.paintProbe.target;
        return { connected: state.connected, pending: state.pending, cursor: state.cursor,
          world: state.world, view: state.observedView, targetInCurrentCells: state.cells.some(c => c.text === target) };
      })));
    }
    sample.transport = await Promise.all(pages.map(page => page.evaluate(() => {
      const p = window.paintProbe;
      return { receivedAt: p.receivedAt ?? null, accepted: !!p.accepted, errors: p.errors ?? [] };
    })));
    samples.push(sample);
    console.log(JSON.stringify(sample));
    if (screenshotAt && before.peers >= screenshotAt && !screenshots.length) {
      for (const [index, page] of pages.entries()) {
        const path = output + (index ? '.mobile.png' : '.desktop.png');
        await page.screenshot({ path, timeout: 10000 });
        screenshots.push(path);
      }
    }
  }
  await sleep(Math.max(0, start + seconds * 1000 - Date.now()));
} finally {
  clearTimeout(watchdog);
  await browser.close();
  await writeFile(output, JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), origin, entry,
    desktopWidth: 1200, mobileWidth: 390, glyphBase, quietFrom, quietUntil, screenshotAt, screenshots,
    samples, errors }, null, 2));
}
