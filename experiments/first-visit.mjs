// Paired cold/reload visits under one repeatable mobile network profile.
// TARGET_ROOT can select an unchanged worktree for before/after comparison.
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = resolve(process.env.TARGET_ROOT || '.');
const { createTextworld } = await import(pathToFileURL(resolve(root, 'server/index.js')));
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const workingTree = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
const app = createTextworld({ storagePath: ':memory:', now: () => 1_000_000 });
const address = await app.listen(0, '127.0.0.1');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
const results = [];
const network = { offline: false, latency: 150, downloadThroughput: 250000, uploadThroughput: 125000 };
const runs = Number(process.env.VISIT_RUNS || 3);
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 10) throw new Error('VISIT_RUNS must be 1..10');
try {
  for (const scenario of ['empty', 'mixed']) {
    if (scenario === 'mixed') for (const [index, text] of ['안녕하세요 한글', '日本語 こんにちは', '中文 欢迎abc'].entries()) {
      app.world.applyWrite({ author: 'fixture', id: `fixture-${index}`, x: 10, y: 8 + index, epoch: app.world.epoch, text, layout: 2 });
    }
    for (let run = 0; run < runs; run++) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage(), session = await context.newCDPSession(page);
      await session.send('Network.enable'); await session.send('Network.emulateNetworkConditions', network);
      for (const visit of ['cold', 'reload']) {
        if (visit === 'cold') await page.goto(`http://127.0.0.1:${address.port}/#x=16&y=8`, { waitUntil: 'domcontentloaded' });
        else await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(scenario => {
          const state = window.textworld?.inspect();
          return state?.connected && state.cursor.x === 16 && state.cursor.y === 8
            && !state.cameraActive && (scenario === 'empty' || state.cells.some(cell => cell.text === '안'));
        }, scenario, { timeout: 60000 });
        const inputReadyMs = await page.evaluate(() => performance.now());
        await page.evaluate(async () => {
          // Let Canvas request fonts for the actual snapshot, then wait for them.
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          await document.fonts.ready;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        const observation = await page.evaluate(() => ({
          paintedMs: performance.now(), cells: window.textworld.inspect().cells.length,
          resources: performance.getEntriesByType('resource').map(r => ({ path: new URL(r.name).pathname, transferSize: r.transferSize, encodedBodySize: r.encodedBodySize, decodedBodySize: r.decodedBodySize, duration: r.duration })),
          navigation: performance.getEntriesByType('navigation').map(r => ({ transferSize: r.transferSize, encodedBodySize: r.encodedBodySize })),
        }));
        const bytes = observation.resources.reduce((n, r) => n + r.transferSize, 0) + observation.navigation[0].transferSize;
        results.push({ scenario, run, visit, inputReadyMs, bytes, ...observation });
        console.log(JSON.stringify({ scenario, run, visit, inputReadyMs, paintedMs: observation.paintedMs, bytes }));
      }
      await context.close();
    }
  }
  const output = resolve(process.env.VISIT_OUTPUT || 'artifacts/first-visit.json');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ revision, workingTree, browser: browser.version(), network, viewport: { width: 390, height: 844 }, results }, null, 2));
} finally { await browser.close(); await app.close(); }
