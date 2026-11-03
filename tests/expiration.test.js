import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { expire } from '../server/expiration.js';

test('expiration waits for the shared timestamp uncertainty and preserves a concurrent overwrite', t => {
  let time = 10000000;
  const world = new World({ now: () => time }); t.after(() => world.close());
  world.applyWrite({ author: 'a', id: 'marker', epoch: 1, x: 0, y: 0, text: 'A' });
  time += 4999;
  world.applyWrite({ author: 'a', id: 'later', epoch: 1, x: 3, y: 3, text: '한' });
  time += 180000;
  assert.equal(expire(world), 0);
  const candidates = world.expiredCandidates(time);
  world.applyWrite({ author: 'b', id: 'overwrite', epoch: 1, x: 3, y: 3, text: 'B' });
  const result = world.conditionalDelete({ id: 'race', epoch: 1, candidates });
  assert.equal(world.getCell(3, 3).text, 'B');
  assert.ok(!result.cells.some(cell => cell.x === 3 && cell.y === 3));
  time += 2;
  expire(world);
  assert.equal(world.getCell(0, 0).text, '');
  assert.equal(world.getCell(3, 3).text, 'B');
});

test('expiration ignores candidates from an obsolete topology', t => {
  let time = 0; const world = new World({ now: () => time }); t.after(() => world.close());
  world.applyWrite({ author: 'a', id: 'old', epoch: 1, x: 3, y: 3, text: '한' });
  const candidates = world.expiredCandidates(0);
  world.resize(256, 128);
  const snapshot = world.snapshot();
  assert.throws(() => world.conditionalDelete({ id: 'old-epoch', epoch: 1, candidates }), { code: 'STALE_EPOCH' });
  assert.deepEqual(world.snapshot(), snapshot);
});

test('server automatically expires text and publishes removals to a live client', async t => {
  const { createTextworld } = await import('../server/index.js');
  const { connect } = await import('./ws-client.js');
  let time = 10000000;
  const app = createTextworld({ storagePath: ':memory:', now: () => time });
  t.after(() => app.close());
  app.world.applyWrite({ author: 'old', id: 'old', epoch: 1, x: 64, y: 32, text: '한' });
  const address = await app.listen(0, '127.0.0.1');
  const client = connect(`ws://127.0.0.1:${address.port}/ws`);
  await client.next(message => message.type === 'snapshot');
  const after = client.messages.length;
  time += 185001;
  const removal = await client.next(message => message.type === 'view' && message.observation.forget.some(p => p.x === 64 && p.y === 32), after, 8000);
  assert.ok(removal.observation.forget.some(p => p.x === 65 && p.y === 32));
  assert.equal(app.world.getCell(64, 32).text, '');
});

test('author colors survive restart without storing color on every cell', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'textworld-color-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'world.sqlite');
  let world = new World({ storagePath: path });
  world.reserveAuthor('writer', '#123456'); world.persistAuthor('writer');
  world.applyWrite({ author: 'writer', id: 'write', epoch: 1, x: 1, y: 1, text: '가A' });
  world.close(); world = new World({ storagePath: path });
  assert.equal(world.authorColors.get(world.getCell(1, 1).author), '#123456');
  assert.equal(world.authorColors.get(world.getCell(3, 1).author), '#123456');
  assert.ok(!('color' in world.getCell(1, 1)));
  world.close();
});
