import { once } from 'node:events';
import { parentPort, workerData } from 'node:worker_threads';
import { createTextworld, networkKey } from '../../server/index.js';
import { createPlaytestIngress } from './ingress.mjs';

// Only the private fixture listener assigns simulated households. Browser
// connections, including a browser on this machine, retain their own budgets.
const households = new WeakMap();
const app = createTextworld({
  storagePath: workerData.database, metricsPath: workerData.metrics, metricsToken: '', trustProxy: false,
  identifyNetwork: req => households.get(req) ?? networkKey(req, false),
});
const bots = createPlaytestIngress((...args) => app.server.emit('upgrade', ...args), households);
const sample = () => ({
  width: app.world.width, height: app.world.height, epoch: app.world.epoch,
  occupiedCells: app.world.ink, connections: app.wss.clients.size, rssBytes: process.memoryUsage.rss(),
});

// Register the listening/error handlers before either bind.
const browserReady = once(app.server, 'listening');
app.server.listen(workerData.port, workerData.lan ? '0.0.0.0' : '127.0.0.1');
await browserReady;
const botPort = await bots.listen();
const report = (type, extra) => parentPort.postMessage({ type, ...extra, world: sample(), resources: app.playtestResources() });
report('ready', { mapPort: app.server.address().port, botPort, credential: bots.credential });
const timer = setInterval(() => report('world'), 1000);
parentPort.once('message', async () => {
  clearInterval(timer);
  const stopped = bots.close();
  await app.close();
  await stopped;
  report('final');
  parentPort.close();
});
