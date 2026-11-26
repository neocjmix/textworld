// A short, explicit production smoke check: two browsers, a handful of writes.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
const origin = process.env.PUBLIC_URL || 'https://textworld-production-987c.up.railway.app';
const expected = process.env.PUBLIC_REVISION;
const options = { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] };
if (process.env.HTTPS_PROXY) {
  const proxy = new URL(process.env.HTTPS_PROXY);
  options.proxy = { server: proxy.protocol + '//' + proxy.host };
  if (proxy.username) options.proxy.username = decodeURIComponent(proxy.username);
  if (proxy.password) options.proxy.password = decodeURIComponent(proxy.password);
}
const browser = await chromium.launch(options);
const errors = [];
try {
  const contexts = await Promise.all([1200, 390].map(width => browser.newContext({ viewport: { width, height: 844 }, ignoreHTTPSErrors: true })));
  for (const context of contexts) await context.addInitScript(() => {
    window.checkSockets = [];
    const NativeSocket = WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) { super(...args); window.checkSockets.push(this); }
    };
  });
  const pages = await Promise.all(contexts.map(c => c.newPage()));
  for (const page of pages) { page.setDefaultTimeout(30000); page.on('pageerror', e => errors.push(e.message)); }
  await Promise.all(pages.map(p => p.goto(origin + '/#x=16&y=8', { waitUntil: 'domcontentloaded' })));
  for (const page of pages) await page.waitForFunction(() => {
    const s = window.textworld?.inspect(); return s?.connected && s.cursor.x === 16 && s.cursor.y === 8 && s.peers.length >= 2;
  });
  await Promise.all(pages.map(page => page.waitForFunction(() => document.getElementById('intro').hidden)));
  const [writer, reader] = pages;
  const health = await reader.evaluate(async () => (await fetch('/health', { cache: 'no-store' })).json());
  if (expected) assert.equal(health.revision, expected);
  await writer.locator('#input').focus(); await writer.keyboard.insertText('공개시험');
  await writer.waitForFunction(() => window.textworld.inspect().pending === 0);
  await reader.waitForFunction(() => window.textworld.inspect().cells.some(c => c.x === 16 && c.y === 8 && c.text === '공'));
  await writer.keyboard.press('Enter'); await writer.keyboard.insertText('OK');
  await reader.waitForFunction(() => window.textworld.inspect().cells.some(c => c.x === 16 && c.y === 9 && c.text === 'O'));
  await reader.evaluate(() => window.checkSockets.at(-1).close(1000, 'smoke reconnect'));
  await reader.waitForFunction(() => window.checkSockets.length >= 2 && window.textworld.inspect().connected);
  await reader.waitForFunction(() => window.textworld.inspect().cells.some(c => c.x === 16 && c.y === 9 && c.text === 'O'));
  await mkdir('artifacts', { recursive: true });
  for (const [index, page] of pages.entries()) {
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    await page.screenshot({ path: `artifacts/public-${index ? 'mobile' : 'desktop'}.png` });
  }
  const fonts = await reader.evaluate(() => [...document.fonts].filter(face => face.status === 'loaded').length);
  assert.deepEqual(errors, []);
  const report = { at: new Date().toISOString(), revision: health.revision, origin, capacity: health.capacity, loadedFontParts: fonts,
    checks: ['public HTTPS', 'two WSS participants', 'CJK overwrite', 'Enter', 'remote observation', 'reconnect convergence', 'desktop/mobile screenshots', 'no runtime errors'] };
  await writeFile('artifacts/public-smoke.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
