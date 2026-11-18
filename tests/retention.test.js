import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '../server/world.js';
import { expire } from '../server/expiration.js';
import { ParticipantPolicy } from '../server/participant-policy.js';
import { pruneRecords, RETENTION_MS } from '../server/retention.js';

test('bounded pruning keeps live wide glyphs, source evidence and sparse clocks on restart', t => {
  const directory = mkdtempSync(join(tmpdir(), 'tw-retention-'));
  const storagePath = join(directory, 'test.sqlite');
  let now = 10_000;
  let world = new World({ storagePath, now: () => now });
  t.after(() => { world.close(); rmSync(directory, {recursive: true, force: true}); });
  const write = (id, text, x) => world.applyWrite({ author: 'a', id, text, x, y: 0, epoch: 1 });
  const count = table => world.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  write('first', '가A', 0);
  now += 1000;
  write('shares-clock', '다', 8);
  world.erase({ author: 'a', id: 'delete-A', epoch: 1, x: 2, y: 0 });
  now += RETENTION_MS + 5001;
  const latest = write('recent', 'A', 20);
  assert.equal(pruneRecords(world, 1), true);
  assert.equal(count('operations'), 3);
  for (let pass = 0; pass < 20; pass++) pruneRecords(world, 1);
  assert.equal(count('operations'), 1);
  assert.equal(count('change_times'), 2);
  assert.equal(world.getCell(2, 0), undefined);
  assert.equal(world.getCell(1, 0).width, 0);
  assert.equal(world.getCell(9, 0).width, 0);
  assert.equal(world.evidence().find(cell => cell.x === 0).originalGroupCells, 3);
  world.close();
  world = new World({storagePath, now: () => now});
  assert.equal(world.getCell(8, 0).updatedAt, 10_000);
  assert.equal(world.prior('a', 'recent').seq, latest.seq);
  assert.equal(expire(world), 4);
  now += RETENTION_MS + 1;
  expire(world);
  now += RETENTION_MS + 1;
  for (let pass = 0; pass < 20; pass++) pruneRecords(world, 2);
  for (const table of ['cells', 'history', 'operations', 'change_times']) assert.equal(count(table), 0, table);
});

test('an expired opaque coordinate receipt is rejected instead of resurrecting a write', t => {
  let now = 1000;
  const world = new World({ now: () => now });
  t.after(() => world.close());
  const peer = { id: 'p', x: 0, y: 0 };
  const policy = new ParticipantPolicy({ world, peer, now: () => now });
  const write = { type: 'write', id: 'opaque', epoch: 1, layout: 2, x: 0, y: 0, text: 'A' };
  policy.acceptCoordinateEdit(write);
  assert.equal(policy.acceptCoordinateEdit(write).duplicate, true);
  now += RETENTION_MS + 1;
  expire(world);
  pruneRecords(world);
  const seq = world.seq;
  assert.throws(() => policy.acceptCoordinateEdit(write), {code: 'IDEMPOTENCY_EXPIRED'});
  assert.equal(world.seq, seq);
  assert.equal(world.getCell(0, 0).text, '');
  policy.acceptCoordinateEdit({...write, id: 'next', x: peer.x, text: 'B'});
});

test('released colors are collected only after their cells and marks are gone', t => {
  let now = 1000;
  const world = new World({now: () => now});
  t.after(() => world.close());
  world.reserveAuthor('active', '#112233');
  world.persistAuthor('active');
  world.reserveAuthor('gone', '#112244');
  world.persistAuthor('gone');
  world.applyWrite({author:'gone', id:'w', epoch:1, x:0, y:0, text:'Z'});
  world.releaseAuthor('gone');
  pruneRecords(world);
  assert.equal(world.authorColors.get('gone'), '#112244');
  assert.equal(world.authorColors.get('active'), '#112233');
  now += RETENTION_MS + 1;
  expire(world);
  pruneRecords(world);
  assert.equal(world.authorColors.has('gone'), false);
  assert.equal(world.usedColors.has('#112244'), false);
  world.releaseAuthor('active');
  assert.equal(world.usedColors.has('#112233'), false);
});

test('a WebSocket input ordinal stays consumed after its receipt and glyph are gone', async t => {
  const { createTextworld } = await import('../server/index.js');
  const { connect } = await import('./ws-client.js');
  let now = 1000;
  const app = createTextworld({ storagePath: ':memory:', now: () => now });
  t.after(() => app.close());
  const {port} = await app.listen(0, '127.0.0.1');
  const client = connect(`ws://127.0.0.1:${port}/ws`);
  await client.next(m => m.type === 'snapshot');
  const input = {type:'input', id:'w', sequence:1, epoch:1, action:{kind:'type', text:'한'}};
  client.send(input);
  await client.next(m => m.type === 'ack' && m.id === 'w');
  now += RETENTION_MS + 1;
  assert.equal(expire(app.world), 2);
  pruneRecords(app.world);
  const seq = app.world.seq, after = client.messages.length;
  client.send(input);
  assert.ok((await client.next(m => m.type === 'ack' && m.id === 'w', after)).duplicate);
  assert.equal(app.world.seq, seq);
  assert.equal(app.world.ink, 0);
});

test('topology summaries retire in bounded batches while the newest transitions survive', t => {
  const world = new World();
  t.after(() => world.close());
  const insert = world.db.prepare('INSERT INTO topology_events(seq) VALUES (?)');
  for (let seq = 1; seq <= 80; seq++) insert.run(seq);
  assert.equal(pruneRecords(world, 4), true);
  assert.equal(world.db.prepare('SELECT min(seq) oldest FROM topology_events').get().oldest, 5);
  while (pruneRecords(world, 4)) {}
  assert.deepEqual({...world.db.prepare('SELECT min(seq) oldest,max(seq) newest FROM topology_events').get()},
    {oldest:17, newest:80});
});

test('failed housekeeping leaves memory, receipts and SQLite in the same state for retry', t => {
  let now = 1000;
  const world = new World({now: () => now});
  t.after(() => world.close());
  world.applyWrite({author:'a', id:'write', epoch:1, x:0, y:0, text:'A'});
  world.erase({author:'a', id:'erase', epoch:1, x:0, y:0});
  now += RETENTION_MS + 1;
  world.db.exec("CREATE TRIGGER fail_prune BEFORE DELETE ON history BEGIN SELECT RAISE(ABORT,'retry'); END");
  assert.throws(() => pruneRecords(world), /retry/);
  assert.equal(world.getCell(0, 0).text, '');
  assert.equal(world.db.prepare('SELECT count(*) AS n FROM cells').get().n, 1);
  assert.equal(world.prior('a', 'write').duplicate, true);
  world.db.exec('DROP TRIGGER fail_prune');
  pruneRecords(world);
  assert.equal(world.getCell(0, 0), undefined);
  assert.equal(world.prior('a', 'write'), null);
});
