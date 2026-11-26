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
parentPort.postMessage({ type: 'ready', mapPort: app.server.address().port, botPort, credential: bots.credential, world: sample() });
const timer = setInterval(() => parentPort.postMessage({ type: 'world', world: sample() }), 1000);
parentPort.once('message', async () => {
  clearInterval(timer);
  const stopped = bots.close();
  await app.close();
  await stopped;
  parentPort.postMessage({ type: 'final', world: sample() });
  parentPort.close();
});
