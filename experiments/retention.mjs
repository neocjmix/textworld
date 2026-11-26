// One simulated hour per rate. File-backed WAL/FULL exercises storage and
// restart fidelity; advancing the world clock does not measure wall-clock QoS.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '../server/world.js';
import { expire, EXPIRY_BATCH } from '../server/expiration.js';
import { pruneRecords } from '../server/retention.js';

const start = 1_000_000;
const cellState = world => [...world.cells.values()]
  .sort((first, second) => first.y - second.y || first.x - second.x)
  .map(cell => ({...cell}));

for (const rate of [32, 48]) {
  const directory = mkdtempSync(join(tmpdir(), 'textworld-retention-'));
  const storagePath = join(directory, 'world.sqlite');
  let now = start;
  let world = new World({width: 1024, height: 512, storagePath, now: () => now});
  let writes = 0, travelling = 0, maxLagMs = 0;
  try {
    for (let second = 1; second <= 3600; second++) {
      for (let writer = 0; writer < rate; writer++) {
        now = start + (second - 1) * 1000 + Math.floor(writer * 1000 / rate);
        // Half repeatedly overwrite the origin; half fill previously unused
        // glyph positions. Leave room for the full two-column glyph.
        const slot = ++writes % 2 === 0 ? 0 : 1 + travelling++ % 65535;
        world.applyWrite({author: 's' + writer, id: 'input:' + writes, epoch: 1,
          x: slot % 512 * 2, y: Math.floor(slot / 512), text: writes % 3 ? '가' : 'A'});
      }
      if (second % 5 === 0) {
        now = start + second * 1000;
        let passes = 0, more;
        do {
          const removed = expire(world, () => {}, EXPIRY_BATCH, lag => { maxLagMs = Math.max(maxLagMs, lag); });
          more = pruneRecords(world) || removed >= EXPIRY_BATCH;
          assert.ok(++passes < 1000, 'Maintenance did not drain');
        } while (more);
      }
      if (second % 300 === 0) {
        const count = table => world.db.prepare('SELECT count(*) AS n FROM ' + table).get().n;
        console.log(JSON.stringify({rate, minute: second / 60, history: count('history'), receipts: count('operations'),
          clocks: count('change_times'), cells: count('cells'), occupied: world.ink, maxLagMs,
          pages: world.db.prepare('PRAGMA page_count').get().page_count,
          freePages: world.db.prepare('PRAGMA freelist_count').get().freelist_count}));
      }
    }
    const metadata = world.metadata(), before = cellState(world);
    world.close();
    world = new World({storagePath, now: () => now});
    assert.deepEqual(world.metadata(), metadata);
    assert.deepEqual(cellState(world), before);
    console.log(JSON.stringify({rate, writes, restartVerified: true}));
  } finally {
    world.close();
    rmSync(directory, {recursive: true, force: true});
  }
}
