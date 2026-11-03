import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createTextworld } from '../server/index.js';
import { TextworldAgent } from '../sdk/textworld-agent.mjs';
import { mkdir, writeFile } from 'node:fs/promises';

const app = createTextworld({ storagePath: ':memory:', now: () => 1000000 });
const { port } = await app.listen(0, '127.0.0.1'), base = 'http://127.0.0.1:' + port;
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const results = [], errors = [];
let agent;
try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  let hold = false, queued = [];
  await context.routeWebSocket('**/ws', ws => {
    const server = ws.connectToServer();
    ws.onMessage(data => {
      const m = JSON.parse(String(data));
      if (hold && m.type === 'input') queued.push(() => server.send(data)); else server.send(data);
    });
    server.onMessage(data => {
      const m = JSON.parse(String(data));
      if (m.type === 'error') errors.push(m);
      ws.send(data);
    });
  });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/#x=7&y=8');
  await page.waitForFunction(() => window.textworld?.inspect().peers[0]?.x === 7);
  const cdp = await context.newCDPSession(page);
  await page.locator('#input').focus();
  hold = true;
  await page.keyboard.press('ArrowRight');
  await page.keyboard.insertText('한');
  await page.waitForFunction(() => window.textworld.inspect().pending === 1);
  await cdp.send('Input.imeSetComposition', { text: '글', selectionStart: 1, selectionEnd: 1 });
  assert.equal(app.world.seq, 0);
  const resized = app.world.resize(160, 64, undefined, { seed: 42 });
  await page.waitForFunction(e => window.textworld.inspect().world.epoch === e, resized.epoch);
  const state = await page.evaluate(() => window.textworld.inspect());
  assert.equal(state.pending, 1); assert.equal(state.composing, true);
  assert.equal(await page.locator('#input').textContent(), '한글');
  const expected = resized.cursorMapping({ x: 7, y: 8 }); expected.x++;
  assert.deepEqual(state.cursor, { x: expected.x + 2, y: expected.y });
  hold = false; for (const deliver of queued) deliver(); queued = [];
  await page.waitForFunction(() => window.textworld.inspect().pending === 0);
  assert.equal(app.world.getCell(expected.x, expected.y).text, '한');
  await cdp.send('Input.insertText', { text: '글' });
  await page.waitForFunction(() => window.textworld.inspect().pending === 0 && !window.textworld.inspect().composing);
  assert.equal(app.world.getCell(expected.x + 2, expected.y).text, '글');
  results.push('delayed relative movement and Korean commit survive resize; the next active composition also commits exactly once');

  // Remove both the composing glyph and the old cursor address.
  await page.evaluate(() => { location.hash = 'x=20&y=8'; });
  await page.waitForFunction(() => window.textworld.inspect().cursor.x === 20);
  await page.keyboard.insertText('ㅎ'); await page.waitForFunction(() => window.textworld.inspect().pending === 0);
  await cdp.send('Input.imeSetComposition', { text: '하', selectionStart: 1, selectionEnd: 1, replacementStart: 0, replacementEnd: 1 });
  const values = Array(64).fill(20); values[0] = 21;
  const shrink = app.world.resize(156, 64, undefined, { seed: 43, seams: { axis: 'width', values } });
  await page.waitForFunction(e => window.textworld.inspect().world.epoch === e, shrink.epoch);
  assert.equal([...app.world.cells.values()].some(c => c.text === 'ㅎ'), false);
  assert.equal(await page.evaluate(() => window.textworld.inspect().composing), true);
  const corrected = await page.evaluate(() => window.textworld.inspect().cursor);
  await cdp.send('Input.insertText', { text: '하' });
  await page.waitForFunction(() => window.textworld.inspect().pending === 0);
  assert.equal(app.world.getCell(corrected.x, corrected.y).text, '하');
  results.push('removing the composing glyph and old caret preserves the OS draft and commits at the corrected location');

  // A concurrent narrow overwrite changes Backspace's actual target while its
  // request is in flight. Acknowledge and correct the cursor without rewinding
  // subsequent intentions or claiming the old wide glyph still exists.
  await page.evaluate(() => { location.hash = 'x=22&y=8'; });
  await page.waitForFunction(() => window.textworld.inspect().peers[0]?.x === 22);
  app.world.applyWrite({ author: 'neighbor', id: 'wide', epoch: app.world.epoch, x: 20, y: 8, text: '한' });
  for (const socket of app.wss.clients) socket.emit('message', Buffer.from(JSON.stringify({ type: 'sync' })));
  await page.waitForFunction(() => window.textworld.inspect().cells.some(c => c.x === 20 && c.y === 8 && c.text === '한'));
  hold = true; await page.keyboard.press('Backspace');
  await page.waitForFunction(() => window.textworld.inspect().pending === 1);
  assert.equal((await page.evaluate(() => window.textworld.inspect().cursor)).x, 20);
  app.world.applyWrite({ author: 'neighbor', id: 'narrow', epoch: app.world.epoch, x: 21, y: 8, text: 'A' });
  hold = false; for (const deliver of queued) deliver(); queued = [];
  await page.waitForFunction(() => window.textworld.inspect().pending === 0 && window.textworld.inspect().cursor.x === 21);
  assert.equal(app.world.getCell(21, 8).text, '');
  results.push('a concurrent overwrite during delayed Backspace corrects the predicted cursor to the server result');

  await page.mouse.move(500, 500); await page.mouse.down(); await page.mouse.move(491, 500);
  await page.waitForTimeout(100);
  const duringDrag = app.world.resize(164, 64, undefined, { seed: 45 });
  await page.waitForFunction(e => window.textworld.inspect().world.epoch === e, duringDrag.epoch);
  const dragging = await page.evaluate(() => window.textworld.inspect().cursor);
  await page.mouse.move(482, 500);
  await page.waitForFunction(p => window.textworld.inspect().cursor.x === (p.x + 1) % window.textworld.inspect().world.width, dragging);
  await page.waitForTimeout(100); await page.mouse.up();
  results.push('an active drag continues across resize using relative motion at the corrected cursor');
  await mkdir('artifacts', { recursive: true });
  await page.waitForFunction(() => document.getElementById('intro').hidden && !window.textworld.inspect().cameraActive);
  await page.screenshot({ path: 'artifacts/cursor-resize-composition.png' });
  await context.close();

  agent = await TextworldAgent.connect(base, { name: 'cursor continuation' });
  const started = performance.now();
  const running = agent.turn([{ type: 'type', text: 'ABCD' }, { type: 'enter' }, { type: 'type', text: '끝' }], { id: 'through-resize' });
  while (![...app.world.cells.values()].some(c => c.text === 'A')) await new Promise(r => setTimeout(r, 5));
  app.world.resize(172, 64, undefined, { seed: 44 });
  const done = await running;
  assert.equal(done.turn.status, 'completed'); assert.equal(done.turn.completedSteps, 6);
  assert.ok(performance.now() - started >= 480, 'resize never bypasses human pacing');
  for (const text of ['B', 'C', 'D', '끝']) assert.ok([...app.world.cells.values()].some(c => c.text === text));
  const seq = app.world.seq;
  await agent.turn([{ type: 'type', text: 'ABCD' }, { type: 'enter' }, { type: 'type', text: '끝' }], { id: 'through-resize' });
  assert.equal(app.world.seq, seq, 'retry must not execute the continued turn twice');
  results.push('HTTP/MCP turn continues typing and Enter at corrected cursor, with pacing and retry deduplication');
  assert.deepEqual(errors, []);
  await writeFile('artifacts/cursor-resize-results.json', JSON.stringify({ results, protocolErrors: errors.length }, null, 2));
  for (const result of results) console.log('PASS', result);
} finally { await agent?.close(); await browser.close(); await app.close(); }
