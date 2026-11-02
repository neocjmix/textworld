import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { createTextworld } from '../server/index.js';

function connect(url) {
  const socket = new WebSocket(url);
  const messages = [];
  const waiters = [];
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString()); messages.push(message);
    for (const waiter of [...waiters]) if (waiter.predicate(message)) {
      waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(message);
    }
  });
  const next = predicate => new Promise((resolve, reject) => {
    const existing = messages.find(predicate);
    if (existing) return resolve(existing);
    const waiter = { predicate, resolve, timer: setTimeout(() => reject(new Error('Timed out waiting for protocol message')), 2000) };
    waiters.push(waiter);
  });
  return { socket, messages, next, send: value => socket.send(JSON.stringify(value)) };
}

test('independent sockets converge on overwrites, presence, stale epochs and reconnect snapshots', async t => {
  const app = createTextworld({ storagePath: ':memory:' });
  t.after(() => app.close());
  const address = await app.listen(0, '127.0.0.1');
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const a = connect(url), b = connect(url);
  const sa = await a.next(m => m.type === 'snapshot'), sb = await b.next(m => m.type === 'snapshot');
  assert.notEqual(sa.selfId, sb.selfId);
  await a.next(m => m.type === 'presence' && m.peers.length === 2);
  a.send({ type: 'move', epoch: 1, x: -1, y: 64 });
  await b.next(m => m.type === 'presence' && m.peers.some(p => p.id === sa.selfId && p.x === 127 && p.y === 0));
  a.send({ type: 'write', id: 'a-write', epoch: 1, x: 5, y: 6, text: 'A한' });
  await b.next(m => m.type === 'cells' && m.id === 'a-write');
  b.send({ type: 'write', id: 'b-write', epoch: 1, x: 5, y: 6, text: 'B' });
  const patchA = await a.next(m => m.type === 'cells' && m.id === 'b-write');
  const patchB = await b.next(m => m.type === 'cells' && m.id === 'b-write');
  assert.deepEqual(patchA, patchB);
  assert.equal(app.world.getCell(5, 6).text, 'B');
  assert.equal(app.world.getCell(6, 6).text, '한');
  // Retrying the earlier operation cannot undo B's overwrite.
  a.send({ type: 'write', id: 'a-write', epoch: 1, x: 5, y: 6, text: 'A한' });
  await a.next(m => m.type === 'ack' && m.id === 'a-write' && m.duplicate);
  assert.equal(app.world.getCell(5, 6).text, 'B');
  app.world.resize(256, 128);
  a.send({ type: 'write', id: 'stale', epoch: 1, x: 5, y: 6, text: 'X' });
  await a.next(m => m.type === 'error' && m.code === 'STALE_EPOCH');
  assert.equal(app.world.getCell(5, 6).text, 'B');
  const c = connect(url);
  const sc = await c.next(m => m.type === 'snapshot');
  assert.equal(sc.cells.find(c => c.x === 5 && c.y === 6).text, 'B');
  assert.equal(sc.seq, patchA.seq + 1);
  assert.equal(sc.world.epoch, 2);
  assert.equal(sc.world.width, 256);
  b.socket.close();
  await a.next(m => m.type === 'presence' && m.peers.length === 2 && m.peers.some(p => p.id === sc.selfId));
});

test('scavenger capability is private and deletion uses observed cell versions', async t => {
  const app = createTextworld({ storagePath: ':memory:', scavengerToken: 'test-capability', now: () => 1000 });
  t.after(() => app.close());
  const address = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const live = connect(`ws://127.0.0.1:${address.port}/ws`);
  await live.next(m => m.type === 'snapshot');
  const auth = { authorization: 'Bearer test-capability', 'content-type': 'application/json' };
  const denied = await fetch(`${base}/api/scavenger/evidence`);
  assert.equal(denied.status, 404);
  app.world.applyWrite({ author: 'a', id: 'old', epoch: 1, x: 0, y: 0, text: 'old' });
  const evidence = await (await fetch(`${base}/api/scavenger/evidence?before=1000`, { headers: auth })).json();
  assert.equal(evidence.cells.length, 3);
  app.world.applyWrite({ author: 'b', id: 'new', epoch: 1, x: 0, y: 0, text: 'N' });
  const deleted = await (await fetch(`${base}/api/scavenger/delete`, { method: 'POST', headers: auth, body: JSON.stringify({ id: 'clean', epoch: evidence.epoch, candidates: evidence.cells }) })).json();
  assert.equal(deleted.deleted, 2);
  const patch = await live.next(m => m.type === 'cells' && m.id === 'clean');
  assert.equal(patch.cells.length, 2);
  assert.ok(patch.cells.every(cell => cell.text === ''));
  assert.equal(app.world.getCell(0, 0).text, 'N');
  assert.equal(app.world.getCell(1, 0).text, '');
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.ok, true);
});

test('invalid frames and cross-origin browser connections do not mutate the world', async t => {
  const app = createTextworld({ storagePath: ':memory:' });
  t.after(() => app.close());
  const address = await app.listen(0, '127.0.0.1');
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const a = connect(url);
  await a.next(m => m.type === 'snapshot');
  a.socket.send('not json');
  await a.next(m => m.type === 'error' && m.code === 'BAD_MESSAGE');
  a.send({ type: 'write', id: 'bad', epoch: 1, x: 1.5, y: 1, text: 'X' });
  await a.next(m => m.type === 'error' && m.code === 'BAD_POSITION');
  assert.equal(app.world.seq, 0);
  const rejected = new WebSocket(url, { origin: 'https://unrelated.example' });
  await new Promise(resolve => rejected.once('error', resolve));
  assert.equal(app.world.seq, 0);
});


test('simultaneous competing writes share one server order regardless of network arrival', async t => {
  const app = createTextworld({ storagePath: ':memory:' });
  t.after(() => app.close());
  const address = await app.listen(0, '127.0.0.1');
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const a = connect(url), b = connect(url);
  await Promise.all([a.next(m => m.type === 'snapshot'), b.next(m => m.type === 'snapshot')]);
  // Neither sender waits for the other's acknowledgement.
  a.send({ type: 'write', id: 'race-a', epoch: 1, x: 9, y: 9, text: '가' });
  b.send({ type: 'write', id: 'race-b', epoch: 1, x: 9, y: 9, text: '나' });
  await Promise.all([a.next(m => m.type === 'cells' && m.seq === 2), b.next(m => m.type === 'cells' && m.seq === 2)]);
  const updatesA = a.messages.filter(m => m.type === 'cells');
  const updatesB = b.messages.filter(m => m.type === 'cells');
  assert.deepEqual(updatesA, updatesB);
  assert.deepEqual(updatesA.map(m => m.seq), [1, 2]);
  assert.equal(app.world.getCell(9, 9).text, updatesA.at(-1).cells[0].text);
  assert.equal(app.world.getCell(9, 9).version, 2);
});


test('a burst of stale frames sends only one fresh epoch snapshot and explicit sync remains available', async t => {
  const app = createTextworld({ storagePath: ':memory:' });
  t.after(() => app.close());
  const address = await app.listen(0, '127.0.0.1');
  const a = connect(`ws://127.0.0.1:${address.port}/ws`);
  await a.next(m => m.type === 'snapshot');
  app.world.resize(256, 128);
  for (let i = 0; i < 5; i++) a.send({ type: 'write', id: `stale-${i}`, epoch: 1, x: i, y: 0, text: 'X' });
  a.send({ type: 'write', id: 'fresh-1', epoch: 2, x: 0, y: 0, text: 'A' });
  await a.next(m => m.type === 'ack' && m.id === 'fresh-1');
  assert.equal(a.messages.filter(m => m.type === 'error' && m.code === 'STALE_EPOCH').length, 5);
  assert.equal(a.messages.filter(m => m.type === 'snapshot' && m.world.epoch === 2).length, 1);
  assert.equal(app.world.getCell(0, 0).text, 'A');
  assert.equal(app.world.getCell(1, 0), undefined);
  // Further late old-epoch traffic cannot reset the newer local input state.
  a.send({ type: 'write', id: 'late-stale', epoch: 1, x: 1, y: 0, text: 'X' });
  a.send({ type: 'write', id: 'fresh-2', epoch: 2, x: 1, y: 0, text: 'B' });
  await a.next(m => m.type === 'ack' && m.id === 'fresh-2');
  assert.equal(a.messages.filter(m => m.type === 'snapshot').length, 2);
  // A deliberate sync can always obtain a new full snapshot, including in the same epoch.
  a.send({ type: 'sync' });
  a.send({ type: 'write', id: 'fresh-3', epoch: 2, x: 2, y: 0, text: 'C' });
  await a.next(m => m.type === 'ack' && m.id === 'fresh-3');
  assert.equal(a.messages.filter(m => m.type === 'snapshot').length, 3);
  assert.equal(a.messages.filter(m => m.type === 'snapshot').at(-1).cells.map(c => c.text).join(''), 'AB');
});


test('standalone scavenger process removes aged cells while retaining current text', async t => {
  const token = randomUUID();
  let clock = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const app = createTextworld({ storagePath: ':memory:', scavengerToken: token, now: () => clock });
  t.after(() => app.close());
  app.world.applyWrite({ author: 'old-user', id: 'old-text', epoch: 1, x: 3, y: 4, text: '오래된글' });
  clock = Date.now();
  app.world.applyWrite({ author: 'current-user', id: 'current-text', epoch: 1, x: 3, y: 5, text: '새글' });
  const address = await app.listen(0, '127.0.0.1');
  const observer = connect(`ws://127.0.0.1:${address.port}/ws`);
  await observer.next(m => m.type === 'snapshot');
  const execute = () => promisify(execFile)(process.execPath, [fileURLToPath(new URL('../server/scavenger.js', import.meta.url))], {
    env: { ...process.env, SCAVENGER_TOKEN: token, TEXTWORLD_URL: `http://127.0.0.1:${address.port}`, SCAVENGER_MAX_AGE_MS: String(24 * 60 * 60 * 1000) },
    timeout: 5000,
  });
  const first = await execute();
  assert.equal(JSON.parse(first.stdout).deleted, 4);
  assert.equal(first.stderr, '');
  assert.ok(!first.stdout.includes(token));
  assert.equal(app.world.getCell(3, 4).text, '');
  assert.equal(app.world.getCell(3, 5).text, '새');
  const removal = await observer.next(m => m.type === 'cells' && m.author === 'scavenger');
  assert.equal(removal.cells.length, 4);
  assert.ok(removal.cells.every(cell => cell.text === ''));
  const second = await execute();
  assert.equal(second.stdout.trim(), 'No expired cells.');
  assert.equal(app.world.getCell(3, 5).text, '새');
});


test('explicit writing origin reaches both sockets while legacy write messages remain compatible', async t => {
  const app = createTextworld({ storagePath: ':memory:' });
  t.after(() => app.close());
  const address = await app.listen(0, '127.0.0.1');
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const writer = connect(url), observer = connect(url);
  const snapshot = await writer.next(m => m.type === 'snapshot');
  await observer.next(m => m.type === 'snapshot');
  writer.send({ type: 'write', id: 'prefix', epoch: 1, x: 7, y: 3, text: 'AB' });
  await writer.next(m => m.type === 'ack' && m.id === 'prefix');
  writer.send({ type: 'write', id: 'continued', epoch: 1, x: 9, y: 3, lineStartX: 7, text: 'C\nD' });
  const patch = await observer.next(m => m.type === 'cells' && m.id === 'continued');
  assert.deepEqual(patch.cells.map(({ x, y, text }) => ({ x, y, text })), [
    { x: 9, y: 3, text: 'C' }, { x: 7, y: 4, text: 'D' },
  ]);
  const ack = await writer.next(m => m.type === 'ack' && m.id === 'continued');
  assert.deepEqual(ack.cursor, { x: 8, y: 4 });
  await observer.next(m => m.type === 'presence' && m.peers.some(p => p.id === snapshot.selfId && p.x === 8 && p.y === 4));
  const before = app.world.snapshot();
  writer.send({ type: 'write', id: 'invalid-origin', epoch: 1, x: 7, y: 3, lineStartX: null, text: 'X\nY' });
  await writer.next(m => m.type === 'error' && m.id === 'invalid-origin' && m.code === 'BAD_POSITION');
  assert.deepEqual(app.world.snapshot(), before);
  writer.send({ type: 'write', id: 'legacy-lines', epoch: 1, x: 20, y: 3, text: 'E\nF' });
  const legacy = await observer.next(m => m.type === 'cells' && m.id === 'legacy-lines');
  assert.deepEqual(legacy.cells.map(({ x, y, text }) => ({ x, y, text })), [
    { x: 20, y: 3, text: 'E' }, { x: 20, y: 4, text: 'F' },
  ]);
});
