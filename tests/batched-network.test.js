import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createTextworld } from '../server/index.js';
import { connect } from './ws-client.js';

async function fixture(t) {
  const app = createTextworld({ storagePath: ':memory:', now: () => 12345 });
  t.after(() => app.close());
  const address = await app.listen(0, '127.0.0.1');
  const join = async (x, y, batched = true) => {
    const client = connect('ws://127.0.0.1:' + address.port + '/ws');
    await client.next(message => message.type === 'snapshot');
    client.send({ type: 'hello', ...(batched ? { batchVersion: 1 } : {}), x, y, view: { cols: 9, rows: 5 } });
    await client.sync();
    return client;
  };
  return { app, join };
}

const stream = (client, from) => client.messages.slice(from).flatMap(message => message.messages || [message]);
const write = (client, id, x, y, text) => client.send({ type: 'write', epoch: 1, id, x, y, text });
const move = (client, x, y) => client.send({ type: 'move', epoch: 1, x, y });
const ack = (client, id) => client.next(message => message.type === 'ack' && message.id === id);
const batchesWith = predicate => message => message.type === 'batch' && message.messages.some(predicate);

test('live batch preserves each CJK overwrite and cursor move, filters hidden writes and reports departure', async t => {
  const { join } = await fixture(t);
  const reader = await join(64, 32), writer = await join(64, 32), distant = await join(5, 5);
  const baseline = await reader.sync(), from = reader.messages.length;
  write(distant, 'hidden', 5, 5, '비밀');
  await ack(distant, 'hidden');
  write(writer, 'a', 64, 32, '가');
  move(writer, 64, 32);
  write(writer, 'b', 64, 32, '나');
  move(writer, 64, 32);
  write(writer, 'c', 64, 32, '다');
  await ack(writer, 'c');
  writer.socket.close();
  await reader.next(batchesWith(view => view.observation.departed?.includes(writer.state.selfId)), from);
  const updates = stream(reader, from).filter(message => message.type === 'view').map(message => message.observation);
  assert.deepEqual(updates.flatMap(update => update.cells.filter(cell => cell.width === 2).map(cell => cell.text)), ['가', '나', '다']);
  assert.deepEqual(updates.flatMap(update => update.peers.filter(peer => peer.id === writer.state.selfId).map(peer => peer.x)), [66, 64, 66, 64, 66]);
  assert.deepEqual(updates.map(update => update.revision), Array.from({ length: updates.length }, (_, i) => baseline.viewRevision + 1 + i));
  assert.doesNotMatch(JSON.stringify(updates), /비|밀/);
  assert.ok(updates.every(update => update.cells.every(cell => cell.x === 64 || cell.x === 65)));
});

test('resize flushes old epoch deltas first and a rejoined reader starts at the remapped snapshot', async t => {
  const { app, join } = await fixture(t);
  const reader = await join(64, 32), writer = await join(64, 32, false);
  const from = reader.messages.length;
  write(writer, 'old', 64, 32, '구');
  await ack(writer, 'old');
  // A pre-negotiation client continues to receive the original observation.
  assert.ok(writer.messages.some(message => message.type === 'view' && message.observation.cells.some(cell => cell.text === '구')));
  app.world.resize(256, 128);
  await reader.next(message => message.type === 'snapshot' && message.world.epoch === 2, from);
  const delivered = stream(reader, from);
  const before = delivered.findIndex(message => message.type === 'view' && message.observation.cells.some(cell => cell.text === '구'));
  const barrier = delivered.findIndex(message => message.type === 'snapshot' && message.world.epoch === 2);
  assert.ok(before >= 0 && before < barrier);
  assert.equal(delivered[before].world.epoch, 1);
  const text = app.world.snapshot().cells.find(cell => cell.text === '구');
  const closed = once(reader.socket, 'close');
  reader.socket.close();
  await closed;
  const adjacent = { x: (text.x + 2) % app.world.width, y: text.y };
  writer.send({ type: 'move', epoch: 2, ...adjacent });
  writer.send({ type: 'write', id: 'away', ...adjacent, text: 'Z', epoch: 2 });
  await ack(writer, 'away');
  const rejoined = await join(text.x, text.y);
  assert.equal(rejoined.state.world.epoch, 2);
  assert.ok([...rejoined.state.cells.values()].some(cell => cell.text === '구'));
  assert.ok([...rejoined.state.cells.values()].some(cell => cell.text === 'Z'));
});
