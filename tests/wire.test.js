import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeWire } from '../shared/wire.js';
import { encodeCompactView, encodeCompactSnapshot, encodingCounters } from '../server/encode-view.js';
import { createViewDelivery } from '../server/view-delivery.js';
import { World } from '../server/world.js';
import { Observer } from '../server/visibility.js';

const metadata = world => ({ width: world.width, height: world.height, epoch: world.epoch, textLayout: 2 });
const message = (world, observation) => ({ type: 'view', world: metadata(world), observation });
const roundtrip = value => decodeWire(JSON.parse('["tw1","v",' + encodeCompactView(value) + ']'));

test('compact observations preserve CJK closure, marks, freshness, moves, deletions and toroidal resize', t => {
  let clock = 1000;
  const world = new World({ now: () => clock });
  t.after(() => world.close());
  const self = { id: 'self', name: '가"\\\n😀', color: '#123456', x: 0, y: 0 };
  const other = { ...self, id: 'other', x: 1 };
  const observer = new Observer({ world, peer: self, view: { cols: 8, rows: 4 } });
  let sequence = 0;
  const write = (text, x = world.width - 1, y = 0) => world.applyWrite({ author: 'writer', id: String(++sequence), epoch: world.epoch, text, x, y });
  write('한"\\\n');
  const read = observer.read([other]);
  assert.deepEqual(roundtrip(message(world, read)), message(world, read));
  for (const text of ['국', 'A', ' ', '字', '😀']) {
    const change = write(text);
    const delta = observer.change({ cells: change.cells, peer: other });
    assert.deepEqual(roundtrip(message(world, delta)), message(world, delta));
  }
  other.x = world.width - 1;
  let delta = observer.change({ peer: other });
  assert.deepEqual(roundtrip(message(world, delta)), message(world, delta));
  clock += 65000;
  delta = observer.change({});
  assert.deepEqual(roundtrip(message(world, delta)), message(world, delta));
  other.y = 20;
  delta = observer.change({ peer: other });
  assert.deepEqual(roundtrip(message(world, delta)), message(world, delta));
  self.x = world.width - 2;
  delta = observer.change({ getPeers: () => [other] });
  assert.deepEqual(roundtrip(message(world, delta)), message(world, delta));
  world.resize(256, 128, [self, other]);
  const reset = observer.read([other], { force: true });
  const snapshot = { type: 'snapshot', world: metadata(world), selfId: self.id,
    ...reset, input: { sequence: 9, private: 'only this socket' } };
  assert.deepEqual(decodeWire(JSON.parse(encodeCompactSnapshot(snapshot))), snapshot);
  const patch = { type: 'snapshot', world: metadata(world), basis: { epoch: 1, revision: 9 }, patch: delta, inputSequence: 9 };
  assert.deepEqual(decodeWire(JSON.parse(encodeCompactSnapshot(patch))), patch);
});

test('shared public records are reused without reusing private envelopes or mutable snapshots', () => {
  const cell = Object.freeze({ x: 0, y: 1, text: '한', width: 2, leadX: null, version: 5 });
  const peer = Object.freeze({ id: 'p', name: '방문자', color: '#123456', x: 0, y: 1 });
  const observation = { partial: true, revision: 2, view: { x: 0, y: 0, cols: 8, rows: 4 },
    cells: [cell], forget: [], marks: [], unmark: [], freshness: { 5: 'now' }, colors: { 5: '#123456' },
    forgetVersions: [], peers: [peer], departed: [] };
  const world = { width: 128, height: 64, epoch: 1 };
  const first = message(world, observation);
  const before = encodingCounters();
  assert.deepEqual(roundtrip(first), first);
  const second = message(world, { ...observation, revision: 8 });
  assert.deepEqual(roundtrip(second), second);
  const after = encodingCounters();
  assert.equal(after.records - before.records, 2);
  assert.equal(after.reused - before.reused, 2);
  const mutable = { ...cell };
  first.observation = { ...observation, cells: [mutable] };
  roundtrip(first);
  mutable.text = 'Z';
  assert.equal(roundtrip(first).observation.cells[0].text, 'Z');
});

test('compact and legacy sockets preserve every ordered observation, including oversized UTF-8 messages', () => {
  const socket = { textworldWireVersion: 1 }, legacy = {}, sent = [];
  const delivery = createViewDelivery({ frameBytes: 260, record() {}, write(socket, data, fragmentBytes) {
    const decoded = decodeWire(JSON.parse(data));
    sent.push({ socket, values: decoded.messages || [decoded], bytes: Buffer.byteLength(data), fragmentBytes });
    return true;
  } });
  const values = Array.from({ length: 7 }, (_, i) => ({ type: 'view', world: { width: 128, height: 64, epoch: 1, textLayout: 2 },
    observation: { partial: true, revision: i + 1, view: { x: 0, y: 0, cols: 8, rows: 4 }, cells: [], forget: [],
      marks: [], unmark: [], freshness: {}, colors: {}, forgetVersions: [],
      peers: [{ id: 'p', name: '가'.repeat(i === 4 ? 100 : 2), color: '#123456', x: i, y: 0 }], departed: [] } }));
  for (const value of values) for (const client of [socket, legacy]) delivery.enqueue(client, value, performance.now());
  for (const client of [socket, legacy]) {
    delivery.flush(client);
    assert.deepEqual(sent.filter(s => s.socket === client).flatMap(s => s.values), values);
  }
  assert(sent.every(s => s.bytes <= 260 || s.fragmentBytes === 260));
  assert(sent.filter(s => s.socket === socket).reduce((n, s) => n + s.bytes, 0)
    < sent.filter(s => s.socket === legacy).reduce((n, s) => n + s.bytes, 0));
});
