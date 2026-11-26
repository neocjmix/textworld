import { parentPort, workerData } from 'node:worker_threads';
import { startTraffic } from './traffic.mjs';

const traffic = startTraffic({ ...workerData, onPhase: phase => parentPort.postMessage({ type: 'phase', phase }) });
function report(type) {
  parentPort.postMessage({ type, phase: traffic.phase, population: traffic.population.report(), position: traffic.position() });
}
const timer = setInterval(() => report('sample'), 1000);
parentPort.on('message', m => {
  if (m.type === 'stop') traffic.stop(m.reason);
  if (m.type === 'set') {
    traffic.setTarget(m.counts, m.writing);
    report('override');
  }
});
report('sample');
try {
  const reason = await traffic.done;
  parentPort.postMessage({ type: 'end', reason, population: traffic.population.report() });
} finally {
  clearInterval(timer);
  parentPort.close();
}
