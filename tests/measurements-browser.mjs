import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createTextworld } from '../server/index.js';

const app = createTextworld({ storagePath: ':memory:' });
const { port } = await app.listen(0, '127.0.0.1');
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const original = window.setInterval;
    window.setInterval = (fn, ms, ...args) => {
      if (ms === 60000) window.flushMeasurements = fn;
      return original(fn, ms, ...args);
    };
  });
  await page.goto('http://127.0.0.1:' + port);
  await page.waitForFunction(() => window.textworld?.inspect().connected);
  await page.locator('#input').focus();
  await page.keyboard.insertText('한');
  await page.waitForFunction(() => window.textworld.inspect().pending === 0);
  assert.ok([...app.world.cells.values()].some(cell => cell.text === '한'));
  await page.evaluate(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise(resolve => setTimeout(resolve, 30));
    delete document.visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
    window.flushMeasurements();
  });
  const deadline = performance.now() + 5000;
  while (!app.measurements.pending.has('client.reported.hidden_ms') && performance.now() < deadline) await pause(20);
  for (const name of ['ack_ms', 'submit_to_draw_ms', 'dpr', 'draw_ms', 'visible_ms', 'hidden_ms'])
    assert.ok(app.measurements.pending.get('client.reported.' + name)?.count > 0, name);
  console.log('Chromium reported native input, ACK, drawing and visible/hidden intervals in one telemetry frame.');
} finally {
  await browser.close();
  await app.close();
}
