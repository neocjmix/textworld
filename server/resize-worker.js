import { parentPort, workerData } from 'node:worker_threads';
import { cellKey } from '../shared/world.js';
import { selectResize } from './resize-plan.js';
const { from, control, seed } = workerData;
const cells = new Map();
parentPort.on('message', chunk => {
  if (chunk) {
    for (const cell of chunk) cells.set(cellKey(cell.x, cell.y), cell);
    return;
  }
  parentPort.postMessage(selectResize(cells, from, control, seed));
  parentPort.close();
});
