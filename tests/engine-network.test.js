import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { createTextworld } from '../server/index.js';
import { connect, hasCell, hasPeer, observationOf } from './ws-client.js';

async function fixture(t, options = {}) {
  const app = createTextworld({ storagePath: ':memory:', ...options });
  t.after(() => app.close());
  const address = await app.listen(0, '127.0.0.1');
  return { app, url: `ws://127.0.0.1:${address.port}/ws`, base: `http://127.0.0.1:${address.port}` };
}
async function joined(url) {
  const client = connect(url);
  await client.next(message => message.type === 'snapshot');
  client.send({ type: 'view', cols: 128, rows: 64 });
  await client.sync();
  return client;
}

test('independent sockets converge on overwrites, visible presence, stale epochs and reconnect views', async t => {
  const { app, url } = await fixture(t);
  const a = await joined(url), b = await joined(url), aid = a.state.selfId;
  assert.notEqual(aid, b.state.selfId);
  await a.next(message => hasPeer(message, b.state.selfId));
  await a.locate(-1, 64);
  await b.next(message => hasPeer(message, aid, 127, 0));
  await a.locate(5, 6); await b.locate(5, 6);
  a.send({ type: 'write', id: 'a-write', epoch: 1, x: 5, y: 6, text: 'A한' });
  await b.next(message => hasCell(message, 5, 6, 'A', 1));
  b.send({ type: 'write', id: 'b-write', epoch: 1, x: 5, y: 6, text: 'B' });
  await Promise.all([a.next(message => hasCell(message, 5, 6, 'B', 2)), b.next(message => hasCell(message, 5, 6, 'B', 2))]);
  assert.deepEqual([...a.state.cells.values()], [...b.state.cells.values()]);
  assert.equal(app.world.getCell(5, 6).text, 'B'); assert.equal(app.world.getCell(6, 6).text, '한');
  a.send({ type: 'write', id: 'a-write', epoch: 1, x: 5, y: 6, text: 'A한' });
  await a.next(message => message.type === 'ack' && message.id === 'a-write' && message.duplicate);
  assert.equal(app.world.getCell(5, 6).text, 'B');
  app.world.resize(256, 128);
  a.send({ type: 'write', id: 'stale', epoch: 1, x: 5, y: 6, text: 'X' });
  await a.next(message => message.type === 'error' && message.code === 'STALE_EPOCH');
  assert.equal(app.world.getCell(5, 6).text, 'B');
  const c = await joined(url);
  await c.locate(5, 6, 2);
  assert.equal(c.state.cells.get('5,6').text, 'B');
  assert.equal(c.state.world.epoch, 2); assert.equal(c.state.world.width, 256);
  const after = a.messages.length;
  b.socket.close();
  await a.next(message => observationOf(message)?.peers.length === 2 && hasPeer(message, c.state.selfId), after);
});

test('scavenger capability is private and deletion uses observed cell versions', async t => {
  const { app, url, base } = await fixture(t, { scavengerToken: 'test-capability', now: () => 1000 });
  const live = await joined(url);
  const auth = { authorization: 'Bearer test-capability', 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/api/scavenger/evidence`)).status, 404);
  app.world.applyWrite({ author: 'a', id: 'old', epoch: 1, x: 0, y: 0, text: 'old' });
  const evidence = await (await fetch(`${base}/api/scavenger/evidence?before=1000`, { headers: auth })).json();
  assert.equal(evidence.cells.length, 3);
  app.world.applyWrite({ author: 'b', id: 'new', epoch: 1, x: 0, y: 0, text: 'N' });
  await live.sync();
  const after = live.messages.length;
  const deleted = await (await fetch(`${base}/api/scavenger/delete`, { method: 'POST', headers: auth, body: JSON.stringify({ id: 'clean', epoch: evidence.epoch, candidates: evidence.cells }) })).json();
  assert.equal(deleted.deleted, 2);
  const patch = await live.next(message => message.type === 'view' && message.observation.forget.length === 2, after);
  assert.deepEqual(patch.observation.forget, [{ x: 1, y: 0 }, { x: 2, y: 0 }]);
  assert.equal(app.world.getCell(0, 0).text, 'N'); assert.equal(app.world.getCell(1, 0).text, '');
  assert.equal((await (await fetch(`${base}/health`)).json()).ok, true);
});

test('invalid frames and cross-origin browser connections do not mutate the world', async t => {
  const { app, url } = await fixture(t), a = await joined(url);
  a.socket.send('not json');
  await a.next(message => message.type === 'error' && message.code === 'BAD_MESSAGE');
  a.send({ type: 'write', id: 'bad', epoch: 1, x: 1.5, y: 1, text: 'X' });
  await a.next(message => message.type === 'error' && message.code === 'BAD_POSITION');
  assert.equal(app.world.seq, 0);
  const rejected = new WebSocket(url, { origin: 'https://unrelated.example' });
  await new Promise(resolve => rejected.once('error', resolve));
  assert.equal(app.world.seq, 0);
});

test('simultaneous competing writes share one server order regardless of network arrival', async t => {
  const { app, url } = await fixture(t), a = await joined(url), b = await joined(url);
  await a.locate(9, 9); await b.locate(9, 9);
  a.send({ type: 'write', id: 'race-a', epoch: 1, x: 9, y: 9, text: '가' });
  b.send({ type: 'write', id: 'race-b', epoch: 1, x: 9, y: 9, text: '나' });
  await Promise.all([a.next(message => observationOf(message)?.cells.some(cell => cell.version === 2)), b.next(message => observationOf(message)?.cells.some(cell => cell.version === 2))]);
  const patches = client => client.messages.filter(message => message.type === 'view' && message.observation.cells.length).map(message => message.observation.cells);
  assert.deepEqual(patches(a), patches(b));
  assert.deepEqual(patches(a).map(cells => cells[0].version), [1, 2]);
  assert.equal(app.world.getCell(9, 9).text, patches(a).at(-1)[0].text);
  assert.equal(app.world.getCell(9, 9).version, 2);
});

test('a burst of stale frames sends only one fresh epoch snapshot and explicit sync remains available', async t => {
  const { app, url } = await fixture(t), a = await joined(url);
  await a.locate(0, 0);
  const beforeSnapshots = a.messages.filter(message => message.type === 'snapshot').length;
  app.world.resize(256, 128);
  for (let index = 0; index < 5; index++) a.send({ type: 'write', id: `stale-${index}`, epoch: 1, x: index, y: 0, text: 'X' });
  a.send({ type: 'write', id: 'fresh-1', epoch: 2, x: 0, y: 0, text: 'A' });
  await a.next(message => message.type === 'ack' && message.id === 'fresh-1');
  assert.equal(a.messages.filter(message => message.type === 'error' && message.code === 'STALE_EPOCH').length, 5);
  assert.equal(a.messages.filter(message => message.type === 'snapshot' && message.world.epoch === 2).length, 1);
  assert.equal(app.world.getCell(0, 0).text, 'A'); assert.equal(app.world.getCell(1, 0), undefined);
  a.send({ type: 'write', id: 'late-stale', epoch: 1, x: 1, y: 0, text: 'X' });
  a.send({ type: 'write', id: 'fresh-2', epoch: 2, x: 1, y: 0, text: 'B' });
  await a.next(message => message.type === 'ack' && message.id === 'fresh-2');
  assert.equal(a.messages.filter(message => message.type === 'snapshot').length, beforeSnapshots + 1);
  const snapshot = await a.sync();
  assert.equal(snapshot.cells.map(cell => cell.text).join(''), 'AB');
  a.send({ type: 'write', id: 'fresh-3', epoch: 2, x: 2, y: 0, text: 'C' });
  await a.next(message => message.type === 'ack' && message.id === 'fresh-3');
  assert.equal(a.messages.filter(message => message.type === 'snapshot').length, beforeSnapshots + 2);
});

test('standalone scavenger process removes aged cells while retaining current text', async t => {
  const token = randomUUID();
  let clock = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const { app, url, base } = await fixture(t, { scavengerToken: token, now: () => clock });
  app.world.applyWrite({ author: 'old-user', id: 'old-text', epoch: 1, x: 3, y: 4, text: '오래된글' });
  clock = Date.now();
  app.world.applyWrite({ author: 'current-user', id: 'current-text', epoch: 1, x: 3, y: 5, text: '새글' });
  const observer = await joined(url), after = observer.messages.length;
  const execute = () => promisify(execFile)(process.execPath, [fileURLToPath(new URL('../server/scavenger.js', import.meta.url))], {
    env: { ...process.env, SCAVENGER_TOKEN: token, TEXTWORLD_URL: base, SCAVENGER_MAX_AGE_MS: String(24 * 60 * 60 * 1000) }, timeout: 5000,
  });
  const first = await execute();
  assert.equal(JSON.parse(first.stdout).deleted, 8); assert.equal(first.stderr, ''); assert.ok(!first.stdout.includes(token));
  assert.equal(app.world.getCell(3, 4).text, ''); assert.equal(app.world.getCell(3, 5).text, '새');
  const removal = await observer.next(message => message.type === 'view' && message.observation.forget.length === 8, after);
  assert.ok(removal.observation.forget.every(cell => cell.y === 4));
  assert.equal(observer.state.cells.get('3,5').text, '새');
  const second = await execute();
  assert.equal(second.stdout.trim(), 'No expired cells.'); assert.equal(app.world.getCell(3, 5).text, '새');
});

test('explicit writing origin reaches both sockets while an omitted origin starts at the input column', async t => {
  const { app, url } = await fixture(t), writer = await joined(url), observer = await joined(url);
  await writer.locate(7, 3);
  writer.send({ type: 'write', id: 'prefix', epoch: 1, x: 7, y: 3, text: 'AB' });
  await writer.next(message => message.type === 'ack' && message.id === 'prefix');
  writer.send({ type: 'write', id: 'continued', epoch: 1, x: 9, y: 3, lineStartX: 7, text: 'C\nD' });
  const patch = await observer.next(message => hasCell(message, 7, 4, 'D'));
  assert.deepEqual(patch.observation.cells.map(({ x, y, text }) => ({ x, y, text })), [
    { x: 9, y: 3, text: 'C' }, { x: 7, y: 4, text: 'D' },
  ]);
  const ack = await writer.next(message => message.type === 'ack' && message.id === 'continued');
  assert.deepEqual(ack.cursor, { x: 8, y: 4 });
  await observer.next(message => hasPeer(message, writer.state.selfId, 8, 4));
  const before = app.world.snapshot();
  writer.send({ type: 'write', id: 'invalid-origin', epoch: 1, x: 7, y: 3, lineStartX: null, text: 'X\nY' });
  await writer.next(message => message.type === 'error' && message.id === 'invalid-origin' && message.code === 'BAD_POSITION');
  assert.deepEqual(app.world.snapshot(), before);
  await writer.locate(20, 3);
  writer.send({ type: 'write', id: 'default-lines', epoch: 1, x: 20, y: 3, text: 'E\nF' });
  const legacy = await observer.next(message => hasCell(message, 20, 4, 'F'));
  assert.deepEqual(legacy.observation.cells.map(({ x, y, text }) => ({ x, y, text })), [
    { x: 20, y: 3, text: 'E' }, { x: 20, y: 4, text: 'F' },
  ]);
});

test('old clients receive an update instruction before incompatible writes can mutate cells', async t => {
  const { app, url } = await fixture(t), old = await joined(url);
  assert.equal(old.state.world.textLayout, 2);
  old.send({ layout: undefined, type: 'write', id: 'old-width', epoch: 1, x: 10, y: 3, text: '한글' });
  const error = await old.next(message => message.type === 'error' && message.id === 'old-width');
  assert.equal(error.code, 'CLIENT_UPDATE_REQUIRED'); assert.match(error.message, /새로고침/);
  assert.equal(app.world.seq, 0); assert.equal(app.world.snapshot().cells.length, 0);
  await old.locate(10, 3);
  old.send({ type: 'write', id: 'new-width', epoch: 1, x: 10, y: 3, text: '한글' });
  const ack = await old.next(message => message.type === 'ack' && message.id === 'new-width');
  assert.deepEqual(ack.cursor, { x: 14, y: 3 });
});
